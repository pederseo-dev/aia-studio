// The Transform tools, for the parts of vector layers and for whole layers.
//   Select (V) does everything: click a part to pick it (Shift+click: add or take out), drag it to move (Shift:
//   straight; Alt: a copy), drag on empty space for a marquee (a click there goes back to the layer), the square
//   handles scale (Shift: keep proportions; Alt: from the origin), the round handle rotates (Shift: 15° steps).
//   A second click on the picked part edits the points of its layer (see pointEdit.js).
//   Move (M), Scale (S) and Rotate (T) do only that, dragging anywhere, as Moho's separate tools.
// With a layer selected, the tools change the layer's own transform (x, y, rotation, scale; Moho's Transform Layer):
// its parts' vertices stay as they are. Dragging on its content moves the layer; a click without moving picks the
// part. Parts are only geometry: transforming them rewrites their vertices, in their layer's coordinates.
// The origin (the crosshair) is what a part or a layer rotates and scales around: drag it to move it, double-click it
// to bring it back to the center. While dragging, the canvas shows a preview; one batch is saved when released.
// Everything here is measured on the artboard and turned into each object's own coordinates (core/transform.js).

import { findObject } from '../core/document.js';
import { IDENTITY, apply, around, bounds, multiply, originOf, rotate, round2, scale, transformPart, translate } from '../core/geometry.js';
import {
  conjugate,
  contentBounds,
  decompose,
  invert,
  isTransformed,
  layerMatrix,
  mapBox,
  moveLayerOrigin,
  parentWorldOf,
  pivotOf as layerPivot,
  transformOf,
  transformProps,
  worldOf,
} from '../core/transform.js';
import { copyOps } from '../core/copy.js';
import { partsToMove } from '../core/shapes.js';
import { addPainter, onToolDown, showPreview } from './canvas.js';
import { editPoints, inShownLayer, isLocked, run, select, selectMany, selectedParts, state, toggleSelect } from './state.js';
import { isPart } from './schema.js';
import { pointEditDown } from './pointEdit.js';
import { drag, element, screen, svg, toDoc } from './view.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/document.js').DocObject} DocObject
 * @typedef {import('../core/geometry.js').Matrix} Matrix
 * @typedef {import('../core/geometry.js').Box} Box
 * @typedef {import('./view.js').Point} Point
 * @typedef {{ parts: DocObject[], layer: DocObject | null }} Subject
 * @typedef {{ box: Box, f: Matrix }} Frame the box around a subject in a frame of its own, and that frame's matrix to the artboard
 */

const HANDLE = 7; // screen px
const ROTATE_GAP = 22; // screen px above the frame
const SNAP = 15; // degrees
const ORIGIN = 7; // screen px, half the crosshair

/** Each handle's place on the frame, from -1 to 1 (x right, y down). */
const HANDLES = /** @type {const} */ ({
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
});

/** @param {Box} b @param {number} hx @param {number} hy */
const onFrame = (b, hx, hy) => ({ x: b.x + ((hx + 1) / 2) * b.width, y: b.y + ((hy + 1) / 2) * b.height });

const isLayerType = (/** @type {string | undefined} */ type) => type === 'vector' || type === 'image' || type === 'group';

/**
 * What the tools transform: the selected layer (its own transform), or the picked parts.
 * @param {Doc | null} [doc] @returns {Subject}
 */
function subject(doc = state.document) {
  const only = doc && state.selection.length === 1 ? findObject(doc, state.selection[0]) : undefined;
  if (doc && isLayerType(only?.type)) return { parts: [], layer: only && !isLocked(only.id) ? only : null };
  const ids = new Set(state.selection);
  return { parts: doc ? doc.objects.filter((o) => ids.has(o.id) && isPart(o.type)) : [], layer: null };
}

/** Whether there is something to transform. @param {Subject} s */
const hasSubject = (s) => !!s.layer || s.parts.length > 0;

/** A part's box on the artboard. @param {Doc} doc @param {DocObject} part */
const worldBox = (doc, part) => {
  const box = bounds([part]);
  return box && mapBox(box, worldOf(doc, part.id));
};

