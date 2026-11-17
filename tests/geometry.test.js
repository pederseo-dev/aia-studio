import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply,
  around,
  bounds,
  ellipsePoints,
  ellipseVertices,
  flipAcross,
  insertVertex,
  nearestOnOutline,
  multiply,
  rectVertices,
  rotate,
  scale,
  transformPart,
  transformVertices,
  translate,
} from '../src/core/geometry.js';

const line = {
  id: 'line',
  type: 'path',
  parent: 'layer',
  vertices: [{ x: 0, y: 0, out: { x: 10, y: 0 } }, { x: 20, y: 10, in: { x: 0, y: -5 } }],
};

/** @param {{ x: number, y: number }} a @param {{ x: number, y: number }} b */
const near = (a, b) => assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `${JSON.stringify(a)} ≈ ${JSON.stringify(b)}`);

test('matrices compose like SVG transforms', () => {
  near(apply(translate(5, 7), { x: 1, y: 2 }), { x: 6, y: 9 });
  near(apply(rotate(90), { x: 1, y: 0 }), { x: 0, y: 1 });
  near(apply(multiply(translate(10, 0), scale(2, 2)), { x: 1, y: 1 }), { x: 12, y: 2 });
  near(apply(around({ x: 5, y: 5 }, rotate(180)), { x: 0, y: 5 }), { x: 10, y: 5 });
});

test('the Rectangle and Ellipse tools draw paths', () => {
  assert.deepEqual(rectVertices({ x: 10, y: 20, width: 30, height: 40 }), [
    { x: 10, y: 20 },
    { x: 40, y: 20 },
    { x: 40, y: 60 },
    { x: 10, y: 60 },
  ]);
  assert.equal(rectVertices({ x: 0, y: 0, width: 40, height: 20 }, 50).length, 8, 'rounded corners: 2 vertices each');
  assert.equal(rectVertices({ x: 0, y: 0, width: 40, height: 20 }, 50)[0].x, 10, 'the radius is capped at half the shorter side');
  const ellipse = ellipseVertices({ x: 0, y: 0, width: 20, height: 10 });
  assert.deepEqual(ellipse.map((v) => [v.x, v.y]), [[10, 0], [20, 5], [10, 10], [0, 5]]);
  assert.deepEqual(bounds([{ id: 'e', type: 'path', parent: 'l', vertices: ellipse }]), { x: 0, y: 0, width: 20, height: 10 });
});

test('transformPart moves every vertex and turns the handles', () => {
  assert.deepEqual(transformPart(line, translate(1, 2)), {
    vertices: [{ x: 1, y: 2, out: { x: 10, y: 0 } }, { x: 21, y: 12, in: { x: 0, y: -5 } }],
  });
  assert.deepEqual(transformPart(line, rotate(90)), {
    vertices: [{ x: 0, y: 0, out: { x: 0, y: 10 } }, { x: -10, y: 20, in: { x: 5, y: 0 } }],
  });
  assert.deepEqual(transformPart(line, around({ x: 0, y: 0 }, scale(2, 1))).vertices[1], { x: 40, y: 10, in: { x: 0, y: -5 } });
});

test('transformVertices changes only the picked points', () => {
  assert.deepEqual(transformVertices(line, [1], translate(5, 5)), {
    vertices: [{ x: 0, y: 0, out: { x: 10, y: 0 } }, { x: 25, y: 15, in: { x: 0, y: -5 } }],
  });
});

test('flipAcross mirrors points and their handles across the middle of their box', () => {
  const picked = line.vertices;
  assert.deepEqual(transformVertices(line, [0, 1], flipAcross(picked, true)).vertices, [
    { x: 20, y: 0, out: { x: -10, y: 0 } },
    { x: 0, y: 10, in: { x: 0, y: -5 } },
  ]);
  assert.deepEqual(transformVertices(line, [0, 1], flipAcross(picked, false)).vertices, [
    { x: 0, y: 10, out: { x: 10, y: 0 } },
    { x: 20, y: 0, in: { x: 0, y: 5 } },
  ]);
});

test('bounds include the curve handles', () => {
  assert.deepEqual(bounds([line]), { x: 0, y: 0, width: 20, height: 10 });
  assert.equal(bounds([]), null);
});

