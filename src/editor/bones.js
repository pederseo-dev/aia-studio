// Huesos en el lienzo: se dibujan en la superposición (no son parte del personaje ni filas de Layers) y se manejan con
// dos herramientas, como en Moho:
//
// - Add Bone (B): solo crea. Arrastrar en vacío crea un hueso (hijo del seleccionado o, si no hay hueso seleccionado,
//   raíz del skeleton seleccionado o del que contiene la selección; sin ninguno, se crea un skeleton). Arrastrar desde
//   la punta del hueso seleccionado encadena uno nuevo. Un clic en un hueso lo elige (para colgarle hijos).
// - Manipulate Bones (M): solo ajusta. Arrastrar un hueso lo gira; la manija del origen lo mueve y la de la punta
//   cambia dirección y largo.
// - Reparent Bone: nada pasa solo al hacer clic. Clic elige un hueso, Shift/Ctrl + clic suma más, clic en vacío
//   suelta la selección. Los botones de la barra hacen el cambio: «Parent to …» cuelga los elegidos del último que
//   se eligió, y «Clear parent» los deja como raíz. No se mueven en pantalla. Mientras está activa se dibuja la
//   jerarquía.
// - Bind Layer (L): clic en un hueso y después en el dibujo (o su fila de Layers) para que lo siga entero; otro clic lo
//   suelta. Alt + clic toma el grupo que lo contiene.
// - Bind Points: clic en un hueso y después en puntos de los paths de su skeleton (o un recuadro alrededor) para que
//   sigan a ese hueso; Alt suelta. Cada hueso tiene un color y sus puntos se pintan con él.
//
// En el montaje esos ajustes cambian el reposo. Con una pose activa, cualquier herramienta posa: arrastrar un hueso (o
// el dibujo enlazado a él) lo gira dentro de la pose y el origen lo desplaza.

import { locked, findObject, skeletonOf } from '../core/document.js';
import { read } from '../core/schema.js';
import { evaluateInPose, evaluateSkeleton, boneOf, limitAngle, childFrame, reasonNotToBind, opsToReleaseOnMove, planProximityBinding, planReparentBones, boneValues } from '../core/skeleton.js';
import { apply, invert, worldMatrix, multiply } from '../core/geometry.js';
import { applyPose } from '../core/blend.js';
import { editingName, poseOps, activePose, viewedPose } from './editing.js';
import { toggleSelection, notify, docVisible, execute, schema, state, freeId, preview, select, selectSeveral } from './state.js';

const round = (v, d = 10) => Math.round(v * d) / d;

/** Herramientas del grupo de huesos (con cualquiera de ellas, los huesos se pueden tocar en el lienzo). */
export const BONE_TOOLS = ['bone', 'manipulate', 'reparent', 'bindLayer', 'bindPoints'];

// Un color por hueso (como en Rive), para ver qué puntos y qué dibujo siguen a cuál.
const COLORS = ['#ff6b6b', '#ffa94d', '#e9d94a', '#69db7c', '#3bc9db', '#5c9dff', '#b197fc', '#f783ac'];

export function boneColor(doc, id) {
  const i = doc.objects.filter((o) => o.type === 'bone').findIndex((h) => h.id === id);
  return i < 0 ? '#ffffffaa' : COLORS[i % COLORS.length];
}

/** El hueso elegido, si lo hay. */
const chosenBone = (doc = state.doc) => {
  const sel = state.selection && findObject(doc, state.selection);
  return sel?.type === 'bone' ? sel : null;
};

/**
 * Reparent Bone: lo que harían los botones con la selección actual. Los hijos son los huesos elegidos menos el
 * principal (el último elegido), que es el padre. Devuelve { padre, hijos, ops, problema } para «Parent to…» y
 * { sueltos, ops } para «Clear parent» (los elegidos que no son raíz).
 */
export function reparentPlan(doc = state.doc) {
  return planReparentBones(doc, schema, state.selected, state.selection);
}

/** El hueso al que enlaza Bind Layer: el elegido, con esa herramienta activa (y fuera de una pose). */
export function boneToBind(doc = state.doc) {
  return state.tool === 'bindLayer' && !state.pose ? (chosenBone(doc)?.id ?? null) : null;
}
const DEGREES = 180 / Math.PI;

/**
 * El skeleton donde trabaja la herramienta Hueso: el seleccionado, el del hueso seleccionado o el que contiene la
 * selección. null si no hay ninguno.
 */
export function activeSkeleton(doc = state.doc) {
  const sel = state.selection && findObject(doc, state.selection);
  if (!sel) return null;
  return sel.type === 'skeleton' ? sel.id : skeletonOf(doc, sel.id);
}

// Lo usan el árbol y main.js; vive en el núcleo.
export { reasonNotToBind };

/** Pega un objeto al hueso o, si ya estaba pegado a ese, lo suelta. */
export function toggleBinding(id, bone) {
  const obj = findObject(state.doc, id);
  if (!obj || !('bone' in (schema.types.get(obj.type)?.properties ?? {}))) return;
  if (obj.bone === bone) return execute([{ op: 'unset', target: id, props: ['bone'] }], `unbind ${id}`);
  const reason = reasonNotToBind(state.doc, id, bone);
  if (reason) return notify(reason, true);
  execute([{ op: 'set', target: id, props: { bone: bone } }], `bind ${id} to ${bone}`);
}