/**
 * The frame of a subject: for parts, their box on the artboard; for a layer, its content in the layer's own turned
 * frame, so its handles scale along the layer's axes (and the frame turns with it).
 * @param {Subject} s @param {Doc} [doc] @returns {Frame | null}
 */
function frameOf(s, doc = /** @type {Doc} */ (state.document)) {
  if (s.layer) {
    const content = contentBounds(doc, s.layer);
    if (!content) return null;
    const t = transformOf(s.layer);
    const p = layerPivot(doc, s.layer);
    return {
      box: mapBox(content, around(p, scale(t.scaleX, t.scaleY))),
      f: multiply(parentWorldOf(doc, s.layer), multiply(translate(t.x, t.y), around(p, rotate(t.rotation)))),
    };
  }
  const boxes = s.parts.map((part) => worldBox(doc, part)).filter((b) => !!b);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { box: { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y }, f: IDENTITY };
}

/** The point a subject rotates and scales around, on the artboard: its origin, else the center of its frame. @param {Subject} s @param {Doc} [doc] */
function pivotOf(s, doc = /** @type {Doc} */ (state.document)) {
  if (s.layer) return apply(worldOf(doc, s.layer.id), layerPivot(doc, s.layer));
  const origin = s.parts.length === 1 ? originOf(s.parts[0]) : null;
  if (origin) return apply(worldOf(doc, s.parts[0].id), origin);
  const frame = frameOf(s, doc);
  return frame ? apply(frame.f, onFrame(frame.box, 0, 0)) : null;
}

/**
 * The props that change for a matrix that acts on the artboard: a layer's transform, or each part's vertices (in its
 * layer's coordinates).
 * @param {Subject} s @param {Matrix} m
 * @returns {Map<string, Record<string, unknown>>}
 */
function changesFor(s, m) {
  const doc = /** @type {Doc} */ (state.document);
  /** @type {Map<string, Record<string, unknown>>} */
  const changes = new Map();
  if (s.layer) {
    const matrix = multiply(conjugate(m, parentWorldOf(doc, s.layer)), layerMatrix(doc, s.layer));
    changes.set(s.layer.id, transformProps(doc, s.layer, decompose(doc, s.layer, matrix)));
  }
  // A fill moves the lines it follows (see partsToMove).
  for (const part of partsToMove(doc, s.parts)) changes.set(part.id, transformPart(part, conjugate(m, worldOf(doc, part.id))));
  return changes;
}

/** The saved document with a subject changed by a matrix (the preview of a drag). @param {Subject} s @param {Matrix} m */
function changedDoc(s, m) {
  const doc = /** @type {Doc} */ (state.document);
  const changes = changesFor(s, m);
  return { ...doc, objects: doc.objects.map((o) => (changes.has(o.id) ? { ...o, ...changes.get(o.id) } : o)) };
}

/** @param {Subject} s @param {string} verb */
const noteFor = (s, verb) => `${verb} ${s.layer ? s.layer.id : s.parts.length > 1 ? `${s.parts.length} parts` : s.parts[0].id}`;

/** Saves a transform of the subject, or copies of its parts. @param {Subject} s @param {Matrix} m @param {string} verb @param {boolean} [asCopy] */
function commit(s, m, verb, asCopy = false) {
  const doc = /** @type {Doc} */ (state.document);
  if (asCopy && s.parts.length) {
    // The originals go back to their place right away; the copies appear where they were dropped.
    showPreview(null);
    const { ops, ids } = copyOps(doc, s.parts, (part) => conjugate(m, worldOf(doc, part.id)));
    run(ops, { select: ids, note: noteFor(s, 'Copy of') });
    return;
  }
  const ops = [...changesFor(s, m)].map(([target, props]) => ({ op: 'set', target, props }));
  // The preview stays until the saved document arrives, so nothing jumps back to where it was.
  run(ops, { select: state.selection, note: noteFor(s, verb) }).finally(() => showPreview(null));
}

