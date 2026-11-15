// The sugars a pose (set_pose) and a keyframe (set_keys) accept in their values, turned into plain values. Both are
// relative to the setup, so writing them twice gives the same pose:
//   - "+=n" / "-=n" on a number property: n more (or less) than in the setup.
//   - `transformPoints` on a vector layer (as in the setup's `set`): the named points moved, rotated or scaled from
//     where the setup has them; only the points (and the curves whose tangents change) go into the values.

import { findObject } from './document.js';
import { read } from './schema.js';
import { effectiveValue } from './styles.js';
import { meshChanges, transformPointsOf } from './meshTransform.js';

/** "+=14" or "-=2.5": a value relative to the setup one (number properties only). */
const RELATIVE = /^([+-])=\s*(\d+(?:\.\d+)?|\.\d+)$/;

/**
 * `values` ({ object_id: { property: value } }) with "+=n" and `transformPoints` resolved against the setup. `where`
 * names the values in the errors ("values", "keys[2].values").
 * @param {any} doc @param {any} schema @param {any} values @param {string} where
 * @returns {Record<string, Record<string, any>>}
 */
export function resolveValues(doc, schema, values, where) {
  /** @type {Record<string, Record<string, any>>} */
  const resolved = {};
  for (const [id, fields] of Object.entries(values ?? {})) {
    const own = { ...fields };
    const obj = findObject(doc, id);
    for (const [prop, v] of Object.entries(own)) {
      if (typeof v !== 'string' || !/^\s*[+-]=/.test(v)) continue;
      const m = v.match(RELATIVE);
      if (!m) throw new Error(`${where}.${id}.${prop}: "${v}" is not a relative value: write "+=n" or "-=n" with a positive number n (for example "+=140" or "-=140")`);
      if (!obj || obj.type === 'param' || schema.types.get(obj.type)?.properties[prop]?.type !== 'number') {
        throw new Error(`${where}.${id}.${prop}: "${v}" (relative to the setup) only works on number properties of objects${obj ? '' : ` and there is no object "${id}"`}`);
      }
      own[prop] = Math.round((effectiveValue(schema, doc, obj, prop) + (m[1] === '-' ? -1 : 1) * Number(m[2])) * 1e6) / 1e6;
    }
    if (own.transformPoints !== undefined) {
      if (obj?.type === 'shape') throw new Error(`${where}.${id}.transformPoints: it goes on the shape's layer: { "${obj.parent}": { "transformPoints": { "shape": "${id}", ... } } }`);
      if (obj?.type !== 'vector') throw new Error(`${where}.${id}.transformPoints only works on vector layers (vector)${obj ? `, not on ${obj.type}` : `: there is no object "${id}"`}`);
      const setup = { points: read(schema, obj, 'points') ?? {}, curves: read(schema, obj, 'curves') ?? {} };
      let moved;
      try {
        moved = transformPointsOf(doc, obj, own.transformPoints, setup);
      } catch (e) {
        throw new Error(`${where}.${id}.${e.message}`);
      }
      delete own.transformPoints;
      // Only what changed goes into the pose or keyframe.
      const { points, curves } = meshChanges(moved, setup);
      if (points) own.points = { ...points, ...own.points };
      if (curves) own.curves = { ...curves, ...own.curves };
    }
    resolved[id] = own;
  }
  return resolved;
}
