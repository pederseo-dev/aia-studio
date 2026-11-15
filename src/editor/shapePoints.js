// The picked shapes of a vector layer (a click inside the picked layer, Shift + click for more), as Moho's Transform Points: its points are framed by a box in the
// layer's frame. Dragging inside moves them, the corners scale (Shift: proportional), the top handle rotates (Shift:
// 15° steps) and the pivot can be dragged to rotate or scale around another place. Each point can be dragged alone
// to deform the shape. Welded points move the other shapes too.
//
// In the setup everything is written with `transformPoints` on the layer (see src/core/operations.js): the same sugar
// the AI uses. In a pose or a clip the same transform (src/core/meshTransform.js) is applied to the points as they are
// seen there, and only the moved points go into the pose (or a keyframe at the playhead), as set_pose and set_keys
// write them. The pivot is the editor's (a shape has no transform of its own), and lasts while the shape stays picked.

import { findObject, locked } from '../core/document.js';
import { read } from '../core/schema.js';
import { apply, invert, multiply, worldMatrix } from '../core/geometry.js';
import { pointsCenter, shapePointIds } from '../core/mesh.js';
import { meshChanges, transformPointsOf } from '../core/meshTransform.js';
import { applyPose } from '../core/blend.js';
import { boundPerPoint } from '../core/skeleton.js';
import { activePose, editingName, poseOps } from './editing.js';
import { execute, preview, schema, state } from './state.js';

const DEGREES = 180 / Math.PI;
const PAD = 10; // px on screen between the points and their box
const r2 = (v) => Math.round(v * 100) / 100 || 0;

