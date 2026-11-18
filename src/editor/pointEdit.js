// Point editing, the second level of selection, as in Moho: a second click on the picked part shows the points of
// every part of its vector layer (hidden ones too, as ghosts; locked layers excepted).
//   Click a point: pick it (Shift: add or take out); its part becomes the main one. Drag a point: move the picked
//   points, whatever part they belong to (Shift: straight). Drag on empty space: a marquee over the points.
//   The round knobs of a picked point are its curve handles: on a smooth point the other handle turns with the one
//   dragged; on a broken one each moves alone. Shift while dragging, as in Moho, breaks a smooth point or makes a
//   broken one smooth. A welded point shows the handles of every line that meets there (hover one: its line lights
//   up), so each line's curve can be set. Alt+click a point: corner ↔ curve. Del: delete the picked points (a part
//   left with fewer than 2 goes with them). Click on a line or inside a shape of the layer: pick all its points
//   (Shift: add them or take them out) and drag to move them. With Add point on, as Moho's Add Point, a click on a
//   line adds a point there without changing its shape instead (drag to move it at once). A click on empty space, or
//   Esc, ends it.
// Weld (decision 6): a point dropped on a point of another part shares it from then on ({ ref: "jaw.chin" }; the
//   target point gets a name if it has none), dropped on a line of another part it shares a point added there, and
//   the two ends of one line close it. Alt: two open ends of different lines become one line. Shared points show
//   round. Unweld makes them separate points again (there is no Weld button: Auto weld does it). A picked point can
//   be named, and picked points gathered in the point groups of the layer.
// Each change is one batch, even when it touches several parts.

import { findObject } from '../core/document.js';
import { pointOf } from '../core/points.js';
import { deletePointsOps, followOps, groupOps, isShared, namePoint, shareTargets as shareTargetsIn, stretchBetween, unweld, weld } from '../core/weld.js';
import { alignHandle, flipAcross, insertVertex, isSmooth, nearestOnOutline, roundVertex, shapePoint, transformVertices, translate, verticesOf } from '../core/geometry.js';
import { partData } from '../core/draw.js';
import { addPainter, paintOverlay, showPreview } from './canvas.js';
import { isPart } from './schema.js';
import { addPoint, autoWeld, editPoints, inShownLayer, isLocked, notify, pickPoints, run, select, state } from './state.js';
import { drag, element, screen, svg, toDoc } from './view.js';
import { IDENTITY, apply } from '../core/geometry.js';
import { invert, worldOf } from '../core/transform.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/document.js').DocObject} DocObject
 * @typedef {import('../core/geometry.js').Vertex} Vertex
 * @typedef {import('../core/geometry.js').Matrix} Matrix
 * @typedef {import('./view.js').Point} Point
 * @typedef {import('../core/operations.js').Operation} Operation
 */

const POINT = 7; // screen px
const KNOB = 4; // screen px radius

/** @param {string} part @param {number} index */
const keyOf = (part, index) => `${part}:${index}`;
/** @param {string} key @returns {[string, number]} */
const parseKey = (key) => {
  const at = key.lastIndexOf(':');
  return [key.slice(0, at), Number(key.slice(at + 1))];
};

/**
 * The parts whose points can be edited or welded to: a layer's (the edited one by default), in a shown layer and
 * not locked.
 * @param {Doc | null} [doc] @param {string | null} [layer]
 */
function editableParts(doc = state.document, layer = state.editing) {
  if (!doc || !layer) return [];
  return doc.objects.filter((o) => o.parent === layer && isPart(o.type) && inShownLayer(o.id) && !isLocked(o.id));
}

