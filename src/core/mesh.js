// Mesh of a vector layer (as in Moho): points by id and curves that go through them. Shapes (children of the layer)
// fill and stroke curves. A point used by two curves welds them.
//
//   points: { p1: { x, y }, chin: { x, y, bone: 'jaw_bone' } }
//   curves: { c1: { closed: true, points: ['p1', { p: 'chin', mode: 'mirrored', angle: 0, dist: 20 }, 'p3'] } }
//
// A curve entry is a point id (a corner) or { p, ...tangents } with the same fields as a path vertex (see paths.js)
// without x/y: the tangents belong to the point on that curve, so two curves through a point can bend differently.
// The per-point binding (`bone`) belongs to the point, like in Moho.

import { blendVertices, parseD, transformVertices, vertexErrors } from './paths.js';

export const MESH_ID = /^[a-z][a-z0-9_]*$/;
const WELD = 0.01; // px: `d` reuses an existing point this close

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const r2 = (v) => Math.round(v * 100) / 100 || 0;

/** An entry as an object: "p1" → { p: "p1" }. */
export const entryOf = (e) => (typeof e === 'string' ? { p: e } : e);

/** Point ids a curve goes through, in order. */
export const curvePointIds = (curve) => (curve?.points ?? []).map((e) => entryOf(e).p);

/** Shape errors of a points map (empty list if it is fine). Which bones exist is checked by the document. */
export function pointsErrors(value) {
  if (!isMap(value)) return ['must be an object { point_id: { x, y } }'];
  const errors = [];
  for (const [id, pt] of Object.entries(value)) {
    if (!MESH_ID.test(id)) errors.push(`"${id}" is not a valid point id (lowercase letters, digits and _, starting with a letter)`);
    else if (!isMap(pt)) errors.push(`${id} must be an object { x, y }`);
    else {
      for (const k of Object.keys(pt)) if (!['x', 'y', 'bone'].includes(k)) errors.push(`${id}: field "${k}" does not belong in a point (fields: x, y, bone)`);
      for (const k of ['x', 'y']) if (typeof pt[k] !== 'number' || !Number.isFinite(pt[k])) errors.push(`${id}.${k} is missing (number)`);
      if (pt.bone !== undefined && (typeof pt.bone !== 'string' || !pt.bone)) errors.push(`${id}.bone must be the id of a bone`);
    }
  }
  return errors;
}

/** Shape errors of a curves map. That the points exist is checked by the document (it knows the layer). */
export function curvesErrors(value) {
  if (!isMap(value)) return ['must be an object { curve_id: { closed, points: [...] } }'];
  const errors = [];
  for (const [id, curve] of Object.entries(value)) {
    if (!MESH_ID.test(id)) {
      errors.push(`"${id}" is not a valid curve id (lowercase letters, digits and _, starting with a letter)`);
      continue;
    }
    if (!isMap(curve)) {
      errors.push(`${id} must be an object { closed, points: [...] }`);
      continue;
    }
    for (const k of Object.keys(curve)) if (!['closed', 'points'].includes(k)) errors.push(`${id}: field "${k}" does not belong in a curve (fields: closed, points)`);
    if (curve.closed !== undefined && typeof curve.closed !== 'boolean') errors.push(`${id}.closed must be true or false`);
    if (!Array.isArray(curve.points) || curve.points.length < 2) {
      errors.push(`${id}.points must be a list of at least 2 entries (point ids, or { p, mode, ... } with tangents)`);
      continue;
    }
    curve.points.forEach((e, i) => {
      const owner = `${id}.points[${i}]`;
      if (typeof e === 'string') return void (MESH_ID.test(e) || errors.push(`${owner}: "${e}" is not a valid point id`));
      if (!isMap(e) || typeof e.p !== 'string') return void errors.push(`${owner} must be a point id or { p: point_id, mode, ... }`);
      if (e.bone !== undefined) return void errors.push(`${owner}: bone goes on the point (points.${e.p}.bone), not on the curve`);
      if ('x' in e || 'y' in e) return void errors.push(`${owner}: x/y go on the point (points.${e.p}), not on the curve`);
      const { p, ...rest } = e;
      for (const message of vertexErrors({ x: 0, y: 0, ...rest })) errors.push(`${owner} ${message.replace(/, and bone\)/, ', and p)').replace(/\(fields: x, y, /, '(fields: p, ')}`);
    });
  }
  return errors;
}

/**
 * The vertices (paths.js format) a curve draws, with each point's position and bone: the shape is drawn and
 * deformed with the same code as a path. Entries whose point does not exist are skipped.
 */
export function curveVertices(points, curve) {
  return (curve?.points ?? []).flatMap((e) => {
    const { p, ...t } = entryOf(e);
    const pt = points?.[p];
    if (!pt) return [];
    return [{ x: pt.x, y: pt.y, ...t, ...(pt.bone ? { bone: pt.bone } : {}) }];
  });
}

/** The curve entry for a point with the tangents of a vertex (a corner stays as the bare id). */
export function entryFromVertex(p, vertex) {
  const { x, y, bone, ...t } = vertex;
  return Object.keys(t).length ? { p, ...t } : p;
}

