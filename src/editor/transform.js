// Selection tool: select (click, Ctrl/Shift + click, marquee), move and the handles to rotate, scale and move the
// pivot. With several objects, the handles surround all of them and rotate or scale from the group's center.
// In an open pose or clip it also works for what does not follow a bone: move, rotate and scale are saved in the
// pose (in a clip, as keyframes at the playhead) and the setup does not change. The pivot only moves in the setup.

import { locked, findObject, children } from '../core/document.js';
import { read } from '../core/schema.js';
import { apply, invert, localMatrix, worldMatrix, multiply } from '../core/geometry.js';
import { transformVertices } from '../core/paths.js';
import { boneOf } from '../core/skeleton.js';
import { applyPose } from '../core/blend.js';
import { editingName, poseOps, activePose } from './editing.js';
import { toggleSelection, execute, schema, state, preview, selectionRoots, select, selectSeveral } from './state.js';

const round = (v, d = 10) => Math.round(v * d) / d;
const DEGREES = 180 / Math.PI;
const RADIANS = Math.PI / 180;
const SHAPES = 'path, rect, ellipse, circle, line, polyline, polygon, image';

const IN_POSE = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];

/** What follows no bone (neither by layer nor by points): in a pose it is transformed as in the setup. */
export function isFree(doc, id) {
  const o = findObject(doc, id);
  return !!o && o.type !== 'bone' && o.type !== 'skeleton' && !boneOf(doc, id) && !(o.vertices ?? []).some((v) => v.bone);
}

