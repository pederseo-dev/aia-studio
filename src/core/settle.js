// What the store does to every batch before it applies it, whoever sends it (the editor, the AI, the API), so a
// change means the same from every side:
// - shared points, point groups and followed stretches stay coherent (settleOps in points.js);
// - a layer's origin does not wander: a transformed layer without an origin gets one where its pivot is, so adding
//   content later does not move it; and moving the origin of a transformed layer makes up with its x, y, so the
//   layer stays where it is (unless the batch sets x or y itself).

import { findObject } from './document.js';
import { originOf, round2 } from './geometry.js';
import { settleOps } from './points.js';
import { contentBounds, isTransformed, moveLayerOrigin, pivotOf } from './transform.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./operations.js').Operation} Operation
 */

/** @param {DocObject | undefined} o */
const isLayer = (o) => o?.type === 'vector' || o?.type === 'group';

/**
 * The batch the store really applies.
 * @param {Doc} doc the stored document
 * @param {Operation[]} ops
 * @param {(doc: Doc, ops: Operation[]) => Doc} apply applies a batch without checking points
 * @returns {Operation[]}
 */
export function settleBatch(doc, ops, apply) {
  const settled = settleOps(doc, ops, apply);
  if (!Array.isArray(settled) || settled.some((op) => !op || typeof op !== 'object')) return settled;
  // Moving the origin of a transformed layer keeps the layer in place.
  const compensated = settled.map((op) => {
    const props = op.op === 'set' && op.props && typeof op.props === 'object' ? op.props : null;
    if (!props || !('originX' in props || 'originY' in props) || 'x' in props || 'y' in props) return op;
    const layer = findObject(doc, op.target);
    if (!layer || !isLayer(layer) || !isTransformed(layer)) return op;
    const pivot = pivotOf(doc, layer);
    const x = props.originX === undefined ? pivot.x : props.originX;
    const y = props.originY === undefined ? pivot.y : props.originY;
    if (typeof x === 'number' && typeof y === 'number') return { ...op, props: { ...props, ...moveLayerOrigin(doc, layer, { x, y }) } };
    if (x !== null && y !== null) return op; // not numbers: the engine says why
    const box = contentBounds(doc, layer);
    const center = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 };
    return { ...op, props: { ...props, ...moveLayerOrigin(doc, layer, center) } };
  });
  // A transformed layer without an origin gets one where it turns now.
  let after;
  try {
    after = apply(doc, compensated);
  } catch {
    return compensated; // the engine will refuse it, with the reason
  }
  const fixes = after.objects
    .filter((o) => isLayer(o) && isTransformed(o) && !originOf(o))
    .map((o) => {
      const p = pivotOf(after, o);
      return { op: 'set', target: o.id, props: { originX: round2(p.x), originY: round2(p.y) } };
    });
  return [...compensated, ...fixes];
}
