// Mesh of a vector layer (as in Moho): points by id and curves that go through them. Shapes (children of the layer)
// fill and stroke curves. A point used by two curves welds them.
//
//   points: { p1: { x, y }, chin: { x, y, bone: 'jaw_bone' } }
//   curves: { c1: { closed: true, points: ['p1', { p: 'chin', mode: 'mirrored', angle: 0, dist: 20 }, 'p3'] } }
//
// A curve entry is a point id (a corner) or { p, ...tangents } with the same fields as a path vertex (see paths.js)
// without x/y: the tangents belong to the point on that curve, so two curves through a point can bend differently.
// The per-point binding (`bone`) belongs to the point, like in Moho.

import { blendVertices, parseD, tangents, transformVertices, vertexErrors } from './paths.js';

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

/**
 * Ids of the points a shape "has": the points its curves go through and, with `loops`, the points of its loops.
 * @param {Record<string, any>} curves @param {string[] | undefined} curveIds @param {any[]} [loops]
 */
export function shapePointIds(curves, curveIds, loops = []) {
  return [...new Set([...(curveIds ?? []).flatMap((id) => curvePointIds(curves?.[id])), ...(loops ?? []).flatMap((l) => (Array.isArray(l) ? l.map((e) => loopEntryOf(e).p) : []))])];
}

// ---------- Loops: regions bounded by segments of welded curves ----------
//
// A shape fills whole curves (`curves`) and/or `loops`: each loop goes around a region through point ids, and between
// two consecutive points (and from the last back to the first) it follows the curve that joins them there, with that
// curve's tangents. So a lens bounded by two arcs welded at both ends is the loop ["a", "b"]: from a to b along one
// arc, back along the other. An entry { p, via } names the curve to follow from the previous point when several join
// them. The region follows the curves when their points or tangents move (poses, keyframes, bones).

/** A loop entry as an object: "p1" → { p: "p1" }. */
export const loopEntryOf = (e) => (typeof e === 'string' ? { p: e } : e);

/** Shape errors of a loops value (empty list if it is fine). That the points and curves exist is checked by the document. */
export function loopsErrors(value) {
  if (!Array.isArray(value)) return ['must be a list of loops: [["p1", "p2", "p3"]]'];
  const errors = [];
  value.forEach((loop, i) => {
    if (!Array.isArray(loop) || loop.length < 2) return void errors.push(`[${i}] must be a list of at least 2 point ids, around the region`);
    loop.forEach((e, j) => {
      if (typeof e === 'string') return void (MESH_ID.test(e) || errors.push(`[${i}][${j}]: "${e}" is not a valid point id`));
      if (!isMap(e) || typeof e.p !== 'string') return void errors.push(`[${i}][${j}] must be a point id or { p: point_id, via: curve_id }`);
      for (const k of Object.keys(e)) if (!['p', 'via'].includes(k)) errors.push(`[${i}][${j}]: field "${k}" does not belong in a loop entry (fields: p, via)`);
      if (e.via !== undefined && typeof e.via !== 'string') errors.push(`[${i}][${j}].via must be a curve id`);
    });
  });
  return errors;
}

/**
 * The curve segments a loop follows: [{ curve, from, to, forward, span }] with the indices in that curve's points
 * (to = from ± 1, or across the closing span of a closed curve), whether it goes the curve's way and which span it
 * is (span k joins point k and the next). Each step tries the curve's way first. Each segment is used once per loop, so two curves joining the same
 * two points (a lens) give both sides. Returns { segments } or { error } (a point no curve joins to the next).
 * @param {Record<string, any>} curves @param {any[]} loop
 */
