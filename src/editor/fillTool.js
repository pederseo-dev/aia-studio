// The Create Shape tool (F), as Moho's Create Shape (part 4 of docs/rebuild.md): it picks the points of a vector
// layer's lines, and when the picked points close a shape it shows it with a checkerboard (holes clear); Create shape
// in the bar (or Enter) makes it, a part that follows those lines, under them. Picking: a click on a point picks it
// (Shift: adds or takes it out, and dragging on from it does the same to the points passed over), a drag picks the
// points in a box (Shift: toggles each one in it), and a click inside a gap picks all
// the points around it and its holes (Shift: adds them, or takes them out when they are all picked). Where two
// lines cross without a point, a ring shows; a click on it welds them there (a point on each), so the shapes on each
// side can be made. Esc clears the picks. The shapes and crossings come from the core (core/fill.js), the same as
// `aia shape` and `aia crossings`.

import { findObject } from '../core/document.js';
import { crossingsOf, gapAt, nodeKeys, shapeFromPointsOps, shapeOf, styleProps, weldCrossingOps } from '../core/fill.js';
import { addPainter, onToolDown, paintOverlay } from './canvas.js';
import { fromLayer, layerScreen, toLayer } from './pointEdit.js';
import { activeVector, fillStyle, isHidden, isLocked, notify, run, state } from './state.js';
import { drag, element, screen, svg, toDoc } from './view.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/geometry.js').Point} Point
 */

const POINT_HIT = 7; // screen px
const CROSSING_HIT = 8;
const DRAG = 3;

/** @type {Set<string>} the picked points, as nodes ("part.point", or "part#index" for an unnamed one) */
let picks = new Set();
/** @type {string | null} the layer the picks are in */
let pickLayer = null;
/** @type {{ layer: string, at: Point } | null} the gap under the pointer (a hint of what a click picks) */
let hover = null;
/** @type {{ from: Point, to: Point } | null} the box being dragged, on the artboard */
let box = null;

/** The vector layer the tool works in: the one of the picks, the active one, or the top shown one with lines. */
function workLayer() {
  const doc = state.document;
  if (!doc) return null;
  if (pickLayer && findObject(doc, pickLayer)) return pickLayer;
  const active = activeVector();
  if (active) return isLocked(active.id) ? null : active.id;
  const layers = doc.objects.filter((o) => o.type === 'vector' && !isHidden(o.id) && !isLocked(o.id)).reverse();
  return (layers.find((l) => doc.objects.some((o) => o.parent === l.id && o.type === 'path')) ?? layers[0])?.id ?? null;
}

/** The point of the work layer near a place of the artboard, as its node, and how far it is, or null. @param {Point} p */
function pointNear(p) {
  const doc = state.document;
  const layer = workLayer();
  if (!doc || !layer) return null;
  const at = toLayer(layer, p);
  const reach = layerScreen(layer, POINT_HIT);
  let best = null;
  let bestDistance = reach;
  for (const { node, at: q } of nodeKeys(doc, layer).values()) {
    const d = Math.hypot(q.x - at.x, q.y - at.y);
    if (d <= bestDistance) {
      best = node;
      bestDistance = d;
    }
  }
  return best ? { node: best, distance: bestDistance } : null;
}

