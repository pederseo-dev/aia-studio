// Documento: lista plana de objetos con `parent`. El orden de la lista define el orden de dibujo entre hermanos
// (los últimos quedan encima).

import { FORMAT } from './format.js';
import { read, suggest, validateValue } from './schema.js';

export const ID = /^[a-z][a-z0-9_]*$/;
// "meta" nombra las propiedades del documento en set/unset (target: "meta"): ningún objeto puede llamarse así.
export const RESERVED_IDS = new Set(['meta']);
const STRUCTURE = new Set(['id', 'type', 'parent']);

/** Por qué un id nuevo no sirve (null si sirve). */
export function idError(id) {
  if (!ID.test(id ?? '')) return `id inválido "${id}": usa minúsculas, números y _, empezando con letra`;
  if (RESERVED_IDS.has(id)) return `"${id}" is a reserved id (target "meta" means the document's properties); choose another one`;
  return null;
}

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.errors = errors;
  }
}

export function createDocument(meta = {}) {
  return { format: FORMAT, meta: { ...meta }, objects: [] };
}

export function findObject(doc, id) {
  return doc.objects.find((o) => o.id === id);
}

/** Si el objeto o alguno de sus padres tiene el candado puesto (`locked`): en el lienzo no se elige ni se mueve. */
export function locked(doc, id) {
  for (let o = findObject(doc, id); o; o = o.parent ? findObject(doc, o.parent) : null) if (o.locked) return true;
  return false;
}

/** Hijos de un objeto (o de la raíz con null), en orden de dibujo. */
export function children(doc, parent) {
  return doc.objects.filter((o) => (o.parent ?? null) === parent);
}

/** Ids del objeto y todos sus descendientes. */
export function subtree(doc, id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const h of children(doc, ids[i])) ids.push(h.id);
  return ids;
}

/**
 * El skeleton que contiene a un objeto: su ancestro de tipo skeleton más cercano (sin contarse a sí mismo), o null.
 * Para un hueso, es el skeleton al que pertenece.
 */
export function skeletonOf(doc, id) {
  for (let o = findObject(doc, findObject(doc, id)?.parent); o; o = findObject(doc, o.parent)) if (o.type === 'skeleton') return o.id;
  return null;
}

/** Huesos de un skeleton (los suyos, no los de un skeleton anidado), en orden de la lista. */
export function bonesOf(doc, skeletonId) {
  return doc.objects.filter((o) => o.type === 'bone' && skeletonOf(doc, o.id) === skeletonId);
}

/**
 * Por qué un objeto no puede enlazarse a un hueso (null si puede): el hueso tiene que ser del skeleton que lo
 * contiene. `dueño` es el nombre para el mensaje (por ejemplo "arm.bone" o "tail.vertices[3].bone").
 */
export function bindingError(doc, objId, boneId, owner) {
  const bone = findObject(doc, boneId);
  const all = doc.objects.filter((h) => h.type === 'bone').map((h) => h.id);
  if (!bone) return `${owner}: no existe el hueso "${boneId}".${suggest(boneId, all)}`;
  if (bone.type !== 'bone') return `${owner}: "${boneId}" es un ${bone.type}, no un hueso`;
  const own = skeletonOf(doc, objId);
  const fromBone = skeletonOf(doc, boneId);
  if (own === fromBone) return null;
  if (!own) return `${owner}: "${boneId}" es un hueso del skeleton "${fromBone}" y ${objId} no está dentro de ningún skeleton. Un objeto solo se enlaza a huesos de su skeleton: mételo dentro de "${fromBone}" (move) o quita el enlace.`;
  const ownBones = bonesOf(doc, own).map((h) => h.id);
  return `${owner}: "${boneId}" es un hueso del skeleton "${fromBone}", pero ${objId} está en el skeleton "${own}" y solo puede enlazarse a sus huesos: ${ownBones.join(', ') || 'todavía no tiene'}.${suggest(boneId, ownBones)}`;
}

/** Propiedades que no son estructurales (id, type, parent). */
export function savedProperties(obj) {
  return Object.keys(obj).filter((k) => !STRUCTURE.has(k));
}

