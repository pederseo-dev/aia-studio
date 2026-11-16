// The drawing tools. Every shape is a path (decision 8). Rectangle (R) and Ellipse (E) drag out a path with that
// shape (Shift: square or circle), then a small box asks for its name (optional). New parts go into the active
// vector layer; with none, a new layer is made in the same batch.
// The Pen (P) works as Moho's Add Point: press and drag, and the new point follows the pointer until it is released.
// Pressing on an open end of a line of the layer continues that line; anywhere else starts a new line of two points.
// Points come out smooth (an automatic curve through their neighbors); Sharp corners, or Alt, makes corners.
// Released on the other end of the same line, it closes it into a shape. The points of the layer show as small dots,
// and with Auto weld on a point pressed or released on a point or a line of the layer is welded there (it shares
// that point). A ring shows where: green to weld, the accent color on an end that would be continued.
// Each stretch is saved when it is released: one step to undo.

import { childrenOf, findObject, idFromName } from '../core/document.js';
import { ellipseVertices, rectVertices, round2, roundVertex, verticesOf } from '../core/geometry.js';
import { askName } from './namePrompt.js';
import { activeVector, autoWeld, drawStyle, isHidden, isLocked, notify, penOptions, run, state } from './state.js';
import { paintLayerPoints, shapePoint, shareTargets, showWeldHint, weldPlace, weldTargetNear } from './pointEdit.js';
import { addPainter, onToolDown, paintOverlay } from './canvas.js';
import { drag, element, screen, svg, toDoc } from './view.js';

/**
 * @typedef {import('../core/geometry.js').Vertex} Vertex
 * @typedef {import('../core/operations.js').Operation} Operation
 * @typedef {import('./view.js').Point} Point
 */


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
 * @param {Operation[]} [before] ops that go first in the same batch (points of other parts the new one shares)
 * @param {boolean} [ask] whether to ask for its name afterwards
 */
