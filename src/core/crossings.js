// Where the lines of a vector layer cross without a shared point, and welding them there (part 4 of docs/rebuild.md).
// A shape turns from one line onto another only at a point, as in Moho, so the editor's Create Shape shows a ring at
// each crossing (a click welds it) and `aia crossings` lists and welds them. The places are found on the lines'
// sampled stretches (fill.js), so a place is within a fraction of a unit.

import { findObject } from './document.js';
import { insertVertex, verticesOf } from './geometry.js';
import { TINY, lineStretches } from './fill.js';
import { weld } from './weld.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Point} Point
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {import('./fill.js').HalfEdge} HalfEdge
 */

const NEAR = 0.5; // units: a crossing this near a point of a line is at that point (or at a point they share)

/**
 * @typedef {{ x: number, y: number, a: { part: string, segment: number, t: number }, b: { part: string, segment: number, t: number } }} Crossing
 *   where two lines cross without a shared point: the stretch of each and how far along it (0 to 1)
 */

/** @type {WeakMap<Doc, Map<string, Crossing[]>>} */
const crossingCache = new WeakMap();

/**
 * Where the lines of a layer cross each other without a shared point (Moho needs a point there too, to turn from one
 * line onto the other). Found on the sampled curves, so a place is within a fraction of a unit.
 * @param {Doc} doc resolved @param {string} layer
 * @returns {Crossing[]}
 */
export function crossingsOf(doc, layer) {
  let byLayer = crossingCache.get(doc);
  if (!byLayer) crossingCache.set(doc, (byLayer = new Map()));
  const known = byLayer.get(layer);
  if (known) return known;
  const stretches = lineStretches(doc, layer).map((h) => ({ h, box: boxOf(h.points) }));
  /** @type {Crossing[]} */
  const found = [];
  for (let i = 0; i < stretches.length; i++) {
    for (let j = i + 1; j < stretches.length; j++) {
      const { h: p, box: pb } = stretches[i];
      const { h: q, box: qb } = stretches[j];
      if (p.part === q.part || pb.x1 < qb.x0 || qb.x1 < pb.x0 || pb.y1 < qb.y0 || qb.y1 < pb.y0) continue;
      // Where the two lines already share a point is not a crossing.
      const sharedAt = [
        ...(p.a === q.a || p.a === q.b ? [p.points[0]] : []),
        ...(p.b === q.a || p.b === q.b ? [p.points[p.points.length - 1]] : []),
      ];
      for (let k = 0; k + 1 < p.points.length; k++) {
        for (let m = 0; m + 1 < q.points.length; m++) {
          // Touching counts too (a line through the other's vertex), so the same place can come from two pieces.
          const hit = meet(p.points[k], p.points[k + 1], q.points[m], q.points[m + 1]);
          if (!hit || sharedAt.some((s) => Math.hypot(s.x - hit.x, s.y - hit.y) < NEAR)) continue;
          if (found.some((c) => c.a.part === p.part && c.b.part === q.part && Math.hypot(c.x - hit.x, c.y - hit.y) < NEAR)) continue;
          const tp = curveT(p, k, hit.u);
          const tq = curveT(q, m, hit.v);
          found.push({ x: hit.x, y: hit.y, a: { part: p.part, segment: p.from, t: tp }, b: { part: q.part, segment: q.from, t: tq } });
        }
      }
    }
  }
  byLayer.set(layer, found);
  return found;
}

/**
 * How far along its stretch (as the curve's parameter, which is what insertVertex takes) a place is, from the sample
 * piece it is on. A straight stretch is one piece drawn as a cubic with its controls at its ends, so its parameter is
 * not the fraction of its length: 3t² − 2t³ = that fraction.
 * @param {HalfEdge} h @param {number} piece @param {number} along 0 to 1 within the piece
 */
function curveT(h, piece, along) {
  if (h.points.length > 2) return (piece + along) / (h.points.length - 1);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) / 2;
    if (3 * t * t - 2 * t * t * t < along) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}

/** @param {Point[]} points */
function boxOf(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Where two segments cross or touch, and how far along each (0 to 1), or null (also when they are parallel). @param {Point} a @param {Point} b @param {Point} c @param {Point} d */
function meet(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < TINY) return null;
  const u = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const v = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  const edge = 1e-9;
  if (u < -edge || u > 1 + edge || v < -edge || v > 1 + edge) return null;
  return { x: a.x + u * rx, y: a.y + u * ry, u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) };
}


/**
 * The batch that welds two lines where they cross: a point on each (added, unless the crossing is at a point the
 * line already has), the second sharing the first's, as Moho's Add Point with auto weld on a crossing. Both lines
 * keep their shape.
 * @param {Doc} doc resolved @param {Crossing} crossing
 * @returns {{ ops: Operation[], note: string, added: { part: string, index: number }[] }} added: where points were
 *   added (the points after them moved up one place)
 */
export function weldCrossingOps(doc, crossing) {
  /** @param {{ part: string, segment: number, t: number }} on @returns {number | null} the point of the line it is at, if any */
  const pointAt = (on) => {
    const vertices = verticesOf(/** @type {DocObject} */ (findObject(doc, on.part)));
    const ends = [on.segment, (on.segment + 1) % vertices.length];
    return ends.find((i) => Math.hypot(vertices[i].x - crossing.x, vertices[i].y - crossing.y) < NEAR) ?? null;
  };
  const a = /** @type {DocObject} */ (findObject(doc, crossing.a.part));
  /** @type {{ part: string, index: number }[]} */
  const added = [];
  /** @type {Operation[]} */
  const ops = [];
  let index = pointAt(crossing.a);
  let withPoint = doc;
  if (index === null) {
    const inserted = insertVertex(a, crossing.a.segment, crossing.a.t);
    index = inserted.index;
    added.push({ part: a.id, index });
    ops.push({ op: 'set', target: a.id, props: { vertices: inserted.vertices } });
    withPoint = { ...doc, objects: doc.objects.map((o) => (o.id === a.id ? { ...a, vertices: inserted.vertices } : o)) };
  }
  // a's point goes onto b's line there (b gets a point, or uses the one it has) and shares it.
  const onB = pointAt(crossing.b);
  if (onB === null) added.push({ part: crossing.b.part, index: crossing.b.segment + 1 });
  const target = onB === null ? { part: crossing.b.part, segment: crossing.b.segment, t: crossing.b.t } : { part: crossing.b.part, index: onB };
  const welded = weld(withPoint, { part: a.id, index }, target);
  return { ops: [...ops, ...welded.ops], note: `Weld ${a.id} and ${crossing.b.part} where they cross`, added };
}
