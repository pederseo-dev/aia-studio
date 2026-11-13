// Edición de puntos de un path: arrastrar anclas y tangentes, doble clic en un ancla para alternar recto/curvo,
// clic sobre el contorno para agregar un vértice y Supr para borrar el seleccionado. Alt al arrastrar una tangente
// la separa de la otra (pico).

import { findObject } from '../core/document.js';
import { read } from '../core/schema.js';
import { apply, invert, worldMatrix, multiply } from '../core/geometry.js';
import { applyPose } from '../core/blend.js';
import { withBone, splitSpan, handles, sampleSpan, tangents, vertexFromTangents } from '../core/paths.js';
import { docVisible, execute, schema, state, setState, preview } from './state.js';
import { editingName, poseOps, activePose } from './editing.js';

const NEAR_OUTLINE = 8; // px

export function createPoints(ctx) {
  // Con una pose activa se editan los vértices de la pose (el morph); sin pose, los del montaje.
  const path = () => findObject(applyPose(docVisible(), schema, activePose(docVisible())), state.editing);
  // La matriz del dibujo en pantalla tal como se ve (con huesos y pose incluidos).
  const matrix = () => {
    const m = ctx.element(state.editing)?.getCTM();
    return m ? [m.a, m.b, m.c, m.d, m.e, m.f] : multiply(ctx.cameraMatrix(), worldMatrix(docVisible(), schema, state.editing));
  };
  const vertexOps = (vertices) => {
    const pose = activePose();
    return pose ? poseOps(state.doc, pose.id, state.editing, { vertices }) : [{ op: 'set', target: state.editing, props: { vertices } }];
  };
  const save = (vertices, note) => execute(vertexOps(vertices), `${state.pose ? `${editingName()}: ` : ''}${note} in ${state.editing}`);

  function draw() {
    const obj = path();
    if (!obj) return;
    const m = matrix();
    const screen = (p) => apply(m, ...p);
    const vertices = read(schema, obj, 'vertices');
    handles(vertices).forEach((h, i) => {
      const a = screen(h.anchor);
      for (const [which, point] of [['entrada', h.entrada], ['salida', h.salida]]) {
        if (!point) continue;
        const t = screen(point);
        ctx.overlay.append(ctx.crear('line', { class: 'tangente', x1: a[0], y1: a[1], x2: t[0], y2: t[1] }));
        ctx.overlay.append(ctx.crear('circle', { class: 'manija tangente-punto', 'data-manija': `${which}-${i}`, cx: t[0], cy: t[1], r: 4 }, 'Tangent (Alt: break)'));
      }
      ctx.overlay.append(
        ctx.crear(
          'rect',
          { class: `manija ancla${i === state.vertex ? ' activa' : ''}${vertices[i].bone ? ' con-hueso' : ''}`, 'data-manija': `ancla-${i}`, x: a[0] - 4.5, y: a[1] - 4.5, width: 9, height: 9 },
          `Vertex ${i}${vertices[i].bone ? `, follows ${vertices[i].bone}` : ''} (double-click: straight/curved)`,
        ),
      );
    });
  }

  /** Arrastre de un ancla o de una tangente. */
  function handle(e, kind) {
    const [which, text] = kind.split('-');
    const i = Number(text);
    const obj = path();
    const vertices = read(schema, obj, 'vertices');
    const inverse = invert(matrix());
    const local = (ev) => apply(inverse, ...ctx.screenPoint(ev));
    const start = local(e);
    setState({ vertex: i });
    let change = null;

    ctx.drag(
      e,
      (ev) => {
        const p = local(ev);
        const v = vertices[i];
        const created = [...vertices];
        if (which === 'ancla') {
          created[i] = { ...v, x: Math.round((v.x + p[0] - start[0]) * 100) / 100, y: Math.round((v.y + p[1] - start[1]) * 100) / 100 };
        } else {
          const t = tangents(v);
          const other = which === 'entrada' ? 'salida' : 'entrada';
          t[which] = [p[0] - v.x, p[1] - v.y];
          const mode = ev.altKey ? 'detached' : (v.mode ?? 'straight');
          if (mode === 'mirrored') t[other] = [-t[which][0], -t[which][1]];
          if (mode === 'asymmetric') {
            const otherLength = Math.hypot(...t[other]);
            const l = Math.hypot(...t[which]) || 1;
            t[other] = [(-t[which][0] / l) * otherLength, (-t[which][1] / l) * otherLength];
          }
          created[i] = withBone(v, vertexFromTangents(v.x, v.y, t.entrada, t.salida));
        }
        change = created;
        preview(vertexOps(created));
      },
      () => (change ? save(change, which === 'ancla' ? 'move vertex' : 'adjust curve') : preview(null)),
    );
  }

  /** Clic en el lienzo fuera de las manijas. Devuelve true si lo resolvió (agregar un vértice). */
  function pointerdown(e) {
    const obj = path();
    if (!obj) return false;
    const vertices = read(schema, obj, 'vertices');
    const m = matrix();
    const p = ctx.screenPoint(e);
    const spans = read(schema, obj, 'closed') ? vertices.length : vertices.length - 1;
    let best = null;
    for (let i = 0; i < spans; i++) {
      for (const { t, p: q } of sampleSpan(vertices, i, 40)) {
        const s = apply(m, ...q);
        const d = Math.hypot(s[0] - p[0], s[1] - p[1]);
        if (!best || d < best.d) best = { d, i, t };
      }
    }
    if (!best || best.d > NEAR_OUTLINE || best.t < 0.02 || best.t > 0.98) return false;
    save(splitSpan(vertices, best.i, best.t), 'add vertex');
    setState({ vertex: best.i + 1 });
    return true;
  }

  /** Doble clic en un ancla: recto ↔ curvo. */
  function toggle(i) {
    const obj = path();
    const vertices = read(schema, obj, 'vertices');
    const v = vertices[i];
    const created = [...vertices];
    if ((v.mode ?? 'straight') !== 'straight') {
      created[i] = withBone(v, { x: v.x, y: v.y });
    } else {
      // Tangente paralela a la línea entre los vecinos, de un tercio de la distancia media.
      const previous = vertices[(i - 1 + vertices.length) % vertices.length];
      const next = vertices[(i + 1) % vertices.length];
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      const dist = Math.round((Math.hypot(dx, dy) / 6) * 100) / 100 || 20;
      created[i] = withBone(v, { x: v.x, y: v.y, mode: 'mirrored', angle: Math.round((Math.atan2(dy, dx) * 180) / Math.PI * 100) / 100, dist });
    }
    save(created, 'toggle vertex');
  }

  function deleteVertex() {
    const obj = path();
    const vertices = read(schema, obj, 'vertices');
    if (state.vertex == null || vertices.length <= 2) return false;
    save(vertices.filter((_, i) => i !== state.vertex), 'delete vertex');
    setState({ vertex: null });
    return true;
  }

  return { draw, handle, pointerdown, toggle, deleteVertex };
}
