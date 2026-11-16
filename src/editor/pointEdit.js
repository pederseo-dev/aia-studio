// Point editing, the second level of selection, as in Moho: a second click on the picked part shows the points of
// every part of its vector layer (hidden ones too, as ghosts; locked layers excepted).
//   Click a point: pick it (Shift: add or take out); its part becomes the main one. Drag a point: move the picked
//   points, whatever part they belong to (Shift: straight). Drag on empty space: a marquee over the points.
//   The round knobs of a picked point are its curve handles: dragging one keeps the curve smooth (the other handle
//   turns with it); with Alt it moves alone, making a corner. Alt+click a point: corner ↔ curve. Del: delete the
//   picked points. Click on the line of an outline: add a point there without changing its shape, as Moho's Add
//   Point (drag to move it at once). Click a part of the layer: make it the main one. A click on empty space, or Esc,
//   ends it.
// Weld (decision 6): a point dropped on a point of another part shares it from then on ({ ref: "jaw.chin" }; the
//   target point gets a name if it has none), dropped on a line of another part it shares a point added there, and
//   the two ends of one line close it. Alt: two open ends of different lines become one line. Shared points show
//   round. Unweld makes them separate points again. A picked point can be named, and picked points gathered in the
//   point groups of the layer.
// Each change is one batch, even when it touches several parts.

import { findObject, idFromName } from '../core/document.js';
import { nextPointName, pointOf, splitRef } from '../core/points.js';
import { closeOutline, endOf, insertVertex, joinOutlines, nearestOnOutline, roundVertex, transformVertices, translate, verticesOf } from '../core/geometry.js';
import { partData } from '../core/draw.js';
import { addPainter, paintOverlay, showPreview } from './canvas.js';
import { isPart } from './schema.js';
import { autoWeld, editPoints, inShownLayer, isLocked, notify, pickPoints, run, select, state } from './state.js';
import { drag, element, screen, svg, toDoc } from './view.js';

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
  const start = toDoc(event);
  /** @type {Map<string, Vertex[]> | null} */
  let changes = null;
  drag(
    event,
    (p, e) => {
      let dx = p.x - start.x;
      let dy = p.y - start.y;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      if (!changes && Math.hypot(dx, dy) < screen(2)) return;
      changes = movedPicked(translate(dx, dy));
      // Auto weld shows where the point would weld if it were dropped here.
      const target = autoWeld.on && state.points.length === 1 ? weldTargetNear(p, key) : null;
      weldHint = target && weldOps(key, target, e.altKey) ? weldPlace(target) : null;
      hintKind = 'weld';
      showPreview(withVertices(changes));
    },
    (p, e) => {
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
        const weld = target && weldOps(key, target, e.altKey);
        if (weld) {
          applyWeld(weld).finally(() => showPreview(null));
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
  const other = side === 'in' ? 'out' : 'in';
  const otherLength = vertex[other] ? Math.hypot(vertex[other].x, vertex[other].y) : 0;
  let moved = false;
  drag(
    event,
    (p, e) => {
      moved = true;
      const handle = { x: p.x - vertex.x, y: p.y - vertex.y };
      vertex[side] = handle;
      // Smooth: the other handle points the opposite way, keeping its own length. Alt breaks it into a corner.
      if (!e.altKey && vertex[other]) {
        const length = Math.hypot(handle.x, handle.y) || 1;
        vertex[other] = { x: (-handle.x / length) * otherLength, y: (-handle.y / length) * otherLength };
      }
      showPreview(withVertices(new Map([[part.id, vertices]])));
    },
    () => (moved ? save(new Map([[part.id, vertices]]), `Curve a point of ${part.id}`) : showPreview(null)),
  );
}

/**
 * Makes a vertex a smooth curve (handles along the line between its neighbors, a third of the way to each) or, with
 * corner, takes its handles away. Changes the vertices in place.
 * @param {Vertex[]} vertices @param {number} index @param {boolean} closed @param {boolean} corner
 */
export function shapePoint(vertices, index, closed, corner) {
  const v = vertices[index];
  delete v.in;
  delete v.out;
  if (corner) return;
  const prev = vertices[index - 1] ?? (closed ? vertices.at(-1) : undefined);
  const next = vertices[index + 1] ?? (closed ? vertices[0] : undefined);
  const a = prev ?? v;
  const b = next ?? v;
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const reach = (/** @type {Vertex | undefined} */ n) => (n ? Math.hypot(n.x - v.x, n.y - v.y) / 3 : 0);
  if (prev) v.in = { x: -dir.x * reach(prev), y: -dir.y * reach(prev) };
  if (next) v.out = { x: dir.x * reach(next), y: dir.y * reach(next) };
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
          .map((v, i) => (v.x >= r.x && v.x <= r.x + r.width && v.y >= r.y && v.y <= r.y + r.height ? keyOf(part.id, i) : ''))
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
    if (hit && hit.distance <= screen(LINE_REACH) && (!best || hit.distance < best.distance)) best = { part, ...hit };
  }
  return best;
}

/** Adds a point on a line and follows the pointer with it; one batch when released. @param {PointerEvent} event @param {DocObject} part @param {number} segment @param {number} t */
function addPointDown(event, part, segment, t) {
  hover = null;
  const { vertices, index } = insertVertex(part, segment, t);
  const key = keyOf(part.id, index);
  pickPoints([key], part.id);
  const start = toDoc(event);
  let changed = vertices;
  showPreview(withVertices(new Map([[part.id, changed]])));
  drag(
    event,
    (p) => {
      const m = translate(p.x - start.x, p.y - start.y);
      changed = transformVertices({ ...part, vertices }, [index], m).vertices;
      showPreview(withVertices(new Map([[part.id, changed]])));
    },
    () => save(new Map([[part.id, changed]]), `Add a point to ${part.id}`),
  );
}

/** @type {Point | null} where a click would add a point (shown while the pointer is near a line) */
let hover = null;

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
  const onLine = lineAt(toDoc(event));
  if (onLine) return addPointDown(event, onLine.part, onLine.segment, onLine.t);
  const id = target.closest?.('.content [data-id]')?.getAttribute('data-id');
  const other = id ? findObject(doc, id) : undefined;
  if (other && isPart(other.type) && !isLocked(other.id)) {
    // A part of the same layer becomes the main one; a part of another layer ends point editing and is picked.
    if (other.parent === state.editing) return pickPoints(state.points, other.id);
    return select(other.id);
  }
  pointMarquee(event);
}