/** From a layer's coordinates to the artboard's (its parts' vertices are in its coordinates). @param {string | null | undefined} layer */
const layerWorld = (layer) => (state.document && layer ? worldOf(state.document, layer) : IDENTITY);
/** A point of the artboard in a layer's coordinates. @param {string | null | undefined} layer @param {Point} p */
export const toLayer = (layer, p) => apply(invert(layerWorld(layer)), p);
/** A point in a layer's coordinates on the artboard. @param {string | null | undefined} layer @param {Point} p */
export const fromLayer = (layer, p) => apply(layerWorld(layer), p);
/** A length of `px` screen pixels in a layer's units (a scaled layer has bigger or smaller units). @param {string | null | undefined} layer @param {number} px */
export const layerScreen = (layer, px) => {
  const w = layerWorld(layer);
  return screen(px) / (Math.hypot(w[0], w[1]) || 1);
};
/** Where the pointer is in the edited layer's coordinates. @param {{ clientX: number, clientY: number }} event */
const pointerInLayer = (event) => toLayer(state.editing, toDoc(event));

/** The picked points grouped by part: { part id: [indices] }. */
function pickedByPart() {
  /** @type {Map<string, number[]>} */
  const groups = new Map();
  for (const key of state.points) {
    const [part, index] = parseKey(key);
    groups.set(part, [...(groups.get(part) ?? []), index]);
  }
  return groups;
}

/** The new vertices of each part when the picked points move by `m`. @param {Matrix} m */
function movedPicked(m) {
  const doc = /** @type {Doc} */ (state.document);
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  for (const [id, indices] of pickedByPart()) {
    const part = findObject(doc, id);
    if (part) changes.set(id, transformVertices(part, indices, m).vertices);
  }
  return changes;
}

/** The saved document with some parts' vertices replaced (a preview). @param {Map<string, Vertex[]>} changes */
function withVertices(changes) {
  const doc = /** @type {Doc} */ (state.document);
  return { ...doc, objects: doc.objects.map((o) => (changes.has(o.id) ? { ...o, vertices: changes.get(o.id) } : o)) };
}

/** Saves new vertices for one or more parts as one batch. @param {Map<string, Vertex[]>} changes @param {string} note */
function save(changes, note) {
  if (!changes.size) return showPreview(null);
  // The preview stays until the saved document arrives, so the points never jump back to where they were.
  run(
    [...changes].map(([id, vertices]) => ({ op: 'set', target: id, props: { vertices: vertices.map(roundVertex) } })),
    { select: state.selected, note },
  ).finally(() => showPreview(null));
}

/** @param {number} count */
const pointsWord = (count) => (count > 1 ? `${count} points` : 'a point');

/** @param {PointerEvent} event @param {DocObject} part @param {number} index */
function pointDown(event, part, index) {
  if (event.altKey) return toggleCorner(part, index);
  const key = keyOf(part.id, index);
  if (event.shiftKey) {
    pickPoints(state.points.includes(key) ? state.points.filter((k) => k !== key) : [...state.points, key], part.id);
    return;
  }
  if (!state.points.includes(key)) pickPoints([key], part.id);
  const start = pointerInLayer(event);
  /** @type {Map<string, Vertex[]> | null} */
  let changes = null;
  drag(
    event,
    (world, e) => {
      const p = toLayer(state.editing, world);
      let dx = p.x - start.x;
      let dy = p.y - start.y;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      if (!changes && Math.hypot(dx, dy) < screen(2)) return;
      changes = movedPicked(translate(dx, dy));
      // Auto weld shows where the point would weld if it were dropped here.
      const target = autoWeld.on && state.points.length === 1 ? weldTargetNear(p, key) : null;
      weldHint = target && weldOps(key, target, e.altKey) ? weldPlace(target) : null;
      hintKind = 'weld';
      hintLayer = state.editing;
      showPreview(withVertices(changes));
    },
    (world, e) => {
      const p = toLayer(state.editing, world);
      weldHint = null;
      if (!changes) {
        // A click without moving on one of several picked points picks only it.
        if (state.points.length > 1) pickPoints([key], part.id);
        return showPreview(null);
      }
      // Auto weld: a point dropped on another point, or on a line of another part, welds to it (Alt: two open
      // ends become one line).
      if (autoWeld.on && state.points.length === 1) {
        const target = weldTargetNear(p, key);
        const welded = target && weldOps(key, target, e.altKey);
        if (welded) {
          applyWeld(welded).finally(() => showPreview(null));
          return;
        }
      }
      save(changes, `Move ${pointsWord(state.points.length)}`);
    },
  );
}

