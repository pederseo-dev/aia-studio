// Pen: click adds a straight vertex; click and drag adds a curved one (mirrored). Click on the first vertex
// closes the shape; Enter or Escape finish it open.

import { apply, invert, worldMatrix, multiply } from '../core/geometry.js';
import { vertexFromTangents, verticesAD } from '../core/paths.js';
import { execute, schema, state, setState, freeId, parentForNew, select } from './state.js';

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

  /** Creates the path with the drawn points (in the parent's coordinates) and returns to the selection tool. */
  function finish(closed) {
    const drawn = points;
    points = [];
    cursor = null;
    if (drawn.length < 2) return ctx.redraw();

    const parent = parentForNew();
    const inverse = invert(multiply(ctx.cameraMatrix(), worldMatrix(state.doc, schema, parent)));
    const linear = ([x, y]) => [inverse[0] * x + inverse[2] * y, inverse[1] * x + inverse[3] * y];
    const [ox, oy] = apply(inverse, ...drawn[0].p).map((v) => Math.round(v * 10) / 10);
    const vertices = drawn.map((pt) => {
      const [x, y] = apply(inverse, ...pt.p);
      return vertexFromTangents(x - ox, y - oy, linear(pt.in), linear(pt.out));
    });
    const props = { x: ox, y: oy, vertices, closed: closed };
    if (!closed) Object.assign(props, { fill: null, stroke: '#2b2135', strokeWidth: 3 });
    const id = freeId('path');
    execute([{ op: 'create', type: 'path', id, parent: parent, props }], `draw ${id}`);
    setState({ tool: 'select' });
    select(id);
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
