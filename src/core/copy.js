// Copies of parts, for the editor (Ctrl+D, Ctrl+C / Ctrl+V, Alt+drag) and for `aia copy`. A copy gets a free name
// from its original (rect_1 → rect_2) and does not share the original's points: its shared vertices stay where they
// are, as its own (so copies are taken from a resolved document, where shared vertices have x, y).

import { findObject, idFromName } from './document.js';
import { IDENTITY, transformPart } from './geometry.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Matrix} Matrix
 * @typedef {import('./operations.js').Operation} Operation
 */

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
    const { id: _id, type, parent, ...props } = structuredClone(part);
    const matrix = typeof m === 'function' ? m(part) : m;
    Object.assign(props, matrix === IDENTITY ? {} : transformPart(part, matrix));
    // A copy does not share the original's points: its shared vertices stay where they are, as its own.
    if (Array.isArray(props.vertices)) props.vertices = props.vertices.map(({ ref: _ref, follow: _follow, way: _way, ...v }) => v);
    ops.push({ op: 'create', type, id, parent: layer ?? parent, props });
  }
  return { ops, ids: [...used] };
}
