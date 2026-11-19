// The Fill & Stroke tool (F), as agreed in part 4 of docs/rebuild.md: a selector of gaps. Over a gap that the lines of
// a vector layer close, the gap shows hatched; a click marks it (again: unmarks it; Shift: marks several), and the
// marks stay until Fill (Enter) fills them, each with a part that follows the lines around it, under them, or until
// Esc. A marked gap that is already filled gets recolored. The tool's own fill and stroke are in the options bar.
// The gaps are found in the core (core/fill.js), the same as `aia fill`.

import { findObject } from '../core/document.js';
import { fillOps, gapAt, styleProps } from '../core/fill.js';
import { applyOps } from '../core/operations.js';
import { resolveDoc } from '../core/points.js';
import { addPainter, onToolDown, paintOverlay } from './canvas.js';
import { fromLayer, toLayer } from './pointEdit.js';
import { schema } from './schema.js';
import { activeVector, fillStyle, isHidden, isLocked, notify, run, state } from './state.js';
import { element, screen, svg, toDoc } from './view.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/geometry.js').Point} Point
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

/** The outline of a mark's gap now (the drawing may have changed since it was marked), or null. @param {Doc} doc @param {Mark} mark */
function polygonOf(doc, mark) {
  if (!findObject(doc, mark.layer)) return null;
  const gap = gapAt(doc, mark.layer, mark.at);
  return 'error' in gap ? null : gap.polygon;
}

/** Whether two marks are in the same gap. @param {Doc} doc @param {Mark} a @param {Mark} b */
function sameGap(doc, a, b) {
  if (a.layer !== b.layer) return false;
  const ga = gapAt(doc, a.layer, a.at);
  const gb = gapAt(doc, b.layer, b.at);
  return !('error' in ga) && !('error' in gb) && ga.area === gb.area && ga.polygon[0].x === gb.polygon[0].x && ga.polygon[0].y === gb.polygon[0].y;
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

/** Fill (Enter): fills the marked gaps with the tool's style, in one step. @returns {boolean} whether there were any */
export function fillMarked() {
  const saved = state.saved;
  if (!saved || !marks.length) return false;
  const props = styleProps(fillStyle);
  let stored = saved;
  let resolved = resolveDoc(saved);
  /** @type {import('../core/operations.js').Operation[]} */
  const ops = [];
  let made = 0;
  let recolored = 0;
  try {
    for (const mark of marks) {
      const result = fillOps(resolved, mark.layer, mark.at, props);
      if (!result.ops.length) continue;
      stored = applyOps(schema, stored, result.ops).document;
      resolved = resolveDoc(stored);
      ops.push(...result.ops);
      if (result.made) made++;
      else recolored++;
    }
  } catch (e) {
    notify(e.message);
    return true;
  }
  marks = [];
  if (!ops.length) return true;
  const note = [made && `Fill ${made === 1 ? 'a gap' : `${made} gaps`}`, recolored && `recolor ${recolored === 1 ? 'a fill' : `${recolored} fills`}`].filter(Boolean).join(', ');
  run(ops, { note: note.charAt(0).toUpperCase() + note.slice(1) });
  return true;
}

/** @param {PointerEvent} event */
function fillDown(event) {
  const doc = state.document;
  if (!doc) return;
  const mark = gapUnder(toDoc(event));
  if (!mark) {
    if (!event.shiftKey) clearMarks();
    return notify(layersToTry().length ? 'No gap here: only lines welded where they meet close one' : 'No vector layer to fill (or it is locked)');
  }
  const at = marks.findIndex((m) => sameGap(doc, m, mark));
  if (at >= 0) marks.splice(at, 1);
  else if (event.shiftKey) marks.push(mark);
  else marks = [mark];
  notify('');
}

/** @param {SVGElement} overlay @param {Doc} doc @param {Mark} mark @param {string} kind */
function paintGap(overlay, doc, mark, kind) {
  const polygon = polygonOf(doc, mark);
  if (!polygon) return;
  const points = polygon.map((p) => fromLayer(mark.layer, p));
  const d = `M${points.map((p) => `${p.x} ${p.y}`).join('L')}Z`;
  overlay.append(element('path', { d, class: `gap ${kind}` }));
}

export function setupFillTool() {
  onToolDown('fill', fillDown);
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
    if (hover && !marks.some((m) => sameGap(doc, m, /** @type {Mark} */ (hover)))) paintGap(overlay, doc, hover, 'hover');
  });
}