/** The part under the pointer that can be picked (not in a locked layer). @param {EventTarget | null} target */
export function partAt(target) {
  const id = /** @type {Element} */ (target)?.closest?.('.content [data-id]')?.getAttribute('data-id');
  const object = id && state.document ? findObject(state.document, id) : undefined;
  return object && isPart(object.type) && !isLocked(object.id) ? object : undefined;
}

/**
 * The image layer under the pointer that can be picked (not locked: a locked reference lets clicks through). An image
 * layer has no parts, so a click on its picture picks the layer itself.
 * @param {EventTarget | null} target
 */
export function imageAt(target) {
  const id = /** @type {Element} */ (target)?.closest?.('.content [data-id]')?.getAttribute('data-id');
  const object = id && state.document ? findObject(state.document, id) : undefined;
  return object?.type === 'image' && !isLocked(object.id) ? object : undefined;
}

/** The selected layer, if the part is inside it (then dragging the part moves the layer). @param {DocObject} part */
function selectedLayerHolding(part) {
  const doc = state.document;
  const s = subject();
  if (!doc || !s.layer) return null;
  for (let o = part.parent ? findObject(doc, part.parent) : undefined; o; o = o.parent ? findObject(doc, o.parent) : undefined) {
    if (o.id === s.layer.id) return s;
  }
  return null;
}

/**
 * Drags the subject by the pointer.
 * @param {PointerEvent} event @param {Subject} s
 * @param {() => void} [onClick] what a click without moving does
 */
function moveDrag(event, s, onClick) {
  const start = toDoc(event);
  /** @type {Matrix} */
  let m = translate(0, 0);
  let moved = false;
  drag(
    event,
    (p, e) => {
      let dx = p.x - start.x;
      let dy = p.y - start.y;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      moved ||= Math.hypot(dx, dy) > screen(2);
      m = translate(dx, dy);
      if (moved) showPreview(changedDoc(s, m));
    },
    (p, e) => {
      if (!moved) {
        showPreview(null);
        return onClick?.();
      }
      commit(s, m, 'Move', e.altKey);
    },
  );
}

/** Scales from a handle of the frame (Alt: from the origin), along the frame's axes. @param {PointerEvent} event @param {keyof typeof HANDLES} handle */
function handleScale(event, handle) {
  const s = subject();
  const frame = frameOf(s);
  const pivot = pivotOf(s);
  if (!frame || !pivot) return;
  const { box, f } = frame;
  const back = invert(f);
  const pivotInFrame = apply(back, pivot);
  const [hx, hy] = HANDLES[handle];
  /** @type {Matrix} */
  let m = translate(0, 0);
  drag(
    event,
    (world, e) => {
      const p = apply(back, world);
      const anchor = e.altKey ? pivotInFrame : onFrame(box, -hx, -hy);
      const grip = onFrame(box, hx, hy);
      /** @param {'x' | 'y'} axis @param {number} along */
      const factor = (axis, along) => {
        const span = grip[axis] - anchor[axis];
        if (!along || Math.abs(span) < 1e-6) return 1;
        const k = (p[axis] - anchor[axis]) / span;
        return Math.abs(k) < 0.01 ? Math.sign(k || 1) * 0.01 : k;
      };
      let sx = factor('x', hx);
      let sy = factor('y', hy);
      if (e.shiftKey) {
        const k = hx && hy ? (Math.abs(sx) > Math.abs(sy) ? sx : sy) : hx ? sx : sy;
        sx = Math.sign(sx || 1) * Math.abs(k);
        sy = Math.sign(sy || 1) * Math.abs(k);
      }
      // Scaled in the frame, seen on the artboard.
      m = multiply(f, multiply(around(anchor, scale(sx, sy)), back));
      showPreview(changedDoc(s, m));
    },
    () => commit(s, m, 'Scale'),
  );
}

