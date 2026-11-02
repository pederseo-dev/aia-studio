// Documento: lista plana de objetos con `parent`. El orden de la lista define el orden de dibujo entre hermanos
// (los últimos quedan encima).

import { FORMATO } from './formato.js';
import { sugerir, validarValor } from './esquema.js';

export const ID = /^[a-z][a-z0-9_]*$/;
const ESTRUCTURA = new Set(['id', 'type', 'parent']);

export class ErrorDeValidacion extends Error {
  constructor(errores) {
    super(errores.join('\n'));
    this.errores = errores;
  }
}

export function crearDocumento(meta = {}) {
  return { format: FORMATO, meta: { ...meta }, objects: [] };
}

export function buscar(doc, id) {
  return doc.objects.find((o) => o.id === id);
}

/** Hijos de un objeto (o de la raíz con null), en orden de dibujo. */
export function hijos(doc, padre) {
  return doc.objects.filter((o) => (o.parent ?? null) === padre);
}

/** Ids del objeto y todos sus descendientes. */
export function subarbol(doc, id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const h of hijos(doc, ids[i])) ids.push(h.id);
  return ids;
}

/** Propiedades que no son estructurales (id, type, parent). */
export function propiedadesGuardadas(obj) {
  return Object.keys(obj).filter((k) => !ESTRUCTURA.has(k));
}

/**
 * Revisa el documento completo contra el esquema.
 * Los errores impiden guardar; los avisos no (propiedades desconocidas se conservan para no perder datos de
 * versiones futuras, pero suelen ser errores de tipeo).
 */
export function validar(doc, esquema) {
  const errores = [];
  const avisos = [];
  if (doc?.format !== FORMATO) errores.push(`format debe ser "${FORMATO}"`);
  if (!doc?.meta || typeof doc.meta !== 'object') errores.push('falta meta');
  if (!Array.isArray(doc?.objects)) errores.push('falta la lista objects');
  if (errores.length) return { errores, avisos };

  revisarPropiedades('meta', doc.meta, Object.keys(doc.meta), esquema.meta, errores, avisos);

  const ids = new Set();
  for (const o of doc.objects) {
    if (!ID.test(o?.id ?? '')) {
      errores.push(`id inválido "${o?.id}": usa minúsculas, números y _, empezando con letra`);
      continue;
    }
    if (ids.has(o.id)) errores.push(`id repetido "${o.id}"`);
    ids.add(o.id);
  }

  for (const o of doc.objects) {
    const tipo = esquema.tipos.get(o.type);
    if (!tipo) {
      errores.push(`${o.id}: tipo desconocido "${o.type}".${sugerir(o.type, esquema.tipos.keys())} Tipos: ${[...esquema.tipos.keys()].join(', ')}`);
      continue;
    }
    if (o.parent != null) {
      const padre = buscar(doc, o.parent);
      if (!padre) errores.push(`${o.id}: el padre "${o.parent}" no existe.${sugerir(o.parent, ids)}`);
      else if (!esquema.tipos.get(padre.type)?.container) errores.push(`${o.id}: su padre "${o.parent}" es un ${padre.type} y no puede tener hijos (usa un group)`);
    }
    revisarPropiedades(o.id, o, propiedadesGuardadas(o), tipo, errores, avisos);
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type === 'ref' && o[prop] != null && !ids.has(o[prop])) errores.push(`${o.id}.${prop}: el objeto "${o[prop]}" no existe`);
    }
  }

  // Ciclos: subir por los padres nunca debe volver al punto de partida.
  for (const o of doc.objects) {
    const vistos = new Set([o.id]);
    for (let p = buscar(doc, o.parent); p; p = buscar(doc, p.parent)) {
      if (vistos.has(p.id)) {
        errores.push(`ciclo de padres: ${[...vistos].join(' → ')} → ${p.id}`);
        break;
      }
      vistos.add(p.id);
    }
  }
  return { errores, avisos };
}

function revisarPropiedades(dueño, obj, props, tipo, errores, avisos) {
  for (const prop of props) {
    const p = tipo.properties[prop];
    if (!p) {
      avisos.push(`${dueño}: propiedad desconocida "${prop}" en ${tipo.name} (se conserva).${sugerir(prop, Object.keys(tipo.properties))}`);
      continue;
    }
    const error = validarValor(p, obj[prop]);
    if (error) errores.push(`${dueño}.${prop} ${error}`);
  }
}
