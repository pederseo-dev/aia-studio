// Documento: lista plana de objetos con `parent`. El orden de la lista define el orden de dibujo entre hermanos
// (los últimos quedan encima).

import { FORMATO } from './formato.js';
import { leer, sugerir, validarValor } from './esquema.js';

export const ID = /^[a-z][a-z0-9_]*$/;
// "meta" nombra las propiedades del documento en set/unset (target: "meta"): ningún objeto puede llamarse así.
export const IDS_RESERVADOS = new Set(['meta']);
const ESTRUCTURA = new Set(['id', 'type', 'parent']);

/** Por qué un id nuevo no sirve (null si sirve). */
export function errorDeId(id) {
  if (!ID.test(id ?? '')) return `id inválido "${id}": usa minúsculas, números y _, empezando con letra`;
  if (IDS_RESERVADOS.has(id)) return `"${id}" is a reserved id (target "meta" means the document's properties); choose another one`;
  return null;
}

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

/**
 * El skeleton que contiene a un objeto: su ancestro de tipo skeleton más cercano (sin contarse a sí mismo), o null.
 * Para un hueso, es el skeleton al que pertenece.
 */
export function esqueletoDe(doc, id) {
  for (let o = buscar(doc, buscar(doc, id)?.parent); o; o = buscar(doc, o.parent)) if (o.type === 'skeleton') return o.id;
  return null;
}

/** Huesos de un skeleton (los suyos, no los de un skeleton anidado), en orden de la lista. */
export function huesosDe(doc, esqueletoId) {
  return doc.objects.filter((o) => o.type === 'bone' && esqueletoDe(doc, o.id) === esqueletoId);
}

/**
 * Por qué un objeto no puede enlazarse a un hueso (null si puede): el hueso tiene que ser del skeleton que lo
 * contiene. `dueño` es el nombre para el mensaje (por ejemplo "arm.bone" o "tail.vertices[3].bone").
 */