/**
 * Revisa el documento completo contra el esquema.
 * Los errores impiden guardar; los avisos no (propiedades desconocidas se conservan para no perder datos de
 * versiones futuras, pero suelen ser errores de tipeo).
 */
export function validate(doc, schema) {
  const errors = [];
  const warnings = [];
  if (doc?.format !== FORMAT) errors.push(`format debe ser "${FORMAT}"`);
  if (!doc?.meta || typeof doc.meta !== 'object') errors.push('falta meta');
  if (!Array.isArray(doc?.objects)) errors.push('falta la lista objects');
  if (errors.length) return { errors, warnings };

  checkProperties('meta', doc.meta, Object.keys(doc.meta), schema.meta, errors, warnings);

  const ids = new Set();
  for (const o of doc.objects) {
    if (idError(o?.id)) {
      errors.push(idError(o?.id));
      continue;
    }
    if (ids.has(o.id)) errors.push(`id repetido "${o.id}"`);
    ids.add(o.id);
  }

  for (const o of doc.objects) {
    const tipo = schema.types.get(o.type);
    if (!tipo) {
      errors.push(`${o.id}: tipo desconocido "${o.type}".${suggest(o.type, schema.types.keys())} Tipos: ${[...schema.types.keys()].join(', ')}`);
      continue;
    }
    if (tipo.resource && o.parent != null) errors.push(`${o.id}: es un recurso (${o.type}) y va en la raíz (parent: null)`);
    else if (o.parent == null && tipo.requiresParent) {
      const skeletons = doc.objects.filter((x) => x.type === 'skeleton').map((x) => x.id);
      const track = skeletons.length ? ` Esqueletos del documento: ${skeletons.join(', ')}.` : ' Crea primero un skeleton (la capa de huesos, que también contiene el dibujo que mueve) y pon el hueso adentro.';
      errors.push(`${o.id}: un ${o.type} no puede estar en la raíz: va dentro de ${tipo.parentTypes.join(' o ')}.${track} (Los documentos de antes de los skeleton se convierten con npm run migrar.)`);
    } else if (o.parent != null) {
      const parent = findObject(doc, o.parent);
      if (!parent) errors.push(`${o.id}: el padre "${o.parent}" no existe.${suggest(o.parent, ids)}`);
      else if (!schema.types.get(parent.type)?.container) errors.push(`${o.id}: su padre "${o.parent}" es un ${parent.type} y no puede tener hijos (usa un group)`);
      else if (tipo.parentTypes && !tipo.parentTypes.includes(parent.type)) errors.push(`${o.id}: un ${o.type} solo puede estar ${tipo.requiresParent ? '' : 'en la raíz o '}dentro de ${tipo.parentTypes.join(' o ')} (su padre "${o.parent}" es un ${parent.type})`);
      else if (schema.types.get(parent.type).childTypes && !schema.types.get(parent.type).childTypes.includes(o.type)) {
        const track = parent.type === 'bone' ? `; el dibujo va dentro del skeleton (${skeletonOf(doc, parent.id) ?? 'el de ese hueso'}), no dentro del hueso: ponlo ahí y enlázalo con la propiedad bone` : '';
        errors.push(`${o.id}: un ${parent.type} solo puede tener hijos ${schema.types.get(parent.type).childTypes.join(' o ')} y "${o.id}" es un ${o.type}${track}`);
      }
    }
    checkProperties(o.id, o, savedProperties(o), tipo, errors, warnings);
    errors.push(...controlErrors(doc, schema, o));
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'ref' || o[prop] == null) continue;
      errors.push(...referenceErrors(doc, o, prop, p, o[prop], o.id));
    }
    // Los vértices enlazados a un hueso (enlace por punto) nombran huesos de su skeleton.
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'vertices' || !Array.isArray(o[prop])) continue;
      o[prop].forEach((v, i) => {
        if (v?.bone == null) return;
        const error = bindingError(doc, o.id, v.bone, `${o.id}.${prop}[${i}].bone`);
        if (error) errors.push(error);
      });
    }
    // Las poses nombran objetos que existen y propiedades animables suyas, con valores válidos.
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'pose' || !o[prop] || typeof o[prop] !== 'object' || Array.isArray(o[prop])) continue;
      for (const [id, fields] of Object.entries(o[prop])) {
        const target = findObject(doc, id);
        if (!target) {
          errors.push(`${o.id}.${prop}: no existe el objeto "${id}".${suggest(id, ids)}`);
          continue;
        }
        const props = schema.types.get(target.type)?.properties ?? {};
        const animatable = Object.keys(props).filter((k) => props[k].animatable);
        for (const [k, v] of Object.entries(fields ?? {})) {
          if (!props[k]?.animatable) {
            errors.push(`${o.id}.${prop}.${id}.${k}: ${target.type} no tiene "${k}" animable. Animables: ${animatable.join(', ')}.${suggest(k, animatable)}`);
            continue;
          }
          const error = validateValue(props[k], v);
          if (error) errors.push(`${o.id}.${prop}.${id}.${k} ${error}`);
          else if (props[k].type === 'ref') errors.push(...referenceErrors(doc, target, k, props[k], v, `${o.id}.${prop}.${id}`, { pose: o.id }));
        }
      }
    }
    // Las pistas de un clip: como las poses, más los params (que animan su valor) y los tiempos dentro de la duración.
    for (const [prop, p] of Object.entries(tipo.properties)) {
      if (p.type !== 'tracks' || validateValue(p, o[prop] ?? {})) continue;
      const duration = read(schema, o, 'duration');
      for (const [id, fields] of Object.entries(o[prop] ?? {})) {
        const target = findObject(doc, id);
        if (!target) {
          errors.push(`${o.id}.${prop}: object "${id}" does not exist.${suggest(id, ids)}`);
          continue;
        }
        // Los params son del muñeco: solo un clip de Puppet los anima. Una escena keya los valores mismos.
        if (target.type === 'param' && read(schema, o, 'usage') !== 'puppet') {
          errors.push(`${o.id}.${prop}.${id}: scene "${o.id}" (Animate) can't animate params: params belong to Puppet. If this is a Puppet clip, pass usage: "puppet". Otherwise key the values themselves (set_keys with values or pose) and remove this track (set_keys with remove: ["${id}"], delete_keys with targets: ["${id}"], or × on the track in the editor).`);
          continue;
        }
        for (const [k, keys] of Object.entries(fields)) {
          const owner = `${o.id}.${prop}.${id}.${k}`;
          const outside = keys.find((c) => c.t < 0 || c.t > duration + 1e-9);
          if (outside) errors.push(`${owner}: keyframe at t ${outside.t} is outside the clip (0…${duration} s). Make duration longer or move the keyframe.`);
          const valueError = animatedValueError(doc, schema, target, k);
          if (typeof valueError === 'string') {
            errors.push(`${owner}: ${valueError}`);
            continue;
          }
          for (const [i, c] of keys.entries()) {
            const error = valueError(c.value);
            if (error) errors.push(`${owner}[${i}].value ${error}`);
            else if (schema.types.get(target.type).properties[k]?.type === 'ref') errors.push(...referenceErrors(doc, target, k, schema.types.get(target.type).properties[k], c.value, `${owner}[${i}]`, { clip: o.id, t: c.t }));
          }
        }
      }
    }
  }

  // Ciclos: subir por los padres nunca debe volver al punto de partida.
  for (const o of doc.objects) {
    const seen = new Set([o.id]);
    for (let p = findObject(doc, o.parent); p; p = findObject(doc, p.parent)) {
      if (seen.has(p.id)) {
        errors.push(`ciclo de padres: ${[...seen].join(' → ')} → ${p.id}`);
        break;
      }
      seen.add(p.id);
    }
  }
  return { errors, warnings };
}

