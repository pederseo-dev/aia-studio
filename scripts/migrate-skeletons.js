#!/usr/bin/env node
// Converts the documents in documents/ to the bone layer model (see src/core/migration.js). It can be run
// as many times as needed: a document that no longer has loose bones is left as it is.
//
//   npm run migrate              → all documents
//   npm run migrate -- gato_rig  → only the named ones
//
// Each migrated document gets a "migration" entry in its history. Undo does not cross that entry: the
// inverses from before refer to the old bone frame and applying them now would move things out of place.

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
    // no history
  }
  const note = `Moved to the Skeleton model: ${changes.join('; ')}`;
  await fs.appendFile(history, JSON.stringify({ n, date: new Date().toISOString(), origin: 'system', kind: 'migration', note, ops: [], inverses: [] }) + '\n');
  console.log(`${id}: ${changes.join('; ')}`);
}