/** @param {PointerEvent} event @param {DocObject} part @param {number} index @param {'in' | 'out'} side */
function knobDown(event, part, index, side) {
  const vertices = structuredClone(verticesOf(part));
  const vertex = vertices[index];
  // What the point is now decides: a smooth point turns its other handle with this one, a broken one moves only this
  // one. Shift, as in Moho, does the opposite while it is held: it breaks a smooth point, or makes a broken one smooth.
  const smooth = isSmooth(vertex);
  let moved = false;
  drag(
    event,
    (world, e) => {
      const p = toLayer(state.editing, world);
      moved = true;
      vertex[side] = { x: p.x - vertex.x, y: p.y - vertex.y };
      if (smooth !== e.shiftKey) alignHandle(vertex, side);
      showPreview(withVertices(new Map([[part.id, vertices]])));
    },
    () => (moved ? save(new Map([[part.id, vertices]]), `Curve a point of ${part.id}`) : showPreview(null)),
  );
}

/**
 * A click on a line or inside a shape of the edited layer: picks all its points and drags them (Shift: adds them to
 * the picked ones, or takes them out if they all were).
 * @param {PointerEvent} event @param {DocObject} part
 */
function partDown(event, part) {
  const keys = verticesOf(part).map((_, index) => keyOf(part.id, index));
  if (event.shiftKey) {
    const all = keys.every((k) => state.points.includes(k));
    pickPoints(all ? state.points.filter((k) => !keys.includes(k)) : [...state.points, ...keys], part.id);
    return;
  }
  pickPoints(keys, part.id);
  const start = pointerInLayer(event);
  /** @type {Map<string, Vertex[]> | null} */
  let changes = null;
  drag(
    event,
    (world, e) => {
      const p = toLayer(state.editing, world);
      let dx = p.x - start.x;
      let dy = p.y - start.y;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      if (!changes && Math.hypot(dx, dy) < screen(2)) return;
      changes = movedPicked(translate(dx, dy));
      showPreview(withVertices(changes));
    },
    () => (changes ? save(changes, `Move ${part.id}`) : showPreview(null)),
  );
}

/** Alt+click: a curve point becomes a corner, a corner becomes a smooth curve. @param {DocObject} part @param {number} index */
function toggleCorner(part, index) {
  const vertices = structuredClone(verticesOf(part));
  const corner = !!(vertices[index].in || vertices[index].out);
  shapePoint(vertices, index, part.closed !== false, corner);
  pickPoints([keyOf(part.id, index)], part.id);
  save(new Map([[part.id, vertices]]), `${corner ? 'Corner' : 'Curve'} at a point of ${part.id}`);
}

/** Whether every picked point is a corner (no handles). */
export function pickedAreCorners() {
  const doc = state.document;
  if (!doc) return true;
  return state.points.every((key) => {
    const [id, index] = parseKey(key);
    const v = verticesOf(findObject(doc, id) ?? { id, type: 'path', parent: null })[index];
    return !v?.in && !v?.out;
  });
}

/** The Corner / Curve button: makes every picked point a curve, or a corner if they are all curves already. */
export function toggleCornersPicked() {
  const doc = state.document;
  if (!doc || !state.points.length) return;
  const corner = !pickedAreCorners();
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  for (const [id, indices] of pickedByPart()) {
    const part = findObject(doc, id);
    if (!part) continue;
    const vertices = structuredClone(verticesOf(part));
    for (const index of indices) shapePoint(vertices, index, part.closed !== false, corner);
    changes.set(id, vertices);
  }
  save(changes, `${corner ? 'Corner' : 'Curve'} at ${pointsWord(state.points.length)}`);
}