async function addPart(base, props, note, before = [], ask = true) {
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
  await run([...target.ops, ...before, { op: 'create', type: 'path', id, parent: target.layer, props: { ...props, ...style } }], { select: id, note });
  if (ask && state.document && findObject(state.document, id)) askName(id);
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

const END_REACH = 8; // screen px: a press this close to an open end of a line continues that line

/**
 * @typedef {import('./pointEdit.js').WeldTarget} WeldTarget
 * @typedef {{ from: Point, to: Point }} Stretch
 */

/** @type {Stretch | null} the stretch being dragged out */
let stretch = null;

/** The parts of the active layer the Pen can continue or weld to. */
function layerParts() {
  const doc = state.document;
  const layer = activeVector();
  if (!doc || !layer || isLocked(layer.id)) return [];
  return doc.objects.filter((o) => o.parent === layer.id && !isHidden(o.id));
}

/**
 * The open end of a line of the active layer at `p`, if any: the Pen continues that line from there.
 * @param {Point} p
 * @returns {{ part: import('../core/document.js').DocObject, index: number } | null}
 */
function openEndAt(p) {
  /** @type {{ part: import('../core/document.js').DocObject, index: number } | null} */
  let best = null;
  let bestDistance = screen(END_REACH);
  for (const part of layerParts()) {
    const vertices = verticesOf(part);
    if (part.closed !== false || vertices.length < 2) continue;
    for (const index of [0, vertices.length - 1]) {
      const d = Math.hypot(vertices[index].x - p.x, vertices[index].y - p.y);
      if (d <= bestDistance) {
        best = { part, index };
        bestDistance = d;
      }
    }
  }
  return best;
}

/** Where the Pen would weld at `p` (Auto weld on, in the active layer). @param {Point} p @param {string} [except] "part:index" */
function penWeld(p, except = '') {
  const layer = activeVector();
  return autoWeld.on && layer && !isLocked(layer.id) ? weldTargetNear(p, except, layer.id) : null;
}

/** Whether new points are corners: the Sharp corners switch, turned around while Alt is held. @param {PointerEvent} e */
const sharp = (e) => penOptions.sharp !== e.altKey;

/**
 * Smooths the vertices at `indices` (handles along their neighbors, as Moho's automatic curvature), unless they are
 * corners. Changes the vertices in place.
 * @param {Vertex[]} vertices @param {number[]} indices @param {boolean} closed
 */
function smooth(vertices, indices, closed) {
  for (const i of indices) if (i >= 0 && i < vertices.length) shapePoint(vertices, i, closed, false);
}

/** Whether a vertex is smooth (it has a handle): a corner stays a corner when the line goes on. @param {Vertex} v */
const isSmooth = (v) => !!(v.in || v.out);

/**
 * Pen down: press on an open end of a line to continue it, anywhere else to start a new line; drag to where the new
 * point goes, as Moho's Add Point. Released on a point or a line of the layer, the new point welds there; on the
 * other end of the same line, it closes it. Each stretch is one step.
 * @param {PointerEvent} event
 */
function penDown(event) {
  const p = toDoc(event);
  const end = openEndAt(p);
  if (!end && !targetLayer()) return;
  const endVertex = end ? verticesOf(end.part)[end.index] : null;
  const startWeld = end ? null : penWeld(p);
  const from = endVertex ? { x: endVertex.x, y: endVertex.y } : startWeld ? weldPlace(startWeld) : p;
  const except = end ? `${end.part.id}:${end.index}` : '';
  /** @type {WeldTarget | null} */
  let weld = null;
  let moved = false;
  stretch = { from, to: from };
  showWeldHint(null);
  drag(
    event,
    (q) => {
      moved ||= Math.hypot(q.x - from.x, q.y - from.y) > screen(3);
      weld = moved ? penWeld(q, except) : null;
      const place = weld ? weldPlace(weld) : null;
      stretch = { from, to: place ?? q };
      showWeldHint(place);
      paintOverlay();
    },
    (q, e) => {
      const to = stretch?.to ?? q;
      stretch = null;
      showWeldHint(null);
      if (!moved) return paintOverlay();
      if (end) continueLine(end, to, weld, sharp(e));
      else newLine(from, to, startWeld, weld, sharp(e));
    },
  );
}

/**
 * A new line of two points, each welded where it was pressed or released if it was on a point or a line.
 * @param {Point} from @param {Point} to @param {WeldTarget | null} fromWeld @param {WeldTarget | null} toWeld @param {boolean} corners
 */
function newLine(from, to, fromWeld, toWeld, corners) {
  if (fromWeld && toWeld && 'index' in fromWeld && 'index' in toWeld && fromWeld.part === toWeld.part && fromWeld.index === toWeld.index) return paintOverlay();
  /** @type {Vertex[]} */
  let vertices = [{ x: from.x, y: from.y }, { x: to.x, y: to.y }];
  if (!corners) smooth(vertices, [0, 1], false);
  const { ops, refs } = fromWeld || toWeld ? shareTargets([fromWeld, toWeld]) : { ops: [], refs: [] };
  vertices = vertices.map((v, i) => roundVertex(refs[i] ? { ...v, ref: /** @type {string} */ (refs[i]) } : v));
  addPart('line', { vertices, closed: false }, `Pen: line${refs.some(Boolean) ? ', welded' : ''}`, ops, false);
}

/**
 * Continues a line from one of its open ends with a new point (or closes it, if the point is its other end).
 * @param {{ part: import('../core/document.js').DocObject, index: number }} end @param {Point} to
 * @param {WeldTarget | null} weld @param {boolean} corners
 */
function continueLine(end, to, weld, corners) {
  const { part } = end;
  const atStart = end.index === 0;
  let vertices = verticesOf(part).map((v) => ({ ...v }));
  const otherEnd = atStart ? vertices.length - 1 : 0;
  // Dropped on the other end of the same line: it closes, as a shape with the auto fill. Other points of the same
  // line are not welded to (a part does not share its own points).
  const own = !!weld && weld.part === part.id;
  if (own && vertices.length > 2 && weld && 'index' in weld && weld.index === otherEnd) {
    smooth(vertices, [0, vertices.length - 1].filter((i) => isSmooth(vertices[i])), true);
    /** @type {Record<string, unknown>} */
    const props = { vertices: vertices.map(roundVertex), closed: true };
    if (part.fill === null && drawStyle.fill) props.fill = drawStyle.fill;
    run([{ op: 'set', target: part.id, props }], { select: part.id, note: `Pen: close ${part.id}` });
    return;
  }
  if (own) weld = null;
  /** @type {Vertex} */
  const added = { x: to.x, y: to.y };
  if (atStart) vertices.unshift(added);
  else vertices.push(added);
  const index = atStart ? 0 : vertices.length - 1;
  const neighbor = atStart ? 1 : vertices.length - 2;
  smooth(vertices, [...(corners ? [] : [index]), ...(isSmooth(vertices[neighbor]) ? [neighbor] : [])], false);
  /** @type {Operation[]} */
  let ops = [];
  if (weld) {
    const shared = shareTargets([weld]);
    ops = shared.ops;
    if (shared.refs[0]) vertices[index] = { ...vertices[index], ref: shared.refs[0] };
  }
  vertices = vertices.map(roundVertex);
  run([...ops, { op: 'set', target: part.id, props: { vertices } }], { select: part.id, note: `Pen: continue ${part.id}${weld ? ', welded' : ''}` });
}

/** Esc and changing tools: nothing of the Pen is left half done (each stretch is saved when released). */
export function cancelPen() {
  showWeldHint(null);
  return false;
}

export function setupDrawTools() {
  onToolDown('rect', (event) => boxDown(event, 'rect'));
  onToolDown('ellipse', (event) => boxDown(event, 'ellipse'));
  onToolDown('pen', penDown);
  svg.addEventListener('pointermove', (event) => {
    if (state.tool !== 'pen' || event.buttons) return;
    const p = toDoc(event);
    const end = openEndAt(p);
    if (end) {
      const v = verticesOf(end.part)[end.index];
      return showWeldHint({ x: v.x, y: v.y }, 'continue');
    }
    const weld = penWeld(p);
    showWeldHint(weld ? weldPlace(weld) : null);
  });
  addPainter((overlay) => {
    if (state.tool !== 'pen') return;
    const layer = activeVector();
    if (layer) paintLayerPoints(overlay, layer.id);
    if (!stretch) return;
    const { from, to } = stretch;
    overlay.append(
      element('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'pen-line' }),
      element('circle', { cx: from.x, cy: from.y, r: screen(3.5), class: 'pen-point' }),
      element('circle', { cx: to.x, cy: to.y, r: screen(4.5), class: 'pen-start' }),
    );
  });
}