/**
 * Qué valores acepta una pista de `destino.prop`: devuelve un validador (valor → mensaje o null), o un mensaje si esa
 * propiedad no se puede animar. Un param anima su `value` (número, 0/1 o una de sus opciones).
 */
export function animatedValueError(doc, schema, target, prop) {
  if (target.type === 'param') {
    if (prop !== 'value') return `a param only animates "value" (not "${prop}")`;
    const kind = read(schema, target, 'kind');
    if (kind === 'enum') {
      const options = read(schema, target, 'options');
      return (v) => (options.includes(v) ? null : `must be one of the options of ${target.id}: ${options.join(', ') || 'none yet'}`);
    }
    return (v) => (kind === 'boolean' && typeof v === 'boolean') || (typeof v === 'number' && Number.isFinite(v)) ? null : 'must be a number';
  }
  const props = schema.types.get(target.type)?.properties ?? {};
  const animatable = Object.keys(props).filter((k) => props[k].animatable);
  if (!props[prop]?.animatable) return `${target.type} has no animatable "${prop}". Animatable: ${animatable.join(', ') || 'none'}.${suggest(prop, animatable)}`;
  return (v) => validateValue(props[prop], v);
}

/**
 * Errores de una referencia: que exista, que sea del tipo pedido y, con refScope "children", que sea un hijo; con
 * refScope "skeleton", que sea un hueso del skeleton que contiene al objeto.
 */
