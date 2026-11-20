// Hide Edge: stretches of a part's stroke that are not drawn (hiddenEdges, see points.js), as batches of plain
// operations for the editor's Hide Edge tool and `aia edge` alike. A stretch is one a part draws between two vertices
// next to each other: for an element, between two of its points; for a shape that follows a line, between two points
// of that line. Its two points are named first when they have no name (as Create Shape does), since a hidden edge is
// the pair of their names.

import { findObject } from './document.js';
import { nearestOnOutline } from './geometry.js';
import { hiddenFlags, pointOf, stretchEnds, strokedOutlines, withEdge } from './points.js';
import { WeldError, namedRefs, vertexOps } from './weld.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {import('./points.js').StrokedOutline} StrokedOutline
 * @typedef {import('./weld.js').PointAt} PointAt
 * @typedef {{ part: string, hole: number, index: number }} Stretch a drawn stretch: of which outline (hole, or -1
 *   for the part's own) and which one (from vertex `index` to the next)
 */

/** @param {Doc} doc @param {string} id */
function needPart(doc, id) {
  const part = findObject(doc, id);
  if (!part || part.type !== 'path') throw new WeldError(`there is no part "${id}"`);
  return part;
}

/** @param {DocObject} part @param {number} hole */
const outlineOf = (part, hole) => strokedOutlines(part).find((o) => o.hole === hole);

/**
 * Whether a drawn stretch is hidden.
 * @param {Doc} doc resolved @param {Stretch} stretch
 */
export function isHidden(doc, { part: id, hole, index }) {
  const part = needPart(doc, id);
  const outline = outlineOf(part, hole);
  return !!outline && !!hiddenFlags(part, outline)[index];
}

/**
 * The batch that hides or shows a drawn stretch, naming the points at its ends that have no name.
 * @param {Doc} doc resolved @param {Stretch} stretch @param {boolean} hide
 * @returns {{ ops: Operation[], edge: [string, string], named: string[] }} named: the points that got a name
 */
export function edgeOps(doc, { part: id, hole, index }, hide) {
  const part = needPart(doc, id);
  const outline = outlineOf(part, hole);
  const count = outline ? stretchEnds(outline).length : 0;
  if (!outline || index < 0 || index >= count) throw new WeldError(`${id} draws no stretch ${index}${hole >= 0 ? ` in hole ${hole}` : ''}`);
  const n = outline.points.length;
  const ends = [outline.points[index], outline.points[(index + 1) % n]];
  /** @type {PointAt[]} */
  const unnamed = [];
  for (const end of ends) {
    if (end.id) continue;
    if (!end.at) throw new WeldError(`that stretch is in a hole of ${id} between points of the hole’s own, which take no names: weld the hole to a line first`);
    unnamed.push(end.at);
  }
  const { refs, changes } = namedRefs(doc, unnamed);
  let named = 0;
  const edge = /** @type {[string, string]} */ (ends.map((end) => end.id ?? refs[named++]));
  const was = hiddenFlags(part, outline)[index];
  if (was === hide) throw new WeldError(`the stretch ${edge[0]} – ${edge[1]} of ${id} is ${hide ? 'hidden' : 'shown'} already`);
  return { ops: [...vertexOps(changes), { op: 'set', target: id, props: { hiddenEdges: withEdge(part, edge, hide) } }], edge, named: refs };
}

/**
 * The drawn stretch of a part between two points, by the points' names (part.point or part.index: a shared vertex
 * stands for the point it shares, so a shape's stretch is named by its line's points).
 * @param {Doc} doc resolved @param {string} id the part @param {PointAt} a @param {PointAt} b from pointsNamed
 * @returns {Stretch}
 */
export function stretchBetweenPoints(doc, id, a, b) {
  const part = needPart(doc, id);
  /** @param {import('./points.js').DrawnPoint} p @returns {string | null} which vertex owns it, as "part:index" */
  const owner = (p) => {
    const shared = p.id ? pointOf(doc, p.id) : null;
    if (shared) return `${shared.part.id}:${shared.index}`;
    return p.at ? `${p.at.part}:${p.at.index}` : null;
  };
  const want = new Set([`${a.part}:${a.index}`, `${b.part}:${b.index}`]);
  for (const outline of strokedOutlines(part)) {
    const n = outline.points.length;
    const count = stretchEnds(outline).length;
    for (let index = 0; index < count; index++) {
      const ends = new Set([owner(outline.points[index]), owner(outline.points[(index + 1) % n])]);
      if (want.size === 2 && [...want].every((w) => ends.has(w))) return { part: id, hole: outline.hole, index };
    }
  }
  throw new WeldError(`${id} draws no stretch between these two points: they must be next to each other along its stroke (for a shape, points of the line it follows)`);
}

/**
 * The drawn stretch of a part nearest a place, within `reach`, or null.
 * @param {DocObject} part resolved @param {{ x: number, y: number }} p in its layer's coordinates @param {number} reach
 * @returns {(Stretch & { distance: number }) | null}
 */
export function stretchNear(part, p, reach) {
  /** @type {(Stretch & { distance: number }) | null} */
  let best = null;
  for (const outline of strokedOutlines(part)) {
    const hit = nearestOnOutline(/** @type {DocObject} */ ({ id: part.id, type: 'path', parent: part.parent, vertices: outline.vertices, closed: outline.closed }), p);
    if (hit && hit.distance <= reach && (!best || hit.distance < best.distance)) best = { part: part.id, hole: outline.hole, index: hit.segment, distance: hit.distance };
  }
  return best;
}

/**
 * The vertices of a drawn stretch, for showing it (from vertex `index` to the next).
 * @param {DocObject} part resolved @param {Stretch} stretch
 */
export function stretchVertices(part, { hole, index }) {
  const outline = outlineOf(part, hole);
  if (!outline || index < 0 || index >= stretchEnds(outline).length) return [];
  const n = outline.vertices.length;
  return [outline.vertices[index], outline.vertices[(index + 1) % n]];
}

/**
 * Every hidden stretch a part has, for showing them.
 * @param {DocObject} part resolved
 * @returns {Stretch[]}
 */
export function hiddenStretches(part) {
  return strokedOutlines(part).flatMap((outline) => hiddenFlags(part, outline).flatMap((h, index) => (h ? [{ part: part.id, hole: outline.hole, index }] : [])));
}
