// Copies of parts, for the editor (Ctrl+D, Ctrl+C / Ctrl+V, Alt+drag) and for `aia copy`. A copy gets a free name
// from its original (rect_1 → rect_2) and does not share the original's points: its shared vertices stay where they
// are, as its own (so copies are taken from a resolved document, where shared vertices have x, y). A shape that
// follows lines is copied as it is drawn: its outline and holes with the curves it follows, as points of its own.

import { findObject, idFromName } from './document.js';
import { IDENTITY, holeOutlinesOf, holesOf, outlineOf, transformPart } from './geometry.js';
import { hiddenEdgesOf, nextPointName, strokedOutlines } from './points.js';
import { hiddenFlags } from './edges.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Matrix} Matrix
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {import('./geometry.js').Vertex} Vertex
 */

/** A vertex of a copy: where it is, as a point of its own. @param {Vertex} v @returns {Vertex} */
const own = ({ ref: _ref, follow: _follow, way: _way, ...v }) => v;

/**
 * The hidden edges of a copy: the same stretches of its own outline (its points at their ends named if they have no
 * name). A hole's points take no names, so stretches hidden in holes are not copied.
 * @param {DocObject} part resolved @param {string} id the copy's @param {Vertex[]} vertices the copy's (its drawn outline)
 * @returns {{ vertices: Vertex[], hiddenEdges?: [string, string][] }}
 */
function copiedEdges(part, id, vertices) {
  const [outline] = strokedOutlines(part);
  const hidden = hiddenFlags(part, outline);
  const named = vertices.map((v) => ({ ...v }));
  const copy = { id, type: 'path', parent: null, vertices: named };
  const n = named.length;
  /** @param {number} i */
  const nameOf = (i) => (named[i].name ??= nextPointName(copy));
  /** @type {[string, string][]} */
  const edges = [];
  hidden.forEach((h, k) => {
    if (h) edges.push([`${id}.${nameOf(k)}`, `${id}.${nameOf((k + 1) % n)}`]);
  });
  return { vertices: named, ...(edges.length ? { hiddenEdges: edges } : {}) };
}

/**
 * The ops that create copies of parts, each moved by `m`, in the layer `layer` (or each in its own layer).
 * @param {Doc} doc
 * @param {DocObject[]} parts
 * @param {Matrix | ((part: DocObject) => Matrix)} m the same for all, or one for each part (in its layer's coordinates)
 * @param {string} [layer]
 * @returns {{ ops: Operation[], ids: string[] }}
 */
export function copyOps(doc, parts, m, layer) {
  /** @type {Set<string>} */
  const used = new Set();
  /** @type {Operation[]} */
  const ops = [];
  for (const part of parts) {
    const id = idFromName(part.id, (x) => x === 'meta' || !!findObject(doc, x) || used.has(x));
    used.add(id);
    // What is drawn, not what is stored: a shape's followed stretches become its own points.
    /** @type {DocObject} */
    const drawn = { ...part, vertices: outlineOf(part), ...(holesOf(part).length ? { holes: holeOutlinesOf(part) } : {}) };
    const { id: _id, type, parent, hiddenEdges: _hidden, ...props } = structuredClone(drawn);
    const matrix = typeof m === 'function' ? m(part) : m;
    Object.assign(props, matrix === IDENTITY ? {} : transformPart(drawn, matrix));
    // A copy does not share the original's points: its shared vertices stay where they are, as its own.
    if (Array.isArray(props.vertices)) props.vertices = props.vertices.map(own);
    if (Array.isArray(props.holes)) props.holes = props.holes.map((/** @type {Vertex[]} */ hole) => hole.map(own));
    if (hiddenEdgesOf(part).length) Object.assign(props, copiedEdges(part, id, /** @type {Vertex[]} */ (props.vertices)));
    ops.push({ op: 'create', type, id, parent: layer ?? parent, props });
  }
  return { ops, ids: [...used] };
}