export function resolveLoop(curves, loop) {
  const entries = loop.map(loopEntryOf);
  const used = new Set();
  const segments = [];
  for (let step = 1; step <= entries.length; step++) {
    const k = step % entries.length;
    const a = entries[step - 1].p;
    const { p: b, via } = entries[k];
    let found = null;
    for (const [id, curve] of Object.entries(curves ?? {})) {
      if (via !== undefined && id !== via) continue;
      const ids = curvePointIds(curve);
      const n = ids.length;
      for (let i = 0; i < n && !found; i++) {
        if (ids[i] !== a) continue;
        // Span k goes from point k to the next one: forward from i is span i, back from i is span i − 1 (on a closed
        // curve they wrap, so a closed curve of 2 points has two spans between the same points).
        const forward = i + 1 < n ? i + 1 : curve.closed ? 0 : -1;
        const back = i > 0 ? i - 1 : curve.closed ? n - 1 : -1;
        /** @type {[number, number, boolean][]} */
        const options = [[forward, i, true], [back, back, false]];
        for (const [to, span, isForward] of options) {
          if (to < 0 || ids[to] !== b) continue;
          const key = `${id}:${span}`;
          if (used.has(key)) continue;
          found = { curve: id, from: i, to, forward: isForward, span, key };
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      const by = via !== undefined ? ` along ${via}` : '';
      return { error: `no curve joins ${a} to ${b}${by} (consecutive points of a loop must be neighbors on a curve)` };
    }
    used.add(found.key);
    segments.push({ curve: found.curve, from: found.from, to: found.to, forward: found.forward, span: found.span });
  }
  return { segments };
}

/**
 * SVG path of a loop from its segments: `vertsOf(curve)` gives that curve's vertices (as curveVertices: positions and
 * tangents, already deformed in a pose). Each segment is drawn with the tangents it has on its curve, reversed when
 * the loop goes against the curve. (A rounded corner, `radius`, is drawn sharp here.)
 * @param {(curve: string) => any[]} vertsOf @param {{ curve: string, from: number, to: number, forward: boolean }[]} segments
 */
export function loopD(vertsOf, segments) {
  const f = (v) => +v.toFixed(3);
  let d = '';
  for (const { curve, from, to, forward } of segments) {
    const v = vertsOf(curve);
    const [a, b] = [v[from], v[to]];
    if (!a || !b) return '';
    const ta = tangents(a);
    const tb = tangents(b);
    const [c1, c2] = forward ? [ta.out, tb.in] : [ta.in, tb.out];
    if (!d) d = `M${f(a.x)} ${f(a.y)}`;
    d += `C${f(a.x + c1[0])} ${f(a.y + c1[1])} ${f(b.x + c2[0])} ${f(b.y + c2[1])} ${f(b.x)} ${f(b.y)}`;
  }
  return d ? `${d}Z` : '';
}

/** Ids of the curves the loops of a shape follow (unresolvable loops add none). */
export function loopCurveIds(curves, loops) {
  return [...new Set((loops ?? []).flatMap((loop) => (Array.isArray(loop) ? (resolveLoop(curves, loop).segments ?? []).map((s) => s.curve) : [])))];
}

/**
 * A key of the region a shape (or a region found at a point) covers: its curves and the curve spans of its loops,
 * in any order. Two equal keys fill the same area.
 * @param {Record<string, any>} curves @param {{ curves?: string[], loops?: any[] }} region
 */
export function regionKey(curves, { curves: ids = [], loops = [] }) {
  const loopKeys = (loops ?? []).map((l) => (resolveLoop(curves, l).segments ?? []).map((s) => `${s.curve}:${s.span}`).sort().join('+')).sort();
  return [[...(ids ?? [])].sort().join(), ...loopKeys].join('|');
}

/** Every curve a shape uses: its own and the ones its loops follow (what deleting it must not leave unused). */
export const shapeCurveIds = (curves, shape) => [...new Set([...(shape?.curves ?? []), ...loopCurveIds(curves, shape?.loops)])];

/**
 * The curves the picked points close, as Moho's Create Shape: every point of the curve is picked. `closedOnly` keeps
 * the closed ones (what a fill needs). The points of an inner curve picked too add it, and it cuts a hole.
 * @param {Record<string, any>} curves @param {Iterable<string>} pointIds @param {{ closedOnly?: boolean }} [options]
 */
export function curvesOfPoints(curves, pointIds, { closedOnly = false } = {}) {
  const picked = new Set(pointIds);
  return Object.entries(curves ?? {})
    .filter(([, c]) => (!closedOnly || c.closed) && c.points?.length && curvePointIds(c).every((p) => picked.has(p)))
    .map(([id]) => id);
}

/** Ids of the curves of a mesh that no shape fills or strokes (`used`: the curve ids the shapes list). */
export function looseCurves(curves, used) {
  const taken = new Set(used);
  return Object.keys(curves ?? {}).filter((id) => !taken.has(id));
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