export function createTransform(ctx) {
  // ---------- Pose or setup ----------

  /** The document as seen: in a pose or clip, with its values applied (x, rotation, scale… are read from there). */
  const seen = () => {
    const pose = state.pose && activePose();
    return pose ? applyPose(state.doc, schema, pose) : state.doc;
  };

  /**
   * In a pose, the drawing's `set`s go to the pose being edited (in a clip, keyframes at the playhead), each one on
   * top of what the previous one left. Outside a pose they stay as they are.
   */
  function inPose(ops) {
    if (!ops || !state.pose) return ops;
    const pose = activePose();
    let doc = state.doc;
    let output = [];
    for (const op of ops) {
      const fields = Object.fromEntries(Object.entries(op.props).filter(([k]) => IN_POSE.includes(k)));
      if (!Object.keys(fields).length) continue;
      output = poseOps(doc, pose.id, op.target, fields);
      doc = { ...doc, objects: doc.objects.map((o) => (o.id === pose.id ? { ...o, ...output[0].props } : o)) };
    }
    return output.length ? output : null;
  }
  const show = (ops) => preview(inPose(ops));
  const save = (ops, note) => {
    const final = inPose(ops);
    if (!final) return preview(null);
    execute(final, state.pose ? `${editingName()}: ${note}` : note);
  };
  /** What is picked and transformed: in a pose, only the free ones (bones and bound things are posed with their bones). */
  const roots = () => (state.pose ? selectionRoots().filter((id) => isFree(state.doc, id)) : selectionRoots());

  // ---------- Boxes on screen ----------

  /** The four corners of an element's box, on screen (rotated with it). Null if it is not seen. */
  function cornersOf(el) {
    if (!el || el.closest('[display="none"]')) return null;
    const m = el.getCTM();
    const box = boxWithOutline(el, m);
    if (!m || !box) return null;
    const point = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    return [point(box.x0, box.y0), point(box.x1, box.y0), point(box.x1, box.y1), point(box.x0, box.y1)];
  }

  /**
   * Box of `el` in its local coordinates counting the outline width of each shape (getBBox does not count it,
   * and in groups with thick outlines the selection was cut off). Hidden variants of a switch do not count.
   */
  function boxWithOutline(el, m) {
    const shapes = el.matches(SHAPES) ? [el] : [...el.querySelectorAll(SHAPES)];
    const inverse = m?.inverse();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of shapes) {
      if (f.closest('[display="none"]')) continue;
      const b = f.getBBox();
      if (!b.width && !b.height) continue;
      const style = getComputedStyle(f);
      const half = style.stroke && style.stroke !== 'none' ? (parseFloat(style.strokeWidth) || 0) / 2 : 0;
      // From the shape to the coordinates of `el`.
      const a = f === el ? null : inverse.multiply(f.getCTM());
      for (const [x, y] of [[b.x - half, b.y - half], [b.x + b.width + half, b.y - half], [b.x + b.width + half, b.y + b.height + half], [b.x - half, b.y + b.height + half]]) {
        const [px, py] = a ? [a.a * x + a.c * y + a.e, a.b * x + a.d * y + a.f] : [x, y];
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  }

  /** Screen-aligned box that wraps several lists of corners. */
  function enclosing(lists) {
    const points = lists.flat();
    if (!points.length) return null;
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return { corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], center: [(x0 + x1) / 2, (y0 + y1) / 2], x0, y0, x1, y1 };
  }

  const several = () => state.selected.length > 1;

  // ---------- Drawing of the selection and its handles ----------

  function draw() {
    if (state.pose && !state.selected.every((id) => isFree(state.doc, id))) return;
    // Locked (picked from Layers): it is marked, without handles.
    if (state.selected.some((id) => locked(state.doc, id))) {
      for (const id of state.selected) {
        const corners = cornersOf(ctx.element(id));
        if (corners) ctx.overlay.append(ctx.create('polygon', { class: 'selection secondary', points: corners.map((p) => p.join(',')).join(' ') }, 'Locked: unlock it in Layers to edit it on the canvas'));
      }
      return;
    }
    if (several()) return drawSeveral();
    const el = state.selection && ctx.element(state.selection);
    if (!el) return;
    const obj = findObject(state.doc, state.selection);
    const corners = cornersOf(el);
    if (corners) boxHandles(corners);
    const m = el.getCTM();
    const [px, py] = [m.e, m.f];
    const movable = !state.pose && ['group', 'path', 'rect', 'ellipse', 'image'].includes(obj.type);
    ctx.overlay.append(
      ctx.create('circle', { class: movable ? 'pivot handle' : 'pivot', 'data-handle': movable ? 'pivot' : '', cx: px, cy: py, r: 5 }, movable ? 'Move the pivot without moving the drawing' : 'Pivot'),
    );
  }

  function drawSeveral() {
    const lists = state.selected.map((id) => cornersOf(ctx.element(id))).filter(Boolean);
    for (const corners of lists) ctx.overlay.append(ctx.create('polygon', { class: 'selection secondary', points: corners.map((p) => p.join(',')).join(' ') }));
    const box = enclosing(lists);
    if (!box) return;
    boxHandles(box.corners);
    ctx.overlay.append(ctx.create('circle', { class: 'pivot', cx: box.center[0], cy: box.center[1], r: 4 }, `${state.selected.length} objects: rotate and scale from the center`));
  }

  function boxHandles(corners) {
    ctx.overlay.append(ctx.create('polygon', { class: 'selection', points: corners.map((p) => p.join(',')).join(' ') }));
    // Rotate handle: above the top edge.
    const top = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
    const side = [corners[0][0] - corners[3][0], corners[0][1] - corners[3][1]];
    const l = Math.hypot(...side) || 1;
    const rotate = [top[0] + (side[0] / l) * 26, top[1] + (side[1] / l) * 26];
    ctx.overlay.append(ctx.create('line', { class: 'selection', x1: top[0], y1: top[1], x2: rotate[0], y2: rotate[1] }));
    ctx.overlay.append(ctx.create('circle', { class: 'handle', 'data-handle': 'rotate', cx: rotate[0], cy: rotate[1], r: 5 }, 'Rotate (Shift: 15° steps)'));
    const help = several() ? 'Scale the set from its center' : 'Scale from the pivot (Shift: proportional)';
    corners.forEach(([x, y], i) => {
      ctx.overlay.append(ctx.create('rect', { class: 'handle', 'data-handle': `scale${i}`, x: x - 4, y: y - 4, width: 8, height: 8 }, help));
    });
  }

  // ---------- Select and move ----------

  function selectAndMove(e) {
    const g = e.target.closest('[data-id]');
    const add = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!g || !ctx.documentG.contains(g)) return marquee(e, add);
    const id = g.dataset.id;
    // Ctrl or Shift + click: adds or removes without moving.
    if (add) return toggleSelection(id);
    // Click on something already in a multiple selection: all of them move; if there was no drag, only that one stays.
    const inGroup = several() && state.selected.includes(id);
    if (!inGroup) select(id);
    else if (state.selection !== id) selectSeveral(state.selected, id);

    const start = { x: e.clientX, y: e.clientY };
    const doc = seen();
    const objects = roots().map((oid) => {
      const obj = findObject(doc, oid);
      const inverse = invert(multiply(ctx.cameraMatrix(), worldMatrix(doc, schema, obj.parent ?? null)));
      return { id: oid, inverse, x0: read(schema, obj, 'x'), y0: read(schema, obj, 'y'), l0: apply(inverse, ...ctx.screenPoint(e)) };
    });
    let ops = null;

    ctx.drag(
      e,
      (ev) => {
        if (!ops && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
        // Shift: move only along the dominant screen axis.
        const s0 = ctx.screenPoint(e);
        let s = ctx.screenPoint(ev);
        if (ev.shiftKey) s = Math.abs(s[0] - s0[0]) > Math.abs(s[1] - s0[1]) ? [s[0], s0[1]] : [s0[0], s[1]];
        ops = objects.map((o) => {
          const [lx, ly] = apply(o.inverse, ...s);
          return { op: 'set', target: o.id, props: { x: round(o.x0 + lx - o.l0[0]), y: round(o.y0 + ly - o.l0[1]) } };
        });
        show(ops);
      },
      () => {
        if (ops) return save(ops, `move ${name(objects)}`);
        preview(null);
        if (inGroup) select(id);
      },
    );
  }

  const name = (objects) => (objects.length === 1 ? objects[0].id : `${objects.length} objects`);

  /** Dragging on an empty spot: selects the shapes the marquee touches. With Ctrl or Shift, adds them. */
  function marquee(e, add) {
    const base = add ? [...state.selected] : [];
    const s0 = ctx.screenPoint(e);
    const frame = ctx.create('rect', { class: 'marquee' });
    // Boxes of the visible shapes (not containers: what is seen is picked, as with the click).
    const shapes = [...ctx.documentG.querySelectorAll('[data-id]')]
      .filter((el) => !['group', 'skeleton', 'switch'].includes(findObject(state.doc, el.dataset.id)?.type) && !locked(state.doc, el.dataset.id))
      .map((el) => ({ id: el.dataset.id, box: enclosing([cornersOf(el) ?? []]) }))
      .filter((f) => f.box);
    let moved = false;

    ctx.drag(
      e,
      (ev) => {
        const s = ctx.screenPoint(ev);
        if (!moved && Math.hypot(s[0] - s0[0], s[1] - s0[1]) < 3) return;
        moved = true;
        const [x0, y0, x1, y1] = [Math.min(s0[0], s[0]), Math.min(s0[1], s[1]), Math.max(s0[0], s[0]), Math.max(s0[1], s[1])];
        const touched = shapes.filter(({ box: c }) => c.x0 <= x1 && c.x1 >= x0 && c.y0 <= y1 && c.y1 >= y0).map((f) => f.id);
        const ids = [...base, ...touched.filter((id) => !base.includes(id))];
        if (ids.join() !== state.selected.join()) selectSeveral(ids, ids.at(-1) ?? null);
        for (const [k, v] of Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })) frame.setAttribute(k, v);
        ctx.overlay.append(frame); // the overlay is redrawn when the selection changes
      },
      () => {
        frame.remove();
        if (!moved && !add) select(null);
      },
    );
  }

  // ---------- Handles ----------

  function handle(e, kind) {
    if (roots().length > 1) return multiHandle(e, kind);
    const id = state.selection;
    if (state.pose && (kind === 'pivot' || !isFree(state.doc, id))) return;
    const doc = seen();
    const obj = findObject(doc, id);
    const parent = multiply(ctx.cameraMatrix(), worldMatrix(doc, schema, obj.parent ?? null));
    const x0 = read(schema, obj, 'x');
    const y0 = read(schema, obj, 'y');
    const rot0 = read(schema, obj, 'rotation');
    const sx0 = read(schema, obj, 'scaleX');
    const sy0 = read(schema, obj, 'scaleY');
    const pivot = apply(parent, x0, y0); // on screen
    let ops = null;
    const finish = (note) => () => (ops ? save(ops, note) : preview(null));

    if (kind === 'rotate') {
      const direction = directionOf(parent);
      const angle = (p) => Math.atan2(p[1] - pivot[1], p[0] - pivot[0]) * DEGREES;
      const a0 = angle(ctx.screenPoint(e));
      return ctx.drag(
        e,
        (ev) => {
          let rot = rot0 + direction * (angle(ctx.screenPoint(ev)) - a0);
          rot = ev.shiftKey ? Math.round(rot / 15) * 15 : round(rot);
          ops = [{ op: 'set', target: id, props: { rotation: rot } }];
          show(ops);
        },
        finish(`rotate ${id}`),
      );
    }

    if (kind === 'scale-free') {
      // Scale tool: dragging anywhere scales proportionally according to the distance to the pivot.
      const distance = (p) => Math.hypot(p[0] - pivot[0], p[1] - pivot[1]);
      const d0 = Math.max(distance(ctx.screenPoint(e)), 8);
      return ctx.drag(
        e,
        (ev) => {
          const f = distance(ctx.screenPoint(ev)) / d0;
          ops = [{ op: 'set', target: id, props: { scaleX: round(sx0 * f, 1000), scaleY: round(sy0 * f, 1000) } }];
          show(ops);
        },
        finish(`scale ${id}`),
      );
    }

    if (kind.startsWith('scale')) {
      // Coordinates of the object rotated but without its scale: that way the quotient gives the new scale.
      const frame = invert(multiply(parent, localMatrix(schema, { ...obj, scaleX: 1, scaleY: 1 })));
      const p0 = apply(frame, ...ctx.screenPoint(e));
      return ctx.drag(
        e,
        (ev) => {
          const p = apply(frame, ...ctx.screenPoint(ev));
          let sx = Math.abs(p0[0]) > 1 ? (sx0 * p[0]) / p0[0] : sx0;
          let sy = Math.abs(p0[1]) > 1 ? (sy0 * p[1]) / p0[1] : sy0;
          if (ev.shiftKey) {
            const f = Math.hypot(...p) / (Math.hypot(...p0) || 1);
            [sx, sy] = [sx0 * f, sy0 * f];
          }
          ops = [{ op: 'set', target: id, props: { scaleX: round(sx, 1000), scaleY: round(sy, 1000) } }];
          show(ops);
        },
        finish(`scale ${id}`),
      );
    }

    if (kind === 'pivot') {
      // Moves the pivot and compensates the content (children or vertices) so the drawing does not move.
      const parentInverse = invert(parent);
      const linear = invert([...localMatrix(schema, obj).slice(0, 4), 0, 0]);
      return ctx.drag(
        e,
        (ev) => {
          const [x, y] = apply(parentInverse, ...ctx.screenPoint(ev)).map((v) => round(v));
          const [dx, dy] = apply(linear, x - x0, y - y0);
          ops = [{ op: 'set', target: id, props: { x, y } }];
          if (obj.type === 'path') {
            ops[0].props.vertices = transformVertices(read(schema, obj, 'vertices'), [1, 0, 0, 1, -dx, -dy]);
          } else if (obj.type === 'rect' || obj.type === 'ellipse' || obj.type === 'image') {
            // The shape shifts inside its frame: the pivot moves to another fraction of the width and the height.
            const [w, h] = [read(schema, obj, 'width'), read(schema, obj, 'height')];
            if (w && Math.abs(dx) > 1e-6) ops[0].props.originX = round(read(schema, obj, 'originX') + dx / w, 10000);
            if (h && Math.abs(dy) > 1e-6) ops[0].props.originY = round(read(schema, obj, 'originY') + dy / h, 10000);
          } else {
            for (const h of children(state.doc, id)) {
              ops.push({ op: 'set', target: h.id, props: { x: round(read(schema, h, 'x') - dx, 100), y: round(read(schema, h, 'y') - dy, 100) } });
            }
          }
          show(ops);
        },
        finish(`move pivot of ${id}`),
      );
    }
  }

  // If the parent is mirrored, the rotation on screen goes the other way.
  const directionOf = (m) => Math.sign(m[0] * m[3] - m[1] * m[2]) || 1;

  /**
   * Rotate or scale several objects at once from the center of their common box: each one rotates or scales about
   * itself and its pivot moves around the center. With several, the scale is always proportional.
   */
  function multiHandle(e, kind) {
    const ids = roots();
    const box = enclosing(ids.map((id) => cornersOf(ctx.element(id))).filter(Boolean));
    if (!box) return;
    const c = box.center;
    const doc = seen();
    const objects = ids.map((id) => {
      const obj = findObject(doc, id);
      const parent = multiply(ctx.cameraMatrix(), worldMatrix(doc, schema, obj.parent ?? null));
      const props = Object.fromEntries(['x', 'y', 'rotation', 'scaleX', 'scaleY'].map((p) => [p, read(schema, obj, p)]));
      return { id, parent, inverse: invert(parent), props, pivot: apply(parent, props.x, props.y) };
    });
    const position = (o, [sx, sy]) => {
      const [x, y] = apply(o.inverse, sx, sy);
      return { x: round(x), y: round(y) };
    };
    let ops = null;
    const note = `${kind === 'rotate' ? 'rotate' : 'scale'} ${objects.length} objects`;

    if (kind === 'rotate') {
      const angle = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]) * DEGREES;
      const a0 = angle(ctx.screenPoint(e));
      return ctx.drag(
        e,
        (ev) => {
          let delta = angle(ctx.screenPoint(ev)) - a0;
          if (ev.shiftKey) delta = Math.round(delta / 15) * 15;
          const [cos, sin] = [Math.cos(delta * RADIANS), Math.sin(delta * RADIANS)];
          ops = objects.map((o) => {
            const [dx, dy] = [o.pivot[0] - c[0], o.pivot[1] - c[1]];
            const p = position(o, [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos]);
            return { op: 'set', target: o.id, props: { ...p, rotation: round(o.props.rotation + directionOf(o.parent) * delta) } };
          });
          show(ops);
        },
        () => (ops ? save(ops, note) : preview(null)),
      );
    }

    if (kind.startsWith('scale')) {
      const distance = (p) => Math.hypot(p[0] - c[0], p[1] - c[1]);
      const d0 = Math.max(distance(ctx.screenPoint(e)), 8);
      return ctx.drag(
        e,
        (ev) => {
          const f = distance(ctx.screenPoint(ev)) / d0;
          ops = objects.map((o) => {
            const p = position(o, [c[0] + (o.pivot[0] - c[0]) * f, c[1] + (o.pivot[1] - c[1]) * f]);
            return { op: 'set', target: o.id, props: { ...p, scaleX: round(o.props.scaleX * f, 1000), scaleY: round(o.props.scaleY * f, 1000) } };
          });
          show(ops);
        },
        () => (ops ? save(ops, note) : preview(null)),
      );
    }
  }

  /**
   * Rotate and Scale tools (as in Moho): dragging anywhere on the canvas transforms the selection.
   * If it starts over an object that is not selected, that one is selected first.
   */
  function withTool(e, tool) {
    const g = e.target.closest('[data-id]');
    if (g && ctx.documentG.contains(g) && !state.selected.includes(g.dataset.id)) select(g.dataset.id);
    if (!state.selection) return;
    handle(e, tool === 'rotate' ? 'rotate' : 'scale-free');
  }

  return { draw, selectAndMove, handle, withTool };
}