test('the origin moves along with its part, and stays unset when it was', async () => {
  const { transformOrigin } = await import('../src/core/geometry.js');
  assert.deepEqual(transformPart({ ...line, originX: 5, originY: 5 }, translate(10, 0)).originX, 15);
  assert.equal('originX' in transformPart(line, translate(10, 0)), false);
  assert.deepEqual(transformOrigin({ originX: 1, originY: 0 }, rotate(90)), { originX: 0, originY: 1 });
});

test('welding the two ends of one open line closes it', async () => {
  const { closeOutline, endOf } = await import('../src/core/geometry.js');
  const open = { id: 'u', type: 'path', parent: 'l', closed: false, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 1, y: 1, in: { x: 2, y: 0 } }] };
  assert.equal(endOf(open, 0), 'start');
  assert.equal(endOf(open, 3), 'end');
  assert.equal(endOf(open, 1), null);
  assert.equal(endOf({ ...open, closed: true }, 0), null);
  assert.deepEqual(closeOutline(open, 'start'), {
    closed: true,
    vertices: [{ x: 0, y: 0, in: { x: 2, y: 0 } }, { x: 10, y: 0 }, { x: 10, y: 10 }],
  });
});

test('welding ends of two lines joins them, the meeting point where the target end is', async () => {
  const { joinOutlines } = await import('../src/core/geometry.js');
  const a = { id: 'a', type: 'path', parent: 'l', closed: false, vertices: [{ x: 0, y: 0 }, { x: 10, y: 0, in: { x: -3, y: 0 } }] };
  const b = { id: 'b', type: 'path', parent: 'l', closed: false, vertices: [{ x: 20, y: 10 }, { x: 11, y: 1, out: { x: 0, y: 4 } }] };
  // a's end goes onto b's end: a, then b walked backwards (its handles swapped).
  assert.deepEqual(joinOutlines(a, 'end', b, 'end'), [
    { x: 0, y: 0 },
    { x: 11, y: 1, in: { x: -3, y: 0 } },
    { x: 20, y: 10 },
  ]);
  // a's start onto b's start: a walked backwards, then b.
  assert.deepEqual(joinOutlines(a, 'start', b, 'start').map((v) => [v.x, v.y]), [[10, 0], [20, 10], [11, 1]]);
});

test('a point added on a curve keeps its shape', () => {
  const circle = { id: 'c', type: 'path', parent: 'layer', vertices: ellipseVertices({ x: 0, y: 0, width: 100, height: 100 }) };
  const hit = nearestOnOutline(circle, { x: 100, y: 0 });
  assert.ok(hit);
  assert.equal(hit.segment, 0); // the stretch from the top to the right
  assert.ok(Math.abs(Math.hypot(hit.point.x - 50, hit.point.y - 50) - 50) < 0.1);
  const { vertices, index } = insertVertex(circle, hit.segment, hit.t);
  assert.equal(index, 1);
  assert.equal(vertices.length, 5);
  // Points along the new outline still sit on the circle.
  const after = { ...circle, vertices };
  for (const probe of [{ x: 90, y: 10 }, { x: 60, y: -10 }, { x: 110, y: 40 }]) {
    const on = nearestOnOutline(after, probe);
    assert.ok(on && Math.abs(Math.hypot(on.point.x - 50, on.point.y - 50) - 50) < 0.2);
  }
});

test('a point added on a straight side is a corner, also on the closing side', () => {
  const square = { id: 's', type: 'path', parent: 'layer', vertices: rectVertices({ x: 0, y: 0, width: 10, height: 10 }) };
  const hit = nearestOnOutline(square, { x: -1, y: 5 });
  assert.ok(hit);
  assert.equal(hit.segment, 3); // from the bottom-left corner back to the first one
  const { vertices, index } = insertVertex(square, hit.segment, hit.t);
  assert.equal(index, 4);
  assert.deepEqual(vertices[4], { x: 0, y: 5 });
  // An open line has no closing side.
  assert.equal(nearestOnOutline({ ...line, closed: false }, { x: 10, y: 20 })?.segment, 0);
});

test('an ellipse with more points is still round', () => {
  const vertices = ellipsePoints({ x: 0, y: 0, width: 100, height: 100 }, 12);
  assert.equal(vertices.length, 12);
  const circle = { id: 'c', type: 'path', parent: 'layer', vertices };
  for (const probe of [{ x: 120, y: 30 }, { x: -20, y: 70 }, { x: 50, y: 130 }]) {
    const on = nearestOnOutline(circle, probe);
    assert.ok(on && Math.abs(Math.hypot(on.point.x - 50, on.point.y - 50) - 50) < 0.05);
  }
});
