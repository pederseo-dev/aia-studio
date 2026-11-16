import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { drawDocument, partData, pathData, toSvg } from '../src/core/draw.js';
import { rectVertices } from '../src/core/geometry.js';

const schema = loadSchema();

/** @param {any[]} ops */
const build = (ops) => applyOps(schema, newDocument({ name: 'Test' }), ops).document;
const square = rectVertices({ x: 0, y: 0, width: 10, height: 10 });

test('every part is a path, and parts live only inside a vector layer', () => {
  assert.throws(() => build([{ op: 'create', type: 'vector', id: 'face' }, { op: 'create', type: 'rect', id: 'box', parent: 'face' }]), /unknown type "rect"/);
  assert.throws(() => build([{ op: 'create', type: 'path', id: 'box' }]), /a path cannot go at the root/);
  assert.throws(
    () => build([{ op: 'create', type: 'group', id: 'g' }, { op: 'create', type: 'path', id: 'box', parent: 'g' }]),
    /a path cannot go inside "g"/,
  );
  const doc = build([{ op: 'create', type: 'vector', id: 'face' }, { op: 'create', type: 'path', id: 'eye', parent: 'face', props: { vertices: square } }]);
  assert.deepEqual(doc.objects[1], { id: 'eye', type: 'path', parent: 'face', vertices: square });
});

test('vertices are validated', () => {
  const ops = (vertices) => [
    { op: 'create', type: 'vector', id: 'face' },
    { op: 'create', type: 'path', id: 'mouth', parent: 'face', props: { vertices } },
  ];
  assert.throws(() => build(ops('M0 0')), /must be a list of vertices/);
  assert.throws(() => build(ops([{ x: 0 }])), /vertex 0 needs numbers x and y/);
  assert.throws(() => build(ops([{ x: 0, y: 0, z: 1 }])), /unknown fields: z/);
  assert.throws(() => build(ops([{ x: 0, y: 0, out: { x: 1 } }])), /"out" must be \{ x, y \}/);
  assert.doesNotThrow(() => build(ops([{ x: 0, y: 0, out: { x: 5, y: 0 } }, { x: 10, y: 10, in: { x: 0, y: -5 } }])));
});

test('pathData: straight segments as lines, handles as curves, closed outlines end in Z', () => {
  assert.equal(pathData([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true), 'M0 0L10 0L10 10Z');
  assert.equal(pathData([{ x: 0, y: 0 }, { x: 10, y: 0 }], false), 'M0 0L10 0');
  assert.equal(
    pathData([{ x: 0, y: 0, out: { x: 5, y: 0 } }, { x: 10, y: 10, in: { x: 0, y: -5 } }], false),
    'M0 0C5 0 10 5 10 10',
  );
  assert.equal(pathData([], true), '');
  assert.equal(partData({ id: 'p', type: 'path', parent: 'l', vertices: square }), 'M0 0L10 0L10 10L0 10Z');
  assert.equal(partData({ id: 'p', type: 'path', parent: 'l', vertices: square, closed: false }), 'M0 0L10 0L10 10L0 10');
});

test('drawDocument keeps the drawing order and leaves out what is hidden', () => {
  const doc = build([
    { op: 'create', type: 'vector', id: 'back' },
    { op: 'create', type: 'path', id: 'sky', parent: 'back', props: { vertices: square, fill: '#88ccff', stroke: null } },
    { op: 'create', type: 'vector', id: 'front' },
    { op: 'create', type: 'path', id: 'sun', parent: 'front', props: { vertices: square } },
    { op: 'create', type: 'path', id: 'line', parent: 'front', props: { vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }], closed: false, fill: null } },
    { op: 'create', type: 'vector', id: 'hidden', props: { visible: false } },
    { op: 'create', type: 'path', id: 'ghost', parent: 'hidden', props: { vertices: square } },
  ]);
  const { nodes } = drawDocument(doc);
  assert.deepEqual(nodes.map((n) => n.attrs['data-id']), ['back', 'front']);
  const [sky] = nodes[0].children;
  assert.equal(sky.attrs.fill, '#88ccff');
  assert.equal(sky.attrs.stroke, undefined);
  const [sun, line] = nodes[1].children;
  assert.equal(sun.attrs.fill, schema.get('part').properties.fill.default);
  assert.equal(sun.attrs.stroke, schema.get('part').properties.stroke.default);
  assert.equal(line.attrs.fill, 'none');
  assert.equal(line.attrs.d, 'M0 0L5 5');
  const svg = toSvg(doc);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="800" height="600"/);
  assert.doesNotMatch(svg, /ghost/);
});
