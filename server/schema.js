// Loads the schema from schema/*.json in Node (the editor loads the same files with import.meta.glob).

import fs from 'node:fs';
import { resolveSchema } from '../src/core/schema.js';

export const SCHEMA_FOLDER = new URL('../schema/', import.meta.url);

/** @returns {import('../src/core/schema.js').TypeDefinition[]} */
export function readDefinitions() {
  return fs
    .readdirSync(SCHEMA_FOLDER)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(new URL(name, SCHEMA_FOLDER), 'utf8')));
}

export const loadSchema = () => resolveSchema(readDefinitions());
