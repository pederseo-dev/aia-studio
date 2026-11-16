// Fill, Stroke and Both, as Moho's Paint Bucket and Create Shape:
// - A click fills the region under the pointer (the smallest area its curves close around it, a closed curve or
//   segments of curves welded at their points, with the closed curves inside it as holes) or, with Stroke, strokes
//   the curve under it. Hovering previews what the click does. The region is looked
//   up in the picked vector layer and, if it has none there, in the topmost layer that does. Alt + click clears it.
// - Dragging a box picks points of the picked layer (Shift adds, Alt removes; click or Shift + click a point, Ctrl+A
//   all), and Create (Space or Enter) paints the whole curves they close: open curves too, with Stroke.
// As in Moho, a shape has a fill and a stroke: painting curves that a shape already covers adds the fill or the stroke
// to that shape instead of stacking another one. Clear takes it off (the curves stay, to paint again).
//
// The editor writes what the AI writes: `create shape` with `curves` and `loops` (or `at`, the same region), `set` of its fill
// and stroke, and `delete` with `keepCurves` (see src/core/operations.js and src/core/regions.js).

import { children, findObject, locked } from '../core/document.js';
import { read } from '../core/schema.js';
import { apply, invert, multiply, worldMatrix } from '../core/geometry.js';
import { verticesAD } from '../core/paths.js';
import { curveVertices, curvesOfPoints, loopD, regionKey, resolveLoop, shapeCurveIds } from '../core/mesh.js';
import { curveNear, meshRegions, regionIn } from '../core/regions.js';
import { NEW_STROKE } from './drawing.js';
import { execute, freeId, notify, pickable, schema, select, setState, state, subscribe } from './state.js';

export const SHAPE_TOOLS = ['fill', 'stroke', 'both'];
export const NAMES = { fill: 'Fill', stroke: 'Stroke', both: 'Both' };
const NEAR = 6; // px on screen: how close to a curve Stroke strokes it

/** The fill a new shape gets from Fill and Both (the shape's default fill). */
const newFill = () => schema.types.get('shape').properties.fill.default;

export const isShapeTool = (tool = state.tool) => SHAPE_TOOLS.includes(tool);

/** The vector layer whose points the tools pick: the picked layer, or the layer of the picked shape. */
export function shapeToolLayer(doc = state.doc) {
  const id = pickable(state.selection);
  const o = id && findObject(doc, id);
  return o?.type === 'vector' && !locked(doc, o.id) ? o : null;
}

// Another layer (or another document) starts over with no points picked.
let pickedIn = null;
subscribe((c) => {
  if (!('selection' in c || 'id' in c)) return;
  const layer = state.doc ? (shapeToolLayer()?.id ?? null) : null;
  if (layer !== pickedIn || 'id' in c) {
    pickedIn = layer;
    if (state.shapePicked.length) setState({ shapePicked: [] });
  }
});

/** @typedef {{ curves: string[], loops: any[][] }} Region what a shape fills: whole curves and loops (see mesh.js) */
const hasFill = (o) => read(schema, o, 'fill') != null || read(schema, o, 'fillGradient') != null;
const hasStroke = (o) => read(schema, o, 'stroke') != null;

/** The shape of the layer over exactly this region (the one Fill, Stroke and Both paint), if any. @param {Region} region */
export function shapeOver(doc, layer, region) {
  const curves = read(schema, layer, 'curves') ?? {};
  const key = regionKey(curves, region);
  return children(doc, layer.id).find((o) => o.type === 'shape' && regionKey(curves, o) === key) ?? null;
}

/**
 * The batch that paints a region of `layer` with the tool: it adds the fill or the stroke to the shape already over
 * it, or creates one. `shape`: the shape to paint instead (Stroke on a curve of a filled shape strokes that shape).
 * Returns { ops, id } (ops empty: it already has it).
 * @param {any} doc @param {any} layer @param {Region} region
 */