/** @param {PointerEvent} event */
function pointMarquee(event) {
  const start = toDoc(event);
  const additive = event.shiftKey;
  const box = element('rect', { class: 'marquee' });
  svg.querySelector('.overlay')?.append(box);
  let dragged = false;
  /** @param {Point} p */
  const rectOf = (p) => ({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) });
  drag(
    event,
    (p) => {
      const r = rectOf(p);
      dragged ||= r.width > screen(3) || r.height > screen(3);
      for (const [k, v] of Object.entries(r)) box.setAttribute(k, String(v));
    },
    (p) => {
      box.remove();
      if (!dragged) return editPoints(null);
      const r = rectOf(p);
      const hits = editableParts().flatMap((part) =>
        verticesOf(part)
          .map((v, i) => {
            const w = fromLayer(state.editing, v);
            return w.x >= r.x && w.x <= r.x + r.width && w.y >= r.y && w.y <= r.y + r.height ? keyOf(part.id, i) : '';
          })
          .filter(Boolean),
      );
      const main = hits.length ? parseKey(hits.at(-1) ?? '')[0] : undefined;
      pickPoints(additive ? [...state.points, ...hits] : hits, main);
    },
  );
}

const LINE_REACH = 5; // screen px: how near the line of an outline a click adds a point

/** The line of an editable outline under a point, if one is within reach. @param {Point} p */
function lineAt(p) {
  /** @type {{ part: DocObject, segment: number, t: number, point: Point, distance: number } | null} */
  let best = null;
  for (const part of editableParts()) {
    const hit = nearestOnOutline(part, p);
    if (hit && hit.distance <= layerScreen(state.editing, LINE_REACH) && (!best || hit.distance < best.distance)) best = { part, ...hit };
  }
  return best;
}

/** Adds a point on a line and follows the pointer with it; one batch when released. @param {PointerEvent} event @param {DocObject} part @param {number} segment @param {number} t */
function addPointDown(event, part, segment, t) {
  hover = null;
  const { vertices, index } = insertVertex(part, segment, t);
  const key = keyOf(part.id, index);
  pickPoints([key], part.id);
  const start = pointerInLayer(event);
  let changed = vertices;
  showPreview(withVertices(new Map([[part.id, changed]])));
  drag(
    event,
    (world) => {
      const p = toLayer(state.editing, world);
      const m = translate(p.x - start.x, p.y - start.y);
      changed = transformVertices({ ...part, vertices }, [index], m).vertices;
      showPreview(withVertices(new Map([[part.id, changed]])));
    },
    () => save(new Map([[part.id, changed]]), `Add a point to ${part.id}`),
  );
}

/** @type {Point | null} where a click would add a point (shown while the pointer is near a line) */
let hover = null;
/** @type {string | null} the part whose curve handle is under the pointer (its line lights up) */
let knobPart = null;
/** @type {string | null} the curve handle under the pointer, "part|index|side" (it grows a little) */
let knobKey = null;

/** The pointerdown of the Transform tools while points are being edited. @param {PointerEvent} event */
export function pointEditDown(event) {
  const doc = state.document;
  if (!doc || !state.editing) return editPoints(null);
  const target = /** @type {Element} */ (event.target);
  const point = target.getAttribute?.('data-point');
  const knob = target.getAttribute?.('data-knob');
  const hit = point ?? knob;
  if (hit) {
    const [id, index, side] = hit.split('|');
    const part = findObject(doc, id);
    if (!part) return;
    if (side) return knobDown(event, part, Number(index), /** @type {'in' | 'out'} */ (side));
    return pointDown(event, part, Number(index));
  }
  const onLine = lineAt(pointerInLayer(event));
  if (onLine && addPoint.on) return addPointDown(event, onLine.part, onLine.segment, onLine.t);
  if (onLine) return partDown(event, onLine.part);
  const id = target.closest?.('.content [data-id]')?.getAttribute('data-id');
  const other = id ? findObject(doc, id) : undefined;
  if (other && isPart(other.type) && !isLocked(other.id)) {
    // A shape of the same layer: all its points; a part of another layer ends point editing and is picked.
    if (other.parent === state.editing) return partDown(event, other);
    return select(other.id);
  }
  pointMarquee(event);
}

