// The drawing tools. Every shape is a path (decision 8): Pen (P) clicks corners and drags curves (a click on the
// first point closes the outline, Enter ends an open line, Esc cancels); Rectangle (R) and Ellipse (E) drag out a
// path with that shape (Shift: square or circle). New parts go into the active vector layer; with none, a new layer
// is made in the same batch. Then a small box asks for the part's name (optional).

import { childrenOf, findObject, idFromName } from '../core/document.js';
import { pathData } from '../core/draw.js';
import { ellipseVertices, rectVertices, round2, roundVertex } from '../core/geometry.js';
import { askName } from './namePrompt.js';
import { activeVector, drawStyle, isLocked, notify, run, state } from './state.js';
import { addPainter, onToolDown, paintOverlay } from './canvas.js';
import { drag, element, screen, svg, toDoc } from './view.js';

/**
 * @typedef {import('../core/geometry.js').Vertex} Vertex
 * @typedef {import('../core/operations.js').Operation} Operation
 * @typedef {import('./view.js').Point} Point
 */

const CLOSE_DISTANCE = 8; // screen px: a pen click this close to the first point closes the outline

/** @type {Vertex[]} the pen's outline in progress */
let pen = [];
/** @type {Point | null} the pointer, for the pen's rubber band */
let pointer = null;

/**
 * The vector layer new parts go into, and the ops that make one if there is none.
 * @returns {{ layer: string, ops: Operation[] } | null}
 */
export function targetLayer() {
  const doc = state.document;
  if (!doc) return null;
  const active = activeVector();
  if (active) {
    if (isLocked(active.id)) {
      notify(`The layer "${active.id}" is locked`);
      return null;
    }
    return { layer: active.id, ops: [] };
  }
  const id = idFromName('layer_1', (x) => x === 'meta' || !!findObject(doc, x));
  const selected = state.selected ? findObject(doc, state.selected) : undefined;
  /** @type {Operation} */
  const create = { op: 'create', type: 'vector', id };
  if (selected?.type === 'group') create.parent = selected.id;
  else if (selected) {
    create.parent = selected.parent;
    create.index = childrenOf(doc, selected.parent).indexOf(selected) + 1;
  }
  return { layer: id, ops: [create] };
}

/**
 * Adds a path to the active layer, then asks for its name.
 * @param {string} base the name it gets until it is named: shape_1, line_1…
 * @param {Record<string, unknown>} props
 * @param {string} note
 */
async function addPart(base, props, note) {
  const doc = state.document;
  const target = targetLayer();
  if (!doc || !target) return;
  const id = idFromName(`${base}_1`, (x) => x === 'meta' || !!findObject(doc, x) || target.ops.some((o) => o.id === x));
  // The auto fill and auto stroke of the tools (an open line never gets a fill).
  const style = {
    fill: props.closed === false ? null : drawStyle.fill,
    stroke: drawStyle.stroke,
    ...(drawStyle.stroke ? { strokeWidth: drawStyle.strokeWidth } : {}),
  };
  await run([...target.ops, { op: 'create', type: 'path', id, parent: target.layer, props: { ...props, ...style } }], { select: id, note });
  if (state.document && findObject(state.document, id)) askName(id);
}

