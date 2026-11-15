// Schema: the definitions of schema/*.json resolved (inheritance included). It is the single source of truth for
// which types exist and which properties they have; validation, the editor inspector and the AI guide come from here.

import { SAME_TIME, curveError } from './curves.js';
import { vertexErrors } from './paths.js';
import { pointsErrors, curvesErrors } from './mesh.js';

const PROPERTY_TYPES = new Set(['number', 'string', 'strings', 'boolean', 'color', 'enum', 'ref', 'asset', 'vertices', 'points', 'curves', 'stops', 'pose', 'tracks']);
const POSE_ID = /^[a-z][a-z0-9_]*$/;
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Name of a file in the document's assets/ folder (see src/core/images.js): no folders or oddities.
export const ASSET_FILE = /^[a-z0-9][a-z0-9_.-]*\.(png|jpg|jpeg|webp|svg)$/;

/** @param {object[]} defs content of schema/*.json */
export function createSchema(defs) {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const resolved = new Map();

  const resolve = (name, chain = []) => {
    if (resolved.has(name)) return resolved.get(name);
    const def = byName.get(name);
    if (!def) throw new Error(`Schema: type "${chain.at(-1)}" extends a nonexistent type "${name}"`);
    if (chain.includes(name)) throw new Error(`Schema: circular inheritance in ${[...chain, name].join(' → ')}`);
    const base = def.extends ? resolve(def.extends, [...chain, name]) : null;
    for (const [prop, p] of Object.entries(def.properties ?? {})) {
      if (!PROPERTY_TYPES.has(p.type)) throw new Error(`Schema: ${name}.${prop} has an unknown type "${p.type}"`);
      if (p.type === 'enum' && !Array.isArray(p.values)) throw new Error(`Schema: ${name}.${prop} is enum and needs values`);
    }
    const kind = {
      name: name,
      description: def.description ?? '',
      // `description` (in Spanish) is for the AI guide; `help` (in English) is what the editor shows.
      help: def.help ?? '',
      abstract: !!def.abstract,
      container: def.container ?? base?.container ?? false,
      // Asset: it lives at the root, is not drawn and other objects use it by reference (styles, gradients).
      resource: def.resource ?? base?.resource ?? false,
      // Hierarchy constraints: which types it can have as parent (besides the root, except with requiresParent) and
      // as children.
      parentTypes: def.parentTypes ?? base?.parentTypes ?? null,
      childTypes: def.childTypes ?? base?.childTypes ?? null,
      // If true, it cannot be at the root (bones always go inside a skeleton).
      requiresParent: def.requiresParent ?? base?.requiresParent ?? false,
      ancestors: base ? [base.name, ...base.ancestors] : [],
      properties: { ...base?.properties, ...def.properties },
    };
    resolved.set(name, kind);
    return kind;
  };

  for (const d of defs) resolve(d.name);
  const meta = resolved.get('meta');
  if (!meta) throw new Error('Schema: schema/meta.json is missing');
  const types = new Map([...resolved].filter(([n, t]) => n !== 'meta' && !t.abstract));
  return { meta, types };
}