export function errorDeEnlace(doc, objId, huesoId, dueño) {
  const hueso = buscar(doc, huesoId);
  const todos = doc.objects.filter((h) => h.type === 'bone').map((h) => h.id);
  if (!hueso) return `${dueño}: no existe el hueso "${huesoId}".${sugerir(huesoId, todos)}`;
  if (hueso.type !== 'bone') return `${dueño}: "${huesoId}" es un ${hueso.type}, no un hueso`;
  const propio = esqueletoDe(doc, objId);
  const delHueso = esqueletoDe(doc, huesoId);
  if (propio === delHueso) return null;
  if (!propio) return `${dueño}: "${huesoId}" es un hueso del skeleton "${delHueso}" y ${objId} no está dentro de ningún skeleton. Un objeto solo se enlaza a huesos de su skeleton: mételo dentro de "${delHueso}" (move) o quita el enlace.`;
  const propios = huesosDe(doc, propio).map((h) => h.id);
  return `${dueño}: "${huesoId}" es un hueso del skeleton "${delHueso}", pero ${objId} está en el skeleton "${propio}" y solo puede enlazarse a sus huesos: ${propios.join(', ') || 'todavía no tiene'}.${sugerir(huesoId, propios)}`;
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
    if (errorDeId(o?.id)) {
      errores.push(errorDeId(o?.id));
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
    else if (o.parent == null && tipo.requiresParent) {
      const esqueletos = doc.objects.filter((x) => x.type === 'skeleton').map((x) => x.id);
      const pista = esqueletos.length ? ` Esqueletos del documento: ${esqueletos.join(', ')}.` : ' Crea primero un skeleton (la capa de huesos, que también contiene el dibujo que mueve) y pon el hueso adentro.';
      errores.push(`${o.id}: un ${o.type} no puede estar en la raíz: va dentro de ${tipo.parentTypes.join(' o ')}.${pista} (Los documentos de antes de los skeleton se convierten con npm run migrar.)`);
    } else if (o.parent != null) {
      const padre = buscar(doc, o.parent);
      if (!padre) errores.push(`${o.id}: el padre "${o.parent}" no existe.${sugerir(o.parent, ids)}`);
      else if (!esquema.tipos.get(padre.type)?.container) errores.push(`${o.id}: su padre "${o.parent}" es un ${padre.type} y no puede tener hijos (usa un group)`);
      else if (tipo.parentTypes && !tipo.parentTypes.includes(padre.type)) errores.push(`${o.id}: un ${o.type} solo puede estar ${tipo.requiresParent ? '' : 'en la raíz o '}dentro de ${tipo.parentTypes.join(' o ')} (su padre "${o.parent}" es un ${padre.type})`);
      else if (esquema.tipos.get(padre.type).childTypes && !esquema.tipos.get(padre.type).childTypes.includes(o.type)) {
        const pista = padre.type === 'bone' ? `; el dibujo va dentro del skeleton (${esqueletoDe(doc, padre.id) ?? 'el de ese hueso'}), no dentro del hueso: ponlo ahí y enlázalo con la propiedad bone` : '';
        errores.push(`${o.id}: un ${padre.type} solo puede tener hijos ${esquema.tipos.get(padre.type).childTypes.join(' o ')} y "${o.id}" es un ${o.type}${pista}`);
      }
    }
    revisarPropiedades(o.id, o, propiedadesGuardadas(o), tipo, errores, avisos);
    errores.push(...erroresDeControl(doc, esquema, o));
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'ref' || o[prop] == null) continue;
      errores.push(...erroresDeReferencia(doc, o, prop, p, o[prop], o.id));
    }
    // Los vértices enlazados a un hueso (enlace por punto) nombran huesos de su skeleton.
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'vertices' || !Array.isArray(o[prop])) continue;
      o[prop].forEach((v, i) => {
        if (v?.bone == null) return;
        const error = errorDeEnlace(doc, o.id, v.bone, `${o.id}.${prop}[${i}].bone`);
        if (error) errores.push(error);
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
          else if (props[k].type === 'ref') errores.push(...erroresDeReferencia(doc, destino, k, props[k], v, `${o.id}.${prop}.${id}`, o.id));
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

/**
 * Errores de una referencia: que exista, que sea del tipo pedido y, con refScope "children", que sea un hijo; con
 * refScope "skeleton", que sea un hueso del skeleton que contiene al objeto.
 */
function erroresDeReferencia(doc, o, prop, p, valor, dueño, poseId = null) {
  if (valor == null) return [];
  if (p.refScope === 'skeleton') {
    const error = errorDeEnlace(doc, o.id, valor, `${dueño}.${prop}`);
    return error ? [error] : [];
  }
  const referido = buscar(doc, valor);
  if (!referido) return [`${dueño}.${prop}: el objeto "${valor}" no existe.${sugerir(valor, doc.objects.map((x) => x.id))}`];
  if (p.refTypes && !p.refTypes.includes(referido.type)) return [`${dueño}.${prop}: "${valor}" es un ${referido.type}; se esperaba ${p.refTypes.join(' o ')}`];
  if (p.refScope === 'children' && referido.parent !== o.id) {
    const hijos = doc.objects.filter((x) => x.parent === o.id).map((x) => x.id);
    // Lo más común: sacar del switch una variante que una pose elige. El mensaje dice cómo seguir.
    if (poseId) {
      return [`Pose "${poseId}" makes switch ${o.id} show "${valor}", but "${valor}" is not a child of ${o.id} (children: ${hijos.join(', ') || 'none'}). To take it out of the switch, first remove only ${o.id}'s ${prop} from pose "${poseId}" — in the editor: View → Pose: ${poseId}, select ${o.id} and click ↺ next to ${prop}; for the AI: set_pose with remove: ["${o.id}.${prop}"] — or keep "${valor}" inside ${o.id}. Otherwise, pick one of its children.`];
    }
    return [`${dueño}.${prop}: "${valor}" no es hijo de ${o.id}. Hijos: ${hijos.join(', ') || 'ninguno'}.${sugerir(valor, hijos)}`];
  }
  return [];
}

/**
 * Coherencia de params y drivers: un param enum con initial fuera de sus options, un param numérico con min > max, o
 * un driver con equals que no es una opción de su param.
 */
function erroresDeControl(doc, esquema, o) {
  const errores = [];
  const lista = (opciones) => (opciones?.length ? opciones.map((x) => `"${x}"`).join(', ') : 'none yet');
  if (o.type === 'param') {
    const [kind, opciones, min, max] = ['kind', 'options', 'min', 'max'].map((k) => leer(esquema, o, k));
    if (kind === 'enum' && o.initial != null && Array.isArray(opciones) && !opciones.includes(o.initial)) errores.push(`${o.id}.initial "${o.initial}" is not one of its options: ${lista(opciones)}`);
    if (Array.isArray(opciones) && new Set(opciones).size !== opciones.length) errores.push(`${o.id}.options has repeated options: ${lista(opciones)}`);
    if (kind !== 'enum' && typeof min === 'number' && typeof max === 'number' && min > max) errores.push(`${o.id}: min (${min}) is greater than max (${max})`);
    // Drivers cuyo equals no es una opción (por ejemplo, al quitar o renombrar una opción en uso): un solo error que
    // los nombra a todos y dice cómo seguir.
    if (kind === 'enum' && Array.isArray(opciones)) {
      const malos = doc.objects.filter((d) => d.type === 'driver' && d.param === o.id && d.equals != null && !opciones.includes(d.equals));
      if (malos.length) {
        const ejemplo = `{ "op": "set", "target": "${malos[0].id}", "props": { "equals": ${JSON.stringify(opciones[0] ?? 'option')} } }`;
        errores.push(`param ${o.id} has options ${lista(opciones)}, but ${malos.length === 1 ? 'driver' : 'drivers'} ${malos.map((d) => `${d.id}.equals "${d.equals}"`).join(', ')} ${malos.length === 1 ? 'uses a value' : 'use values'} that ${malos.length === 1 ? 'is' : 'are'} not among them. If you are removing or renaming an option, change ${malos.length === 1 ? 'that driver’s' : 'those drivers’'} equals in the same batch (for example ${ejemplo}) or delete ${malos.length === 1 ? 'it' : 'them'}; otherwise use one of the options.`);
      }
    }
  }
  return errores;
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