/**
 * Del while editing points: removes the picked ones, in one step. A part left with fewer than 2 points (an outline
 * needs 2) is deleted with them; points of other parts welded to it stay where they were, as points of their own.
 */
export function deletePoints() {
  const doc = state.document;
  if (!doc || !state.editing || !state.points.length) return false;
  const count = state.points.length;
  const { ops, gone } = deletePointsOps(doc, state.points.map(atOf));
  // Point editing goes on with a part of the layer that stays (the main one before the batch lands, so editing does
  // not end with the deleted one); with none left, the layer is selected. The picked points clear only once it is
  // saved, so a refused batch leaves them picked.
  const stays = state.selected && !gone.includes(state.selected) ? state.selected : editableParts(doc).find((p) => !gone.includes(p.id))?.id;
  if (stays) pickPoints(state.points, stays);
  const picked = state.points;
  const note = gone.length ? `Delete ${pointsWord(count)} and ${gone.join(', ')}` : `Delete ${pointsWord(count)}`;
  run(ops, { select: stays ?? state.editing, note }).then(() => {
    if (!state.notice && state.points === picked) pickPoints([]);
  });
  return true;
}

/** Arrow keys while editing points: nudge the picked ones. @param {number} dx @param {number} dy */
export function nudgePoints(dx, dy) {
  if (!state.editing || !state.points.length) return false;
  save(movedPicked(translate(dx, dy)), `Nudge ${pointsWord(state.points.length)}`);
  return true;
}

/**
 * Flip horizontal / vertical while editing points: the picked points (and their curve handles) mirror across the
 * middle of their box, in the layer's coordinates, as Moho's Flip Points. @param {boolean} horizontal
 */
export function flipPoints(horizontal) {
  if (!state.editing || !state.points.length) return false;
  const places = state.points.map((key) => pointAt(key)?.vertex).filter((v) => !!v);
  if (!places.length) return false;
  save(movedPicked(flipAcross(places, horizontal)), `Flip ${pointsWord(state.points.length)} ${horizontal ? 'horizontally' : 'vertically'}`);
  return true;
}

const WELD_DISTANCE = 8; // screen px
const WELD_HINT = 8; // screen px, the radius of the ring that shows where a weld would happen

/**
 * @typedef {import('../core/weld.js').PointAt} PointAt
 * @typedef {PointAt | { part: string, segment: number, t: number, point: Point }} WeldTarget a point, or a place on a line (and where it is)
 * @typedef {{ ops: Operation[], keep: string, pick: string[], note: string }} Weld
 */

/** @type {Point | null} where the point being dragged or drawn would weld (a ring on the canvas), in hintLayer's coordinates */
let weldHint = null;
/** @type {string | null | undefined} */
let hintLayer = null;
/** @type {'weld' | 'continue'} what the ring means: a weld, or an end the Pen would continue */
let hintKind = 'weld';

/**
 * Shows where a weld would happen, or nothing with null.
 * @param {Point | null} p in the layer's coordinates @param {'weld' | 'continue'} [kind] @param {string | null} [layer]
 */
export function showWeldHint(p, kind = 'weld', layer = state.editing) {
  if (p?.x === weldHint?.x && p?.y === weldHint?.y && kind === hintKind && layer === hintLayer) return;
  weldHint = p;
  hintKind = kind;
  hintLayer = layer;
  paintOverlay();
}

/** Where a weld target is. @param {WeldTarget} target @returns {Point} */
export function weldPlace(target) {
  if (!('index' in target)) return target.point;
  const v = verticesOf(/** @type {DocObject} */ (findObject(/** @type {Doc} */ (state.document), target.part)))[target.index];
  return { x: v.x, y: v.y };
}

/**
 * Where a point dropped at `p` would weld: the nearest point of the layer within reach (other than itself), or else
 * the nearest line of another part.
 * @param {Point} p @param {string} except the dropped point, "part:index" ('' for none)
 * @param {string | null} [layer] the edited layer by default
 * @returns {WeldTarget | null}
 */
