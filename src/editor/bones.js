// Bones on the canvas: they are drawn in the overlay (they are not part of the character nor rows in Layers) and are
// handled with two tools, as in Moho:
//
// - Add Bone (B): only creates. Dragging on empty space creates a bone (child of the selected one or, if no bone is
//   selected, root of the selected skeleton or the one containing the selection; with none, a skeleton is created).
//   Dragging from the tip of the selected bone chains a new one. A click on a bone picks it (to hang children on it).
// - Manipulate Bones (M): only adjusts. Dragging a bone rotates it; the origin handle moves it and the tip handle
//   changes direction and length.
// - Reparent Bone: nothing happens just by clicking. Click picks a bone, Shift/Ctrl + click adds more, click on empty
//   space drops the selection. The bar buttons make the change: «Parent to …» hangs the picked ones from the last one
//   picked, and «Clear parent» makes them roots. They do not move on screen. While it is active the hierarchy is
//   drawn.
// - Bind Layer (L): click on a bone and then on the drawing (or its row in Layers) so it follows it whole; another
//   click releases it. Alt + click takes the group that contains it.
// - Bind Points: click on a bone and then on points of the paths of its skeleton (or a marquee around them) so they
//   follow that bone; Alt releases. Each bone has a color and its points are painted with it.
//
// In the setup those adjustments change the rest pose. With an active pose, any tool poses: dragging a bone (or the
// drawing bound to it) rotates it within the pose and the origin offsets it.

import { locked, findObject, skeletonOf } from '../core/document.js';
import { read } from '../core/schema.js';
import { evaluateInPose, evaluateSkeleton, boneOf, limitAngle, childFrame, reasonNotToBind, opsToReleaseOnMove, planProximityBinding, planReparentBones, boneValues } from '../core/skeleton.js';
import { apply, invert, worldMatrix, multiply } from '../core/geometry.js';
import { applyPose } from '../core/blend.js';
import { editingName, poseOps, activePose, viewedPose } from './editing.js';
import { toggleSelection, notify, docVisible, execute, schema, state, freeId, preview, select, selectSeveral } from './state.js';

const round = (v, d = 10) => Math.round(v * d) / d;

/** Tools of the bone group (with any of them, bones can be touched on the canvas). */
export const BONE_TOOLS = ['bone', 'manipulate', 'reparent', 'bindLayer', 'bindPoints'];

// One color per bone (as in Rive), to see which points and which drawing follow which.
const COLORS = ['#ff6b6b', '#ffa94d', '#e9d94a', '#69db7c', '#3bc9db', '#5c9dff', '#b197fc', '#f783ac'];

export function boneColor(doc, id) {
  const i = doc.objects.filter((o) => o.type === 'bone').findIndex((h) => h.id === id);
  return i < 0 ? '#ffffffaa' : COLORS[i % COLORS.length];
}

/** The picked bone, if any. */
const chosenBone = (doc = state.doc) => {
  const sel = state.selection && findObject(doc, state.selection);
  return sel?.type === 'bone' ? sel : null;
};

/**
 * Reparent Bone: what the buttons would do with the current selection. The children are the picked bones minus the
 * main one (the last picked), which is the parent. Returns { parent, children, ops, problem } for «Parent to…» and
 * { loose, ops } for «Clear parent» (the picked ones that are not roots).
 */
export function reparentPlan(doc = state.doc) {
  return planReparentBones(doc, schema, state.selected, state.selection);
}

/** The bone Bind Layer binds to: the picked one, with that tool active (and outside a pose). */
export function boneToBind(doc = state.doc) {
  return state.tool === 'bindLayer' && !state.pose ? (chosenBone(doc)?.id ?? null) : null;
}
const DEGREES = 180 / Math.PI;

/**
 * The skeleton the Bone tool works on: the selected one, the one of the selected bone or the one containing the
 * selection. null if there is none.
 */
export function activeSkeleton(doc = state.doc) {
  const sel = state.selection && findObject(doc, state.selection);
  if (!sel) return null;
  return sel.type === 'skeleton' ? sel.id : skeletonOf(doc, sel.id);
}

// Used by the Layers panel and main.js; it lives in the core.
export { reasonNotToBind };

