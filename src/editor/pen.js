// Pen: click adds a straight vertex; click and drag adds a curved one (mirrored). Click on the first vertex
// closes the shape; Enter or Escape finish it open. The shape goes into the active vector layer (see drawing.js).

import { apply } from '../core/geometry.js';
import { vertexFromTangents, verticesAD } from '../core/paths.js';
import { state } from './state.js';
import { commitShape, drawingTarget } from './drawing.js';

const NEAR = 9; // px on screen to close on the first vertex

export function createPen(ctx) {
  // Points on screen: { p, in, out } with the tangents as vectors.
  let points = [];
  let cursor = null;

  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= NEAR;

  function pointerdown(e) {
    const p = ctx.screenPoint(e);
    if (points.length >= 2 && near(p, points[0].p)) return finish(true);
    const point = { p, in: [0, 0], out: [0, 0] };
    points.push(point);
    ctx.redraw();
    ctx.drag(
      e,
      (ev) => {
        const q = ctx.screenPoint(ev);
        const v = [q[0] - p[0], q[1] - p[1]];
        if (Math.hypot(...v) < 3) return;
        point.out = v;
        point.in = [-v[0], -v[1]];
        ctx.redraw();
      },
      () => {},
    );
  }

  function hover(e) {
    if (!points.length) return;
    cursor = ctx.screenPoint(e);
    ctx.redraw();
  }

  function draw() {
    if (state.tool !== 'path' || !points.length) return;
    const vertices = points.map((pt) => vertexFromTangents(pt.p[0], pt.p[1], pt.in, pt.out));
    ctx.overlay.append(ctx.create('path', { class: 'pen-stroke', d: verticesAD(vertices, false) }));
    if (cursor) {
      const u = points.at(-1).p;
      ctx.overlay.append(ctx.create('line', { class: 'pen-stroke guide', x1: u[0], y1: u[1], x2: cursor[0], y2: cursor[1] }));
    }
    points.forEach((pt, i) => {
      if (Math.hypot(...pt.out) > 0) {
        for (const t of [pt.in, pt.out]) {
          ctx.overlay.append(ctx.create('line', { class: 'tangent', x1: pt.p[0], y1: pt.p[1], x2: pt.p[0] + t[0], y2: pt.p[1] + t[1] }));
        }
      }
      const closes = i === 0 && points.length >= 2 && cursor && near(cursor, pt.p);
      ctx.overlay.append(ctx.create('rect', { class: `anchor${closes ? ' active' : ''}`, x: pt.p[0] - 4, y: pt.p[1] - 4, width: 8, height: 8 }));
    });
  }

  /** Creates the shape with the drawn points in the active vector layer (or a new one) and returns to the selection tool. */
  function finish(closed) {
    const drawn = points;
    points = [];
    cursor = null;
    if (drawn.length < 2) return ctx.redraw();

    const target = drawingTarget(ctx);
    const m = target.toLocal;
    const linear = ([x, y]) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
    const vertices = drawn.map((pt) => {
      const [x, y] = apply(m, ...pt.p);
      return vertexFromTangents(x, y, linear(pt.in), linear(pt.out));
    });
    // An open line is a stroke without fill, as before.
    commitShape(target, [{ vertices, closed }], closed ? {} : { fill: null, stroke: '#2b2135', strokeWidth: 3 });
  }

  return {
    pointerdown,
    hover,
    draw,
    finish,
    active: () => points.length > 0,
    cancel: () => {
      points = [];
      cursor = null;
      ctx.redraw();
    },
  };
}