/** Del while editing points: removes the picked ones (an outline keeps at least 2). */
export function deletePoints() {
  const doc = state.document;
  if (!doc || !state.editing || !state.points.length) return false;
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  const tooFew = [];
  for (const [id, indices] of pickedByPart()) {
    const part = findObject(doc, id);
    if (!part) continue;
    const kept = verticesOf(part).filter((_, i) => !indices.includes(i));
    if (kept.length < 2) tooFew.push(id);
    else changes.set(id, kept);
  }
  if (tooFew.length) {
    notify(`${tooFew.join(', ')} would keep fewer than 2 points; delete the part instead`);
    return true;
  }
  const count = state.points.length;
  pickPoints([]);
  save(changes, `Delete ${pointsWord(count)}`);
  return true;
}

/** Arrow keys while editing points: nudge the picked ones. @param {number} dx @param {number} dy */
export function nudgePoints(dx, dy) {
  if (!state.editing || !state.points.length) return false;
  save(movedPicked(translate(dx, dy)), `Nudge ${pointsWord(state.points.length)}`);
  return true;
}

const WELD_DISTANCE = 8; // screen px
const WELD_HINT = 8; // screen px, the radius of the ring that shows where a weld would happen

/**
 * @typedef {{ key: string } | { part: DocObject, segment: number, t: number, point: Point }} WeldTarget a point, or a place on a line
 * @typedef {{ ops: Operation[], keep: string, pick: string[], note: string }} Weld
 */

/** @type {Point | null} where the point being dragged or drawn would weld (a ring on the canvas) */
let weldHint = null;
/** @type {'weld' | 'continue'} what the ring means: a weld, or an end the Pen would continue */
let hintKind = 'weld';