/** Attaches an object to the bone or, if it was already attached to that one, releases it. */
export function toggleBinding(id, bone) {
  const obj = findObject(state.doc, id);
  if (!obj || !('bone' in (schema.types.get(obj.type)?.properties ?? {}))) return;
  if (obj.bone === bone) return execute([{ op: 'unset', target: id, props: ['bone'] }], `unbind ${id}`);
  const reason = reasonNotToBind(state.doc, id, bone);
  if (reason) return notify(reason, true);
  execute([{ op: 'set', target: id, props: { bone: bone } }], `bind ${id} to ${bone}`);
}

/** «Bind all by proximity»: the skeleton's drawing that follows no bone goes to the nearest one. */
export function bindByProximity(skeletonId) {
  let plan;
  try {
    plan = planProximityBinding(state.doc, schema, skeletonId);
  } catch {
    return notify(`Skeleton ${skeletonId} has no bones yet: create them with Add Bone (B)`, true);
  }
  const { ops, bindings } = plan;
  if (!bindings.length) return notify(`All the drawing in ${skeletonId} already follows a bone`);
  execute(ops, `bind all by proximity in ${skeletonId} (${bindings.length})`);
  notify(`Bound ${bindings.length}: ${bindings.map((e) => `${e.id} → ${e.bone}`).join(', ')}`);
}

/**
 * Before moving `id` to `parent`: what releases the bindings that would stop being valid (drawing that leaves the
 * skeleton of its bone, or bones that go to another skeleton). It goes in the same batch, before the move.
 */
export function releaseOnMove(doc, id, parent) {
  return opsToReleaseOnMove(doc, schema, id, parent);
}

/** Notice for what releaseOnMove released. */
export function notifyLoose(ops) {
  const ids = [...new Set(ops.map((o) => o.target))];
  if (ids.length) notify(`Unbound ${ids.join(', ')}: a drawing only follows bones of its own skeleton`);
}