/** Scales evenly around the origin by how far the pointer goes from it (the Scale tool). @param {PointerEvent} event */
function freeScale(event) {
  const s = subject();
  const pivot = pivotOf(s);
  if (!pivot) return;
  const start = toDoc(event);
  const from = Math.max(screen(4), Math.hypot(start.x - pivot.x, start.y - pivot.y));
  /** @type {Matrix} */
  let m = translate(0, 0);
  drag(
    event,
    (p) => {
      const k = Math.max(0.01, Math.hypot(p.x - pivot.x, p.y - pivot.y) / from);
      m = around(pivot, scale(k, k));
      showPreview(changedDoc(s, m));
    },
    () => commit(s, m, 'Scale'),
  );
}

/** Rotates around the origin. @param {PointerEvent} event */
function rotateDrag(event) {
  const s = subject();
  const pivot = pivotOf(s);
  if (!pivot) return;
  const start = toDoc(event);
  const startAngle = Math.atan2(start.y - pivot.y, start.x - pivot.x);
  /** @type {Matrix} */
  let m = translate(0, 0);
  drag(
    event,
    (p, e) => {
      let degrees = ((Math.atan2(p.y - pivot.y, p.x - pivot.x) - startAngle) * 180) / Math.PI;
      if (e.shiftKey) degrees = Math.round(degrees / SNAP) * SNAP;
      m = around(pivot, rotate(degrees));
      showPreview(changedDoc(s, m));
    },
    () => commit(s, m, 'Rotate'),
  );
}

/**
 * The props that put an owner's origin at a point of the artboard (null: back to the center). A transformed layer
 * makes up for it with its x, y, so it does not move.
 * @param {DocObject} owner @param {Point | null} world
 */
function originProps(owner, world) {
  const doc = /** @type {Doc} */ (state.document);
  const isLayer = isLayerType(owner.type);
  if (!world) {
    if (!isLayer || !isTransformed(owner)) return { originX: null, originY: null };
    const content = contentBounds(doc, owner);
    const center = content ? onFrame(content, 0, 0) : { x: 0, y: 0 };
    return { ...moveLayerOrigin(doc, owner, center), originX: null, originY: null };
  }
  const local = apply(invert(worldOf(doc, owner.id)), world);
  if (isLayer && isTransformed(owner)) return moveLayerOrigin(doc, owner, local);
  return { originX: round2(local.x), originY: round2(local.y) };
}

/** Drags the origin of the selected part or layer; a double-click puts it back at the center. @param {PointerEvent} event */
function originDrag(event) {
  const s = subject();
  const owner = s.layer ?? (s.parts.length === 1 ? s.parts[0] : null);
  if (!owner) return;
  if (event.detail >= 2) {
    run([{ op: 'set', target: owner.id, props: originProps(owner, null) }], { select: state.selection, note: `Origin of ${owner.id} to the center` });
    return;
  }
  const doc = /** @type {Doc} */ (state.document);
  /** @type {Record<string, unknown> | null} */
  let props = null;
  drag(
    event,
    (p) => {
      props = originProps(owner, p);
      showPreview({ ...doc, objects: doc.objects.map((o) => (o.id === owner.id ? { ...o, ...props } : o)) });
    },
    () => {
      if (!props) return showPreview(null);
      run([{ op: 'set', target: owner.id, props }], { select: state.selection, note: `Move the origin of ${owner.id}` }).finally(() => showPreview(null));
    },
  );
}

