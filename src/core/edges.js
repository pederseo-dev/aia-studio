// Hide Edge: stretches of a part's stroke that are not drawn (hiddenEdges, see points.js), as batches of plain
// operations for the editor's Hide Edge tool and `aia edge` alike. A stretch is one a part draws between two vertices
// next to each other: for an element, between two of its points; for a shape that follows a line, between two points
// of that line. Its two points are named first when they have no name (as Create Shape does), since a hidden edge is
// the pair of their names.

import { findObject } from './document.js';
import { nearestOnOutline } from './geometry.js';
import { edgeKey, hiddenEdgesOf, pointOf, stretchEnds, strokedOutlines } from './points.js';
import { WeldError, namedRefs, vertexOps } from './weld.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {import('./points.js').DrawnPoint} DrawnPoint
 * @typedef {import('./points.js').Edge} Edge
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
const strokedOutline = (part, hole) => strokedOutlines(part).find((o) => o.hole === hole);

/**
 * Which stretches of an outline are hidden, one flag per stretch.
 * @param {DocObject} part @param {{ points: DrawnPoint[], closed: boolean }} outline
 */
export function hiddenFlags(part, outline) {
  const hidden = new Set(hiddenEdgesOf(part).map((e) => edgeKey(...e)));
  return stretchEnds(outline).map((e) => !!e && hidden.has(edgeKey(...e)));
}

/** Whether a part hides some stretch of its stroke. @param {DocObject} part resolved */
export const hidesEdges = (part) => hiddenEdgesOf(part).length > 0 && strokedOutlines(part).some((o) => hiddenFlags(part, o).some(Boolean));

/**
 * The hidden edges of a part with one stretch hidden or shown.
 * @param {DocObject} part @param {Edge} edge @param {boolean} hide
 * @returns {Edge[]}
 */
export function withEdge(part, edge, hide) {
  const key = edgeKey(...edge);
  const others = hiddenEdgesOf(part).filter((e) => edgeKey(...e) !== key);
  return hide ? [...others, edge] : others;
}

/** Whether a part hides every stretch of its stroke. @param {DocObject} part resolved */
export const hidesAll = (part) => hiddenEdgesOf(part).length > 0 && strokedOutlines(part).every((o) => hiddenFlags(part, o).every(Boolean));

/**
 * Whether a drawn stretch is hidden.
 * @param {Doc} doc resolved @param {Stretch} stretch
 */
export function isHidden(doc, { part: id, hole, index }) {
  const part = needPart(doc, id);
  const outline = strokedOutline(part, hole);
  return !!outline && !!hiddenFlags(part, outline)[index];
}

/**
 * The ends of a drawn stretch, as what each drawn vertex is, or why it is no stretch.
 * @param {Doc} doc resolved @param {Stretch} stretch
 */
function endsOf(doc, { part: id, hole, index }) {
  const part = needPart(doc, id);
  const outline = strokedOutline(part, hole);
  const count = outline ? stretchEnds(outline).length : 0;
  if (!outline || index < 0 || index >= count) throw new WeldError(`${id} draws no stretch ${index}${hole >= 0 ? ` in hole ${hole}` : ''}`);
  const n = outline.points.length;
  return { part, outline, ends: [outline.points[index], outline.points[(index + 1) % n]] };
}

/**
 * The batch that hides or shows a drawn stretch, naming the points at its ends that have no name.
 * @param {Doc} doc resolved @param {Stretch} stretch @param {boolean} hide
 * @returns {{ ops: Operation[], edge: [string, string], named: string[] }} named: the points that got a name
 */
export function edgeOps(doc, stretch, hide) {
  const { part, outline, ends } = endsOf(doc, stretch);
  if (ends.some((end) => !end.id && !end.at)) {
    throw new WeldError(`that stretch is in a hole of ${part.id} between points of the hole’s own, which take no names: weld the hole to a line first`);
  }
  if (hiddenFlags(part, outline)[stretch.index] === hide) {
    const named = ends.map((end) => end.id ?? 'an unnamed point');
    throw new WeldError(`the stretch ${named[0]} – ${named[1]} of ${part.id} is ${hide ? 'hidden' : 'shown'} already`);
  }
  const { ops, edges, named } = edgesOps(doc, [stretch], hide);
  return { ops, edge: edges[0], named };
}

/**
 * The batch that hides or shows several drawn stretches at once (a drag of the Hide Edge tool), in one step: the
 * points at their ends that have no name get one, all together. Stretches already so, and ones between a hole's own
 * points (which take no names), are left out.
 * @param {Doc} doc resolved @param {Stretch[]} stretches @param {boolean} hide
 * @returns {{ ops: Operation[], edges: [string, string][], named: string[] }}
 */
export function edgesOps(doc, stretches, hide) {
  const todo = stretches.map((stretch) => ({ stretch, ...endsOf(doc, stretch) })).filter(({ part, outline, ends, stretch }) => hiddenFlags(part, outline)[stretch.index] !== hide && ends.every((end) => end.id || end.at));
  /** @type {Map<string, PointAt>} the unnamed points, once each */
  const unnamed = new Map();
  for (const { ends } of todo) for (const end of ends) if (!end.id && end.at) unnamed.set(`${end.at.part}:${end.at.index}`, end.at);
  const { refs, changes } = namedRefs(doc, [...unnamed.values()]);
  const nameOf = new Map([...unnamed.keys()].map((key, i) => [key, refs[i]]));
  /** @type {Map<string, Edge[]>} the hidden edges of each part changed */
  const after = new Map();
  /** @type {[string, string][]} */
  const edges = [];
  for (const { part, ends } of todo) {
    const edge = /** @type {[string, string]} */ (ends.map((end) => end.id ?? String(nameOf.get(`${end.at?.part}:${end.at?.index}`))));
    after.set(part.id, withEdge({ ...part, hiddenEdges: after.get(part.id) ?? hiddenEdgesOf(part) }, edge, hide));
    edges.push(edge);
  }
  const set = [...after].map(([target, list]) => ({ op: 'set', target, props: { hiddenEdges: list } }));
  return { ops: [...vertexOps(changes), ...set], edges, named: refs };
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
  const outline = strokedOutline(part, hole);
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