/** The crossing of the work layer's lines near a place, and how far it is, or null. @param {Point} p */
function crossingNear(p) {
  const doc = state.document;
  const layer = workLayer();
  if (!doc || !layer) return null;
  const at = toLayer(layer, p);
  const reach = layerScreen(layer, CROSSING_HIT);
  let best = null;
  let bestDistance = reach;
  for (const c of crossingsOf(doc, layer)) {
    const d = Math.hypot(c.x - at.x, c.y - at.y);
    if (d <= bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best ? { crossing: best, distance: bestDistance } : null;
}

/** The shape the picks make now, or why not. */
function shapeNow() {
  const doc = state.document;
  if (!doc || !pickLayer || !picks.size || !findObject(doc, pickLayer)) return null;
  return shapeOf(doc, pickLayer, picks);
}

/** Whether the picked points close a shape (for the options bar). */
export const canCreate = () => {
  const shape = shapeNow();
  return !!shape && !('error' in shape);
};

/** How many points are picked (for the options bar). */
export const pickedCount = () => picks.size;

/** Esc: clears the picks. @returns {boolean} whether there were any */
export function clearPicks() {
  if (!picks.size) return false;
  picks = new Set();
  notify('');
  return true;
}

/**
 * Picks points. With Shift (add) they are added, or, when they are all picked already, taken out: Shift+click again
 * in a gap unpicks its points.
 * @param {string[]} nodes @param {string} layer @param {boolean} add
 */
function pick(nodes, layer, add) {
  if (!add || pickLayer !== layer) picks = new Set();
  pickLayer = layer;
  const all = nodes.length > 0 && nodes.every((node) => picks.has(node));
  for (const node of nodes) {
    if (add && all) picks.delete(node);
    else picks.add(node);
  }
  notify('');
}

/** Create shape (Enter): makes the shape the picked points close. @returns {boolean} whether something was picked */
export function createPicked() {
  const doc = state.document;
  if (!doc || !pickLayer || !picks.size) return false;
  let result;
  try {
    result = shapeFromPointsOps(doc, pickLayer, picks, styleProps(fillStyle));
  } catch (e) {
    notify(e.message);
    return true;
  }
  picks = new Set();
  run(result.ops, { note: result.note, select: result.id });
  return true;
}

/**
 * Welds two lines where they cross. The picked unnamed points after a point added on a line move up one place.
 * @param {import('../core/fill.js').Crossing} crossing
 */
function weldCrossing(crossing) {
  const doc = state.document;
  if (!doc) return;
  let result;
  try {
    result = weldCrossingOps(doc, crossing);
  } catch (e) {
    return notify(e.message);
  }
  /** @param {string} node @param {string} part @param {number} index */
  const shifted = (node, part, index) => {
    const match = /^(.+)#(\d+)$/.exec(node);
    return match && match[1] === part && Number(match[2]) >= index ? `${part}#${Number(match[2]) + 1}` : node;
  };
  picks = new Set([...picks].map((node) => result.added.reduce((n, at) => shifted(n, at.part, at.index), node)));
  run(result.ops, { note: result.note });
}

/** @param {PointerEvent} event */
function createDown(event) {
  const doc = state.document;
  const layer = workLayer();
  if (!doc) return;
  if (!layer) return notify('No vector layer here (or it is locked)');
  const start = toDoc(event);
  const near = pointNear(start);
  const crossing = crossingNear(start);
  // A crossing next to a point: the nearer one.
  if (crossing && (!near || crossing.distance < near.distance)) return weldCrossing(crossing.crossing);
  if (near) {
    if (!event.shiftKey || pickLayer !== layer) return pick([near.node], layer, false);
    // Shift on a point toggles it, and dragging on does the same to the points passed over: unpicks them if this
    // one was picked, picks them if not.
    const unpick = picks.has(near.node);
    /** @param {string} node */
    const brush = (node) => (unpick ? picks.delete(node) : picks.add(node));
    brush(near.node);
    notify('');
    drag(
      event,
      (p) => {
        const over = pointNear(p);
        if (!over || picks.has(over.node) !== unpick) return;
        brush(over.node);
        notify('');
      },
      () => {},
    );
    return;
  }
  let moved = false;
  drag(
    event,
    (p) => {
      moved ||= Math.hypot(p.x - start.x, p.y - start.y) > screen(DRAG);
      if (!moved) return;
      box = { from: start, to: p };
      paintOverlay();
    },
    (p, e) => {
      box = null;
      if (moved) {
        // The points inside the box.
        const x0 = Math.min(start.x, p.x);
        const x1 = Math.max(start.x, p.x);
        const y0 = Math.min(start.y, p.y);
        const y1 = Math.max(start.y, p.y);
        const inside = [...nodeKeys(doc, layer).values()].filter(({ at }) => {
          const w = fromLayer(layer, at);
          return w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1;
        });
        const nodes = [...new Set(inside.map((k) => k.node))];
        if (!e.shiftKey || pickLayer !== layer) return pick(nodes, layer, false);
        // Shift+box toggles each point in it: the picked ones are unpicked, the others picked.
        for (const node of nodes) {
          if (picks.has(node)) picks.delete(node);
          else picks.add(node);
        }
        return notify('');
      }
      // A click inside a gap picks the points around it.
      const gap = gapAt(doc, layer, toLayer(layer, p));
      if ('error' in gap) {
        if (!e.shiftKey) clearPicks();
        paintOverlay();
        return /no lines .* close a gap/.test(gap.error) ? undefined : notify(gap.error);
      }
      pick(gap.nodes, layer, e.shiftKey);
    },
  );
}

/** A closed outline on the artboard as path data. @param {string} layer @param {Point[]} polygon */
const ring = (layer, polygon) => `M${polygon.map((p) => fromLayer(layer, p)).map((p) => `${p.x} ${p.y}`).join('L')}Z`;

/** @param {SVGGElement} overlay @param {Doc} doc */
function paint(overlay, doc) {
  const layer = workLayer();
  if (!layer || !findObject(doc, layer)) return;
  const defs = element('defs');
  // The checkerboard of the shape that would be made, in screen pixels.
  const cell = screen(5);
  const checker = element('pattern', { id: 'shape-checker', width: cell * 2, height: cell * 2, patternUnits: 'userSpaceOnUse' });
  checker.append(element('rect', { width: cell, height: cell }), element('rect', { x: cell, y: cell, width: cell, height: cell }));
  defs.append(checker);
  overlay.append(defs);
  if (hover && hover.layer === layer && !box) {
    const gap = gapAt(doc, layer, hover.at);
    if (!('error' in gap)) overlay.append(element('path', { d: [gap.polygon, ...gap.holePolygons].map((p) => ring(layer, p)).join(''), class: 'gap hover', 'fill-rule': 'evenodd' }));
  }
  const shape = pickLayer === layer ? shapeNow() : null;
  if (shape && !('error' in shape)) {
    overlay.append(element('path', { d: [shape.polygon, ...shape.holePolygons].map((p) => ring(layer, p)).join(''), class: 'shape-preview', 'fill-rule': 'evenodd' }));
  } else if (shape && 'shown' in shape) {
    for (const stretch of shape.shown) {
      const d = `M${stretch.map((p) => fromLayer(layer, p)).map((p) => `${p.x} ${p.y}`).join('L')}`;
      overlay.append(element('path', { d, class: 'shape-stretch' }));
    }
  }
  // The points of the lines (each once), the picked ones filled.
  const half = screen(3);
  const drawn = new Set();
  for (const { node, at } of nodeKeys(doc, layer).values()) {
    if (drawn.has(node)) continue;
    drawn.add(node);
    const w = fromLayer(layer, at);
    const picked = pickLayer === layer && picks.has(node);
    overlay.append(element('rect', { x: w.x - half, y: w.y - half, width: half * 2, height: half * 2, class: `shape-point${picked ? ' picked' : ''}` }));
  }
  for (const c of crossingsOf(doc, layer)) {
    const w = fromLayer(layer, c);
    overlay.append(element('circle', { cx: w.x, cy: w.y, r: screen(4), class: 'shape-crossing' }));
  }
  if (box) {
    const x = Math.min(box.from.x, box.to.x);
    const y = Math.min(box.from.y, box.to.y);
    overlay.append(element('rect', { x, y, width: Math.abs(box.to.x - box.from.x), height: Math.abs(box.to.y - box.from.y), class: 'marquee' }));
  }
}

export function setupFillTool() {
  onToolDown('fill', createDown);
  svg.addEventListener('pointermove', (event) => {
    if (state.tool !== 'fill' || event.buttons) return;
    const p = toDoc(event);
    const layer = workLayer();
    const doc = state.document;
    let next = null;
    if (doc && layer && !pointNear(p) && !crossingNear(p)) {
      const at = toLayer(layer, p);
      const gap = gapAt(doc, layer, at);
      if (!('error' in gap)) next = { layer, at };
    }
    const same = next && hover && doc && next.layer === hover.layer && gapKey(doc, next) === gapKey(doc, hover);
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
      picks = new Set();
      hover = null;
      return;
    }
    // Picks of points that are gone (the drawing changed) are dropped.
    if (pickLayer && findObject(doc, pickLayer)) {
      const known = new Set([...nodeKeys(doc, pickLayer).values()].map((k) => k.node));
      for (const node of picks) if (!known.has(node)) picks.delete(node);
    }
    paint(overlay, doc);
  });
}

/** Which gap a place is in, as a key. @param {Doc} doc @param {{ layer: string, at: Point }} h */
function gapKey(doc, h) {
  const gap = gapAt(doc, h.layer, h.at);
  return 'error' in gap ? '' : `${gap.area}:${gap.polygon[0].x}:${gap.polygon[0].y}`;
}