export function createBones(ctx) {
  const active = () => BONE_TOOLS.includes(state.tool) || !!state.pose;
  const adjusting = () => state.tool === 'manipulate' || !!state.pose;
  const isBone = (id) => findObject(state.doc, id)?.type === 'bone';

  // ---------- Drawing ----------

  function draw() {
    const doc = docVisible();
    const bones = doc.objects.filter((o) => o.type === 'bone');
    if (!bones.length) return;
    const { posed } = evaluateInPose(doc, schema, viewedPose(doc));
    const camera = ctx.cameraMatrix();
    const layer = ctx.create('g', { class: `bones${active() ? ' active' : ''}` });
    const chosen = chosenBone(doc);
    for (const h of bones) {
      const m = multiply(camera, posed.get(h.id));
      const o = apply(m, 0, 0);
      const t = apply(m, read(schema, h, 'length'), 0);
      const length = Math.hypot(t[0] - o[0], t[1] - o[1]);
      // The parent and the children of the picked bone, marked to see the chain.
      // With Reparent Bone and several picked, the main one is the parent that will be used: it is marked differently.
      const reparenting = state.tool === 'reparent' && state.selected.length > 1;
      const kinship = reparenting ? (h.id === state.selection ? ' new-parent' : '') : chosen && h.id === chosen.parent ? ' parent' : chosen && h.parent === chosen.id ? ' child' : '';
      const className = `bone${state.selected.includes(h.id) ? ' selected' : ''}${h.id === state.selection ? ' main' : ''}${kinship}`;
      // Locked (it or a parent): drawn but not picked, so clicks go through to what is below.
      const color = { style: `--c: ${boneColor(doc, h.id)}${locked(doc, h.id) ? '; pointer-events: none' : ''}` };
      // Dotted joint when the bone does not start at its parent's tip.
      const parent = h.parent && findObject(doc, h.parent);
      if (parent?.type === 'bone') {
        const mp = multiply(camera, posed.get(parent.id));
        const tip = apply(mp, read(schema, parent, 'length'), 0);
        if (Math.hypot(tip[0] - o[0], tip[1] - o[1]) > 2) layer.append(ctx.create('line', { class: 'union-bone', x1: tip[0], y1: tip[1], x2: o[0], y2: o[1] }));
      }
      if (length < 4) {
        layer.append(ctx.create('circle', { class: className, 'data-bone': h.id, cx: o[0], cy: o[1], r: 4, ...color }, h.id));
        continue;
      }
      // Elongated diamond shape, as in Moho: wide near the origin, pointed towards the end.
      const [dx, dy] = [(t[0] - o[0]) / length, (t[1] - o[1]) / length];
      const width = Math.min(9, Math.max(3, length * 0.12));
      const q = [o[0] + dx * length * 0.2, o[1] + dy * length * 0.2];
      const points = [o, [q[0] - dy * width, q[1] + dx * width], t, [q[0] + dy * width, q[1] - dx * width]];
      layer.append(ctx.create('polygon', { class: className, 'data-bone': h.id, points: points.map((p) => p.join(',')).join(' '), ...color }, h.id));
    }
    // Reparent Bone: the whole hierarchy, a line from each bone to the middle of its parent.
    if (state.tool === 'reparent' && !state.pose) {
      for (const h of bones) {
        const parent = findObject(doc, h.parent);
        if (parent?.type !== 'bone') continue;
        const o = apply(multiply(camera, posed.get(h.id)), 0, 0);
        const p = apply(multiply(camera, posed.get(parent.id)), read(schema, parent, 'length') / 2, 0);
        layer.prepend(ctx.create('line', { class: 'parent-line', x1: o[0], y1: o[1], x2: p[0], y2: p[1] }, `${h.id} hangs from ${parent.id}`));
      }
    }
    ctx.overlay.append(layer);
    if (state.tool === 'bindPoints' && !state.pose) drawPoints(doc);

    // What the picked bone moves, marked on the drawing.
    const marked = chosen?.id;
    if (marked) {
      for (const o of doc.objects.filter((x) => x.bone === marked)) {
        const el = ctx.element(o.id);
        const m = el?.getCTM();
        const box = el?.getBBox();
        if (!m || !box || (!box.width && !box.height)) continue;
        const p = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f].join(',');
        const points = [p(box.x, box.y), p(box.x + box.width, box.y), p(box.x + box.width, box.y + box.height), p(box.x, box.y + box.height)].join(' ');
        ctx.overlay.append(ctx.create('polygon', { class: 'bound', points: points }, `${o.id} follows ${marked}`));
      }
    }

    // Handles of the main selected bone: with Manipulate (or in a pose), origin and tip to adjust it; with Add
    // Bone, only the tip, to chain.
    const sel = active() && state.selection && findObject(doc, state.selection);
    if (sel?.type === 'bone') {
      const m = multiply(camera, posed.get(sel.id));
      const [ox, oy] = apply(m, 0, 0);
      const [tx, ty] = apply(m, read(schema, sel, 'length'), 0);
      if (adjusting()) ctx.overlay.append(ctx.create('circle', { class: 'handle', 'data-handle': 'bone-origin', cx: ox, cy: oy, r: 5 }, state.pose ? 'Offset the bone in the pose' : 'Move the bone origin'));
      const title = state.pose ? 'Rotate the bone' : adjusting() ? 'Direction and length (Shift: 15° steps)' : 'Drag: chain a new bone from this tip';
      if (adjusting() || state.tool === 'bone') ctx.overlay.append(ctx.create('circle', { class: `handle${adjusting() ? '' : ' handle-chain'}`, 'data-handle': 'bone-tip', cx: tx, cy: ty, r: 5 }, title));
    }
  }

  /** Bind Points: the points of the active skeleton's paths, with the color of the bone they follow. */
  function drawPoints(doc) {
    const skeleton = activeSkeleton(doc);
    if (!skeleton) return;
    const camera = ctx.cameraMatrix();
    const layer = ctx.create('g', { class: 'bone-points' });
    // Points of locked paths are not shown: they cannot be bound from the canvas.
    for (const path of doc.objects.filter((o) => o.type === 'path' && skeletonOf(doc, o.id) === skeleton && !locked(doc, o.id))) {
      const m = multiply(camera, worldMatrix(doc, schema, path.id));
      read(schema, path, 'vertices').forEach((v, i) => {
        const [x, y] = apply(m, v.x, v.y);
        const attributes = { class: `bone-point${v.bone ? '' : ' free'}`, 'data-point': `${path.id}:${i}`, cx: x, cy: y, r: 4 };
        if (v.bone) attributes.style = `--c: ${boneColor(doc, v.bone)}`;
        layer.append(ctx.create('circle', attributes, `${path.id} point ${i}${v.bone ? ` → ${v.bone}` : ' (follows the shape)'}`));
      });
    }
    ctx.overlay.append(layer);
  }

  // ---------- Working matrices ----------

  /** What is needed to drag a bone: its matrix on screen and that of its parent's frame. */
  function frames(id) {
    const doc = state.doc;
    const pose = activePose(doc);
    // What is seen: with the pose also applied to the skeleton and to its groups above.
    const seen = pose ? applyPose(doc, schema, pose) : doc;
    const ev = evaluateSkeleton(seen, schema, pose);
    const world = pose ? ev.posed : ev.rest;
    const h = findObject(doc, id);
    const camera = ctx.cameraMatrix();
    // The parent's frame: the parent bone or, for a root bone, its skeleton.
    const fromBone = findObject(doc, h.parent)?.type === 'bone';
    const parent = multiply(camera, fromBone ? world.get(h.parent) : childFrame(seen, schema, h.parent));
    // Rotation is measured against the parent, except with an independent angle (it only inherits the parent's position).
    const rotation = !fromBone || !read(schema, h, 'independentAngle') ? parent : camera;
    return { doc, pose, h, values: boneValues(schema, h, pose), own: multiply(camera, world.get(id)), parent, rotation };
  }

  const directionOf = (m) => Math.sign(m[0] * m[3] - m[1] * m[2]) || 1;

  /** Batch to change a bone: in the active pose if there is one, otherwise in the setup. */
  function change(id, fields) {
    const pose = activePose();
    if (pose) {
      if (fields.rotation !== undefined) fields.rotation = limitAngle(schema, findObject(state.doc, id), fields.rotation);
      return poseOps(state.doc, pose.id, id, fields);
    }
    return [{ op: 'set', target: id, props: fields }];
  }

  const note = (id, what) => (state.pose ? `${editingName()}: ${what} ${id}` : `${what} ${id}`);

  // ---------- Interaction ----------

  /** Rotate a bone by dragging around its origin. */
  function rotate(e, id) {
    const { values, own, rotation } = frames(id);
    const origin = apply(own, 0, 0);
    const angle = (p) => Math.atan2(p[1] - origin[1], p[0] - origin[0]) * DEGREES;
    const direction = directionOf(rotation);
    let previous = angle(ctx.screenPoint(e));
    let accumulated = 0;
    let ops = null;
    ctx.drag(
      e,
      (ev) => {
        const a = angle(ctx.screenPoint(ev));
        // No jumps when crossing ±180°.
        accumulated += ((a - previous + 540) % 360) - 180;
        previous = a;
        let rot = values.rotation + direction * accumulated;
        rot = ev.shiftKey ? Math.round(rot / 15) * 15 : round(rot);
        ops = change(id, { rotation: rot });
        preview(ops);
      },
      () => (ops ? execute(ops, note(id, 'rotate')) : preview(null)),
    );
  }

  function handle(e, kind) {
    const id = state.selection;
    if (!isBone(id)) return;
    const { values, parent, rotation, own } = frames(id);
    let ops = null;
    const finish = (what) => () => (ops ? execute(ops, note(id, what)) : preview(null));

    if (kind === 'bone-origin') {
      const inverse = invert(parent);
      return ctx.drag(
        e,
        (ev) => {
          const [x, y] = apply(inverse, ...ctx.screenPoint(ev)).map((v) => round(v));
          ops = change(id, { x, y });
          preview(ops);
        },
        finish('move'),
      );
    }

    if (kind === 'bone-tip') {
      // In the pose, the tip only rotates. Add Bone chains a new one; Manipulate changes direction and length.
      if (state.pose) return rotate(e, id);
      if (!adjusting()) return create(e);
      const inverse = invert(rotation);
      const origin = apply(inverse, ...apply(own, 0, 0));
      return ctx.drag(
        e,
        (ev) => {
          const p = apply(inverse, ...ctx.screenPoint(ev));
          const [dx, dy] = [p[0] - origin[0], p[1] - origin[1]];
          let rotation = Math.atan2(dy, dx) * DEGREES;
          rotation = ev.shiftKey ? Math.round(rotation / 15) * 15 : round(rotation);
          const length = round(Math.hypot(dx, dy) / (values.scaleX || 1));
          ops = change(id, { rotation, length });
          preview(ops);
        },
        finish('adjust'),
      );
    }
  }

  /** Add Bone in the setup: a click on a bone picks it; dragging on empty space creates one. */
  function pointerdown(e) {
    const id = e.target.closest('[data-bone]')?.dataset.bone;
    if (id) return select(id);
    create(e);
  }

  /** Manipulate Bones in the setup: dragging a bone rotates it; Ctrl + click adds or removes it; click on empty drops the selection. */
  function pointerdownManipulate(e) {
    const id = e.target.closest('[data-bone]')?.dataset.bone;
    if (!id) return boneMarquee(e, e.ctrlKey || e.metaKey || e.shiftKey);
    if (e.ctrlKey || e.metaKey) return toggleSelection(id);
    select(id);
    rotate(e, id);
  }

  /**
   * Dragging on an empty spot: picks the bones the marquee touches (with Ctrl or Shift, adds them). Click: drops
   * everything. With `withShapes` (in a pose or a clip) it also picks the shapes it touches, to key several at once.
   */
  function boneMarquee(e, add, withShapes = false) {
    const doc = docVisible();
    const base = add ? (withShapes ? [...state.selected] : state.selected.filter(isBone)) : [];
    const { posed } = evaluateInPose(doc, schema, viewedPose(doc));
    const camera = ctx.cameraMatrix();
    // Each bone as a few points along its axis, on screen: the marquee touches it if any falls inside.
    const bones = doc.objects.filter((o) => o.type === 'bone' && !locked(doc, o.id)).map((h) => {
      const m = multiply(camera, posed.get(h.id));
      const length = read(schema, h, 'length');
      return { id: h.id, points: Array.from({ length: 13 }, (_, i) => apply(m, (length * i) / 12, 0)) };
    });
    // Visible shapes (not containers, as with the click), with their box on screen; hidden ones measure 0 and stay out.
    const CONTAINERS = ['group', 'skeleton', 'switch'];
    const shapes = !withShapes ? [] : [...ctx.documentG.querySelectorAll('[data-id]')]
      .filter((el) => !CONTAINERS.includes(findObject(doc, el.dataset.id)?.type) && !locked(doc, el.dataset.id))
      .map((el) => {
        const r = el.getBoundingClientRect();
        const [x0, y0] = ctx.screenPoint({ clientX: r.left, clientY: r.top });
        return r.width || r.height ? { id: el.dataset.id, box: [x0, y0, x0 + r.width, y0 + r.height] } : null;
      })
      .filter(Boolean);
    const s0 = ctx.screenPoint(e);
    const box = ctx.create('rect', { class: 'marquee' });
    let moved = false;
    ctx.drag(
      e,
      (ev) => {
        const s = ctx.screenPoint(ev);
        if (!moved && Math.hypot(s[0] - s0[0], s[1] - s0[1]) < 3) return;
        moved = true;
        const [x0, y0, x1, y1] = [Math.min(s0[0], s[0]), Math.min(s0[1], s[1]), Math.max(s0[0], s[0]), Math.max(s0[1], s[1])];
        const touched = [
          ...shapes.filter(({ box: c }) => c[0] <= x1 && c[2] >= x0 && c[1] <= y1 && c[3] >= y0).map((f) => f.id),
          ...bones.filter((h) => h.points.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)).map((h) => h.id),
        ];
        const ids = [...base, ...touched.filter((t) => !base.includes(t))];
        if (ids.join() !== state.selected.join()) selectSeveral(ids, ids.at(-1) ?? null);
        for (const [k, v] of Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })) box.setAttribute(k, v);
        ctx.overlay.append(box); // the overlay is redrawn when the selection changes
      },
      () => {
        box.remove();
        if (!moved && !add) select(null);
      },
    );
  }

  const touchedBone = (e) => e.target.closest('[data-bone]')?.dataset.bone ?? null;

  /**
   * Reparent Bone: the click only selects (Shift/Ctrl + click adds or removes; click on empty space drops everything).
   * The change is made by the option bar buttons (see reparentPlan).
   */
  function pointerdownReparent(e) {
    const touched = touchedBone(e);
    if (touched && (e.shiftKey || e.ctrlKey || e.metaKey)) return toggleSelection(touched);
    select(touched);
  }

  /** Bind Layer: click on a bone picks it; click on the drawing binds it to it (or releases it). Alt: its group. */
  function pointerdownBindLayer(e) {
    const touched = touchedBone(e);
    if (touched) return select(touched);
    const g = e.target.closest('[data-id]');
    if (!g || !ctx.documentG.contains(g)) return;
    const bone = boneToBind();
    if (!bone) return notify('Bind Layer: first click the bone the drawing should follow', true);
    const obj = findObject(state.doc, g.dataset.id);
    toggleBinding(e.altKey && obj.parent && findObject(state.doc, obj.parent)?.type !== 'skeleton' ? obj.parent : obj.id, bone);
  }

  /**
   * Bind Points: click on a bone picks it; click on a point binds it to that bone (or releases it if it was already
   * its own); dragging makes a marquee and binds all the points inside (with Alt, releases them).
   */
  function pointerdownBindPoints(e) {
    const doc = state.doc;
    const touched = touchedBone(e);
    const point = e.target.closest('[data-point]')?.dataset.point;
    if (touched && !point) return select(touched);
    const bone = chosenBone(doc);
    if (!bone) return notify('Bind Points: first click the bone the points should follow', true);
    if (point) {
      const [pathId, i] = [point.slice(0, point.lastIndexOf(':')), Number(point.slice(point.lastIndexOf(':') + 1))];
      const v = read(schema, findObject(doc, pathId), 'vertices')[i];
      return savePoints(new Map([[pathId, new Map([[i, e.altKey || v.bone === bone.id ? null : bone.id]])]]), bone.id);
    }
    // Marquee.
    const s0 = ctx.screenPoint(e);
    const box = ctx.create('rect', { class: 'marquee', x: s0[0], y: s0[1], width: 0, height: 0 });
    ctx.overlay.append(box);
    let s1 = s0;
    ctx.drag(
      e,
      (ev) => {
        s1 = ctx.screenPoint(ev);
        Object.entries({ x: Math.min(s0[0], s1[0]), y: Math.min(s0[1], s1[1]), width: Math.abs(s1[0] - s0[0]), height: Math.abs(s1[1] - s0[1]) }).forEach(([k, v]) => box.setAttribute(k, v));
        ctx.overlay.append(box);
      },
      (ev) => {
        box.remove();
        if (Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) < 4) return;
        const [x0, x1] = [Math.min(s0[0], s1[0]), Math.max(s0[0], s1[0])];
        const [y0, y1] = [Math.min(s0[1], s1[1]), Math.max(s0[1], s1[1])];
        const camera = ctx.cameraMatrix();
        const skeleton = skeletonOf(doc, bone.id);
        const changes = new Map();
        for (const path of doc.objects.filter((o) => o.type === 'path' && skeletonOf(doc, o.id) === skeleton && !locked(doc, o.id))) {
          const m = multiply(camera, worldMatrix(doc, schema, path.id));
          read(schema, path, 'vertices').forEach((v, i) => {
            const [x, y] = apply(m, v.x, v.y);
            if (x < x0 || x > x1 || y < y0 || y > y1) return;
            (changes.get(path.id) ?? changes.set(path.id, new Map()).get(path.id)).set(i, ev.altKey || e.altKey ? null : bone.id);
          });
        }
        if (changes.size) savePoints(changes, bone.id);
      },
    );
  }

  /** Batch with the new vertices of each path: changes = Map(pathId → Map(index → bone or null)). */
  function savePoints(changes, bone) {
    const ops = [];
    let n = 0;
    for (const [pathId, byIndex] of changes) {
      const vertices = read(schema, findObject(state.doc, pathId), 'vertices').map((v, i) => {
        if (!byIndex.has(i)) return v;
        n++;
        const { bone, ...rest } = v;
        return byIndex.get(i) ? { ...rest, bone: byIndex.get(i) } : rest;
      });
      ops.push({ op: 'set', target: pathId, props: { vertices } });
    }
    const loose = [...changes.values()].every((m) => [...m.values()].every((b) => b === null));
    execute(ops, loose ? `unbind ${n} point${n === 1 ? '' : 's'}` : `bind ${n} point${n === 1 ? '' : 's'} to ${bone}`);
  }

  /** With an active pose: the touched bone is rotated, or the bone of the touched drawing. */
  function pointerdownPose(e) {
    let id = e.target.closest('[data-bone]')?.dataset.bone;
    if (!id) {
      const g = e.target.closest('[data-id]');
      if (!g || !ctx.documentG.contains(g)) return boneMarquee(e, e.ctrlKey || e.metaKey || e.shiftKey, true);
      id = boneOf(state.doc, g.dataset.id) ?? nearestBoneToPoints(g.dataset.id, ctx.screenPoint(e));
      // A drawing that follows a locked bone does not rotate it.
      if (id && locked(state.doc, id)) id = null;
      if (!id) return e.ctrlKey || e.metaKey ? toggleSelection(g.dataset.id) : select(g.dataset.id);
    }
    // Ctrl + click: adds or removes from the selection without rotating (to see and key several in the timeline).
    if (e.ctrlKey || e.metaKey) return toggleSelection(id);
    select(id);
    rotate(e, id);
  }

  /** Path bound by point: the bone (among those its vertices follow) closest to the click, in the pose. */
  function nearestBoneToPoints(pathId, point) {
    const path = findObject(state.doc, pathId);
    const ids = [...new Set((path?.vertices ?? []).map((v) => v.bone).filter(Boolean))];
    if (!ids.length) return null;
    const { posed } = evaluateInPose(state.doc, schema, activePose());
    const camera = ctx.cameraMatrix();
    let best = null;
    for (const id of ids) {
      const m = multiply(camera, posed.get(id));
      const a = apply(m, 0, 0);
      const b = apply(m, read(schema, findObject(state.doc, id), 'length'), 0);
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / l2));
      const d = Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t);
      if (!best || d < best.d) best = { id, d };
    }
    return best.id;
  }

  /**
   * Dragging on empty space creates a bone. It is a child of the selected bone (if it starts at its tip, it chains) or
   * a root bone of the active skeleton. Without a skeleton, one is created at the root in the same step.
   */
  function create(e) {
    const doc = state.doc;
    const sel = state.selection && findObject(doc, state.selection);
    const parent = sel?.type === 'bone' ? sel : null;
    const skeleton = parent ? null : activeSkeleton(doc);
    const camera = ctx.cameraMatrix();
    const frame = multiply(camera, childFrame(doc, schema, parent?.id ?? skeleton));
    const inverse = invert(frame);
    const s0 = ctx.screenPoint(e);
    const parentTip = parent && apply(frame, read(schema, parent, 'length'), 0);
    const chained = parentTip && Math.hypot(s0[0] - parentTip[0], s0[1] - parentTip[1]) < 10;
    const start = chained ? parentTip : s0;
    const local0 = chained ? [read(schema, parent, 'length'), 0] : apply(inverse, ...s0);
    const draft = ctx.create('line', { class: 'bone-draft', x1: start[0], y1: start[1], x2: start[0], y2: start[1] });
    ctx.overlay.append(draft);
    let end = null;

    ctx.drag(
      e,
      (ev) => {
        end = ctx.screenPoint(ev);
        draft.setAttribute('x2', end[0]);
        draft.setAttribute('y2', end[1]);
        ctx.overlay.append(draft);
      },
      () => {
        draft.remove();
        if (!end || Math.hypot(end[0] - start[0], end[1] - start[1]) < 6) {
          if (!chained) select(null);
          return;
        }
        const local1 = apply(inverse, ...end);
        const [dx, dy] = [local1[0] - local0[0], local1[1] - local0[1]];
        const id = freeId('bone');
        const props = { x: round(local0[0]), y: round(local0[1]), rotation: round(Math.atan2(dy, dx) * DEGREES), length: round(Math.hypot(dx, dy)) };
        const ops = [];
        let target = parent?.id ?? skeleton;
        if (!target) {
          target = freeId('skeleton');
          ops.push({ op: 'create', type: 'skeleton', id: target });
        }
        ops.push({ op: 'create', type: 'bone', id, parent: target, props });
        execute(ops, parent || skeleton ? `create ${id}` : `create ${target} with ${id}`);
        select(id);
        if (!parent && !skeleton) notify(`Bones live in a skeleton, so ${target} was created. Drag the drawing into it in Layers, then bind it.`);
      },
    );
  }

  return { draw, handle, pointerdown, pointerdownManipulate, pointerdownPose, pointerdownReparent, pointerdownBindLayer, pointerdownBindPoints };
}
