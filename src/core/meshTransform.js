// Transform Points (as in Moho) on a vector layer: which points a `transformPoints` names, and the mesh with them
// moved, rotated or scaled. The same function serves the setup (an operation `set` on the layer, see operations.js)
// and the poses and keyframes (relative to the setup, see poseValues.js).

import { findObject, children } from './document.js';
import { suggest } from './schema.js';
import { pointsCenter, pointsMatrix, shapePointIds, transformMesh } from './mesh.js';

const FIELDS = ['shape', 'points', 'translate', 'rotate', 'scale', 'origin'];

/**
 * The mesh { points, curves } of `layer` (a vector) with `t` applied: { shape | points, translate, rotate, scale,
 * origin }. `base` is the mesh it starts from (the layer's setup by default). Throws an error that says what to fix.
 * @param {any} doc @param {any} layer @param {any} t @param {{ points: any, curves: any }} base
 */
export function transformPointsOf(doc, layer, t, base) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('transformPoints must be an object { shape or points, translate, rotate, scale, origin }');
  for (const k of Object.keys(t)) if (!FIELDS.includes(k)) throw new Error(`transformPoints: unknown field "${k}" (fields: ${FIELDS.join(', ')})`);
  if (t.shape !== undefined && t.points !== undefined) throw new Error('transformPoints takes "shape" or "points", not both: for a shape and more points, list all the points');
  const pair = (k, v) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`transformPoints.${k} must be [x, y] (numbers)`);
    return v;
  };
  if (t.rotate !== undefined && (typeof t.rotate !== 'number' || !Number.isFinite(t.rotate))) throw new Error('transformPoints.rotate must be a number of degrees');
  const { points, curves } = base;
  let ids;
  if (t.shape !== undefined) {
    const shape = findObject(doc, t.shape);
    if (shape?.type !== 'shape' || shape.parent !== layer.id) {
      const own = children(doc, layer.id).filter((o) => o.type === 'shape').map((o) => o.id);
      throw new Error(`transformPoints.shape: "${t.shape}" is not a shape of layer ${layer.id} (${own.join(', ') || 'none'}).${suggest(t.shape, own)}`);
    }
    ids = shapePointIds(curves, shape.curves, shape.loops);
    if (!ids.length) throw new Error(`transformPoints: shape ${t.shape} has no points (no curves): there is nothing to transform`);
  } else if (Array.isArray(t.points) && t.points.length) {
    const missing = t.points.filter((id) => !(id in points));
    if (missing.length) throw new Error(`transformPoints.points: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not in ${layer.id}.points (${Object.keys(points).join(', ') || 'none'})`);
    ids = t.points;
  } else throw new Error('transformPoints needs "shape" (a shape of the layer) or "points" (a list of point ids)');
  const origin = pair('origin', t.origin) ?? pointsCenter(points, ids) ?? [0, 0];
  const m = pointsMatrix({ translate: pair('translate', t.translate), rotate: t.rotate, scale: pair('scale', t.scale), origin });
  return transformMesh(points, curves, ids, m);
}

/**
 * What a transform changed, to write into a pose or keyframe: the points (without the setup's per-point bones, which
 * are not posed) and the curves that differ from `before`. Empty maps are left out.
 * @param {{ points: any, curves: any }} moved @param {{ points: any, curves: any }} before
 */
export function meshChanges(moved, before) {
  const changed = (map, was) => Object.entries(map).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(was[k]));
  const points = Object.fromEntries(changed(moved.points, before.points).map(([k, { bone, ...pt }]) => [k, pt]));
  const curves = Object.fromEntries(changed(moved.curves, before.curves));
  /** @type {{ points?: any, curves?: any }} */
  const fields = {};
  if (Object.keys(points).length) fields.points = points;
  if (Object.keys(curves).length) fields.curves = curves;
  return fields;
}