/** Shows where a weld would happen, or nothing with null. @param {Point | null} p @param {'weld' | 'continue'} [kind] */
export function showWeldHint(p, kind = 'weld') {
  if (p?.x === weldHint?.x && p?.y === weldHint?.y && kind === hintKind) return;
  weldHint = p;
  hintKind = kind;
  paintOverlay();
}

/** Where a weld target is. @param {WeldTarget} target @returns {Point} */
export function weldPlace(target) {
  if (!('key' in target)) return target.point;
  const [id, index] = parseKey(target.key);
  const v = verticesOf(/** @type {DocObject} */ (findObject(/** @type {Doc} */ (state.document), id)))[index];
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
  let bestDistance = screen(WELD_DISTANCE);
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
  if (best) return { key: best };
  /** @type {{ part: DocObject, segment: number, t: number, point: Point, distance: number } | null} */
  let line = null;
  for (const part of editableParts(state.document, layer)) {
    if (part.id === exceptPart) continue;
    const hit = nearestOnOutline(part, p);
    if (hit && hit.distance <= screen(WELD_DISTANCE) && (!line || hit.distance < line.distance)) line = { part, ...hit };
  }
  return line;
}

/**
 * After a point stops being "old" (it now shares "next", or was renamed to it): the vertices that shared it and the
 * point groups that had it name "next" instead (null: the vertices keep their place as their own points, and the
 * groups drop it). Adds the new vertices to `changes` and returns the groups op, if any.
 * @param {Doc} doc @param {string} layer @param {string} old @param {string | null} next
 * @param {Map<string, Vertex[]>} changes
 * @returns {Operation[]}
 */
function redirect(doc, layer, old, next, changes) {
  for (const o of doc.objects) {
    if (o.parent !== layer) continue;
    const vertices = changes.get(o.id) ?? verticesOf(o);
    if (!vertices.some((v) => v.ref === old)) continue;
    changes.set(
      o.id,
      vertices.map((v) => {
        if (v.ref !== old) return v;
        if (next) return { ...v, ref: next };
        const { ref: _ref, ...own } = v;
        return own;
      }),
    );
  }
  const groups = /** @type {Record<string, string[]> | undefined} */ (findObject(doc, layer)?.groups);
  if (!groups || !Object.values(groups).some((members) => members.includes(old))) return [];
  const renamed = Object.fromEntries(
    Object.entries(groups).map(([g, members]) => [g, [...new Set(members.flatMap((m) => (m !== old ? [m] : next ? [next] : [])))]]),
  );
  return [{ op: 'set', target: layer, props: { groups: renamed } }];
}

/** @param {Map<string, Vertex[]>} changes @returns {Operation[]} */
const vertexOps = (changes) => [...changes].map(([id, vertices]) => ({ op: 'set', target: id, props: { vertices: vertices.map(roundVertex) } }));

/**
 * Welds a point of part `a` to the point `bi` of part `b` (whose vertices are `bVertices`: one may have just been
 * added): the point of `a` shares b's point from now on (named first if it has no name). Whoever shared a's point
 * shares b's.
 * @param {Doc} doc @param {DocObject} a @param {number} ai @param {DocObject} b @param {Vertex[]} bVertices @param {number} bi
 * @returns {Weld | null}
 */
function shareOps(doc, a, ai, b, bVertices, bi) {
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  const target = bVertices[bi];
  let owner = target.ref;
  if (!owner) {
    const name = target.name ?? nextPointName(b);
    owner = `${b.id}.${name}`;
    if (!target.name) bVertices = bVertices.map((v, i) => (i === bi ? { ...v, name } : v));
    if (bVertices !== verticesOf(b)) changes.set(b.id, bVertices);
  }
  const shared = owner;
  if (splitRef(shared)[0] === a.id) return null; // a part cannot share a point with itself
  const moving = verticesOf(a)[ai];
  changes.set(
    a.id,
    verticesOf(a).map((v, i) => (i === ai ? { ref: shared, x: target.x, y: target.y, ...(v.in ? { in: v.in } : {}), ...(v.out ? { out: v.out } : {}) } : v)),
  );
  const groupOps = moving.name ? redirect(doc, String(a.parent), `${a.id}.${moving.name}`, shared, changes) : [];
  return { ops: [...vertexOps(changes), ...groupOps], keep: a.id, pick: [keyOf(a.id, ai)], note: `Weld a point of ${a.id} to ${shared}` };
}