/** @param {PointerEvent} event */
function marquee(event) {
  const start = toDoc(event);
  const additive = event.shiftKey;
  const box = element('rect', { class: 'marquee' });
  svg.querySelector('.overlay')?.append(box);
  let dragged = false;
  /** @param {Point} p */
  const rectOf = (p) => ({
    x: Math.min(start.x, p.x),
    y: Math.min(start.y, p.y),
    width: Math.abs(p.x - start.x),
    height: Math.abs(p.y - start.y),
  });
  drag(
    event,
    (p) => {
      const r = rectOf(p);
      dragged ||= r.width > screen(3) || r.height > screen(3);
      for (const [k, v] of Object.entries(r)) box.setAttribute(k, String(v));
    },
    (p) => {
      box.remove();
      const doc = state.document;
      if (!doc) return;
      if (!dragged) {
        // A click on empty space: back from the parts to their layer, as in Moho.
        if (!additive && selectedParts().length) select(selectedParts()[0].parent);
        return;
      }
      const r = rectOf(p);
      const hits = doc.objects
        .filter((o) => isPart(o.type) && !isLocked(o.id) && inShownLayer(o.id))
        .filter((o) => {
          const b = worldBox(doc, o);
          return b && b.x <= r.x + r.width && b.x + b.width >= r.x && b.y <= r.y + r.height && b.y + b.height >= r.y;
        })
        .map((o) => o.id);
      selectMany(additive ? [...selectedParts().map((o) => o.id), ...hits] : hits);
    },
  );
}

/** What a pointerdown on a part does before the tool acts: pick it (Shift: toggle). Returns false if nothing is left to act on. @param {PointerEvent} event @param {DocObject} part */
function pick(event, part) {
  if (event.shiftKey) {
    toggleSelect(part.id);
    return false;
  }
  if (!state.selection.includes(part.id)) select(part.id);
  return true;
}

/** The handle under the pointer, if any. @param {PointerEvent} event */
const handleAt = (event) => /** @type {Element} */ (event.target).getAttribute?.('data-handle');

/** @param {PointerEvent} event */
function selectDown(event) {
  if (state.editing) return pointEditDown(event);
  const handle = handleAt(event);
  if (handle === 'origin') return originDrag(event);
  if (handle === 'rotate') return rotateDrag(event);
  if (handle) return handleScale(event, /** @type {keyof typeof HANDLES} */ (handle));
  const part = partAt(event.target);
  const image = part ? undefined : imageAt(event.target);
  if (image) {
    // Inside a selected group, dragging it moves the group, as for parts; otherwise it is picked and dragged.
    const group = selectedLayerHolding(image);
    if (group) return moveDrag(event, group, () => select(image.id));
    if (state.selected !== image.id) select(image.id);
    return moveDrag(event, subject());
  }
  if (!part) return marquee(event);
  // With its layer selected, dragging a part moves the layer, and a click picks the part.
  const layer = !event.shiftKey && selectedLayerHolding(part);
  if (layer) return moveDrag(event, layer, () => select(part.id));
  // A second click on the part that is already picked alone edits the points of its layer.
  const again = state.selection.length === 1 && state.selected === part.id;
  if (!pick(event, part)) return;
  moveDrag(event, subject(), again ? () => editPoints(part.id) : undefined);
}

/**
 * Move, Scale and Rotate: a pointerdown on a part picks it (unless its layer is selected), then a drag anywhere does
 * the tool's one thing (on the picked parts, or on the selected layer).
 * @param {(event: PointerEvent) => void} act
 */
const singleTool = (act) => (/** @type {PointerEvent} */ event) => {
  if (state.editing) return pointEditDown(event);
  const handle = handleAt(event);
  if (handle === 'origin') return originDrag(event);
  if (handle && handle !== 'rotate' && state.tool === 'scale') return handleScale(event, /** @type {keyof typeof HANDLES} */ (handle));
  const part = partAt(event.target);
  if (part && !selectedLayerHolding(part) && !pick(event, part)) return;
  const image = part ? undefined : imageAt(event.target);
  if (image && !selectedLayerHolding(image) && state.selected !== image.id) select(image.id);
  if (!hasSubject(subject())) return marquee(event);
  act(event);
};

/** @param {Point[]} points @returns {string} a closed polygon as path data */
const polygon = (points) => `M${points.map((p) => `${p.x} ${p.y}`).join('L')}Z`;

