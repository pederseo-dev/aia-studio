// The Select Shape tool (Q), as Moho's Select Shape (step 4 of part 4 in docs/rebuild.md). A line, its shape's fill
// and its shape's stroke lie on top of each other; this tool says which one a click takes: over the canvas, what a
// click would take is marked lightly with a label (element, fill or stroke), and the selection stays marked the same
// way. Near a stroke a click takes the topmost stroke there; inside, the fill. An element is taken whole, a shape's
// fill and stroke apart. Alt+click goes down through everything at that place, from the one selected. ↑ / ↓ raise
// or lower the selected part in its layer (Shift: to the top or bottom; main.js). What is at a place comes from the
// core (partsAt in core/shapes.js).

import { findObject } from '../core/document.js';
import { partData } from '../core/draw.js';
import { kindOf, partsAt } from '../core/shapes.js';
import { worldOf } from '../core/transform.js';
import { addPainter, onToolDown, paintOverlay } from './canvas.js';
import { isHidden, isLocked, select, state } from './state.js';
import { element, screen, svg, toDoc } from './view.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/document.js').DocObject} DocObject
 * @typedef {import('../core/geometry.js').Point} Point
 */

const HIT = 5; // screen px around a stroke (besides half its width)

/** @type {{ id: string, at: Point } | null} what a click would take, and where the pointer is */
let hover = null;

/** The parts a click can take: shown and unlocked. @param {DocObject} part */
const pickable = (part) => !isHidden(part.id) && !isLocked(part.id);

/**
 * What a click at a place takes: the topmost part there, or with `down` the one under the selected one (round to the
 * top again after the last).
 * @param {Doc} doc @param {Point} p @param {boolean} down
 */
function partAt(doc, p, down) {
  const found = partsAt(doc, p, screen(HIT), pickable);
  if (!found.length) return null;
  const now = found.findIndex((f) => f.id === state.selected);
  return found[down && now >= 0 ? (now + 1) % found.length : 0].id;
}

/** @param {PointerEvent} event */
function pickDown(event) {
  const doc = state.document;
  if (!doc) return;
  select(partAt(doc, toDoc(event), event.altKey));
}

/** A part marked on the overlay as what it is: a fill tinted, a stroke as a band, an element both. @param {Doc} doc @param {DocObject} part @param {string} how */
function mark(doc, part, how) {
  const kind = kindOf(part);
  const [a, b, c, d, e, f] = worldOf(doc, part.id);
  const g = element('g', { transform: `matrix(${a} ${b} ${c} ${d} ${e} ${f})`, class: `pick ${kind} ${how}` });
  const data = partData(part);
  const closed = part.closed !== false;
  if (kind !== 'stroke' && closed && part.fill !== null) g.append(element('path', { d: data, class: 'pick-area', 'fill-rule': 'evenodd' }));
  if (kind !== 'fill' || part.fill === null) g.append(element('path', { d: data, class: 'pick-band' }));
  if (kind === 'fill') g.append(element('path', { d: data, class: 'pick-edge' }));
  return g;
}

/** The label next to the pointer: "head_fill · fill". @param {DocObject} part @param {Point} at */
function label(part, at) {
  const text = element('text', { x: at.x + screen(14), y: at.y + screen(22), 'font-size': screen(11), class: 'pick-label' });
  text.textContent = `${part.id} · ${kindOf(part)}`;
  return text;
}

/** @param {SVGGElement} overlay @param {Doc} doc */
function paint(overlay, doc) {
  for (const id of state.selection) {
    const part = findObject(doc, id);
    if (part?.type === 'path') overlay.append(mark(doc, part, 'picked'));
  }
  const part = hover ? findObject(doc, hover.id) : undefined;
  if (part && hover) {
    if (!state.selection.includes(part.id)) overlay.append(mark(doc, part, 'hover'));
    overlay.append(label(part, hover.at));
  }
}

export function setupSelectShapeTool() {
  onToolDown('shapeSelect', pickDown);
  svg.addEventListener('pointermove', (event) => {
    const doc = state.document;
    if (state.tool !== 'shapeSelect' || event.buttons || !doc) return;
    const at = toDoc(event);
    const id = partAt(doc, at, event.altKey);
    hover = id ? { id, at } : null;
    paintOverlay();
  });
  svg.addEventListener('pointerleave', () => {
    if (!hover) return;
    hover = null;
    paintOverlay();
  });
  addPainter((overlay, doc) => {
    if (state.tool !== 'shapeSelect') {
      hover = null;
      return;
    }
    if (hover && !findObject(doc, hover.id)) hover = null;
    paint(overlay, doc);
  });
}
