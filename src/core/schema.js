// The schema: the definitions in schema/*.json, resolved (inheritance included). It is the single source of truth for
// which types exist and which properties they have; validation, the editor and the AI's help come from here. The
// core never reads files: Node (server/schema.js) and the editor (import.meta.glob) load the JSON and pass it in.

/**
 * @typedef {{
 *   type: 'string' | 'number' | 'boolean' | 'color' | 'vertices' | 'pointGroups',
 *   default: unknown, nullable?: boolean, min?: number, max?: number,
 *   description: string, help: string,
 * }} PropertySpec
 * @typedef {{
 *   name: string, extends?: string, abstract?: boolean, childTypes?: string[],
 *   description: string, help: string, properties?: Record<string, PropertySpec>,
 * }} TypeDefinition
 * @typedef {{
 *   name: string, abstract: boolean, childTypes: string[], description: string, help: string,
 *   properties: Record<string, PropertySpec>,
 * }} ResolvedType
 * @typedef {Map<string, ResolvedType>} Schema
 */

/**
 * @param {TypeDefinition[]} definitions
 * @returns {Schema}
 */
export function resolveSchema(definitions) {
  const byName = new Map(definitions.map((d) => [d.name, d]));
  /** @type {Schema} */
  const schema = new Map();
  /** @param {string} name @param {string[]} seen @returns {ResolvedType} */
  const resolve = (name, seen) => {
    if (schema.has(name)) return schema.get(name);
    const definition = byName.get(name);
    if (!definition) throw new Error(`Unknown type "${name}" in the schema`);
    if (seen.includes(name)) throw new Error(`The schema extends in a circle: ${[...seen, name].join(' → ')}`);
    const base = definition.extends ? resolve(definition.extends, [...seen, name]) : null;
    const type = {
      name,
      abstract: !!definition.abstract,
      childTypes: definition.childTypes ?? [],
      description: definition.description,
      help: definition.help,
      properties: { ...base?.properties, ...definition.properties },
    };
    schema.set(name, type);
    return type;
  };
  for (const definition of definitions) resolve(definition.name, []);
  return schema;
}

import { ID } from './document.js';
import { POINT_REF, groupsError } from './points.js';

const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Why a value does not fit a property, or null if it does.
 * @param {PropertySpec} spec
 * @param {unknown} value
 */
export function valueError(spec, value) {
  if (value === null) return spec.nullable ? null : 'cannot be empty (null)';
  switch (spec.type) {
    case 'string':
      return typeof value === 'string' ? null : 'must be text';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'color':
      return typeof value === 'string' && COLOR.test(value) ? null : 'must be a color like "#ff8800"';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (spec.min !== undefined && value < spec.min) return `must be at least ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `must be at most ${spec.max}`;
      return null;
    case 'vertices':
      return verticesError(value);
    case 'pointGroups':
      return groupsError(value);
    default:
      return `has an unknown property type "${spec.type}"`;
  }
}

/** @param {unknown} value */
const isPoint = (value) =>
  !!value &&
  typeof value === 'object' &&
  Object.keys(value).every((k) => k === 'x' || k === 'y') &&
  Number.isFinite(/** @type {any} */ (value).x) &&
  Number.isFinite(/** @type {any} */ (value).y);

/** @param {unknown} value */
function verticesError(value) {
  if (!Array.isArray(value)) return 'must be a list of vertices [{ x, y }]';
  for (const [i, vertex] of value.entries()) {
    if (!vertex || typeof vertex !== 'object') return `vertex ${i} must be { x, y }`;
    const { x, y, in: before, out: after, name, ref, follow, way, ...rest } = vertex;
    const extra = Object.keys(rest);
    if (extra.length) return `vertex ${i} has unknown fields: ${extra.join(', ')} (fields: x, y, in, out, name, ref, follow, way)`;
    if (follow !== undefined && (typeof follow !== 'string' || !ID.test(follow))) return `vertex ${i}: "follow" must be the id of a part, like "jaw"`;
    if (way !== undefined && (way !== 'long' || follow === undefined)) return `vertex ${i}: "way" can only be "long", next to "follow"`;
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !POINT_REF.test(ref)) return `vertex ${i}: "ref" must name a point of another part, like "jaw.chin"`;
      if (x !== undefined || y !== undefined) return `vertex ${i} shares "${ref}", so it has no x, y of its own (it is where that point is)`;
      if (name !== undefined) return `vertex ${i} shares "${ref}", so it takes no name of its own (use "${ref}")`;
    } else if (!Number.isFinite(x) || !Number.isFinite(y)) return `vertex ${i} needs numbers x and y`;
    if (name !== undefined && (typeof name !== 'string' || !ID.test(name))) {
      return `vertex ${i}: a point name is lowercase letters, digits and _, starting with a letter`;
    }
    if (before !== undefined && !isPoint(before)) return `vertex ${i}: "in" must be { x, y } relative to the vertex`;
    if (after !== undefined && !isPoint(after)) return `vertex ${i}: "out" must be { x, y } relative to the vertex`;
  }
  return null;
}
