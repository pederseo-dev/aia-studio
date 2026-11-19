// The Create Shape tool (F), part 4 of docs/rebuild.md: a selector of gaps. Over a gap that the lines of a vector layer
// close, the gap shows hatched, with its holes (shapes inside it) left clear. A click selects it: an empty gap is
// marked (again: unmarked; Shift: several), a gap that is already filled selects its fill part (Shift: adds it). Create
// shape in the bar (Enter) fills the marked gaps, each with a part that follows the lines around it and its holes,
// under them, in one step; Esc clears the marks. The tool's own fill and stroke are in the options bar.
// The gaps are found in the core (core/fill.js), the same as `aia fill`.

import { findObject } from '../core/document.js';
import { fillOfGap, fillOps, gapAt, styleProps } from '../core/fill.js';
import { applyOps } from '../core/operations.js';
import { resolveDoc } from '../core/points.js';
import { addPainter, onToolDown, paintOverlay } from './canvas.js';
import { fromLayer, toLayer } from './pointEdit.js';
import { schema } from './schema.js';
import { activeVector, fillStyle, isHidden, isLocked, notify, run, select, state, toggleSelect } from './state.js';
import { element, screen, svg, toDoc } from './view.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/geometry.js').Point} Point
 * @typedef {import('../core/fill.js').Gap} Gap
 * @typedef {{ layer: string, at: Point }} Mark a place in a gap, in its layer's coordinates
 */

/** @type {Mark[]} */
let marks = [];
/** @type {Mark | null} the gap under the pointer */
let hover = null;

/** The vector layers a click looks in: the active one, or every shown and unlocked one from the top. */
function layersToTry() {
  const doc = state.document;
  if (!doc) return [];
  const active = activeVector();
  if (active) return isLocked(active.id) ? [] : [active.id];
  return doc.objects
    .filter((o) => o.type === 'vector' && !isHidden(o.id) && !isLocked(o.id))
    .map((o) => o.id)
    .reverse();
}

/** The gap under a place of the artboard, as a mark, or null. @param {Point} p */
function gapUnder(p) {
  const doc = state.document;
  if (!doc) return null;
  for (const layer of layersToTry()) {
    const at = toLayer(layer, p);
    if (!('error' in gapAt(doc, layer, at))) return { layer, at };
  }
  return null;
}

/** A mark's gap now (the drawing may have changed since it was marked), or null. @param {Doc} doc @param {Mark} mark @returns {Gap | null} */
function gapOf(doc, mark) {
  if (!findObject(doc, mark.layer)) return null;
  const gap = gapAt(doc, mark.layer, mark.at);
  return 'error' in gap ? null : gap;
}

/** Whether two marks are in the same gap. @param {Doc} doc @param {Mark} a @param {Mark} b */
function sameGap(doc, a, b) {
  if (a.layer !== b.layer) return false;
  const ga = gapOf(doc, a);
  const gb = gapOf(doc, b);
  return !!ga && !!gb && ga.area === gb.area && ga.polygon[0].x === gb.polygon[0].x && ga.polygon[0].y === gb.polygon[0].y;
}

/** The fill part a mark's gap already has, or undefined. @param {Doc} doc @param {Mark} mark */
function filled(doc, mark) {
  const gap = gapOf(doc, mark);
  return gap ? fillOfGap(doc, mark.layer, gap, mark.at) : undefined;
}

/** How many gaps are marked (for the options bar). */
export const markedCount = () => marks.length;

/** Esc: clears the marks. @returns {boolean} whether there were any */
export function clearMarks() {
  if (!marks.length) return false;
  marks = [];
  paintOverlay();
  notify('');
  return true;
}

/** Create shape (Enter): fills the marked gaps with the tool's style, in one step. @returns {boolean} whether there were any */
export function createMarked() {
  const saved = state.saved;
  if (!saved || !marks.length) return false;
  const props = styleProps(fillStyle);
  let stored = saved;
  let resolved = resolveDoc(saved);
  /** @type {import('../core/operations.js').Operation[]} */
  const ops = [];
  /** @type {string[]} */
  const made = [];
  try {
    for (const mark of marks) {
      const result = fillOps(resolved, mark.layer, mark.at, props);
      if (!result.made) continue;
      stored = applyOps(schema, stored, result.ops).document;
      resolved = resolveDoc(stored);
      ops.push(...result.ops);
      made.push(result.id);
    }
  } catch (e) {
    notify(e.message);
    return true;
  }
  marks = [];
  if (!ops.length) return true;
  run(ops, { note: made.length > 1 ? `Create ${made.length} shapes` : `Create shape ${made[0]}`, select: made });
  return true;
}

/** @param {PointerEvent} event */
function createDown(event) {
  const doc = state.document;
  if (!doc) return;
  const mark = gapUnder(toDoc(event));
  if (!mark) {
    if (!event.shiftKey) clearMarks();
    return notify(layersToTry().length ? 'No gap here: only lines welded where they meet close one' : 'No vector layer here (or it is locked)');
  }
  // A filled gap selects its fill.
  const fill = filled(doc, mark);
  if (fill) {
    if (!event.shiftKey) marks = [];
    return event.shiftKey ? toggleSelect(fill.id) : select(fill.id);
  }
  const at = marks.findIndex((m) => sameGap(doc, m, mark));
  if (at >= 0) marks.splice(at, 1);
  else if (event.shiftKey) marks.push(mark);
  else marks = [mark];
  notify('');
}

/** @param {SVGElement} overlay @param {Doc} doc @param {Mark} mark @param {string} kind */
function paintGap(overlay, doc, mark, kind) {
  const gap = gapOf(doc, mark);
  if (!gap) return;
  /** @param {Point[]} polygon */
  const ring = (polygon) => `M${polygon.map((p) => fromLayer(mark.layer, p)).map((p) => `${p.x} ${p.y}`).join('L')}Z`;
  const d = [gap.polygon, ...gap.holePolygons].map(ring).join('');
  overlay.append(element('path', { d, class: `gap ${kind}`, 'fill-rule': 'evenodd' }));
}

export function setupFillTool() {
  onToolDown('fill', createDown);
  svg.addEventListener('pointermove', (event) => {
    if (state.tool !== 'fill' || event.buttons) return;
    const next = gapUnder(toDoc(event));
    const doc = state.document;
    const same = !!next && !!hover && !!doc && sameGap(doc, next, hover);
    if (same || (!next && !hover)) return;
    hover = next;
    paintOverlay();
  });
  svg.addEventListener('pointerleave', () => {
    if (!hover) return;
    hover = null;
    paintOverlay();
  });
  addPainter((overlay, doc) => {
    if (state.tool !== 'fill') {
      marks = [];
      hover = null;
      return;
    }
    // The hatching, in screen pixels whatever the zoom.
    const size = screen(6);
    const hatch = element('pattern', { id: 'gap-hatch', width: size, height: size, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.append(element('line', { x1: 0, y1: 0, x2: 0, y2: size }));
    const defs = element('defs');
    defs.append(hatch);
    overlay.append(defs);
    for (const mark of marks) paintGap(overlay, doc, mark, 'marked');
    if (hover && !marks.some((m) => sameGap(doc, m, /** @type {Mark} */ (hover)))) paintGap(overlay, doc, hover, filled(doc, hover) ? 'hover filled' : 'hover');
  });
}
