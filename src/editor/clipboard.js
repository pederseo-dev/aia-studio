// Copies of parts: Ctrl+D duplicates the selection (a little down and to the right), Ctrl+C / Ctrl+V copy and paste
// it (into the active vector layer, in the same place) and Alt+drag with Select drags a copy (selectTool.js; the
// arrow keys nudge there too). Copies get free names from their originals: rect_1 → rect_2.

import { findObject, idFromName } from '../core/document.js';
import { IDENTITY, transformPart, translate } from '../core/geometry.js';
import { targetLayer } from './drawTools.js';
import { notify, run, selectedParts, state } from './state.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/document.js').DocObject} DocObject
 * @typedef {import('../core/geometry.js').Matrix} Matrix
 * @typedef {import('../core/operations.js').Operation} Operation
 */

const DUPLICATE_OFFSET = 10;

/** @type {DocObject[]} what Ctrl+C copied */
let copied = [];

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
    if (Array.isArray(props.vertices)) props.vertices = props.vertices.map(({ ref: _ref, ...v }) => v);
    ops.push({ op: 'create', type, id, parent: layer ?? parent, props });
  }
  return { ops, ids: [...used] };
}

export function duplicate() {
  const doc = state.document;
  const parts = selectedParts();
  if (!doc || !parts.length) return notify(state.selected ? 'Duplicate works on parts for now' : 'Nothing to duplicate');
  const { ops, ids } = copyOps(doc, parts, translate(DUPLICATE_OFFSET, DUPLICATE_OFFSET));
  run(ops, { select: ids, note: `Duplicate ${parts.length > 1 ? `${parts.length} parts` : parts[0].id}` });
}

export function copy() {
  const parts = selectedParts();
  if (!parts.length) return false;
  copied = structuredClone(parts);
  navigator.clipboard?.writeText(JSON.stringify(copied, null, 2)).catch(() => {});
  return true;
}

export function paste() {
  const doc = state.document;
  if (!doc || !copied.length) return false;
  const target = targetLayer();
  if (!target) return true;
  // Parts made with the target's new layer in the same batch must not reuse its name.
  const withLayer = target.ops.length
    ? { ...doc, objects: [...doc.objects, { id: target.layer, type: 'vector', parent: null }] }
    : doc;
  const { ops, ids } = copyOps(withLayer, copied, IDENTITY, target.layer);
  run([...target.ops, ...ops], { select: ids, note: `Paste ${ids.length > 1 ? `${ids.length} parts` : ids[0]}` });
  return true;
}