/**
 * What welding a point to a target does. The two ends of one line close it. With `merge`, an open end dropped on an
 * open end of another line joins the two lines into the target's part (the other is deleted). Otherwise the point
 * shares the target point, or a point added where it was dropped on a line.
 * @param {string} moving "part:index" @param {WeldTarget} target @param {boolean} [merge]
 * @returns {Weld | null}
 */
function weldOps(moving, target, merge = false) {
  const doc = state.document;
  if (!doc) return null;
  const [movingId, movingIndex] = parseKey(moving);
  const a = findObject(doc, movingId);
  if (!a) return null;
  if (!('key' in target)) {
    if (target.part.id === a.id) return null;
    const { vertices, index } = insertVertex(target.part, target.segment, target.t);
    return shareOps(doc, a, movingIndex, target.part, vertices, index);
  }
  const [targetId, targetIndex] = parseKey(target.key);
  const b = findObject(doc, targetId);
  if (!b) return null;
  const aEnd = endOf(a, movingIndex);
  const bEnd = endOf(b, targetIndex);
  if (a.id === b.id) {
    if (!aEnd || !bEnd || aEnd === bEnd) return null;
    return { ops: [{ op: 'set', target: b.id, props: closeOutline(b, bEnd) }], keep: b.id, pick: [], note: `Weld: close ${b.id}` };
  }
  if (merge) {
    if (!aEnd || !bEnd) return null;
    return {
      ops: [
        { op: 'set', target: b.id, props: { vertices: joinOutlines(a, aEnd, b, bEnd) } },
        { op: 'delete', target: a.id },
      ],
      keep: b.id,
      pick: [],
      note: `Weld ${a.id} into ${b.id}`,
    };
  }
  return shareOps(doc, a, movingIndex, b, verticesOf(b), targetIndex);
}

/** Saves a weld; the part that stays becomes the main one first, so point editing goes on. @param {Weld} weld */
function applyWeld(weld) {
  pickPoints(weld.pick, weld.keep);
  return run(weld.ops, { select: weld.keep, note: weld.note });
}

/** Whether the two picked points can be welded. */
export function canWeld() {
  return state.points.length === 2 && !!weldOps(state.points[0], { key: state.points[1] });
}

/**
 * The Weld button: the first picked point goes to the second and shares it (the two ends of one line close it).
 * Alt+click: two open ends of different lines become one line.
 * @param {boolean} [merge]
 */
export function weldPicked(merge = false) {
  const weld = state.points.length === 2 ? weldOps(state.points[0], { key: state.points[1] }, merge) : null;
  if (!weld) return notify('Pick two points to weld: points of two parts of this layer, or the two ends of a line');
  applyWeld(weld);
}

/** A picked point as { part, index, vertex }. @param {string} key */
function pointAt(key) {
  const [id, index] = parseKey(key);
  const part = state.document ? findObject(state.document, id) : undefined;
  const vertex = part ? verticesOf(part)[index] : undefined;
  return part && vertex ? { part, index, vertex } : null;
}

/** Whether a named point of a part is shared by another. @param {DocObject} part @param {Vertex} v */
const isShared = (part, v) => !!v.name && !!state.document?.objects.some((o) => verticesOf(o).some((w) => w.ref === `${part.id}.${v.name}`));

/** Whether a picked point is welded (it shares a point, or another shares it). */
export function canUnweld() {
  return state.points.some((key) => {
    const at = pointAt(key);
    return !!at && (!!at.vertex.ref || isShared(at.part, at.vertex));
  });
}