/** Returns an error message if the value is not valid for the property, or null if it is fine. */
export function validateValue(p, value) {
  if (value === null) return p.nullable ? null : 'cannot be null';
  switch (p.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `must be a number (received ${JSON.stringify(value)})`;
      if (p.integer && !Number.isInteger(value)) return 'must be an integer';
      if (p.min != null && value < p.min) return `must be ≥ ${p.min}`;
      if (p.max != null && value > p.max) return `must be ≤ ${p.max}`;
      return null;
    case 'string':
      return typeof value === 'string' ? null : 'must be text';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'color':
      return typeof value === 'string' && COLOR.test(value) ? null : `must be a color "#rrggbb" (received ${JSON.stringify(value)})`;
    case 'enum':
      return p.values.includes(value) ? null : `must be one of: ${p.values.join(', ')}`;
    case 'ref':
      return typeof value === 'string' ? null : 'must be the id of an object';
    case 'asset':
      return typeof value === 'string' && ASSET_FILE.test(value) ? null : `must be the file name of an asset of the document, like "sun.png" (lowercase; .png, .jpg, .webp or .svg; received ${JSON.stringify(value)})`;
    case 'vertices': {
      if (!Array.isArray(value)) return 'must be a list of vertices';
      const errors = value.flatMap((v, i) => vertexErrors(v).map((e) => `[${i}] ${e}`));
      return errors.length ? errors.slice(0, 5).join('; ') + (errors.length > 5 ? ` (and ${errors.length - 5} more)` : '') : null;
    }
    case 'points':
    case 'curves': {
      const errors = (p.type === 'points' ? pointsErrors : curvesErrors)(value);
      return errors.length ? errors.slice(0, 5).join('; ') + (errors.length > 5 ? ` (and ${errors.length - 5} more)` : '') : null;
    }
    case 'stops': {
      if (!Array.isArray(value) || !value.length) return 'must be a list of stops [{ offset, color }]';
      for (const [i, s] of value.entries()) {
        if (typeof s?.offset !== 'number' || s.offset < 0 || s.offset > 1) return `[${i}].offset must be a number from 0 to 1`;
        if (typeof s.color !== 'string' || !COLOR.test(s.color)) return `[${i}].color must be "#rrggbb"`;
        if (s.opacity !== undefined && (typeof s.opacity !== 'number' || s.opacity < 0 || s.opacity > 1)) return `[${i}].opacity must be from 0 to 1`;
        if (i && s.offset < value[i - 1].offset) return 'stops must be in order of offset';
      }
      return null;
    }
    case 'strings':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && v) ? null : 'must be a list of texts ["a", "b"]';
    case 'pose': {
      // Only the shape: which objects and properties are valid is checked by the document, which knows the types.
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be an object { object_id: { property: value } }';
      for (const [id, fields] of Object.entries(value)) {
        if (!POSE_ID.test(id)) return `"${id}" is not a valid id`;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return `${id} must be an object { property: value }`;
      }
      return null;
    }
    case 'tracks': {
      // Only the shape: which objects, properties and values are valid is checked by the document, which knows the
      // types and the duration.
      const example = '{ object_id: { property: [ { "t": 0, "value": 10 } ] } }';
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `must be an object ${example}`;
      for (const [id, fields] of Object.entries(value)) {
        if (!POSE_ID.test(id)) return `"${id}" is not a valid id`;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return `${id} must be an object { property: [keyframes] }`;
        for (const [prop, keys] of Object.entries(fields)) {
          if (!Array.isArray(keys)) return `${id}.${prop} must be a list of keyframes [ { "t": 0, "value": … } ]`;
          for (const [i, k] of keys.entries()) {
            if (!k || typeof k !== 'object' || Array.isArray(k)) return `${id}.${prop}[${i}] must be a keyframe { "t": seconds, "value": … }`;
            if (typeof k.t !== 'number' || !Number.isFinite(k.t)) return `${id}.${prop}[${i}].t must be a number of seconds`;
            if (!('value' in k)) return `${id}.${prop}[${i}] needs a value`;
            if (i && k.t - keys[i - 1].t < SAME_TIME) return `${id}.${prop}: keyframes must be in order of t and at least ${SAME_TIME * 1000} ms apart (t ${k.t} after ${keys[i - 1].t})`;
            const curve = curveError(k.ease);
            if (curve) return `${id}.${prop}[${i}]: ${curve}`;
          }
        }
      }
      return null;
    }
  }
  return 'unknown property type';
}

/** Effective value of a property: the saved one or, if absent, the schema's default value. */
export function read(schema, obj, prop) {
  if (obj[prop] !== undefined) return obj[prop];
  return (schema.types.get(obj.type) ?? schema.meta).properties[prop]?.default;
}

export function readMeta(schema, doc, prop) {
  return doc.meta[prop] !== undefined ? doc.meta[prop] : schema.meta.properties[prop]?.default;
}

/** Suggestion for misspelled names: the closest one at distance ≤ 2, or one that is a prefix of the other. */
export function suggest(value, options) {
  let best = null;
  let bestDistance = 3;
  const a = String(value).toLowerCase();
  for (const option of options) {
    const b = String(option).toLowerCase();
    const prefix = Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));
    const d = prefix ? 1 : distance(a, b);
    if (d < bestDistance) [best, bestDistance] = [option, d];
  }
  return best ? ` Did you mean "${best}"?` : '';
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const top = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = top;
    }
  }
  return row[b.length];
}
