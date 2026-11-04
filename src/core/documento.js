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
    if (tipo.resource && o.parent != null) errores.push(`${o.id}: es un recurso (${o.type}) y va en la raíz (parent: null)`);
    else if (o.parent != null) {
      const padre = buscar(doc, o.parent);
      if (!padre) errores.push(`${o.id}: el padre "${o.parent}" no existe.${sugerir(o.parent, ids)}`);
      else if (!esquema.tipos.get(padre.type)?.container) errores.push(`${o.id}: su padre "${o.parent}" es un ${padre.type} y no puede tener hijos (usa un group)`);
      else if (tipo.parentTypes && !tipo.parentTypes.includes(padre.type)) errores.push(`${o.id}: un ${o.type} solo puede estar en la raíz o dentro de ${tipo.parentTypes.join(' o ')} (su padre "${o.parent}" es un ${padre.type})`);
      else if (esquema.tipos.get(padre.type).childTypes && !esquema.tipos.get(padre.type).childTypes.includes(o.type)) {
        const pista = padre.type === 'bone' ? '; para pegar un dibujo a un hueso, déjalo donde está y ponle la propiedad bone' : '';
        errores.push(`${o.id}: un ${padre.type} solo puede tener hijos ${esquema.tipos.get(padre.type).childTypes.join(' o ')} y "${o.id}" es un ${o.type}${pista}`);
      }
    }
    revisarPropiedades(o.id, o, propiedadesGuardadas(o), tipo, errores, avisos);
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'ref' || o[prop] == null) continue;
      errores.push(...erroresDeReferencia(doc, o, prop, p, o[prop], o.id));
    }
    // Los vértices enlazados a un hueso (enlace por punto) nombran huesos que tienen que existir.
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'vertices' || !Array.isArray(o[prop])) continue;
      o[prop].forEach((v, i) => {
        if (v?.bone == null) return;
        const hueso = buscar(doc, v.bone);
        if (!hueso) errores.push(`${o.id}.${prop}[${i}].bone: no existe el hueso "${v.bone}".${sugerir(v.bone, doc.objects.filter((h) => h.type === 'bone').map((h) => h.id))}`);
        else if (hueso.type !== 'bone') errores.push(`${o.id}.${prop}[${i}].bone: "${v.bone}" es un ${hueso.type}, no un hueso`);
      });
    }
    // Las poses nombran objetos que existen y propiedades animables suyas, con valores válidos.
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'pose' || !o[prop] || typeof o[prop] !== 'object' || Array.isArray(o[prop])) continue;
      for (const [id, campos] of Object.entries(o[prop])) {
        const destino = buscar(doc, id);
        if (!destino) {
          errores.push(`${o.id}.${prop}: no existe el objeto "${id}".${sugerir(id, ids)}`);
          continue;
        }
        const props = esquema.tipos.get(destino.type)?.properties ?? {};
        const animables = Object.keys(props).filter((k) => props[k].animatable);
        for (const [k, v] of Object.entries(campos ?? {})) {
          if (!props[k]?.animatable) {
            errores.push(`${o.id}.${prop}.${id}.${k}: ${destino.type} no tiene "${k}" animable. Animables: ${animables.join(', ')}.${sugerir(k, animables)}`);
            continue;
          }
          const error = validarValor(props[k], v);
          if (error) errores.push(`${o.id}.${prop}.${id}.${k} ${error}`);
          else if (props[k].type === 'ref') errores.push(...erroresDeReferencia(doc, destino, k, props[k], v, `${o.id}.${prop}.${id}`));
        }
      }
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

/** Errores de una referencia: que exista, que sea del tipo pedido y, con refScope "children", que sea un hijo. */
function erroresDeReferencia(doc, o, prop, p, valor, dueño) {
  if (valor == null) return [];
  const referido = buscar(doc, valor);
  if (!referido) return [`${dueño}.${prop}: el objeto "${valor}" no existe.${sugerir(valor, doc.objects.map((x) => x.id))}`];
  if (p.refTypes && !p.refTypes.includes(referido.type)) return [`${dueño}.${prop}: "${valor}" es un ${referido.type}; se esperaba ${p.refTypes.join(' o ')}`];
  if (p.refScope === 'children' && referido.parent !== o.id) {
    const hijos = doc.objects.filter((x) => x.parent === o.id).map((x) => x.id);
    return [`${dueño}.${prop}: "${valor}" no es hijo de ${o.id}. Hijos: ${hijos.join(', ') || 'ninguno'}.${sugerir(valor, hijos)}`];
  }
  return [];
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
