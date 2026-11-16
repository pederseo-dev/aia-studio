// Regions of a vector layer's mesh, as Moho's Paint Bucket: what a click at a point fills (the area its closed
// curves enclose there, with the curves inside it as holes) or strokes (the curve under it). One function for the
// editor's Fill, Stroke and Both and for the AI's `create shape` with `at`. All in the layer's coordinates.

import { sampleSpan } from './paths.js';
import { curvePointIds, curveVertices } from './mesh.js';

/** @typedef {{ id: string, poly: number[][], area: number }} Ring */

/** A curve as a polyline (its bezier spans sampled), closed or open. */
export function curvePolyline(points, curve, steps = 12) {
  const vertices = curveVertices(points, curve);
  if (vertices.length < 2) return [];
  const spans = curve.closed ? vertices.length : vertices.length - 1;
  const out = [];
  for (let i = 0; i < spans; i++) for (const { p } of sampleSpan(vertices, i, steps).slice(i ? 1 : 0)) out.push(p);
  return out;
}

const shoelace = (poly) => Math.abs(poly.reduce((s, [x, y], i) => {
  const [u, v] = poly[(i + 1) % poly.length];
  return s + x * v - u * y;
}, 0)) / 2;

/**
 * Whether the point [x, y] is inside a closed polyline (even-odd).
 * @param {number[][]} poly @param {number[]} point
 */
export function insidePolyline(poly, point) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The closed curves of a mesh as rings (polyline and area): the holes regionIn can cut. */
export function closedRings(points, curves) {
  /** @type {Ring[]} */
  const rings = [];
  for (const [id, curve] of Object.entries(curves ?? {})) {
    if (!curve.closed) continue;
    const poly = curvePolyline(points, curve);
    if (poly.length >= 3) rings.push({ id, poly, area: shoelace(poly) });
  }
  return rings;
}

/** Whether ring a lies inside ring b (most of its samples: welded points on the edge count either way). */
const within = (a, b) => a !== b && a.area < b.area && a.poly.filter((p) => insidePolyline(b.poly, p)).length > a.poly.length / 2;

/**
 * @typedef {{ poly: number[][], area: number, edges: { curve: string, from: number, to: number, forward: boolean }[], whole: string | null }} Face
 * A bounded face of the mesh: its outline, its area, the curve spans around it and, if those are every span of one
 * closed curve, that curve.
 */

/**
 * The faces of a mesh: the areas its curves bound between the points where they are welded, as Moho's Paint Bucket
 * sees them (curves that cross without a shared point do not split an area). Each span of a curve (from one point to
 * the next) is an edge between two points; the faces are traced turning at each point to the next edge around it.
 * @returns {Face[]}
 */
export function meshFaces(points, curves, steps = 12) {
  /** @type {{ curve: string, from: number, to: number, forward: boolean, a: string, b: string, poly: number[][], twin?: any, angle?: number }[]} */
  const half = [];
  for (const [id, curve] of Object.entries(curves ?? {})) {
    const ids = curvePointIds(curve);
    const vertices = curveVertices(points, curve);
    if (vertices.length !== ids.length || ids.length < 2) continue;
    const n = ids.length;
    const spans = curve.closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
      const j = (i + 1) % n;
      const poly = sampleSpan(vertices, i, steps).map((s) => s.p);
      const forward = { curve: id, from: i, to: j, forward: true, a: ids[i], b: ids[j], poly };
      const back = { curve: id, from: j, to: i, forward: false, a: ids[j], b: ids[i], poly: [...poly].reverse() };
      forward.twin = back;
      back.twin = forward;
      half.push(forward, back);
    }
  }
  // Outgoing edges of each point, by the angle they leave it at.
  const out = new Map();
  for (const e of half) {
    const [p0] = e.poly;
    const p1 = e.poly.find((q) => Math.hypot(q[0] - p0[0], q[1] - p0[1]) > 1e-6) ?? e.poly.at(-1);
    e.angle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    if (!out.has(e.a)) out.set(e.a, []);
    out.get(e.a).push(e);
  }
  for (const list of out.values()) list.sort((u, v) => u.angle - v.angle);
  // Arriving at a point along e, the face goes on along the edge just before e's twin around that point.
  const next = (e) => {
    const list = out.get(e.b);
    const i = list.indexOf(e.twin);
    return list[(i - 1 + list.length) % list.length];
  };
  const seen = new Set();
  /** @type {Face[]} */
  const faces = [];
  for (const start of half) {
    if (seen.has(start)) continue;
    let cycle = [];
    for (let e = start; !seen.has(e); e = next(e)) {
      seen.add(e);
      cycle.push(e);
    }
    // Spikes (an open curve's loose end, walked there and back) are not part of the outline.
    for (let changed = true; changed && cycle.length; ) {
      changed = false;
      for (let k = 0; k < cycle.length; k++) {
        const l = (k + 1) % cycle.length;
        if (cycle.length > 1 && cycle[l] === cycle[k].twin) {
          cycle = cycle.filter((_, m) => m !== k && m !== l);
          changed = true;
          break;
        }
      }
    }
    if (cycle.length < 1) continue;
    const poly = cycle.flatMap((e) => e.poly.slice(0, -1));
    const signed = poly.reduce((t, [x, y], i) => {
      const [u, v] = poly[(i + 1) % poly.length];
      return t + x * v - u * y;
    }, 0) / 2;
    // The outside of each group of curves goes around the other way: only the bounded faces are kept.
    if (signed <= 1e-6) continue;
    const owners = new Set(cycle.map((e) => e.curve));
    const [only] = owners;
    const curve = curves[only];
    const whole = owners.size === 1 && curve.closed && cycle.length === curvePointIds(curve).length ? only : null;
    faces.push({ poly, area: signed, edges: cycle.map(({ curve, from, to, forward }) => ({ curve, from, to, forward })), whole });
  }
  return faces;
}