/** The frame around the subject with the handles the tool uses, and its origin. @param {SVGGElement} overlay @param {Doc} doc */
function paintSelection(overlay, doc) {
  if (state.editing) return;
  const s = subject(doc);
  if (!hasSubject(s)) return;
  if (s.parts.length > 1) {
    for (const part of s.parts) {
      const b = worldBox(doc, part);
      if (b) overlay.append(element('rect', { ...b, class: 'part-box' }));
    }
  }
  const frame = frameOf(s, doc);
  if (!frame) return;
  const { f } = frame;
  // The padding is on the screen: in the frame it is divided by the frame's own scale.
  const unit = Math.hypot(f[0], f[1]) || 1;
  const pad = screen(3) / unit;
  const b = { x: frame.box.x - pad, y: frame.box.y - pad, width: frame.box.width + pad * 2, height: frame.box.height + pad * 2 };
  /** @param {number} hx @param {number} hy */
  const at = (hx, hy) => apply(f, onFrame(b, hx, hy));
  overlay.append(element('path', { d: polygon([at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)]), class: `selection-box${s.layer ? ' layer' : ''}` }));
  const tool = state.tool;
  if (tool === 'select' || tool === 'rotate') {
    const top = at(0, -1);
    const center = at(0, 0);
    const length = Math.hypot(top.x - center.x, top.y - center.y) || 1;
    const knob = { x: top.x + ((top.x - center.x) / length) * screen(ROTATE_GAP), y: top.y + ((top.y - center.y) / length) * screen(ROTATE_GAP) };
    overlay.append(
      element('line', { x1: top.x, y1: top.y, x2: knob.x, y2: knob.y, class: 'rotate-line' }),
      element('circle', { cx: knob.x, cy: knob.y, r: screen(HANDLE / 2 + 1), class: 'handle rotate', 'data-handle': 'rotate' }),
    );
  }
  if (tool === 'select' || tool === 'scale') {
    const size = screen(HANDLE);
    for (const [name, [x, y]] of Object.entries(HANDLES)) {
      const c = at(x, y);
      overlay.append(
        element('rect', { x: c.x - size / 2, y: c.y - size / 2, width: size, height: size, class: `handle scale ${name}`, 'data-handle': name }),
      );
    }
  }
  // The origin of a single part or of the layer: a crosshair that can be dragged.
  const owner = s.layer ?? (s.parts.length === 1 ? s.parts[0] : null);
  const pivot = owner && pivotOf(s, doc);
  if (pivot) {
    const r = screen(ORIGIN);
    const set = !!originOf(/** @type {DocObject} */ (owner));
    overlay.append(
      element('path', { d: `M${pivot.x - r} ${pivot.y}H${pivot.x + r}M${pivot.x} ${pivot.y - r}V${pivot.y + r}`, class: 'origin-cross' }),
      element('circle', { cx: pivot.x, cy: pivot.y, r: screen(4), class: `handle origin${set ? ' set' : ''}`, 'data-handle': 'origin' }),
    );
  }
}

/**
 * Moves the selected layer, or the picked parts, by an offset on the artboard (the arrow keys).
 * @param {number} dx @param {number} dy
 */
export function nudgeSelection(dx, dy) {
  const s = subject();
  if (!hasSubject(s)) return false;
  commit(s, translate(dx, dy), 'Nudge');
  return true;
}

/**
 * Flip horizontal / vertical of what is selected: the picked parts mirror across the middle of their box (their
 * vertices change), a selected layer across the middle of its content (its own transform changes, its parts stay).
 * @param {boolean} horizontal
 */
export function flipSelection(horizontal) {
  const s = subject();
  const frame = hasSubject(s) ? frameOf(s) : null;
  if (!frame) return false;
  const local = around(onFrame(frame.box, 0, 0), horizontal ? scale(-1, 1) : scale(1, -1));
  commit(s, multiply(frame.f, multiply(local, invert(frame.f))), horizontal ? 'Flip horizontally' : 'Flip vertically');
  return true;
}

export function setupSelectTool() {
  onToolDown('select', selectDown);
  onToolDown('move', singleTool((event) => moveDrag(event, subject())));
  onToolDown('scale', singleTool(freeScale));
  onToolDown('rotate', singleTool(rotateDrag));
  addPainter(paintSelection);
}
