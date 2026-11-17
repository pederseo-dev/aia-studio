// Copies of parts: Ctrl+D duplicates the selection (a little down and to the right), Ctrl+C / Ctrl+V copy and paste
// it (into the active vector layer, in the same place) and Alt+drag with Select drags a copy (selectTool.js; the
// arrow keys nudge there too). Copies get free names from their originals: rect_1 → rect_2.

import { copyOps } from '../core/copy.js';
import { IDENTITY, translate } from '../core/geometry.js';
import { targetLayer } from './drawTools.js';
import { notify, run, selectedParts, state } from './state.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/document.js').DocObject} DocObject
 */

const DUPLICATE_OFFSET = 10;

/** @type {DocObject[]} what Ctrl+C copied */
let copied = [];

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
