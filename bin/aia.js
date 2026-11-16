#!/usr/bin/env node
// The `aia` CLI: the command language for agents with a terminal (Claude Code, Cursor, Codex). It works on the
// documents folder directly, so the app does not need to be open; when it is, the editor shows the changes live.
//   aia help · aia guide start · aia ops <doc> '<batch>' · aia render <doc> …
// `aia ops <doc> -` reads the batch from stdin. `aia render` writes the PNG to --out, or to the temp folder.
// --documents <folder> or AIA_DOCUMENTS choose the folder (as for the app).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAia } from '../server/aia.js';
import { resolveDocumentsFolder } from '../server/folder.js';
import { loadSchema } from '../server/schema.js';
import { createStore } from '../server/store.js';

const argv = process.argv.slice(2);
const at = argv.indexOf('--documents');
const folder = resolveDocumentsFolder();
if (at >= 0) argv.splice(at, 2);
await fs.mkdir(folder, { recursive: true });

// A batch on stdin: aia ops <doc> - (handy for long batches).
const dash = argv.indexOf('-');
if (argv[0] === 'ops' && dash > 0) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  argv[dash] = input;
}

const aia = createAia({ store: createStore({ folder, schema: loadSchema() }), schema: loadSchema() });
const outAt = argv.indexOf('--out');
const out = outAt >= 0 ? argv.splice(outAt, 2)[1] : undefined;
const result = await aia.run(argv);

if (result.image) {
  const file = path.resolve(out ?? path.join(os.tmpdir(), `aia-${result.name ?? 'render.png'}`));
  await fs.writeFile(file, result.image);
  process.stdout.write(`${result.text}\nSaved to ${file}\n`);
} else {
  (result.ok ? process.stdout : process.stderr).write(`${result.text}\n`);
}
process.exitCode = result.ok ? 0 : 1;