/** @param {PointerEvent} event @param {'rect' | 'ellipse'} type */
function boxDown(event, type) {
  const start = toDoc(event);
  const overlay = svg.querySelector('.overlay');
  const draft = element(type === 'rect' ? 'rect' : 'ellipse', { class: 'draft' });
  overlay?.append(draft);
  /** @param {Point} p @param {PointerEvent} e */
  const boxOf = (p, e) => {
    let w = p.x - start.x;
    let h = p.y - start.y;
    if (e.shiftKey) {
      const side = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * side;
      h = Math.sign(h || 1) * side;
    }
    return {
      x: round2(Math.min(start.x, start.x + w)),
      y: round2(Math.min(start.y, start.y + h)),
      width: round2(Math.abs(w)),
      height: round2(Math.abs(h)),
    };
  };
  drag(
    event,
    (p, e) => {
      const b = boxOf(p, e);
      if (type === 'rect') for (const [k, v] of Object.entries(b)) draft.setAttribute(k, String(v));
      else {
        draft.setAttribute('cx', String(b.x + b.width / 2));
        draft.setAttribute('cy', String(b.y + b.height / 2));
        draft.setAttribute('rx', String(b.width / 2));
        draft.setAttribute('ry', String(b.height / 2));
      }
    },
    (p, e) => {
      draft.remove();
      const b = boxOf(p, e);
      if (b.width < screen(2) || b.height < screen(2)) return;
      const vertices = (type === 'rect' ? rectVertices(b) : ellipseVertices(b)).map(roundVertex);
      addPart(type === 'rect' ? 'rectangle' : 'ellipse', { vertices }, `New ${type === 'rect' ? 'rectangle' : 'ellipse'}`);
    },
  );
}

/** @param {boolean} closed */
function finishPen(closed) {
  const vertices = pen.map(roundVertex);
  pen = [];
  pointer = null;
  if (vertices.length < 2) return paintOverlay();
  addPart(closed ? 'shape' : 'line', closed ? { vertices } : { vertices, closed: false }, closed ? 'Pen: shape' : 'Pen: line');
}

/** Esc with the pen: drops the outline in progress. */
export function cancelPen() {
  if (!pen.length) return false;
  pen = [];
  pointer = null;
  paintOverlay();
  return true;
}

/** Enter with the pen: ends the outline as an open line. */
export function finishPenLine() {
  if (!pen.length) return false;
  finishPen(false);
  return true;
}

/** @param {PointerEvent} event */
function penDown(event) {
  const p = toDoc(event);
  const first = pen[0];
  if (first && pen.length > 2 && Math.hypot(p.x - first.x, p.y - first.y) <= screen(CLOSE_DISTANCE)) {
    finishPen(true);
    return;
  }
  if (pen.length === 0 && !targetLayer()) return;
  /** @type {Vertex} */
  const vertex = { x: p.x, y: p.y };
  pen.push(vertex);
  paintOverlay();
  drag(
    event,
    (q) => {
      // Dragging pulls a curve out of the point: "out" follows the pointer and "in" mirrors it.
      const out = { x: q.x - vertex.x, y: q.y - vertex.y };
      if (Math.hypot(out.x, out.y) < screen(3)) {
        delete vertex.out;
        delete vertex.in;
      } else {
        vertex.out = out;
        vertex.in = { x: -out.x, y: -out.y };
      }
      pointer = null;
      paintOverlay();
    },
    () => paintOverlay(),
  );
}

export function setupDrawTools() {
  onToolDown('rect', (event) => boxDown(event, 'rect'));
  onToolDown('ellipse', (event) => boxDown(event, 'ellipse'));
  onToolDown('pen', penDown);
  svg.addEventListener('pointermove', (event) => {
    if (state.tool !== 'pen' || !pen.length || event.buttons) return;
    pointer = toDoc(event);
    paintOverlay();
  });
  addPainter((overlay) => {
    if (state.tool !== 'pen' || !pen.length) return;
    const preview = pointer ? [...pen, { x: pointer.x, y: pointer.y }] : pen;
    overlay.append(element('path', { d: pathData(preview, false), class: 'pen-line' }));
    for (const [i, v] of pen.entries()) {
      for (const h of [v.out, v.in]) {
        if (h) overlay.append(element('line', { x1: v.x, y1: v.y, x2: v.x + h.x, y2: v.y + h.y, class: 'pen-handle' }));
      }
      overlay.append(element('circle', { cx: v.x, cy: v.y, r: screen(i === 0 ? 4.5 : 3.5), class: i === 0 ? 'pen-start' : 'pen-point' }));
    }
  });
}