export function paintOps(doc, layer, region, tool = state.tool, shape = shapeOver(doc, layer, region)) {
  const fill = tool !== 'stroke';
  const stroke = tool !== 'fill';
  if (shape) {
    const props = { ...(fill && !hasFill(shape) ? { fill: newFill() } : {}), ...(stroke && !hasStroke(shape) ? NEW_STROKE : {}) };
    return { id: shape.id, ops: Object.keys(props).length ? [{ op: 'set', target: shape.id, props }] : [] };
  }
  const id = freeId('shape');
  // Fill keeps the shape's default fill.
  const props = { curves: region.curves, ...(region.loops.length ? { loops: region.loops } : {}), ...(fill ? {} : { fill: null }), ...(stroke ? NEW_STROKE : {}) };
  return { id, ops: [{ op: 'create', type: 'shape', id, parent: layer.id, props }] };
}

/**
 * The batch that takes the tool's paint off a shape: the fill (Fill), the stroke (Stroke) or the shape (Both). A shape
 * left with neither is deleted, keeping its curves.
 */
export function clearShapeOps(shape, tool = state.tool) {
  if (!shape) return [];
  if (tool === 'both') return [{ op: 'delete', target: shape.id, keepCurves: true }];
  const [has, other] = tool === 'fill' ? [hasFill, hasStroke] : [hasStroke, hasFill];
  if (!has(shape)) return [];
  if (!other(shape)) return [{ op: 'delete', target: shape.id, keepCurves: true }];
  return [{ op: 'set', target: shape.id, props: tool === 'fill' ? { fill: null, fillGradient: null } : { stroke: null } }];
}

/** @param {Region} region */
function paintNote(tool, region, layer) {
  const n = region.loops.length;
  const parts = [...region.curves, ...(n ? [`${n} region${n > 1 ? 's' : ''} between curves`] : [])];
  return `${NAMES[tool].toLowerCase()} ${parts.join(', ')} of ${layer.id}`;
}

/** Paints (or clears) a region of a layer and picks the shape, so the inspector shows its colors. @param {Region} region */
function applyPaint(doc, layer, region, clear, shape) {
  const target = shape ?? shapeOver(doc, layer, region);
  if (clear) {
    const ops = clearShapeOps(target);
    if (!ops.length) return notify(`${NAMES[state.tool]}: nothing to clear there`);
    execute(ops, `clear ${state.tool === 'both' ? '' : `the ${state.tool} of `}${target.id}`);
    return select(findObject(state.doc, target.id) ? target.id : layer.id);
  }
  const { ops, id } = paintOps(doc, layer, region, state.tool, target);
  if (!ops.length) notify(`${id} already has ${{ fill: 'a fill', stroke: 'a stroke', both: 'a fill and a stroke' }[state.tool]} (Alt + click or Clear takes it off)`);
  else execute(ops, paintNote(state.tool, region, layer));
  select(id);
}

/**
 * What the picked points close: the curves (Fill and Both only the closed ones, Stroke also the open ones). null if
 * they close nothing.
 */
export function shapePlan(doc = state.doc, tool = state.tool) {
  const layer = shapeToolLayer(doc);
  if (!layer || !isShapeTool(tool) || !state.shapePicked.length) return null;
  const curves = curvesOfPoints(read(schema, layer, 'curves') ?? {}, state.shapePicked, { closedOnly: tool !== 'stroke' });
  return curves.length ? { layer, curves, loops: [] } : null;
}

/** Create (Space or Enter): paints the curves the picked points close. */
export function createFromPicked() {
  if (state.pose || state.params || state.live) return notify(`${NAMES[state.tool]}: shapes are painted in the Setup`, true);
  const plan = shapePlan();
  if (!plan) {
    const what = state.tool === 'stroke' ? 'a curve' : 'a closed curve';
    return notify(`${NAMES[state.tool] ?? 'Fill'}: pick all the points of ${what} first (drag a box, or click and Shift + click points)`, true);
  }
  setState({ shapePicked: [] });
  applyPaint(state.doc, plan.layer, plan, false);
}

/**
 * The shape Clear acts on: the one over the curves the picked points close or, with none picked, the picked shape.
 * null if it has nothing of what the tool gives.
 */
export function shapeToClear(doc = state.doc) {
  const plan = shapePlan(doc);
  const shape = plan ? shapeOver(doc, plan.layer, plan) : findObject(doc, state.selection);
  return shape?.type === 'shape' && clearShapeOps(shape).length ? shape : null;
}

