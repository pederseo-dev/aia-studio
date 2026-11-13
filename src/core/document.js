// Document: flat list of objects with `parent`. The order of the list defines the drawing order among siblings
// (the last ones end up on top).

import { FORMAT } from './format.js';
import { read, suggest, validateValue } from './schema.js';

export const ID = /^[a-z][a-z0-9_]*$/;
// "meta" names the document properties in set/unset (target: "meta"): no object can be called that.
export const RESERVED_IDS = new Set(['meta']);
const STRUCTURE = new Set(['id', 'type', 'parent']);

/** Why a new id is not valid (null if it is). */
export function idError(id) {
  if (!ID.test(id ?? '')) return `invalid id "${id}": use lowercase letters, digits and _, starting with a letter`;
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

/** Whether the object or one of its parents is locked (`locked`): on the canvas it cannot be picked or moved. */
export function locked(doc, id) {
  for (let o = findObject(doc, id); o; o = o.parent ? findObject(doc, o.parent) : null) if (o.locked) return true;
  return false;
}

/** Children of an object (or of the root with null), in drawing order. */
export function children(doc, parent) {
  return doc.objects.filter((o) => (o.parent ?? null) === parent);
}

/** Ids of the object and all its descendants. */
export function subtree(doc, id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) for (const h of children(doc, ids[i])) ids.push(h.id);
  return ids;
}

/**
 * The skeleton that contains an object: its nearest ancestor of type skeleton (not counting itself), or null.
 * For a bone, it is the skeleton it belongs to.
 */
export function skeletonOf(doc, id) {
  for (let o = findObject(doc, findObject(doc, id)?.parent); o; o = findObject(doc, o.parent)) if (o.type === 'skeleton') return o.id;
  return null;
}

/** Bones of a skeleton (its own, not those of a nested skeleton), in list order. */
export function bonesOf(doc, skeletonId) {
  return doc.objects.filter((o) => o.type === 'bone' && skeletonOf(doc, o.id) === skeletonId);
}

/**
 * Why an object cannot be bound to a bone (null if it can): the bone has to belong to the skeleton that contains
 * it. `owner` is the name for the message (for example "arm.bone" or "tail.vertices[3].bone").
 */
export function bindingError(doc, objId, boneId, owner) {
  const bone = findObject(doc, boneId);
  const all = doc.objects.filter((h) => h.type === 'bone').map((h) => h.id);
  if (!bone) return `${owner}: bone "${boneId}" does not exist.${suggest(boneId, all)}`;
  if (bone.type !== 'bone') return `${owner}: "${boneId}" is a ${bone.type}, not a bone`;
  const own = skeletonOf(doc, objId);
  const fromBone = skeletonOf(doc, boneId);
  if (own === fromBone) return null;
  if (!own) return `${owner}: "${boneId}" is a bone of skeleton "${fromBone}" and ${objId} is not inside any skeleton. An object can only be bound to bones of its own skeleton: put it inside "${fromBone}" (move) or remove the binding.`;
  const ownBones = bonesOf(doc, own).map((h) => h.id);
  return `${owner}: "${boneId}" is a bone of skeleton "${fromBone}", but ${objId} is in skeleton "${own}" and can only be bound to its bones: ${ownBones.join(', ') || 'it has none yet'}.${suggest(boneId, ownBones)}`;
}

/** Properties that are not structural (id, type, parent). */
export function savedProperties(obj) {
  return Object.keys(obj).filter((k) => !STRUCTURE.has(k));
}

/**
 * Checks the whole document against the schema.
 * Errors prevent saving; warnings do not (unknown properties are kept so as not to lose data from future
 * versions, but they are usually typos).
 */