export function weldTargetNear(p, except, layer = state.editing) {
  const [exceptPart] = except ? parseKey(except) : [''];
  let best = '';
  let bestDistance = layerScreen(layer, WELD_DISTANCE);
  for (const part of editableParts(state.document, layer)) {
    for (const [index, v] of verticesOf(part).entries()) {
      const key = keyOf(part.id, index);
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (key !== except && d <= bestDistance) {
        best = key;
        bestDistance = d;
      }
    }
  }
  if (best) return atOf(best);
  /** @type {{ part: DocObject, segment: number, t: number, point: Point, distance: number } | null} */
  let line = null;
  for (const part of editableParts(state.document, layer)) {
    if (part.id === exceptPart) continue;
    const hit = nearestOnOutline(part, p);
    if (hit && hit.distance <= layerScreen(layer, WELD_DISTANCE) && (!line || hit.distance < line.distance)) line = { part, ...hit };
  }
  return line && { part: line.part.id, segment: line.segment, t: line.t, point: line.point };
}

/** @param {string} key "part:index" @returns {PointAt} */
const atOf = (key) => {
  const [part, index] = parseKey(key);
  return { part, index };
};

/**
 * What welding a point to a target does (see weld in core/weld.js), or null if it cannot be done.
 * @param {string} moving "part:index" @param {WeldTarget} target @param {boolean} [merge]
 * @returns {import('../core/weld.js').Weld | null}
 */
function weldOps(moving, target, merge = false) {
  if (!state.document) return null;
  try {
    return weld(state.document, atOf(moving), target, { merge });
  } catch {
    return null;
  }
}

/** Saves a weld; the part that stays becomes the main one first, so point editing goes on. @param {import('../core/weld.js').Weld} w */
function applyWeld(w) {
  pickPoints(w.pick.map((at) => keyOf(at.part, at.index)), w.keep);
  return run(w.ops, { select: w.keep, note: w.note });
}

/** A picked point as { part, index, vertex }. @param {string} key */
function pointAt(key) {
  const [id, index] = parseKey(key);
  const part = state.document ? findObject(state.document, id) : undefined;
  const vertex = part ? verticesOf(part)[index] : undefined;
  return part && vertex ? { part, index, vertex } : null;
}

/** Whether a picked point is welded (it shares a point, or another shares it). */
export function canUnweld() {
  const doc = state.document;
  return !!doc && state.points.some((key) => {
    const at = pointAt(key);
    return !!at && (!!at.vertex.ref || isShared(doc, at.part, at.vertex));
  });
}

/** Unweld: the picked points stop sharing; each vertex keeps its place as a point of its own. */
export function unweldPicked() {
  if (!state.document) return;
  try {
    run(unweld(state.document, state.points.map(atOf)), { select: state.selected, note: `Unweld ${pointsWord(state.points.length)}` });
  } catch (e) {
    notify(e.message);
  }
}

/** The stretch between the two picked points, if it can follow another part. */
function pickedStretch() {
  if (!state.document || state.points.length !== 2) return null;
  try {
    return stretchBetween(state.document, atOf(state.points[0]), atOf(state.points[1]));
  } catch {
    return null;
  }
}

/** Whether the two picked points make a stretch that can follow another part (or already does). */
export function canFollow() {
  return !!pickedStretch();
}

/** Whether the picked stretch follows another part now. */
export function pickedFollows() {
  return !!pickedStretch()?.follows;
}

/**
 * Follow: the stretch between the two picked points (shared points of another part) follows that part's curve; on a
 * stretch that follows, it stops. Alt+click: the long way round (or back to the short one).
 * @param {boolean} [otherWay]
 */
export function followPicked(otherWay = false) {
  const s = pickedStretch();
  if (!s || !state.document) return notify('Pick two neighbor points of a part that share points of another part, to follow its curve between them');
  /** @type {'short' | 'long' | 'off'} */
  const how = s.follows && !otherWay ? 'off' : (s.follows ? !s.long : otherWay) ? 'long' : 'short';
  const { ops, note } = followOps(state.document, atOf(state.points[0]), atOf(state.points[1]), how);
  run(ops, { select: state.selected, note });
}

