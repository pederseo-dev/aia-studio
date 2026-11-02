// Personajes en disco. Lo usan el servidor de desarrollo (ediciones del usuario) y el MCP (ediciones de la IA),
// así que las dos partes trabajan sobre los mismos archivos y cada lote queda en el historial con su origen.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validar, ErrorDeValidacion } from '../src/core/documento.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';

export const CARPETA = fileURLToPath(new URL('../personajes/', import.meta.url));

const ID = /^[a-z][a-z0-9_-]*$/;

function ruta(id, extension = '.json') {
  if (!ID.test(id)) throw new Error(`id de personaje inválido: "${id}" (minúsculas, números, _ y -)`);
  return path.join(CARPETA, id + extension);
}

export async function listar() {
  const archivos = await fs.readdir(CARPETA);
  return archivos.filter((a) => a.endsWith('.json')).map((a) => a.slice(0, -'.json'.length)).sort();
}

export async function leer(id) {
  try {
    return JSON.parse(await fs.readFile(ruta(id), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`No existe el personaje "${id}"`);
    throw e;
  }
}

async function escribir(id, doc) {
  // Escribe en un temporal y renombra, para que nadie lea un archivo a medio escribir.
  const temporal = ruta(id, '.json.tmp');
  await fs.writeFile(temporal, JSON.stringify(doc, null, 2) + '\n');
  await fs.rename(temporal, ruta(id));
}

async function registrar(id, entrada) {
  await fs.appendFile(ruta(id, '.historial.jsonl'), JSON.stringify({ fecha: new Date().toISOString(), ...entrada }) + '\n');
}

export async function crear(id, doc, { origen, nota }) {
  if ((await listar()).includes(id)) throw new Error(`Ya existe el personaje "${id}"`);
  const errores = validar(doc);
  if (errores.length) throw new ErrorDeValidacion(errores);
  await escribir(id, doc);
  await registrar(id, { origen, nota: nota ?? 'creado', ops: [] });
  return doc;
}

/** Aplica un lote de operaciones sobre la versión en disco. Es atómico: si algo falla, no se escribe nada. */
export async function modificar(id, ops, { origen, nota }) {
  const { doc } = aplicarOperaciones(await leer(id), ops);
  await escribir(id, doc);
  await registrar(id, { origen, nota, ops });
  return doc;
}

export async function historial(id, cantidad = 20) {
  try {
    const lineas = (await fs.readFile(ruta(id, '.historial.jsonl'), 'utf8')).trim().split('\n');
    return lineas.slice(-cantidad).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}
