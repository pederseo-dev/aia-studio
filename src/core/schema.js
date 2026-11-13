// Esquema: las definiciones de schema/*.json resueltas (herencia incluida). Es la fuente única de verdad de qué tipos
// existen y qué propiedades tienen; de aquí salen la validación, el inspector del editor y la guía para la IA.

import { SAME_TIME, curveError } from './curves.js';
import { vertexErrors } from './paths.js';

const PROPERTY_TYPES = new Set(['number', 'string', 'strings', 'boolean', 'color', 'enum', 'ref', 'asset', 'vertices', 'stops', 'pose', 'tracks']);
const POSE_ID = /^[a-z][a-z0-9_]*$/;
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Nombre de un archivo de la carpeta assets/ del documento (ver src/core/imagenes.js): sin carpetas ni rarezas.
export const ASSET_FILE = /^[a-z0-9][a-z0-9_.-]*\.(png|jpg|jpeg|webp|svg)$/;

/** @param {object[]} defs contenido de schema/*.json */
export function createSchema(defs) {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const resolved = new Map();

  const resolve = (name, chain = []) => {
    if (resolved.has(name)) return resolved.get(name);
    const def = byName.get(name);
    if (!def) throw new Error(`Esquema: el tipo "${chain.at(-1)}" extiende un tipo inexistente "${name}"`);
    if (chain.includes(name)) throw new Error(`Esquema: herencia circular en ${[...chain, name].join(' → ')}`);
    const base = def.extends ? resolve(def.extends, [...chain, name]) : null;
    for (const [prop, p] of Object.entries(def.properties ?? {})) {
      if (!PROPERTY_TYPES.has(p.type)) throw new Error(`Esquema: ${name}.${prop} tiene un tipo desconocido "${p.type}"`);
      if (p.type === 'enum' && !Array.isArray(p.values)) throw new Error(`Esquema: ${name}.${prop} es enum y necesita values`);
    }
    const kind = {
      name: name,
      description: def.description ?? '',
      // `description` (en español) es para la guía de la IA; `help` (en inglés) es lo que muestra el editor.
      help: def.help ?? '',
      abstract: !!def.abstract,
      container: def.container ?? base?.container ?? false,
      // Recurso: vive en la raíz, no se dibuja y otros objetos lo usan por referencia (estilos, degradados).
      resource: def.resource ?? base?.resource ?? false,
      // Restricciones de jerarquía: qué tipos puede tener como padre (además de la raíz, salvo con requiresParent) y
      // como hijos.
      parentTypes: def.parentTypes ?? base?.parentTypes ?? null,
      childTypes: def.childTypes ?? base?.childTypes ?? null,
      // Si es true, no puede estar en la raíz (los huesos van siempre dentro de un skeleton).
      requiresParent: def.requiresParent ?? base?.requiresParent ?? false,
      ancestors: base ? [base.name, ...base.ancestors] : [],
      properties: { ...base?.properties, ...def.properties },
    };
    resolved.set(name, kind);
    return kind;
  };

  for (const d of defs) resolve(d.name);
  const meta = resolved.get('meta');
  if (!meta) throw new Error('Esquema: falta schema/meta.json');
  const types = new Map([...resolved].filter(([n, t]) => n !== 'meta' && !t.abstract));
  return { meta, types };
}

/** Devuelve un mensaje de error si el valor no sirve para la propiedad, o null si está bien. */
export function validateValue(p, value) {
  if (value === null) return p.nullable ? null : 'no puede ser null';
  switch (p.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `debe ser un número (recibido ${JSON.stringify(value)})`;
      if (p.integer && !Number.isInteger(value)) return 'debe ser un entero';
      if (p.min != null && value < p.min) return `debe ser ≥ ${p.min}`;
      if (p.max != null && value > p.max) return `debe ser ≤ ${p.max}`;
      return null;
    case 'string':
      return typeof value === 'string' ? null : 'debe ser texto';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'debe ser true o false';
    case 'color':
      return typeof value === 'string' && COLOR.test(value) ? null : `debe ser un color "#rrggbb" (recibido ${JSON.stringify(value)})`;
    case 'enum':
      return p.values.includes(value) ? null : `debe ser uno de: ${p.values.join(', ')}`;
    case 'ref':
      return typeof value === 'string' ? null : 'debe ser el id de un objeto';
    case 'asset':
      return typeof value === 'string' && ASSET_FILE.test(value) ? null : `must be the file name of an asset of the document, like "sun.png" (lowercase; .png, .jpg, .webp or .svg; received ${JSON.stringify(value)})`;
    case 'vertices': {
      if (!Array.isArray(value)) return 'debe ser una lista de vértices';
      const errors = value.flatMap((v, i) => vertexErrors(v).map((e) => `[${i}] ${e}`));
      return errors.length ? errors.slice(0, 5).join('; ') + (errors.length > 5 ? ` (y ${errors.length - 5} más)` : '') : null;
    }
    case 'stops': {
      if (!Array.isArray(value) || !value.length) return 'debe ser una lista de paradas [{ offset, color }]';
      for (const [i, s] of value.entries()) {
        if (typeof s?.offset !== 'number' || s.offset < 0 || s.offset > 1) return `[${i}].offset debe ser un número de 0 a 1`;
        if (typeof s.color !== 'string' || !COLOR.test(s.color)) return `[${i}].color debe ser "#rrggbb"`;
        if (s.opacity !== undefined && (typeof s.opacity !== 'number' || s.opacity < 0 || s.opacity > 1)) return `[${i}].opacity debe ser de 0 a 1`;
        if (i && s.offset < value[i - 1].offset) return 'las paradas deben ir en orden de offset';
      }
      return null;
    }
    case 'strings':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && v) ? null : 'debe ser una lista de textos ["a", "b"]';
    case 'pose': {
      // Solo la forma: qué objetos y propiedades valen lo revisa el documento, que conoce los tipos.
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'debe ser un objeto { id_de_objeto: { propiedad: valor } }';
      for (const [id, fields] of Object.entries(value)) {
        if (!POSE_ID.test(id)) return `"${id}" no es un id válido`;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return `${id} debe ser un objeto { propiedad: valor }`;
      }
      return null;
    }
    case 'tracks': {
      // Solo la forma: qué objetos, propiedades y valores valen lo revisa el documento, que conoce los tipos y la
      // duración.
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
  return 'tipo de propiedad desconocido';
}

/** Valor efectivo de una propiedad: el guardado o, si no está, el valor por defecto del esquema. */
export function read(schema, obj, prop) {
  if (obj[prop] !== undefined) return obj[prop];
  return (schema.types.get(obj.type) ?? schema.meta).properties[prop]?.default;
}

export function readMeta(schema, doc, prop) {
  return doc.meta[prop] !== undefined ? doc.meta[prop] : schema.meta.properties[prop]?.default;
}

/** Sugerencia para nombres mal escritos: el más parecido a distancia ≤ 2, o uno que sea prefijo del otro. */
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
  return best ? ` ¿Quisiste decir "${best}"?` : '';
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