/** The one picked point, if exactly one is picked. */
export function pickedPoint() {
  return state.points.length === 1 ? pointAt(state.points[0]) : null;
}

/**
 * Names the picked point (empty: no name, if nothing uses it). Shared points and groups follow the new name.
 * @param {string} typed
 */
export function renamePickedPoint(typed) {
  const at = pickedPoint();
  if (!state.document || !at) return;
  try {
    const { ops, name } = namePoint(state.document, { part: at.part.id, index: at.index }, typed);
    if (ops.length) run(ops, { select: state.selected, note: name ? `Name a point ${at.part.id}.${name}` : `Unname a point of ${at.part.id}` });
  } catch (e) {
    notify(e.message);
  }
}

/** The point groups of the edited layer. @returns {Record<string, string[]>} */
export function pointGroups() {
  const layer = state.document && state.editing ? findObject(state.document, state.editing) : undefined;
  return /** @type {Record<string, string[]>} */ (layer?.groups ?? {});
}

/** Picks the points of a group. @param {string} group */
export function pickGroup(group) {
  const doc = state.document;
  if (!doc) return;
  const keys = (pointGroups()[group] ?? []).flatMap((ref) => {
    const at = pointOf(doc, ref);
    return at ? [keyOf(at.part.id, at.index)] : [];
  });
  pickPoints(keys, keys.length ? parseKey(keys[keys.length - 1])[0] : undefined);
}

/**
 * Changes the point groups of the edited layer with the picked points: a new group of them, add them to a group,
 * take them out of it, or delete the group.
 * @param {'new' | 'add' | 'remove' | 'delete'} action @param {string} group
 */
export function editGroup(action, group) {
  if (!state.document || !state.editing) return;
  if (action === 'new' && group in pointGroups()) return notify(`There is a group "${group}" already: use + to add to it`);
  try {
    const { ops, name } = groupOps(state.document, state.editing, action === 'new' ? 'set' : action, group, state.points.map(atOf));
    const notes = { new: `New point group ${name}`, add: `Add to ${name}`, remove: `Take out of ${name}`, delete: `Delete the group ${name}` };
    run(ops, { select: state.selected, note: notes[action] });
  } catch (e) {
    notify(e.message);
  }
}

/**
 * What a new outline (the Pen) needs to weld some of its vertices as it is created (see shareTargets in core/weld.js).
 * @param {(WeldTarget | null)[]} targets one per vertex of the new outline
 */
export function shareTargets(targets) {
  return shareTargetsIn(/** @type {Doc} */ (state.document), targets);
}

/** The points of a layer as small dots, to weld to while drawing (not editable). @param {SVGGElement} overlay @param {string} layer */
export function paintLayerPoints(overlay, layer) {
  const size = screen(4);
  for (const part of editableParts(state.document, layer)) {
    for (const v of verticesOf(part)) {
      const w = fromLayer(layer, v);
      overlay.append(element('rect', { x: w.x - size / 2, y: w.y - size / 2, width: size, height: size, class: `layer-point${v.ref ? ' shared' : ''}` }));
    }
  }
}

/** Esc: ends point editing (the main part stays picked). */
export function stopEditing() {
  if (!state.editing) return false;
  editPoints(null);
  return true;
}

