// Bind Points (as in Moho): which bone each point of a vector layer (or vertex of a loose path) follows. One function
// for the editor's Bind Points tool and the MCP's bind_points: all the points spread among the nearest bones, or only
// some (a shape, a list) to the bones given (one bone = all to it), or released.

import { findObject, children } from './document.js';
import { read, suggest } from './schema.js';
import { shapePointIds } from './mesh.js';
import { distributeBetweenBones } from './skeleton.js';

/**
 * The points of a drawing that can each follow a bone: [key, { x, y, bone? }], where the key is the point's id in a
 * vector layer and the vertex index (as text) in a path. Other types have none.
 * @param {any} schema @param {any} o
 */
export function bindablePoints(schema, o) {
  if (o?.type === 'vector') return Object.entries(read(schema, o, 'points') ?? {});
  if (o?.type === 'path') return read(schema, o, 'vertices').map((v, i) => [String(i), v]);
  return [];
}

/**
 * The batch that binds points of `layerId` and the split "bone [points]". `bones`: the bones to spread among (by
 * default, all of its skeleton). `points` (keys, see bindablePoints) or `shape` (of a vector layer) pick which points;
 * `release` takes the bone off them instead.
 * @param {any} doc @param {any} schema @param {string} layerId @param {string[]} [bones]
 * @param {{ points?: string[], shape?: string, release?: boolean }} [options]
 */
export function planBindPoints(doc, schema, layerId, bones, { points, shape, release = false } = {}) {
  const layer = findObject(doc, layerId);
  const type = layer?.type;
  if (type !== 'path' && type !== 'vector') throw new Error(`"${layerId}" is not a vector layer or a path`);
  const current = bindablePoints(schema, layer);
  const keys = current.map(([k]) => k);
  let chosen = null;
  if (points !== undefined && shape !== undefined) throw new Error('pass points or shape, not both');
  if (shape !== undefined) {
    const s = findObject(doc, shape);
    if (type !== 'vector' || s?.type !== 'shape' || s.parent !== layerId) {
      const shapes = children(doc, layerId).filter((o) => o.type === 'shape').map((o) => o.id);
      throw new Error(`"${shape}" is not a shape of ${layerId} (${shapes.join(', ') || 'none'}).${suggest(shape, shapes)}`);
    }
    chosen = shapePointIds(read(schema, layer, 'curves'), s.curves, s.loops);
  } else if (points !== undefined) {
    const missing = points.filter((k) => !keys.includes(String(k)));
    if (missing.length) throw new Error(`${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not in ${layerId}.${type === 'vector' ? 'points' : 'vertices'} (${keys.join(', ') || 'none'})`);
    chosen = points.map(String);
  }
  if (chosen && !chosen.length) throw new Error('no points to bind');
  const picked = (key) => !chosen || chosen.includes(key);
  /** @type {Map<string, any>} */
  const next = new Map(current);
  if (release) {
    for (const [k, v] of current) if (picked(k) && v.bone) next.set(k, (({ bone, ...rest }) => rest)(v));
  } else {
    const spread = distributeBetweenBones(doc, schema, layerId, bones);
    const entries = Array.isArray(spread) ? spread.map((v, i) => [String(i), v]) : Object.entries(spread);
    for (const [k, v] of entries) if (picked(k)) next.set(k, v);
  }
  const count = {};
  for (const [k, v] of next) if (picked(k) && v.bone) (count[v.bone] ??= []).push(k);
  const n = chosen?.length ?? keys.length;
  const distribution = release ? `released ${chosen ? chosen.join(', ') : 'all'}` : Object.entries(count).map(([h, ks]) => `${h} [${ks.join(', ')}]`).join('; ');
  const value = type === 'vector' ? Object.fromEntries(next) : [...next.values()];
  return { ops: [{ op: 'set', target: layerId, props: { [type === 'vector' ? 'points' : 'vertices']: value } }], distribution, count: n };
}
