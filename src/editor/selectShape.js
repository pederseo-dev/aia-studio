// Select Shape, as in Moho: picks shapes (a fill, a stroke or both) of any vector layer, to color them in the
// inspector or change their order. Hovering outlines the shape under the pointer. A click picks the topmost shape
// there; another click on the same spot picks the one below (a fill under its outline). Shift + click adds or removes
// a shape. The arrows ↑ ↓ raise or lower the picked shape in its layer (`move` with index, as the AI does).

import { children, findObject } from '../core/document.js';
import { read as readProp } from '../core/schema.js';
import { execute, notify, schema, select, selectSeveral, state } from './state.js';

const read = (o, prop) => readProp(schema, o, prop);

export const isSelectShape = (tool = state.tool) => tool === 'selectShape';

/** Ids of the shapes under a screen point, the topmost first. */
function shapesAt(documentG, e) {
  const ids = document
    .elementsFromPoint(e.clientX, e.clientY)
    .filter((el) => documentG.contains(el) && el.matches('path[data-id]'))
    .map((el) => /** @type {HTMLElement} */ (/** @type {unknown} */ (el)).dataset.id)
    .filter((id) => findObject(state.doc, id)?.type === 'shape');
  return [...new Set(ids)];
}

/**
 * Raises (+1) or lowers (−1) the picked shape among the shapes of its layer: the last one is drawn on top.
 * Returns false if there is no picked shape.
 */
export function restackShape(step) {
  const shape = findObject(state.doc, state.selection);
  if (shape?.type !== 'shape' || state.pose || state.params || state.live) return false;
  const siblings = children(state.doc, shape.parent);
  const index = siblings.indexOf(shape);
  const to = index + step;
  if (to < 0 || to >= siblings.length) {
    notify(`${shape.id} is already the ${step > 0 ? 'top' : 'bottom'} shape of ${shape.parent}`);
    return true;
  }
  execute([{ op: 'move', target: shape.id, parent: shape.parent, index: to }], `${step > 0 ? 'raise' : 'lower'} ${shape.id}`);
  return true;
}

/** @param {any} ctx the canvas tools context */
export function createSelectShape(ctx) {
  let hovered = null;

  /** Outline of a shape as it is drawn (a copy of its path, with its matrix on screen). */
  function outline(id, className) {
    const el = ctx.documentG.querySelector(`path[data-id="${CSS.escape(id)}"]`);
    if (!el) return null;
    const copy = el.cloneNode();
    const m = el.getCTM();
    for (const a of ['data-id', 'fill', 'stroke', 'stroke-width', 'opacity']) copy.removeAttribute(a);
    copy.setAttribute('class', className);
    copy.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
    return copy;
  }

  function draw() {
    if (!isSelectShape()) return;
    for (const id of state.selected) {
      if (findObject(state.doc, id)?.type !== 'shape') continue;
      const o = outline(id, 'shape-picked');
      if (o) ctx.overlay.append(o);
    }
    if (hovered && !state.selected.includes(hovered)) {
      const o = outline(hovered, 'shape-hover');
      if (o) ctx.overlay.append(o);
    }
  }

  function hover(e) {
    if (!isSelectShape()) return;
    const next = shapesAt(ctx.documentG, e)[0] ?? null;
    if (next === hovered) return;
    hovered = next;
    ctx.redraw();
  }

  function pointerdown(e) {
    const under = shapesAt(ctx.documentG, e);
    if (e.shiftKey) {
      if (!under.length) return;
      const id = under[0];
      const shapes = state.selected.filter((s) => findObject(state.doc, s)?.type === 'shape');
      const next = shapes.includes(id) ? shapes.filter((s) => s !== id) : [...shapes, id];
      return next.length ? selectSeveral(next) : select(null);
    }
    if (!under.length) return select(null);
    // The same spot again: the shape below the picked one (and back to the top after the last).
    const at = state.selected.length === 1 ? under.indexOf(state.selection) : -1;
    select(under[(at + 1) % under.length]);
  }

  return { draw, hover, pointerdown };
}

/** Text of the options bar. */
export function selectShapeSummary(doc) {
  const shapes = state.selected.map((id) => findObject(doc, id)).filter((o) => o?.type === 'shape');
  if (!shapes.length) return 'Select Shape: click a fill or a stroke to pick it (its colors show in the inspector); click again on the same spot picks the one below; Shift + click adds.';
  if (shapes.length > 1) return `${shapes.length} shapes picked: the inspector changes them together. Shift + click adds or removes one.`;
  const s = shapes[0];
  const paint = [read(s, 'fill') != null || read(s, 'fillGradient') != null ? 'fill' : '', read(s, 'stroke') != null ? 'stroke' : ''].filter(Boolean).join(' and ') || 'no fill or stroke';
  return `Shape <b>${s.id}</b> of <b>${s.parent}</b> (${paint}): click again on the same spot for the one below; <kbd>↑</kbd> <kbd>↓</kbd> raise or lower it.`;
}
