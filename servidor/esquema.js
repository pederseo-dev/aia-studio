// Carga el esquema desde schema/*.json en Node (el editor lo carga con import.meta.glob).

import { readdirSync, readFileSync } from 'node:fs';
import { crearEsquema } from '../src/core/esquema.js';

const CARPETA = new URL('../schema/', import.meta.url);

export function cargarEsquema() {
  const defs = readdirSync(CARPETA)
    .filter((a) => a.endsWith('.json'))
    .map((a) => JSON.parse(readFileSync(new URL(a, CARPETA), 'utf8')));
  return crearEsquema(defs);
}