/** «Bind all by proximity»: el dibujo del skeleton que no sigue a ningún hueso va al más cercano. */
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
 * Antes de mover `id` a `padre`: lo que suelta los enlaces que dejarían de valer (dibujo que sale del skeleton de su
 * hueso, o huesos que se van a otro skeleton). Va en el mismo lote, antes del move.
 */
export function releaseOnMove(doc, id, parent) {
  return opsToReleaseOnMove(doc, schema, id, parent);
}

/** Aviso para lo que soltarAlMover soltó. */
export function notifyLoose(ops) {
  const ids = [...new Set(ops.map((o) => o.target))];
  if (ids.length) notify(`Unbound ${ids.join(', ')}: a drawing only follows bones of its own skeleton`);
}

export function createBones(ctx) {
  const active = () => BONE_TOOLS.includes(state.tool) || !!state.pose;
  const adjusting = () => state.tool === 'manipulate' || !!state.pose;
  const isBone = (id) => findObject(state.doc, id)?.type === 'bone';

  // ---------- Dibujo ----------

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
      // El padre y los hijos del hueso elegido, marcados para ver la cadena.
      // Con Reparent Bone y varios elegidos, el principal es el padre que se va a usar: se marca distinto.
      const reparenting = state.tool === 'reparent' && state.selected.length > 1;
      const kinship = reparenting ? (h.id === state.selection ? ' new-parent' : '') : chosen && h.id === chosen.parent ? ' parent' : chosen && h.parent === chosen.id ? ' child' : '';
      const className = `bone${state.selected.includes(h.id) ? ' selected' : ''}${h.id === state.selection ? ' main' : ''}${kinship}`;
      const color = { style: `--c: ${boneColor(doc, h.id)}` };
      // Unión punteada cuando el hueso no nace en la punta de su padre.
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
      // Forma de rombo alargado, como en Moho: ancho cerca del origen, en punta hacia el final.
      const [dx, dy] = [(t[0] - o[0]) / length, (t[1] - o[1]) / length];
      const width = Math.min(9, Math.max(3, length * 0.12));
      const q = [o[0] + dx * length * 0.2, o[1] + dy * length * 0.2];
      const points = [o, [q[0] - dy * width, q[1] + dx * width], t, [q[0] + dy * width, q[1] - dx * width]];
      layer.append(ctx.create('polygon', { class: className, 'data-bone': h.id, points: points.map((p) => p.join(',')).join(' '), ...color }, h.id));
    }
    // Reparent Bone: la jerarquía entera, una línea de cada hueso a la mitad de su padre.
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

    // Lo que mueve el hueso elegido, marcado en el dibujo.
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

    // Manijas del hueso principal seleccionado: con Manipulate (o en una pose), origen y punta para ajustarlo; con Add
    // Bone, solo la punta, para encadenar.
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

  /** Bind Points: los puntos de los paths del skeleton activo, con el color del hueso que siguen. */
  function drawPoints(doc) {
    const skeleton = activeSkeleton(doc);
    if (!skeleton) return;
    const camera = ctx.cameraMatrix();
    const layer = ctx.create('g', { class: 'bone-points' });
    for (const path of doc.objects.filter((o) => o.type === 'path' && skeletonOf(doc, o.id) === skeleton)) {
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

  // ---------- Matrices de trabajo ----------

  /** Lo que hace falta para arrastrar un hueso: su matriz en pantalla y la del marco de su padre. */
  function frames(id) {
    const doc = state.doc;
    const pose = activePose(doc);
    // Lo que se ve: con la pose aplicada también al skeleton y a sus grupos de arriba.
    const seen = pose ? applyPose(doc, schema, pose) : doc;
    const ev = evaluateSkeleton(seen, schema, pose);
    const world = pose ? ev.posed : ev.rest;
    const h = findObject(doc, id);
    const camera = ctx.cameraMatrix();
    // El marco del padre: el hueso padre o, para un hueso raíz, su skeleton.
    const fromBone = findObject(doc, h.parent)?.type === 'bone';
    const parent = multiply(camera, fromBone ? world.get(h.parent) : childFrame(seen, schema, h.parent));
    // El giro se mide contra el padre, salvo con ángulo independiente (solo hereda la posición del hueso padre).
    const rotation = !fromBone || !read(schema, h, 'independentAngle') ? parent : camera;
    return { doc, pose, h, values: boneValues(schema, h, pose), own: multiply(camera, world.get(id)), parent, rotation };
  }

  const directionOf = (m) => Math.sign(m[0] * m[3] - m[1] * m[2]) || 1;

  /** Lote para cambiar un hueso: en la pose activa si la hay, si no en el montaje. */
  function change(id, fields) {
    const pose = activePose();
    if (pose) {
      if (fields.rotation !== undefined) fields.rotation = limitAngle(schema, findObject(state.doc, id), fields.rotation);
      return poseOps(state.doc, pose.id, id, fields);
    }
    return [{ op: 'set', target: id, props: fields }];
  }

  const note = (id, what) => (state.pose ? `${editingName()}: ${what} ${id}` : `${what} ${id}`);

  // ---------- Interacción ----------

  /** Girar un hueso arrastrando alrededor de su origen. */
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
        // Sin saltos al cruzar ±180°.
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
      // En la pose, la punta solo gira. Con Add Bone encadena uno nuevo; con Manipulate cambia dirección y largo.
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

  /** Add Bone en el montaje: un clic en un hueso lo elige; arrastrar en vacío crea uno. */
  function pointerdown(e) {
    const id = e.target.closest('[data-bone]')?.dataset.bone;
    if (id) return select(id);
    create(e);
  }

  /** Manipulate Bones en el montaje: arrastrar un hueso lo gira; Ctrl + clic lo suma o lo quita; un clic en vacío suelta la selección. */
  function pointerdownManipulate(e) {
    const id = e.target.closest('[data-bone]')?.dataset.bone;
    if (!id) return boneMarquee(e, e.ctrlKey || e.metaKey || e.shiftKey);
    if (e.ctrlKey || e.metaKey) return toggleSelection(id);
    select(id);
    rotate(e, id);
  }

  /**
   * Arrastrar en un lugar vacío: elige los huesos que toca el recuadro (con Ctrl o Shift, los suma). Clic: suelta
   * todo. Con `conFormas` (en una pose o un clip) también elige las formas que toca, para keyar varias a la vez.
   */
  function boneMarquee(e, add, withShapes = false) {
    const doc = docVisible();
    const base = add ? (withShapes ? [...state.selected] : state.selected.filter(isBone)) : [];
    const { posed } = evaluateInPose(doc, schema, viewedPose(doc));
    const camera = ctx.cameraMatrix();
    // Cada hueso como unos puntos a lo largo de su eje, en pantalla: lo toca el recuadro si alguno cae adentro.
    const bones = doc.objects.filter((o) => o.type === 'bone').map((h) => {
      const m = multiply(camera, posed.get(h.id));
      const length = read(schema, h, 'length');
      return { id: h.id, points: Array.from({ length: 13 }, (_, i) => apply(m, (length * i) / 12, 0)) };
    });
    // Formas visibles (no contenedores, como con el clic), con su caja en pantalla; las ocultas miden 0 y quedan afuera.
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
        ctx.overlay.append(box); // la superposición se redibuja al cambiar la selección
      },
      () => {
        box.remove();
        if (!moved && !add) select(null);
      },
    );
  }

  const touchedBone = (e) => e.target.closest('[data-bone]')?.dataset.bone ?? null;

  /**
   * Reparent Bone: el clic solo selecciona (Shift/Ctrl + clic suma o quita; clic en vacío suelta todo). El cambio lo
   * hacen los botones de la barra de opciones (ver planDeReparentar).
   */
  function pointerdownReparent(e) {
    const touched = touchedBone(e);
    if (touched && (e.shiftKey || e.ctrlKey || e.metaKey)) return toggleSelection(touched);
    select(touched);
  }

  /** Bind Layer: clic en un hueso lo elige; clic en el dibujo lo enlaza a él (o lo suelta). Alt: su grupo. */
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
   * Bind Points: clic en un hueso lo elige; clic en un punto lo enlaza a ese hueso (o lo suelta si ya era suyo);
   * arrastrar hace un recuadro y enlaza todos los puntos de adentro (con Alt, los suelta).
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
    // Recuadro.
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
        for (const path of doc.objects.filter((o) => o.type === 'path' && skeletonOf(doc, o.id) === skeleton)) {
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

  /** Lote con los vértices nuevos de cada path: cambios = Map(pathId → Map(índice → hueso o null)). */
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

  /** Con una pose activa: se gira el hueso tocado, o el hueso del dibujo tocado. */
  function pointerdownPose(e) {
    let id = e.target.closest('[data-bone]')?.dataset.bone;
    if (!id) {
      const g = e.target.closest('[data-id]');
      if (!g || !ctx.documentG.contains(g)) return boneMarquee(e, e.ctrlKey || e.metaKey || e.shiftKey, true);
      id = boneOf(state.doc, g.dataset.id) ?? nearestBoneToPoints(g.dataset.id, ctx.screenPoint(e));
      if (!id) return e.ctrlKey || e.metaKey ? toggleSelection(g.dataset.id) : select(g.dataset.id);
    }
    // Ctrl + clic: suma o quita de la selección sin girar (para ver y keyar varios en la timeline).
    if (e.ctrlKey || e.metaKey) return toggleSelection(id);
    select(id);
    rotate(e, id);
  }

  /** Path enlazado por punto: el hueso (de los que siguen sus vértices) más cercano al clic, en la pose. */
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
   * Arrastrar en vacío crea un hueso. Es hijo del hueso seleccionado (si se empieza en su punta, se encadena) o un
   * hueso raíz del skeleton activo. Sin skeleton, se crea uno en la raíz en el mismo paso.
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
