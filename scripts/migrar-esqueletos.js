#!/usr/bin/env node
// Convierte los documentos de personajes/ al modelo de capa de huesos (ver src/core/migracion.js). Se puede correr
// las veces que haga falta: un documento que ya no tiene huesos sueltos se deja como está.
//
//   npm run migrar              → todos los documentos
//   npm run migrar -- gato_rig  → solo los nombrados
//
// Cada documento migrado queda con una entrada "migracion" en su historial. Deshacer no cruza esa entrada: las
// inversas de antes hablan del marco viejo de los huesos y aplicarlas ahora movería cosas de lugar.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CARPETA_PERSONAJES } from '../servidor/almacen.js';
import { cargarEsquema } from '../servidor/esquema.js';
import { migrarAEsqueletos } from '../src/core/migracion.js';

const esquema = cargarEsquema();
const pedidos = process.argv.slice(2);
const ids = pedidos.length ? pedidos : (await fs.readdir(CARPETA_PERSONAJES, { withFileTypes: true })).filter((c) => c.isDirectory()).map((c) => c.name).sort();

for (const id of ids) {
  const archivo = path.join(CARPETA_PERSONAJES, id, 'documento.json');
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(archivo, 'utf8'));
  } catch {
    continue;
  }
  const { doc: migrado, cambios } = migrarAEsqueletos(doc, esquema);
  if (!cambios.length) {
    console.log(`${id}: nada que migrar`);
    continue;
  }
  await fs.writeFile(archivo + '.tmp', JSON.stringify(migrado, null, 2) + '\n');
  await fs.rename(archivo + '.tmp', archivo);
  const historial = path.join(CARPETA_PERSONAJES, id, 'historial.jsonl');
  let n = 1;
  try {
    n = (await fs.readFile(historial, 'utf8')).split('\n').filter(Boolean).length + 1;
  } catch {
    // sin historial
  }
  const nota = `Moved to the Skeleton model: ${cambios.join('; ')}`;
  await fs.appendFile(historial, JSON.stringify({ n, fecha: new Date().toISOString(), origen: 'system', tipo: 'migracion', nota, ops: [], inversas: [] }) + '\n');
  console.log(`${id}: ${cambios.join('; ')}`);
}
