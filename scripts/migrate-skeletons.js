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
import { DOCUMENTS_FOLDER } from '../server/store.js';
import { loadSchema } from '../server/schema.js';
import { migrateToSkeletons } from '../src/core/migration.js';

const schema = loadSchema();
const requested = process.argv.slice(2);
const ids = requested.length ? requested : (await fs.readdir(DOCUMENTS_FOLDER, { withFileTypes: true })).filter((c) => c.isDirectory()).map((c) => c.name).sort();

for (const id of ids) {
  const file = path.join(DOCUMENTS_FOLDER, id, 'document.json');
  let doc;
  try {
    doc = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    continue;
  }
  const { doc: migrated, changes } = migrateToSkeletons(doc, schema);
  if (!changes.length) {
    console.log(`${id}: nada que migrar`);
    continue;
  }
  await fs.writeFile(file + '.tmp', JSON.stringify(migrated, null, 2) + '\n');
  await fs.rename(file + '.tmp', file);
  const history = path.join(DOCUMENTS_FOLDER, id, 'history.jsonl');
  let n = 1;
  try {
    n = (await fs.readFile(history, 'utf8')).split('\n').filter(Boolean).length + 1;
  } catch {
    // sin historial
  }
  const note = `Moved to the Skeleton model: ${changes.join('; ')}`;
  await fs.appendFile(history, JSON.stringify({ n, date: new Date().toISOString(), origin: 'system', kind: 'migration', note, ops: [], inverses: [] }) + '\n');
  console.log(`${id}: ${changes.join('; ')}`);
}