/**
 * The loop (shape.loops entry) that goes around a face: the point ids at the end of each of its edges, with `via` where
 * more than one curve joins the same two points.
 */
export function faceLoop(curves, face) {
  const ids = Object.fromEntries(Object.entries(curves).map(([id, c]) => [id, curvePointIds(c)]));
  const joins = (a, b) =>
    Object.entries(ids).filter(([id, list]) => list.some((p, i) => {
      const n = list.length;
      const neighbors = [list[i + 1], list[i - 1], ...(curves[id].closed ? [list[(i + 1) % n], list[(i - 1 + n) % n]] : [])];
      return p === a && neighbors.includes(b);
    })).length;
  // A loop tries each curve's own way first: around a closed curve of 2 points (both of its spans join the same
  // points) the face is written going that curve's way, so the right span is taken back.
  const twoPoint = (e) => curves[e.curve].closed && ids[e.curve].length === 2;
  const edges = face.edges.some((e) => twoPoint(e) && !e.forward)
    ? [...face.edges].reverse().map((e) => ({ curve: e.curve, from: e.to, to: e.from, forward: !e.forward }))
    : face.edges;
  return edges.map(({ curve, from, to }) => {
    const [a, b] = [ids[curve][from], ids[curve][to]];
    return joins(a, b) > 1 ? { p: b, via: curve } : b;
  });
}

/** @typedef {{ faces: Face[], rings: Ring[] }} Regions */

/** What regionIn looks in: the faces of a mesh and its closed curves (worth keeping while the mesh does not change). */
export const meshRegions = (points, curves) => ({ faces: meshFaces(points, curves), rings: closedRings(points, curves) });

/**
 * The region at a point, as a shape fills it: the smallest face around it and, as holes, the closed curves directly
 * inside that face which do not hold the point. A face that is a whole closed curve gives `curves` only; one bounded
 * by segments of welded curves gives a `loops` entry. null if no face is around the point.
 * @param {any} curves @param {Regions} regions @param {number[]} at
 * @returns {{ curves: string[], loops: any[][] } | null}
 */
export function regionIn(curves, regions, at) {
  const face = regions.faces.filter((f) => insidePolyline(f.poly, at)).sort((a, b) => a.area - b.area)[0];
  if (!face) return null;
  const own = new Set(face.edges.map((e) => e.curve));
  const outline = { id: '', poly: face.poly, area: face.area };
  const inner = regions.rings.filter((r) => !own.has(r.id) && within(r, outline) && !insidePolyline(r.poly, at));
  const holes = inner.filter((r) => !inner.some((o) => within(r, o))).map((h) => h.id);
  return face.whole ? { curves: [face.whole, ...holes], loops: [] } : { curves: holes, loops: [faceLoop(curves, face)] };
}

/** regionIn over the mesh itself. */
export const regionAt = (points, curves, at) => regionIn(curves, meshRegions(points, curves), at);

/** Distance from p to the segment ab. @param {number[]} p @param {number[]} a @param {number[]} b */
function segmentDistance(p, a, b) {
  const [[px, py], [ax, ay], [bx, by]] = [p, a, b];
  const [dx, dy] = [bx - ax, by - ay];
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The curve (open or closed) passing closest to `at`, within `tolerance`; null if none. */
export function curveNear(points, curves, at, tolerance) {
  let best = null;
  let bestDistance = tolerance;
  for (const [id, curve] of Object.entries(curves ?? {})) {
    const poly = curvePolyline(points, curve);
    const segments = curve.closed ? poly.length : poly.length - 1;
    for (let i = 0; i < segments; i++) {
      const d = segmentDistance(at, poly[i], poly[(i + 1) % poly.length]);
      if (d <= bestDistance) [best, bestDistance] = [id, d];
    }
  }
  return best;
}