function referenceErrors(doc, o, prop, p, value, owner, { pose: poseId = null, clip = null, t = null } = {}) {
  if (value == null) return [];
  if (p.refScope === 'skeleton') {
    const error = bindingError(doc, o.id, value, `${owner}.${prop}`);
    return error ? [error] : [];
  }
  const referenced = findObject(doc, value);
  if (!referenced) return [`${owner}.${prop}: el objeto "${value}" no existe.${suggest(value, doc.objects.map((x) => x.id))}`];
  if (p.refTypes && !p.refTypes.includes(referenced.type)) return [`${owner}.${prop}: "${value}" es un ${referenced.type}; se esperaba ${p.refTypes.join(' o ')}`];
  if (p.refScope === 'children' && referenced.parent !== o.id) {
    const children = doc.objects.filter((x) => x.parent === o.id).map((x) => x.id);
    // Lo más común: sacar del switch una variante que una pose elige. El mensaje dice cómo seguir.
    if (poseId) {
      return [`Pose "${poseId}" makes switch ${o.id} show "${value}", but "${value}" is not a child of ${o.id} (children: ${children.join(', ') || 'none'}). To take it out of the switch, first remove only ${o.id}'s ${prop} from pose "${poseId}" — in the editor: Puppet → View → Pose: ${poseId}, select ${o.id} and click ↺ next to ${prop}; for the AI: set_pose with remove: ["${o.id}.${prop}"] — or keep "${value}" inside ${o.id}. Otherwise, pick one of its children.`];
    }
    if (clip) {
      return [`Clip "${clip}" makes switch ${o.id} show "${value}" at t ${t} s, but "${value}" is not a child of ${o.id} (children: ${children.join(', ') || 'none'}). To take it out of the switch, first delete that keyframe — in the editor: open the clip in Animate or Puppet, click the keyframe in the ${o.id}.${prop} track and press Del; for the AI: delete_keys with targets ["${o.id}.${prop}"] and times [${t}] (or set_keys with remove: ["${o.id}.${prop}"] for the whole track) — or keep "${value}" inside ${o.id}. Otherwise, pick one of its children.`];
    }
    return [`${owner}.${prop}: "${value}" is not a child of ${o.id}. Children: ${children.join(', ') || 'none'}.${suggest(value, children)}`];
  }
  return [];
}

/**
 * Coherencia de params y drivers: un param enum con initial fuera de sus options, un param numérico con min > max, o
 * un driver con equals que no es una opción de su param.
 */