/** @param {SVGGElement} overlay @param {Doc} doc */
function paintPoints(overlay, doc) {
  const parts = editableParts(doc);
  if (!parts.length) return;
  const w = layerWorld(state.editing);
  // The outlines are drawn in the layer's coordinates; the points and knobs on the artboard, so they keep their size.
  const outlines = element('g', { transform: `matrix(${w.join(' ')})` });
  for (const part of parts) {
    const kind = `${part.id === state.selected ? ' main' : ''}${part.id === knobPart ? ' knob-hover' : ''}`;
    outlines.append(element('path', { d: partData(part), class: `edit-outline${kind}` }));
  }
  overlay.append(outlines);
  /** @param {Point} p */
  const on = (p) => apply(w, p);
  if (hover) {
    const h = on(hover);
    overlay.append(element('circle', { cx: h.x, cy: h.y, r: screen(KNOB), class: 'add-point' }));
  }
  const sharedNames = new Set(parts.flatMap((part) => verticesOf(part).flatMap((v) => (v.ref ? [v.ref] : []))));
  /** The welded point a vertex stands on ("part.name"), if any. @param {DocObject} part @param {Vertex} v */
  const weldedAt = (part, v) => v.ref ?? (v.name && sharedNames.has(`${part.id}.${v.name}`) ? `${part.id}.${v.name}` : null);
  // A picked welded point shows the handles of every line that meets there, not only the picked vertex's.
  const pickedWelds = new Set(
    parts.flatMap((part) =>
      verticesOf(part).flatMap((v, index) => {
        const at = state.points.includes(keyOf(part.id, index)) && weldedAt(part, v);
        return at ? [at] : [];
      }),
    ),
  );
  const size = screen(POINT);
  for (const part of parts) {
    const vertices = verticesOf(part);
    const closed = part.closed !== false;
    for (const [index, v] of vertices.entries()) {
      const picked = state.points.includes(keyOf(part.id, index));
      const at = weldedAt(part, v);
      if (!picked && !(at && pickedWelds.has(at))) continue;
      const before = vertices[index - 1] ?? (closed ? vertices.at(-1) : undefined);
      for (const side of /** @type {const} */ (['in', 'out'])) {
        const h = v[side];
        if (!h) continue;
        // A stretch that follows another part draws that part's curve: its own handles there do nothing, so they
        // are not shown (the out of a vertex that follows, the in of the vertex after it).
        if (side === 'out' ? v.follow : before?.follow) continue;
        const end = on({ x: v.x + h.x, y: v.y + h.y });
        const from = on(v);
        const key = `${part.id}|${index}|${side}`;
        const kind = `${picked ? '' : ' joined'}${key === knobKey ? ' hover' : ''}`;
        overlay.append(
          element('line', { x1: from.x, y1: from.y, x2: end.x, y2: end.y, class: `knob-line${kind}` }),
          // Its size is in screen px (screen()), so it stays the same at any zoom; a little bigger under the pointer.
          element('circle', { cx: end.x, cy: end.y, r: screen(key === knobKey ? KNOB + 1.5 : KNOB), class: `handle knob${kind}`, 'data-knob': key }),
        );
      }
    }
    for (const [index, v] of vertices.entries()) {
      const picked = state.points.includes(keyOf(part.id, index));
      const shared = !!v.ref || sharedNames.has(`${part.id}.${v.name}`);
      const at = on(v);
      overlay.append(
        element('rect', {
          x: at.x - size / 2,
          y: at.y - size / 2,
          width: size,
          height: size,
          ...(shared ? { rx: size / 2 } : {}),
          class: `handle point${picked ? ' picked' : ''}${shared ? ' shared' : ''}`,
          'data-point': `${part.id}|${index}`,
        }),
      );
    }
  }
}

export function setupPointEdit() {
  addPainter(paintPoints);
  addPainter((overlay) => {
    if (!weldHint) return;
    const at = fromLayer(hintLayer, weldHint);
    overlay.append(element('circle', { cx: at.x, cy: at.y, r: screen(WELD_HINT), class: `weld-hint${hintKind === 'continue' ? ' continue' : ''}` }));
  });
  svg.addEventListener('pointermove', (event) => {
    if (!state.editing || event.buttons) return;
    const target = /** @type {Element} */ (event.target);
    const knob = target.getAttribute?.('data-knob');
    const onHandle = target.getAttribute?.('data-point') || knob;
    // The mark where a click adds a point shows only while Add point is on.
    const next = onHandle || !addPoint.on ? null : (lineAt(pointerInLayer(event))?.point ?? null);
    const nextPart = knob ? knob.split('|')[0] : null;
    if (next?.x === hover?.x && next?.y === hover?.y && (knob ?? null) === knobKey) return;
    hover = next;
    knobPart = nextPart;
    knobKey = knob ?? null;
    paintOverlay();
  });
}