/** Unweld: the picked points stop sharing; each vertex keeps its place as a point of its own. */
export function unweldPicked() {
  const doc = state.document;
  const layer = state.editing;
  if (!doc || !layer) return;
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  for (const key of state.points) {
    const at = pointAt(key);
    if (!at) continue;
    const vertices = changes.get(at.part.id) ?? verticesOf(at.part);
    if (at.vertex.ref) {
      const { ref: _ref, ...own } = vertices[at.index];
      changes.set(at.part.id, vertices.map((v, i) => (i === at.index ? own : v)));
    } else if (at.vertex.name) redirect(doc, layer, `${at.part.id}.${at.vertex.name}`, null, changes);
  }
  if (!changes.size) return notify('The picked points are not welded');
  run(vertexOps(changes), { select: state.selected, note: `Unweld ${pointsWord(state.points.length)}` });
}

/**
 * The stretch between the two picked points, if it can follow another part: both in one part and next to each other,
 * both sharing points of one other part.
 */
function pickedStretch() {
  if (state.points.length !== 2) return null;
  const [a, b] = state.points.map(pointAt);
  if (!a || !b || a.part.id !== b.part.id) return null;
  const n = verticesOf(a.part).length;
  const closed = a.part.closed !== false;
  /** @param {{ index: number }} x @param {{ index: number }} y */
  const before = (x, y) => (x.index + 1 < n ? x.index + 1 === y.index : closed && y.index === 0);
  const from = before(a, b) ? a : before(b, a) ? b : null;
  const to = from === a ? b : a;
  if (!from || !from.vertex.ref || !to.vertex.ref) return null;
  const other = splitRef(from.vertex.ref)[0];
  if (splitRef(to.vertex.ref)[0] !== other) return null;
  return { part: from.part, index: from.index, other, follows: from.vertex.follow === other, long: from.vertex.way === 'long' };
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
  if (!s) return notify('Pick two neighbor points of a part that share points of another part, to follow its curve between them');
  const vertices = verticesOf(s.part).map((v, i) => {
    if (i !== s.index) return v;
    const { follow: _follow, way: _way, ...rest } = v;
    if (s.follows && !otherWay) return rest;
    const long = s.follows ? !s.long : otherWay;
    return { ...rest, follow: s.other, ...(long ? { way: 'long' } : {}) };
  });
  const note = s.follows && !otherWay ? `${s.part.id} stops following ${s.other}` : `${s.part.id} follows ${s.other}${otherWay ? ' the other way' : ''}`;
  run([{ op: 'set', target: s.part.id, props: { vertices: vertices.map(roundVertex) } }], { select: state.selected, note });
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
  const doc = state.document;
  const at = pickedPoint();
  const layer = state.editing;
  if (!doc || !at || !layer) return;
  if (at.vertex.ref) return notify(`This point is ${at.vertex.ref}: rename it there`);
  const old = at.vertex.name;
  const taken = new Set(verticesOf(at.part).filter((_, i) => i !== at.index).map((v) => v.name));
  const name = typed.trim() ? idFromName(typed, (x) => taken.has(x)) : undefined;
  if (name === old) return;
  const oldRef = old ? `${at.part.id}.${old}` : '';
  const groups = /** @type {Record<string, string[]>} */ (findObject(doc, layer)?.groups ?? {});
  const used = !!old && (isShared(at.part, at.vertex) || Object.values(groups).some((m) => m.includes(oldRef)));
  if (!name && used) return notify(`${oldRef} is shared or in a group, so it keeps a name`);
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  changes.set(
    at.part.id,
    verticesOf(at.part).map((v, i) => {
      if (i !== at.index) return v;
      const { name: _name, ...rest } = v;
      return name ? { ...rest, name } : rest;
    }),
  );
  const groupOps = old && name ? redirect(doc, layer, oldRef, `${at.part.id}.${name}`, changes) : [];
  run([...vertexOps(changes), ...groupOps], { select: state.selected, note: name ? `Name a point ${at.part.id}.${name}` : `Unname ${oldRef}` });
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
 * The picked points as named points ("part.point"), naming the ones without a name (part_1, part_2…).
 * @returns {{ refs: string[], changes: Map<string, Vertex[]> }}
 */
function pickedRefs() {
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  /** @type {string[]} */
  const refs = [];
  /** @type {Map<string, Set<string>>} */
  const given = new Map();
  for (const key of state.points) {
    const at = pointAt(key);
    if (!at) continue;
    if (at.vertex.ref) {
      refs.push(at.vertex.ref);
      continue;
    }
    let name = at.vertex.name;
    if (!name) {
      const taken = given.get(at.part.id) ?? new Set();
      name = nextPointName(at.part, taken);
      taken.add(name);
      given.set(at.part.id, taken);
      const named = name;
      const vertices = changes.get(at.part.id) ?? verticesOf(at.part);
      changes.set(at.part.id, vertices.map((v, i) => (i === at.index ? { ...v, name: named } : v)));
    }
    refs.push(`${at.part.id}.${name}`);
  }
  return { refs: [...new Set(refs)], changes };
}

/**
 * Changes the point groups of the edited layer with the picked points: a new group of them, add them to a group,
 * take them out of it, or delete the group.
 * @param {'new' | 'add' | 'remove' | 'delete'} action @param {string} group
 */
export function editGroup(action, group) {
  const doc = state.document;
  const layer = state.editing;
  if (!doc || !layer) return;
  const groups = { ...pointGroups() };
  const { refs, changes } = action === 'delete' ? { refs: [], changes: new Map() } : pickedRefs();
  if ((action === 'new' || action === 'add') && !refs.length) return notify('Pick the points for the group first');
  let name = group;
  if (action === 'new') {
    name = idFromName(group || 'group', (x) => x in groups);
    groups[name] = refs;
  } else if (action === 'add') groups[name] = [...new Set([...(groups[name] ?? []), ...refs])];
  else if (action === 'remove') groups[name] = (groups[name] ?? []).filter((m) => !refs.includes(m));
  else delete groups[name];
  const notes = { new: `New point group ${name}`, add: `Add to ${name}`, remove: `Take out of ${name}`, delete: `Delete the group ${name}` };
  // Taking points out names nothing new.
  const named = action === 'remove' ? [] : vertexOps(changes);
  run([...named, { op: 'set', target: layer, props: { groups: Object.keys(groups).length ? groups : null } }], { select: state.selected, note: notes[action] });
}

/**
 * What a new outline (the Pen) needs to weld some of its vertices as it is created: for each target, the point it
 * shares ("part.point"), naming points and adding points on lines as needed; and the ops that do that to the other
 * parts. Targets on the same part are handled together, so indices stay right.
 * @param {(WeldTarget | null)[]} targets one per vertex of the new outline
 * @returns {{ ops: Operation[], refs: (string | null)[] }}
 */
export function shareTargets(targets) {
  const doc = /** @type {Doc} */ (state.document);
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  /** @type {(string | null)[]} */
  const refs = targets.map(() => null);
  /** @param {string} id */
  const verticesNow = (id) => changes.get(id) ?? verticesOf(/** @type {DocObject} */ (findObject(doc, id)));
  // 1. Points added on lines, the last stretch first so the earlier ones keep their index.
  /** @type {Map<string, { i: number, segment: number, t: number }[]>} */
  const onLines = new Map();
  targets.forEach((target, i) => {
    if (target && !('key' in target)) onLines.set(target.part.id, [...(onLines.get(target.part.id) ?? []), { i, segment: target.segment, t: target.t }]);
  });
  /** @type {Map<number, { part: string, index: number }>} where each added point ended up */
  const added = new Map();
  /** @type {Map<string, number[]>} the stretches split in each part (to shift the indices of its other points) */
  const split = new Map();
  for (const [id, list] of onLines) {
    list.sort((a, b) => b.segment - a.segment || b.t - a.t);
    /** @type {{ segment: number, t: number } | null} */
    let previous = null;
    for (const item of list) {
      // A second point on a stretch already split falls on its first half.
      const t = previous && previous.segment === item.segment ? item.t / previous.t : item.t;
      const part = /** @type {DocObject} */ (findObject(doc, id));
      const { vertices, index } = insertVertex({ ...part, vertices: verticesNow(id) }, item.segment, t);
      for (const place of added.values()) if (place.part === id && place.index >= index) place.index++;
      added.set(item.i, { part: id, index });
      changes.set(id, vertices);
      previous = item;
    }
    split.set(id, list.map((item) => item.segment));
  }
  // 2. The points shared: named if they have no name yet.
  /** @type {Map<string, Set<string>>} */
  const given = new Map();
  targets.forEach((target, i) => {
    if (!target) return;
    let id;
    let index;
    if ('key' in target) {
      [id, index] = parseKey(target.key);
      const at = index;
      index += (split.get(id) ?? []).filter((segment) => segment + 1 <= at).length;
    } else ({ part: id, index } = /** @type {{ part: string, index: number }} */ (added.get(i)));
    const vertices = verticesNow(id);
    const v = vertices[index];
    if (v.ref) {
      refs[i] = v.ref;
      return;
    }
    let name = v.name;
    if (!name) {
      const taken = given.get(id) ?? new Set();
      name = nextPointName({ .../** @type {DocObject} */ (findObject(doc, id)), vertices }, taken);
      taken.add(name);
      given.set(id, taken);
      const named = name;
      changes.set(id, vertices.map((w, j) => (j === index ? { ...w, name: named } : w)));
    }
    refs[i] = `${id}.${name}`;
  });
  return { ops: vertexOps(changes), refs };
}

/** The points of a layer as small dots, to weld to while drawing (not editable). @param {SVGGElement} overlay @param {string} layer */
export function paintLayerPoints(overlay, layer) {
  const size = screen(4);
  for (const part of editableParts(state.document, layer)) {
    for (const v of verticesOf(part)) {
      overlay.append(element('rect', { x: v.x - size / 2, y: v.y - size / 2, width: size, height: size, class: `layer-point${v.ref ? ' shared' : ''}` }));
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
  for (const part of parts) {
    overlay.append(element('path', { d: partData(part), class: `edit-outline${part.id === state.selected ? ' main' : ''}` }));
  }
  if (hover) overlay.append(element('circle', { cx: hover.x, cy: hover.y, r: screen(KNOB), class: 'add-point' }));
  const sharedNames = new Set(parts.flatMap((part) => verticesOf(part).flatMap((v) => (v.ref ? [v.ref] : []))));
  const size = screen(POINT);
  for (const part of parts) {
    const vertices = verticesOf(part);
    for (const [index, v] of vertices.entries()) {
      if (!state.points.includes(keyOf(part.id, index))) continue;
      for (const side of /** @type {const} */ (['in', 'out'])) {
        const h = v[side];
        if (!h) continue;
        const end = { x: v.x + h.x, y: v.y + h.y };
        overlay.append(
          element('line', { x1: v.x, y1: v.y, x2: end.x, y2: end.y, class: 'knob-line' }),
          element('circle', { cx: end.x, cy: end.y, r: screen(KNOB), class: 'handle knob', 'data-knob': `${part.id}|${index}|${side}` }),
        );
      }
    }
    for (const [index, v] of vertices.entries()) {
      const picked = state.points.includes(keyOf(part.id, index));
      const shared = !!v.ref || sharedNames.has(`${part.id}.${v.name}`);
      overlay.append(
        element('rect', {
          x: v.x - size / 2,
          y: v.y - size / 2,
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
    if (weldHint) overlay.append(element('circle', { cx: weldHint.x, cy: weldHint.y, r: screen(WELD_HINT), class: `weld-hint${hintKind === 'continue' ? ' continue' : ''}` }));
  });
  svg.addEventListener('pointermove', (event) => {
    if (!state.editing || event.buttons) return;
    const target = /** @type {Element} */ (event.target);
    const onHandle = target.getAttribute?.('data-point') || target.getAttribute?.('data-knob');
    const next = onHandle ? null : (lineAt(toDoc(event))?.point ?? null);
    if (next?.x === hover?.x && next?.y === hover?.y) return;
    hover = next;
    paintOverlay();
  });
}