function controlErrors(doc, schema, o) {
  const errors = [];
  const list = (options) => (options?.length ? options.map((x) => `"${x}"`).join(', ') : 'none yet');
  if (o.type === 'param') {
    const [kind, options, min, max] = ['kind', 'options', 'min', 'max'].map((k) => read(schema, o, k));
    if (kind === 'enum' && o.initial != null && Array.isArray(options) && !options.includes(o.initial)) errors.push(`${o.id}.initial "${o.initial}" is not one of its options: ${list(options)}`);
    if (Array.isArray(options) && new Set(options).size !== options.length) errors.push(`${o.id}.options has repeated options: ${list(options)}`);
    if (kind !== 'enum' && typeof min === 'number' && typeof max === 'number' && min > max) errors.push(`${o.id}: min (${min}) is greater than max (${max})`);
    // Drivers cuyo equals no es una opción (por ejemplo, al quitar o renombrar una opción en uso): un solo error que
    // los nombra a todos y dice cómo seguir.
    if (kind === 'enum' && Array.isArray(options)) {
      const bad = doc.objects.filter((d) => d.type === 'driver' && d.param === o.id && d.equals != null && !options.includes(d.equals));
      if (bad.length) {
        const example = `{ "op": "set", "target": "${bad[0].id}", "props": { "equals": ${JSON.stringify(options[0] ?? 'option')} } }`;
        errors.push(`param ${o.id} has options ${list(options)}, but ${bad.length === 1 ? 'driver' : 'drivers'} ${bad.map((d) => `${d.id}.equals "${d.equals}"`).join(', ')} ${bad.length === 1 ? 'uses a value' : 'use values'} that ${bad.length === 1 ? 'is' : 'are'} not among them. If you are removing or renaming an option, change ${bad.length === 1 ? 'that driver’s' : 'those drivers’'} equals in the same batch (for example ${example}) or delete ${bad.length === 1 ? 'it' : 'them'}; otherwise use one of the options.`);
      }
    }
  }
  // Lo de Live (fade, next, blend, auto) es de los clips de Puppet; una escena no se dispara en vivo.
  if (o.type === 'animation') {
    const puppet = read(schema, o, 'usage') === 'puppet';
    const [next, blend, auto, rmin, rmax] = ['next', 'blend', 'auto', 'repeat_min', 'repeat_max'].map((k) => read(schema, o, k));
    if (!puppet && (next != null || blend !== 'override' || auto !== 'off')) {
      const which = [next != null && 'next', blend !== 'override' && 'blend', auto !== 'off' && 'auto'].filter(Boolean).join(', ');
      errors.push(`${o.id}: ${which} only work in Puppet clips (played live), and "${o.id}" is a scene (Animate). Pass usage: "puppet", or leave ${which} at the default.`);
    }
    const target = next != null ? findObject(doc, next) : null;
    if (target?.type === 'animation') {
      if (read(schema, target, 'usage') !== 'puppet') errors.push(`${o.id}.next: "${next}" is a scene (Animate); next must be a Puppet clip.`);
      else if (read(schema, target, 'auto') !== 'off') errors.push(`${o.id}.next: "${next}" is an auto clip (${read(schema, target, 'auto')}), which plays by itself; next must be a clip the app plays.`);
    }
    if (puppet && next != null && auto !== 'off') errors.push(`${o.id}.next: "${o.id}" is an auto clip and plays by itself; next only works on clips the app plays. Remove next.`);
    else if (puppet && next != null && read(schema, o, 'loop') !== 'once') errors.push(`${o.id}.next: only once clips end, and "${o.id}" is ${read(schema, o, 'loop')}. Set loop: "once" or remove next.`);
    if (typeof rmin === 'number' && typeof rmax === 'number' && rmin > rmax) errors.push(`${o.id}: repeat_min (${rmin}) is greater than repeat_max (${rmax})`);
  }
  return errors;
}

function checkProperties(owner, obj, props, tipo, errors, warnings) {
  for (const prop of props) {
    const p = tipo.properties[prop];
    if (!p) {
      warnings.push(`${owner}: propiedad desconocida "${prop}" en ${tipo.name} (se conserva).${suggest(prop, Object.keys(tipo.properties))}`);
      continue;
    }
    const error = validateValue(p, obj[prop]);
    if (error) errors.push(`${owner}.${prop} ${error}`);
  }
}
