// Carga el esquema desde schema/*.json en Node (el editor lo carga con import.meta.glob).

import { readdirSync, readFileSync } from 'node:fs';
import { createSchema } from '../src/core/schema.js';

const FOLDER = new URL('../schema/', import.meta.url);

export function loadSchema() {
  const defs = readdirSync(FOLDER)
    .filter((a) => a.endsWith('.json'))
    .map((a) => JSON.parse(readFileSync(new URL(a, FOLDER), 'utf8')));
  return createSchema(defs);
}
