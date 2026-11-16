import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { drawDocument } from '../src/core/draw.js';
import { apply, around, multiply, rotate, scale, translate } from '../src/core/geometry.js';
import { applyTransformOps, conjugate, decompose, invert, layerMatrix, moveLayerOrigin, pivotOf, transformProps, worldOf } from '../src/core/transform.js';

const schema = loadSchema();
const build = (ops) => applyOps(schema, newDocument(), ops).document;
const square = { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] };
/** @param {{ x: number, y: number }} a @param {{ x: number, y: number }} b @param {number} [within] */
const near = (a, b, within = 1e-6) => assert.ok(Math.abs(a.x - b.x) < within && Math.abs(a.y - b.y) < within, `${JSON.stringify(a)} ≈ ${JSON.stringify(b)}`);

test('a layer transform moves, turns and scales its content without touching the vertices', () => {
  const doc = build([
    { op: 'create', type: 'vector', id: 'arm', props: { x: 10, rotation: 90, originX: 0, originY: 0 } },
    { op: 'create', type: 'path', id: 'box', parent: 'arm', props: square },
  ]);
  assert.deepEqual(doc.objects[1].vertices, square.vertices);
  near(apply(worldOf(doc, 'box'), { x: 100, y: 0 }), { x: 10, y: 100 });
  assert.match(String(drawDocument(doc).nodes[0].attrs.transform), /^matrix\(0 1 -1 0 10 0\)$/);
  // Without an origin it turns around the center of its content.
  const centered = build([
    { op: 'create', type: 'vector', id: 'arm', props: { rotation: 180 } },
    { op: 'create', type: 'path', id: 'box', parent: 'arm', props: square },
  ]);
  near(pivotOf(centered, centered.objects[0]), { x: 50, y: 50 });
  near(apply(worldOf(centered, 'box'), { x: 0, y: 0 }), { x: 100, y: 100 });
});

test('groups compose with the layers inside them', () => {
  const doc = build([
    { op: 'create', type: 'group', id: 'body', props: { x: 100, originX: 0, originY: 0 } },
    { op: 'create', type: 'vector', id: 'arm', parent: 'body', props: { scaleX: 2, originX: 0, originY: 0 } },
    { op: 'create', type: 'path', id: 'box', parent: 'arm', props: square },
  ]);
  near(apply(worldOf(doc, 'box'), { x: 100, y: 100 }), { x: 300, y: 100 });
  near(apply(worldOf(doc, 'arm'), { x: 0, y: 0 }), { x: 100, y: 0 });
});

test('decompose gives back the transform of a matrix, and moving the origin keeps the layer in place', () => {
  const doc = build([
    { op: 'create', type: 'vector', id: 'arm', props: { originX: 20, originY: 30 } },
    { op: 'create', type: 'path', id: 'box', parent: 'arm', props: square },
  ]);
  const arm = doc.objects[0];
  const t = { x: 5, y: -7, rotation: 30, scaleX: 1.5, scaleY: 0.5 };
  assert.deepEqual(decompose(doc, arm, layerMatrix(doc, arm, t)), t);
  // Turning in the artboard around a point, seen from the layer's parent: the layer's own rotation grows.
  const turned = multiply(around({ x: 0, y: 0 }, rotate(10)), layerMatrix(doc, arm, t));
  assert.equal(decompose(doc, arm, turned).rotation, 40);
  const moved = build([
    { op: 'create', type: 'vector', id: 'arm', props: { ...t, originX: 20, originY: 30 } },
    { op: 'create', type: 'path', id: 'box', parent: 'arm', props: square },
  ]);
  const before = apply(worldOf(moved, 'box'), { x: 100, y: 100 });
  const after = applyOps(schema, moved, [{ op: 'set', target: 'arm', props: moveLayerOrigin(moved, moved.objects[0], { x: 80, y: 90 }) }]).document;
  near(apply(worldOf(after, 'box'), { x: 100, y: 100 }), before, 0.01); // x, y are saved to 2 decimals
  near(apply(conjugate(translate(10, 0), invert(scale(2, 2))), { x: 0, y: 0 }), { x: 20, y: 0 });
});

test('the first transform of a layer fixes its origin; Apply transform puts it into the vertices', () => {
  const doc = build([
    { op: 'create', type: 'vector', id: 'arm' },
    { op: 'create', type: 'path', id: 'box', parent: 'arm', props: square },
  ]);
  const props = transformProps(doc, doc.objects[0], { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 });
  assert.deepEqual(props, { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1, originX: 50, originY: 50 });
  const turned = applyOps(schema, doc, [{ op: 'set', target: 'arm', props }]).document;
  const flat = applyOps(schema, turned, applyTransformOps(turned, turned.objects[0])).document;
  assert.deepEqual(flat.objects[0], { id: 'arm', type: 'vector', parent: null, originX: 50, originY: 50 });
  assert.deepEqual(flat.objects[1].vertices, [{ x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }]);
  assert.throws(() => applyTransformOps(turned, { id: 'g', type: 'group', parent: null }), /vector layers/);
  near(apply(translate(1, 1), { x: 0, y: 0 }), { x: 1, y: 1 });
});