export function clearPicked() {
  const shape = shapeToClear();
  if (shape) applyPaint(state.doc, findObject(state.doc, shape.parent), { curves: shape.curves ?? [], loops: shape.loops ?? [] }, true, shape);
}

/** @param {any} ctx the canvas tools context */
export function createShapeTools(ctx) {
  /** What the pointer is over: { layer, region, shape? } (the region or curve a click paints), or null. */
  let hovered = null;
  /** Faces and closed curves of each layer, while the layer object is the same (a change makes a new one). */
  const regions = new WeakMap();

  /** A layer's matrix layer → screen. */
  const toScreen = (doc, layer) => multiply(ctx.cameraMatrix(), worldMatrix(doc, schema, layer.id));

  /**
   * Its points on screen: [id, [x, y]].
   * @returns {[string, number[]][]}
   */
  function pointsOnScreen(doc, layer) {
    const m = toScreen(doc, layer);
    return Object.entries(read(schema, layer, 'points') ?? {}).map(([id, p]) => [id, apply(m, p.x, p.y)]);
  }

  const active = () => isShapeTool() && !state.pose && !state.params && !state.live;

  /** The vector layers a click looks in: the picked one first, then the rest from the top down. */
  function layersToTry(doc) {
    const first = shapeToolLayer(doc);
    const shown = (o) => !locked(doc, o.id) && read(schema, o, 'visible') !== false;
    const rest = doc.objects.filter((o) => o.type === 'vector' && o !== first && shown(o)).reverse();
    return first ? [first, ...rest] : rest;
  }

  /** What a click at screen point s paints: the curve under it (Stroke) or the region around it. */
  function hitAt(doc, s) {
    for (const layer of layersToTry(doc)) {
      const m = toScreen(doc, layer);
      const at = apply(invert(m), ...s);
      const points = read(schema, layer, 'points') ?? {};
      const curves = read(schema, layer, 'curves') ?? {};
      if (state.tool === 'stroke') {
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        const curve = curveNear(points, curves, at, NEAR / scale);
        if (curve) {
          // A curve of a shape that covers more (a ring): the stroke goes to that shape, on all its curves.
          const shape = children(doc, layer.id).find((o) => o.type === 'shape' && shapeCurveIds(curves, o).includes(curve));
          return { layer, region: shape ? { curves: shape.curves ?? [], loops: shape.loops ?? [] } : { curves: [curve], loops: [] }, shape };
        }
      }
      if (!regions.has(layer)) regions.set(layer, meshRegions(points, curves));
      const region = regionIn(curves, regions.get(layer), at);
      if (region) return { layer, region };
    }
    return null;
  }

  /** Path of a region of a layer, drawn on the overlay with the layer's matrix. @param {Region} region */
  function curvesPath(doc, layer, region, attributes) {
    const points = read(schema, layer, 'points') ?? {};
    const curves = read(schema, layer, 'curves') ?? {};
    const vertsOf = (id) => curveVertices(points, curves[id]);
    const loops = region.loops.map((l) => resolveLoop(curves, l).segments).filter(Boolean).map((segments) => loopD(vertsOf, segments));
    const d = region.curves.filter((id) => curves[id]).map((id) => verticesAD(vertsOf(id), curves[id].closed ?? false)).join('') + loops.join('');
    return ctx.create('path', { d, transform: `matrix(${toScreen(doc, layer).join(' ')})`, 'fill-rule': 'evenodd', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...attributes });
  }

  /** Preview of painting a region with the tool: its fill and stroke, as they would look. @param {Region} region */
  function preview(doc, layer, region) {
    const fill = state.tool !== 'stroke';
    const stroke = state.tool !== 'fill';
    return curvesPath(doc, layer, region, { class: 'shape-preview', fill: fill ? newFill() : 'none', stroke: stroke ? NEW_STROKE.stroke : 'none', 'stroke-width': stroke ? NEW_STROKE.strokeWidth : '' });
  }

  /** The preview (of the picked points, or of what is under the pointer), then the picked layer's points. */
  function draw() {
    if (!active()) return;
    const doc = state.doc;
    const plan = shapePlan(doc);
    if (plan) ctx.overlay.append(preview(doc, plan.layer, plan));
    else if (hovered && findObject(doc, hovered.layer.id)) {
      ctx.overlay.append(preview(doc, hovered.layer, hovered.region));
      ctx.overlay.append(curvesPath(doc, hovered.layer, hovered.region, { class: 'shape-hover', fill: 'none' }));
    }
    const layer = shapeToolLayer(doc);
    if (!layer) return;
    const picked = new Set(state.shapePicked);
    const g = ctx.create('g', { class: 'shape-points' });
    for (const [id, [x, y]] of pointsOnScreen(doc, layer)) {
      g.append(ctx.create('circle', { class: `shape-point${picked.has(id) ? ' picked' : ''}`, 'data-shape-point': id, cx: x, cy: y, r: picked.has(id) ? 5 : 3.5 }, `${layer.id} point ${id}`));
    }
    ctx.overlay.append(g);
  }

  /** Pointer moving: what a click would paint there. */
  function hover(e) {
    if (!active() || state.shapePicked.length) return;
    const next = e.target.closest?.('[data-shape-point]') ? null : hitAt(state.doc, ctx.screenPoint(e));
    const key = (h) => (h ? `${h.layer.id}:${regionKey(read(schema, h.layer, 'curves') ?? {}, h.region)}` : '');
    if (key(next) === key(hovered)) return;
    hovered = next;
    ctx.redraw();
  }

  /**
   * A click paints what is under the pointer (Alt: clears it); on a point, picks it (Shift: adds or removes it).
   * Dragging picks the points inside a box (Shift adds, Alt removes).
   */
  function pointerdown(e) {
    const doc = state.doc;
    if (!active()) return;
    const layer = shapeToolLayer(doc);
    const point = e.target.closest('[data-shape-point]')?.dataset.shapePoint;
    if (layer && point !== undefined) {
      const picked = new Set(e.shiftKey ? state.shapePicked : []);
      if (e.shiftKey && picked.has(point)) picked.delete(point);
      else picked.add(point);
      return setState({ shapePicked: [...picked] });
    }
    const s0 = ctx.screenPoint(e);
    const box = ctx.create('rect', { class: 'marquee', x: s0[0], y: s0[1], width: 0, height: 0 });
    let s1 = s0;
    let boxing = false;
    ctx.drag(
      e,
      (ev) => {
        s1 = ctx.screenPoint(ev);
        if (!layer || Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) < 4) return;
        if (!boxing) ctx.overlay.append(box);
        boxing = true;
        Object.entries({ x: Math.min(s0[0], s1[0]), y: Math.min(s0[1], s1[1]), width: Math.abs(s1[0] - s0[0]), height: Math.abs(s1[1] - s0[1]) }).forEach(([k, v]) => box.setAttribute(k, v));
      },
      (ev) => {
        box.remove();
        const adding = e.shiftKey || ev.shiftKey;
        const removing = e.altKey || ev.altKey;
        if (!boxing) return click(e);
        const [x0, x1] = [Math.min(s0[0], s1[0]), Math.max(s0[0], s1[0])];
        const [y0, y1] = [Math.min(s0[1], s1[1]), Math.max(s0[1], s1[1])];
        const inside = pointsOnScreen(doc, layer).filter(([, [x, y]]) => x >= x0 && x <= x1 && y >= y0 && y <= y1).map(([id]) => id);
        const picked = new Set(adding || removing ? state.shapePicked : []);
        for (const id of inside) {
          if (removing) picked.delete(id);
          else picked.add(id);
        }
        hovered = null;
        setState({ shapePicked: [...picked] });
      },
    );
  }

  function click(e) {
    const doc = state.doc;
    const hit = hitAt(doc, ctx.screenPoint(e));
    hovered = null;
    if (state.shapePicked.length) setState({ shapePicked: [] });
    if (hit) return applyPaint(doc, hit.layer, hit.region, e.altKey, hit.shape);
    // Nothing to paint: a drawing picks its layer (as Select does); empty space drops the selection.
    const g = e.target.closest('[data-id]');
    select(g && ctx.documentG.contains(g) ? pickable(g.dataset.id) : null);
  }

  return { draw, pointerdown, hover };
}