export function validate(doc, schema) {
  const errors = [];
  const warnings = [];
  if (doc?.format !== FORMAT) errors.push(`format must be "${FORMAT}"`);
  if (!doc?.meta || typeof doc.meta !== 'object') errors.push('meta is missing');
  if (!Array.isArray(doc?.objects)) errors.push('the objects list is missing');
  if (errors.length) return { errors, warnings };

  checkProperties('meta', doc.meta, Object.keys(doc.meta), schema.meta, errors, warnings);

  const ids = new Set();
  for (const o of doc.objects) {
    if (idError(o?.id)) {
      errors.push(idError(o?.id));
      continue;
    }
    if (ids.has(o.id)) errors.push(`repeated id "${o.id}"`);
    ids.add(o.id);
  }

  for (const o of doc.objects) {
    const kind = schema.types.get(o.type);
    if (!kind) {
      errors.push(`${o.id}: unknown type "${o.type}".${suggest(o.type, schema.types.keys())} Types: ${[...schema.types.keys()].join(', ')}`);
      continue;
    }
    if (kind.resource && o.parent != null) errors.push(`${o.id}: it is an asset (${o.type}) and goes at the root (parent: null)`);
    else if (o.parent == null && kind.requiresParent) {
      const skeletons = doc.objects.filter((x) => x.type === 'skeleton').map((x) => x.id);
      const track = skeletons.length ? ` Skeletons in the document: ${skeletons.join(', ')}.` : ' First create a skeleton (the bone layer, which also contains the drawing it moves) and put the bone inside it.';
      errors.push(`${o.id}: a ${o.type} cannot be at the root: it goes inside ${kind.parentTypes.join(' or ')}.${track} (Documents from before skeletons are converted with npm run migrate.)`);
    } else if (o.parent != null) {
      const parent = findObject(doc, o.parent);
      if (!parent) errors.push(`${o.id}: parent "${o.parent}" does not exist.${suggest(o.parent, ids)}`);
      else if (!schema.types.get(parent.type)?.container) errors.push(`${o.id}: its parent "${o.parent}" is a ${parent.type} and cannot have children (use a group)`);
      else if (kind.parentTypes && !kind.parentTypes.includes(parent.type)) errors.push(`${o.id}: a ${o.type} can only be ${kind.requiresParent ? '' : 'at the root or '}inside ${kind.parentTypes.join(' or ')} (its parent "${o.parent}" is a ${parent.type})`);
      else if (schema.types.get(parent.type).childTypes && !schema.types.get(parent.type).childTypes.includes(o.type)) {
        const track = parent.type === 'bone' ? `; the drawing goes inside the skeleton (${skeletonOf(doc, parent.id) ?? 'the one of that bone'}), not inside the bone: put it there and bind it with the bone property` : '';
        errors.push(`${o.id}: a ${parent.type} can only have ${schema.types.get(parent.type).childTypes.join(' or ')} children and "${o.id}" is a ${o.type}${track}`);
      }
    }
    checkProperties(o.id, o, savedProperties(o), kind, errors, warnings);
    errors.push(...controlErrors(doc, schema, o));
    for (const [prop, p] of Object.entries(kind.properties)) {
      if (p.type !== 'ref' || o[prop] == null) continue;
      errors.push(...referenceErrors(doc, o, prop, p, o[prop], o.id));
    }
    // Vertices bound to a bone (per-point binding) name bones of their skeleton.
    for (const [prop, p] of Object.entries(kind.properties)) {
      if (p.type !== 'vertices' || !Array.isArray(o[prop])) continue;
      o[prop].forEach((v, i) => {
        if (v?.bone == null) return;
        const error = bindingError(doc, o.id, v.bone, `${o.id}.${prop}[${i}].bone`);
        if (error) errors.push(error);
      });
    }
    // Poses name objects that exist and animatable properties of theirs, with valid values.
    for (const [prop, p] of Object.entries(kind.properties)) {
      if (p.type !== 'pose' || !o[prop] || typeof o[prop] !== 'object' || Array.isArray(o[prop])) continue;
      for (const [id, fields] of Object.entries(o[prop])) {
        const target = findObject(doc, id);
        if (!target) {
          errors.push(`${o.id}.${prop}: object "${id}" does not exist.${suggest(id, ids)}`);
          continue;
        }
        const props = schema.types.get(target.type)?.properties ?? {};
        const animatable = Object.keys(props).filter((k) => props[k].animatable);
        for (const [k, v] of Object.entries(fields ?? {})) {
          if (!props[k]?.animatable) {
            errors.push(`${o.id}.${prop}.${id}.${k}: ${target.type} has no animatable "${k}". Animatable: ${animatable.join(', ')}.${suggest(k, animatable)}`);
            continue;
          }
          const error = validateValue(props[k], v);
          if (error) errors.push(`${o.id}.${prop}.${id}.${k} ${error}`);
          else if (props[k].type === 'ref') errors.push(...referenceErrors(doc, target, k, props[k], v, `${o.id}.${prop}.${id}`, { pose: o.id }));
        }
      }
    }
    // The tracks of a clip: like poses, plus params (which animate their value) and times within the duration.
    for (const [prop, p] of Object.entries(kind.properties)) {
      if (p.type !== 'tracks' || validateValue(p, o[prop] ?? {})) continue;
      const duration = read(schema, o, 'duration');
      for (const [id, fields] of Object.entries(o[prop] ?? {})) {
        const target = findObject(doc, id);
        if (!target) {
          errors.push(`${o.id}.${prop}: object "${id}" does not exist.${suggest(id, ids)}`);
          continue;
        }
        // Params belong to the puppet: only a Puppet clip animates them. A scene keys the values themselves.
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

  // Cycles: going up through the parents must never return to the starting point.
  for (const o of doc.objects) {
    const seen = new Set([o.id]);
    for (let p = findObject(doc, o.parent); p; p = findObject(doc, p.parent)) {
      if (seen.has(p.id)) {
        errors.push(`parent cycle: ${[...seen].join(' → ')} → ${p.id}`);
        break;
      }
      seen.add(p.id);
    }
  }
  return { errors, warnings };
}

/**
 * What values a track of `target.prop` accepts: returns a validator (value → message or null), or a message if that
 * property cannot be animated. A param animates its `value` (number, 0/1 or one of its options).
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
 * Errors of a reference: that it exists, that it is of the requested type and, with refScope "children", that it is
 * a child; with refScope "skeleton", that it is a bone of the skeleton that contains the object.
 */
function referenceErrors(doc, o, prop, p, value, owner, { pose: poseId = null, clip = null, t = null } = {}) {
  if (value == null) return [];
  if (p.refScope === 'skeleton') {
    const error = bindingError(doc, o.id, value, `${owner}.${prop}`);
    return error ? [error] : [];
  }
  const referenced = findObject(doc, value);
  if (!referenced) return [`${owner}.${prop}: object "${value}" does not exist.${suggest(value, doc.objects.map((x) => x.id))}`];
  if (p.refTypes && !p.refTypes.includes(referenced.type)) return [`${owner}.${prop}: "${value}" is a ${referenced.type}; expected ${p.refTypes.join(' or ')}`];
  if (p.refScope === 'children' && referenced.parent !== o.id) {
    const children = doc.objects.filter((x) => x.parent === o.id).map((x) => x.id);
    // The most common case: taking out of the switch a variant that a pose picks. The message says how to proceed.
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
 * Consistency of params and drivers: an enum param with initial outside its options, a numeric param with
 * min > max, or a driver with equals that is not an option of its param.
 */
function controlErrors(doc, schema, o) {
  const errors = [];
  const list = (options) => (options?.length ? options.map((x) => `"${x}"`).join(', ') : 'none yet');
  if (o.type === 'param') {
    const [kind, options, min, max] = ['kind', 'options', 'min', 'max'].map((k) => read(schema, o, k));
    if (kind === 'enum' && o.initial != null && Array.isArray(options) && !options.includes(o.initial)) errors.push(`${o.id}.initial "${o.initial}" is not one of its options: ${list(options)}`);
    if (Array.isArray(options) && new Set(options).size !== options.length) errors.push(`${o.id}.options has repeated options: ${list(options)}`);
    if (kind !== 'enum' && typeof min === 'number' && typeof max === 'number' && min > max) errors.push(`${o.id}: min (${min}) is greater than max (${max})`);
    // Drivers whose equals is not an option (for example, when removing or renaming an option in use): a single error
    // that names them all and says how to proceed.
    if (kind === 'enum' && Array.isArray(options)) {
      const bad = doc.objects.filter((d) => d.type === 'driver' && d.param === o.id && d.equals != null && !options.includes(d.equals));
      if (bad.length) {
        const example = `{ "op": "set", "target": "${bad[0].id}", "props": { "equals": ${JSON.stringify(options[0] ?? 'option')} } }`;
        errors.push(`param ${o.id} has options ${list(options)}, but ${bad.length === 1 ? 'driver' : 'drivers'} ${bad.map((d) => `${d.id}.equals "${d.equals}"`).join(', ')} ${bad.length === 1 ? 'uses a value' : 'use values'} that ${bad.length === 1 ? 'is' : 'are'} not among them. If you are removing or renaming an option, change ${bad.length === 1 ? 'that driver’s' : 'those drivers’'} equals in the same batch (for example ${example}) or delete ${bad.length === 1 ? 'it' : 'them'}; otherwise use one of the options.`);
      }
    }
  }
  // The Live settings (fade, next, blend, auto) belong to Puppet clips; a scene is not triggered live.
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

function checkProperties(owner, obj, props, kind, errors, warnings) {
  for (const prop of props) {
    const p = kind.properties[prop];
    if (!p) {
      warnings.push(`${owner}: unknown property "${prop}" in ${kind.name} (kept).${suggest(prop, Object.keys(kind.properties))}`);
      continue;
    }
    const error = validateValue(p, obj[prop]);
    if (error) errors.push(`${owner}.${prop} ${error}`);
  }
}