/** Point ids used by any curve. */
export function usedPoints(curves) {
  return new Set(Object.values(curves ?? {}).flatMap(curvePointIds));
}

/** The first free id `${prefix}N` in a map (and not in `taken`). */
export function freeKey(map, prefix, taken = new Set()) {
  for (let i = 1; ; i++) if (!(`${prefix}${i}` in map) && !taken.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/**
 * Adds the subpaths of an SVG `d` to a mesh as new curves (one per subpath), in the layer's coordinates. A new point
 * that falls on an existing one (of another curve) reuses it: the curves end up welded there. Returns the new maps
 * and the ids of the curves created.
 */
export function addD(points, curves, d) {
  const subpaths = parseD(d);
  if (!subpaths.length) throw new Error('d draws nothing');
  const P = { ...points };
  const C = { ...curves };
  const ids = [];
  for (const { closed, vertices } of subpaths) {
    const own = new Set();
    const entries = vertices.map((v) => {
      const found = Object.entries(P).find(([id, pt]) => !own.has(id) && Math.abs(pt.x - v.x) < WELD && Math.abs(pt.y - v.y) < WELD);
      const id = found ? found[0] : freeKey(P, 'p');
      if (!found) P[id] = { x: r2(v.x), y: r2(v.y) };
      own.add(id);
      return entryFromVertex(id, v);
    });
    const id = freeKey(C, 'c');
    C[id] = { closed, points: entries };
    ids.push(id);
  }
  return { points: P, curves: C, ids };
}

/**
 * The mesh without the curves no shape uses among `candidates`, and without the points no curve uses any more. It
 * is used when a shape's `d` replaces its curves, so the old ones do not stay behind.
 */
export function dropUnused(points, curves, candidates, usedByShapes) {
  const C = { ...curves };
  for (const id of candidates) if (!usedByShapes.has(id)) delete C[id];
  const used = usedPoints(C);
  const before = usedPoints(curves);
  const P = Object.fromEntries(Object.entries(points).filter(([id]) => used.has(id) || !before.has(id)));
  return { points: P, curves: C };
}

// ---------- Bones inside property values (vertices of a path, points of a mesh) ----------

/** [owner suffix, bone] of each entry of a value bound per point. */
export function boundEntries(p, value) {
  if (p.type === 'vertices' && Array.isArray(value)) return value.flatMap((v, i) => (v?.bone != null ? [[`[${i}]`, v.bone]] : []));
  if (p.type === 'points' && isMap(value)) return Object.entries(value).flatMap(([id, pt]) => (pt?.bone != null ? [[`.${id}`, pt.bone]] : []));
  return [];
}

/**
 * The value with its per-point bones changed: `change(bone)` returns the new bone, or undefined to release it.
 * Returns the same value if nothing changes.
 */
export function mapBones(p, value, change) {
  if (!boundEntries(p, value).length) return value;
  let changed = false;
  const one = (v) => {
    if (v?.bone == null) return v;
    const bone = change(v.bone);
    if (bone === v.bone) return v;
    changed = true;
    const { bone: _, ...rest } = v;
    return bone === undefined ? rest : { ...rest, bone };
  };
  const created = Array.isArray(value) ? value.map(one) : Object.fromEntries(Object.entries(value).map(([id, pt]) => [id, one(pt)]));
  return changed ? created : value;
}

/** The value without per-point bones (poses and keyframes do not store them: the binding belongs to the setup). */
export const withoutBones = (p, value) => mapBones(p, value, () => undefined);

/** Property types whose value is a map by id that poses and keyframes write partially. */
export const isMeshType = (type) => type === 'points' || type === 'curves';

/**
 * The value of a pose (or keyframe) over the setup's: what it lists replaces the setup's, the rest stays. Points keep
 * the setup's bone.
 */
export function overSetup(type, setup, posed) {
  if (!isMap(posed)) return setup;
  const result = { ...setup };
  for (const [id, v] of Object.entries(posed)) {
    if (!(id in (setup ?? {}))) continue;
    if (type === 'points') {
      const { bone, ...pt } = v;
      result[id] = setup[id].bone ? { ...pt, bone: setup[id].bone } : pt;
    } else result[id] = v;
  }
  return result;
}

/** Why a pose or keyframe value does not fit the layer's setup (null if it fits): ids it does not have, or a curve with other points. */
export function meshValueError(type, setup, value) {
  if (!isMap(value)) return null;
  const known = Object.keys(setup ?? {});
  const unknown = Object.keys(value).filter((id) => !(id in (setup ?? {})));
  if (unknown.length) return `${unknown.join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not in the layer's ${type} (${known.join(', ') || 'none'}). A pose or keyframe only moves what the setup has: if this batch removes them from the layer (a new points or curves map), take them out of this pose or keyframe in the same batch; if they are new, add them to the setup first`;
  if (type === 'curves') {
    for (const [id, curve] of Object.entries(value)) {
      if (curvePointIds(curve).join() !== curvePointIds(setup[id]).join()) return `curve ${id} must go through the same points as in the setup (${curvePointIds(setup[id]).join(', ')}); a pose or keyframe only changes its tangents`;
    }
  }
  return null;
}

/** Points of a map (whole or partial, as in a pose) shifted by (dx, dy), keeping their bones. */
export function shiftPoints(points, dx, dy) {
  if (!isMap(points)) return points;
  return Object.fromEntries(Object.entries(points).map(([id, pt]) => [id, { ...pt, x: r2(pt.x + dx), y: r2(pt.y + dy) }]));
}

/** Ids of the points the curves of a shape go through (the points a shape "has"). */
export function shapePointIds(curves, curveIds) {
  return [...new Set((curveIds ?? []).flatMap((id) => curvePointIds(curves?.[id])))];
}

/** Center of the box of some points ([x, y]), or null if there are none. */
export function pointsCenter(points, ids) {
  const list = ids.map((id) => points?.[id]).filter(Boolean);
  if (!list.length) return null;
  const xs = list.map((p) => p.x);
  const ys = list.map((p) => p.y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/**
 * Matrix of a points transform, as in Moho's Transform Points: scale, then rotate (degrees, clockwise), both around
 * `origin`, then translate. All in the layer's coordinates.
 */
export function pointsMatrix({ translate = [0, 0], rotate = 0, scale = [1, 1], origin = [0, 0] }) {
  const r = (rotate * Math.PI) / 180;
  const [c, s] = [Math.cos(r), Math.sin(r)];
  const [sx, sy] = scale;
  const [a, b, cc, d] = [c * sx, s * sx, -s * sy, c * sy];
  const [ox, oy] = origin;
  return [a, b, cc, d, ox + translate[0] - (a * ox + cc * oy), oy + translate[1] - (b * ox + d * oy)];
}

/**
 * The mesh with the points `ids` transformed by the matrix m: their positions, and their tangents on every curve
 * (rotated and scaled with them, so the shape keeps its look). The other points stay; a curve that also goes
 * through them stretches.
 */
export function transformMesh(points, curves, ids, m) {
  const chosen = new Set(ids);
  const linear = [m[0], m[1], m[2], m[3], 0, 0];
  const P = { ...points };
  for (const id of chosen) {
    const pt = points[id];
    if (pt) P[id] = { ...pt, x: r2(m[0] * pt.x + m[2] * pt.y + m[4]), y: r2(m[1] * pt.x + m[3] * pt.y + m[5]) };
  }
  const C = {};
  for (const [id, curve] of Object.entries(curves)) {
    C[id] = {
      ...curve,
      points: curve.points.map((e) => {
        const { p, ...t } = entryOf(e);
        if (!chosen.has(p) || !Object.keys(t).length) return e;
        return entryFromVertex(p, transformVertices([{ x: 0, y: 0, ...t }], linear)[0]);
      }),
    };
  }
  return { points: P, curves: C };
}

// ---------- Interpolation ----------

/** Points of two maps by the weight w: the ones in both are interpolated; the others are kept as they are. */
export function blendPoints(a, b, w) {
  if (!isMap(a) || !isMap(b)) return w >= 0.5 ? b : a;
  const result = { ...a };
  for (const [id, q] of Object.entries(b)) {
    const p = a[id];
    result[id] = p ? { x: r2(p.x + (q.x - p.x) * w), y: r2(p.y + (q.y - p.y) * w) } : (({ bone, ...rest }) => rest)(q);
  }
  return result;
}

/** Curves of two maps by the weight w: the tangents of the ones with the same points are interpolated. */
export function blendCurves(a, b, w) {
  if (!isMap(a) || !isMap(b)) return w >= 0.5 ? b : a;
  const result = { ...a };
  for (const [id, cb] of Object.entries(b)) {
    const ca = a[id];
    if (!ca || curvePointIds(ca).join() !== curvePointIds(cb).join()) {
      result[id] = w >= 0.5 || !ca ? cb : ca;
      continue;
    }
    // The anchors do not matter here (they are the points): the tangents are blended at (0, 0).
    const asVertices = (c) => c.points.map((e) => ({ x: 0, y: 0, ...(({ p, ...t }) => t)(entryOf(e)) }));
    const blended = blendVertices(asVertices(ca), asVertices(cb), w);
    result[id] = { ...(w >= 0.5 ? cb : ca), points: blended.map((v, i) => entryFromVertex(entryOf(ca.points[i]).p, v)) };
  }
  return result;
}

// ---------- Basic shapes as `d` (the editor's Rectangle and Ellipse tools; the AI can write the same `d`) ----------

const f = (v) => +v.toFixed(2);

/** Rectangle from its corner and size, as an SVG path (4 corner points). */
export const rectD = (x, y, w, h) => `M${f(x)} ${f(y)} H${f(x + w)} V${f(y + h)} H${f(x)} Z`;

/** Ellipse from its center and radii, as an SVG path (4 points with mirrored tangents). */
export const ellipseD = (cx, cy, rx, ry) => `M${f(cx - rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 1 ${f(cx + rx)} ${f(cy)} A${f(rx)} ${f(ry)} 0 1 1 ${f(cx - rx)} ${f(cy)} Z`;