/** @param {any} ctx the canvas tools context */
export function createShapePoints(ctx) {
  /** Pivot the user moved: { shape: the picked shapes' key, at: [x, y] in the layer's coordinates }. */
  let pivot = null;
  /** Key of the picked shapes: the pivot belongs to that exact set. */
  const pickedKey = () => [...state.selected].sort().join(',');

  /**
   * The picked shape, its layer, its points and curves as they are seen (in the pose or clip, if one is open) and the
   * matrix layer → screen. null if no shape is picked.
   */
  function picked() {
    // The pivot belongs to the shape picked now: picking anything else (or going back to the layer) forgets it.
    if (pivot && pivot.shape !== pickedKey()) pivot = null;
    // The Parameters view only shows the blend (nothing is edited there).
    if (state.live || (state.params && !state.pose) || state.tool !== 'select' || !state.selected.length) return null;
    const doc = state.previewDoc ?? state.doc;
    // One shape, or several shapes of the same layer (Shift + click): their points are transformed together.
    const shapes = state.selected.map((id) => findObject(doc, id));
    const shape = findObject(doc, state.selection);
    if (shape?.type !== 'shape' || !shapes.every((s) => s?.type === 'shape' && s.parent === shape.parent)) return null;
    const pose = activePose(doc);
    const seen = pose ? applyPose(doc, schema, pose) : doc;
    const layer = findObject(seen, shape.parent);
    // A locked layer is not changed on the canvas (transform.js marks it). In a pose, points bound to bones are
    // drawn where their bones take them, which is not where they are stored: they are posed with the bones.
    if (!layer || locked(doc, layer.id) || (pose && boundPerPoint(layer))) return null;
    const points = read(schema, layer, 'points') ?? {};
    const curves = read(schema, layer, 'curves') ?? {};
    const ids = shapePointIds(curves, shapes.flatMap((s) => s.curves ?? [])).filter((id) => points[id]);
    if (!ids.length) return null;
    // In a pose the layer may follow a bone: its matrix is the one drawn on screen.
    const m = pose ? ctx.element(layer.id)?.getCTM() : null;
    const toScreen = m ? [m.a, m.b, m.c, m.d, m.e, m.f] : multiply(ctx.cameraMatrix(), worldMatrix(doc, schema, layer.id));
    const pad = PAD / (Math.sqrt(Math.abs(toScreen[0] * toScreen[3] - toScreen[1] * toScreen[2])) || 1);
    const name = shapes.length === 1 ? shape.id : `${shapes.length} shapes`;
    // What transformPoints moves: the shape (its points), or the points of all the picked shapes.
    const what = shapes.length === 1 ? { shape: shape.id } : { points: ids };
    return { shape, shapes, name, what, layer, points, curves, ids, toScreen, toLayer: invert(toScreen), pad, center: pivot?.at ?? pointsCenter(points, ids) };
  }

  /**
   * The batch that applies the transform `t`: in the setup, `transformPoints` on the layer; in a pose or clip, the
   * moved points (and the curves whose tangents turn) into the pose or a keyframe.
   */
  function opsFor(p, t) {
    const pose = activePose();
    if (!pose) return [{ op: 'set', target: p.layer.id, props: { transformPoints: t } }];
    const before = { points: p.points, curves: p.curves };
    const fields = meshChanges(transformPointsOf(state.doc, p.layer, t, before), before);
    return Object.keys(fields).length ? poseOps(state.doc, pose.id, p.layer.id, fields) : [];
  }

  const noteFor = (what) => (activePose() ? `${editingName()}: ${what}` : what);

  /**
   * Box of the points in the layer's coordinates: [x0, y0, x1, y1], with a margin of PAD screen pixels so its handles
   * do not cover the corner points.
   */
  function box(p) {
    const xs = p.ids.map((id) => p.points[id].x);
    const ys = p.ids.map((id) => p.points[id].y);
    return [Math.min(...xs) - p.pad, Math.min(...ys) - p.pad, Math.max(...xs) + p.pad, Math.max(...ys) + p.pad];
  }

  function draw() {
    const p = picked();
    if (!p) return;
    const [x0, y0, x1, y1] = box(p);
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => apply(p.toScreen, x, y));
    ctx.overlay.append(ctx.create('polygon', { class: 'selection points-box', points: corners.map((c) => c.join(',')).join(' ') }));
    // Rotate handle: above the top edge, on screen.
    const top = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
    const side = [corners[0][0] - corners[3][0], corners[0][1] - corners[3][1]];
    const l = Math.hypot(...side) || 1;
    const knob = [top[0] + (side[0] / l) * 26, top[1] + (side[1] / l) * 26];
    ctx.overlay.append(ctx.create('line', { class: 'selection', x1: top[0], y1: top[1], x2: knob[0], y2: knob[1] }));
    ctx.overlay.append(ctx.create('circle', { class: 'handle', 'data-handle': 'sp-rotate', cx: knob[0], cy: knob[1], r: 5 }, 'Rotate the points around the pivot (Shift: 15° steps)'));
    corners.forEach(([x, y], i) => ctx.overlay.append(ctx.create('rect', { class: 'handle', 'data-handle': `sp-scale${i}`, x: x - 4, y: y - 4, width: 8, height: 8 }, 'Scale the points from the pivot (Shift: proportional)')));
    for (const id of p.ids) {
      const [x, y] = apply(p.toScreen, p.points[id].x, p.points[id].y);
      ctx.overlay.append(ctx.create('rect', { class: 'handle anchor', 'data-handle': `sp-point-${id}`, x: x - 3.5, y: y - 3.5, width: 7, height: 7 }, `Point ${id}: drag to deform the shape`));
    }
    const [px, py] = apply(p.toScreen, ...p.center);
    ctx.overlay.append(ctx.create('circle', { class: 'pivot handle', 'data-handle': 'sp-pivot', cx: px, cy: py, r: 5 }, 'Pivot of the points: drag it to rotate or scale around another place'));
  }

  /** Drags with a batch built from the layer-coordinates cursor; it is previewed and saved as one step. */
  function dragOps(e, build, note) {
    const p = picked();
    if (!p) return;
    const l0 = apply(p.toLayer, ...ctx.screenPoint(e));
    let ops = null;
    let last = null;
    ctx.drag(
      e,
      (ev) => {
        const transform = build(p, l0, apply(p.toLayer, ...ctx.screenPoint(ev)), ev);
        if (!transform) return;
        last = transform;
        ops = opsFor(p, transform);
        preview(ops);
      },
      () => {
        if (!ops?.length) return preview(null);
        // Moving the whole shape carries the pivot the user placed along with it.
        if (pivot && (last.shape || last.points === p.ids) && last.translate) pivot = { ...pivot, at: [r2(pivot.at[0] + last.translate[0]), r2(pivot.at[1] + last.translate[1])] };
        execute(ops, noteFor(`${note} ${p.name}`));
      },
    );
  }

  /** Drag inside the picked shape: moves all its points. */
  function move(e) {
    dragOps(e, (p, l0, l, ev) => {
      if (Math.hypot(l[0] - l0[0], l[1] - l0[1]) < 0.5) return null;
      let d = [l[0] - l0[0], l[1] - l0[1]];
      if (ev.shiftKey) d = Math.abs(d[0]) > Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
      return { ...p.what, translate: d.map(r2) };
    }, 'move points of');
  }

  function handle(e, name) {
    if (name === 'sp-pivot') {
      const p = picked();
      if (!p) return;
      return ctx.drag(
        e,
        (ev) => {
          pivot = { shape: pickedKey(), at: apply(p.toLayer, ...ctx.screenPoint(ev)).map(r2) };
          ctx.redraw();
        },
        () => {},
      );
    }
    if (name === 'sp-rotate') {
      return dragOps(e, (p, l0, l, ev) => {
        const c = p.center;
        let a = (Math.atan2(l[1] - c[1], l[0] - c[0]) - Math.atan2(l0[1] - c[1], l0[0] - c[0])) * DEGREES;
        a = ((a + 540) % 360) - 180;
        a = ev.shiftKey ? Math.round(a / 15) * 15 : r2(a);
        return { ...p.what, rotate: a, origin: c };
      }, 'rotate points of');
    }
    if (name.startsWith('sp-scale')) {
      return dragOps(e, (p, l0, l, ev) => {
        const c = p.center;
        // The corner sits PAD outside the points: the ratio is measured without that margin, so the box's corner
        // stays under the cursor.
        const ratio = (now, start) => {
          const side = Math.sign(start) || 1;
          const from = start - side * p.pad;
          return Math.abs(from) < 1e-6 ? 1 : (now - side * p.pad) / from;
        };
        let sx = ratio(l[0] - c[0], l0[0] - c[0]);
        let sy = ratio(l[1] - c[1], l0[1] - c[1]);
        if (ev.shiftKey) {
          const d0 = Math.hypot(l0[0] - c[0], l0[1] - c[1]);
          sx = sy = d0 > p.pad * 1.5 ? (Math.hypot(l[0] - c[0], l[1] - c[1]) - p.pad * 1.41) / (d0 - p.pad * 1.41) : 1;
        }
        return { ...p.what, scale: [Math.round(sx * 1000) / 1000, Math.round(sy * 1000) / 1000], origin: c };
      }, 'scale points of');
    }
    if (name.startsWith('sp-point-')) {
      const id = name.slice('sp-point-'.length);
      return dragOps(e, (p, l0, l) => ({ points: [id], translate: [r2(l[0] - l0[0]), r2(l[1] - l0[1])] }), `move point ${id} of`);
    }
  }

  /** Arrow keys on a picked shape: its points move 1 px on screen (Shift: 10). */
  function nudge(dx, dy) {
    const p = picked();
    if (!p) return false;
    const [ox, oy] = apply(p.toLayer, 0, 0);
    const [x, y] = apply(p.toLayer, dx, dy);
    if (pivot) pivot = { ...pivot, at: [r2(pivot.at[0] + x - ox), r2(pivot.at[1] + y - oy)] };
    const ops = opsFor(p, { ...p.what, translate: [r2(x - ox), r2(y - oy)] });
    if (ops.length) execute(ops, noteFor(`move points of ${p.name}`), { group: `arrows:${state.pose ?? ''}:${pickedKey()}` });
    return true;
  }

  return { draw, handle, move, nudge, active: () => !!picked() };
}
