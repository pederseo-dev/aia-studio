import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { findObject, createDocument } from '../src/core/document.js';
import { blendPoses, driverWeight, paramValues } from '../src/core/blend.js';
import { applyOperations } from '../src/core/operations.js';
import { svgDocument } from '../src/render/svg.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema).doc;

// A face: mouth as a switch (rest / o) and as a path with the same number of points (for the morph), head that turns.
function face() {
  return op(
    createDocument({ name: 'Cara' }),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'head_bone', parent: 'rig', props: { from: [100, 200], to: [100, 100] } },
    { op: 'create', type: 'group', id: 'head', parent: 'rig', props: { x: 100, y: 200, bone: 'head_bone' } },
    { op: 'create', type: 'switch', id: 'mouth', parent: 'head' },
    { op: 'create', type: 'rect', id: 'mouth_rest', parent: 'mouth', props: { width: 20, height: 4 } },
    { op: 'create', type: 'ellipse', id: 'mouth_o', parent: 'mouth', props: { width: 12, height: 12 } },
    { op: 'create', type: 'path', id: 'smile', parent: 'head', props: { closed: false, d: 'M-20 0 L0 0 L20 0' } },
    { op: 'create', type: 'pose', id: 'happy', props: { values: { smile: { d: 'M-20 -10 L0 10 L20 -10' }, head: { opacity: 0.5 } } } },
    { op: 'create', type: 'pose', id: 'turn_r', props: { values: { head_bone: { rotation: 20 } } } },
    { op: 'create', type: 'pose', id: 'viseme_o', props: { values: { mouth: { active: 'mouth_o' } } } },
    { op: 'create', type: 'param', id: 'happiness' },
    { op: 'create', type: 'param', id: 'head_turn', props: { min: -1, max: 1 } },
    { op: 'create', type: 'param', id: 'viseme', props: { kind: 'enum', options: ['rest', 'o'] } },
    { op: 'create', type: 'driver', id: 'd_happy', props: { param: 'happiness', pose: 'happy' } },
    { op: 'create', type: 'driver', id: 'd_turn', props: { param: 'head_turn', pose: 'turn_r' } },
    { op: 'create', type: 'driver', id: 'd_o', props: { param: 'viseme', pose: 'viseme_o', equals: 'o' } },
  );
}

test('initial values of the params and weight of the drivers', () => {
  const doc = face();
  assert.deepEqual(paramValues(doc, schema), { happiness: 0, head_turn: 0, viseme: 'rest' });
  assert.deepEqual(paramValues(doc, schema, { head_turn: 5, viseme: 'x' }).head_turn, 1);
  assert.equal(driverWeight(doc, schema, findObject(doc, 'd_happy'), 0.25), 0.25);
  assert.equal(driverWeight(doc, schema, findObject(doc, 'd_turn'), -1), 0);
  assert.equal(driverWeight(doc, schema, findObject(doc, 'd_o'), 'o'), 1);
});

test('the blend adds numbers, interpolates vertices and picks the switch', () => {
  const doc = face();
  const half = blendPoses(doc, schema, { happiness: 0.5, head_turn: 1, viseme: 'o' }).values;
  assert.equal(half.head.opacity, 0.75);
  assert.deepEqual(half.smile.vertices.map((v) => [v.x, v.y]), [[-20, -5], [0, 5], [20, -5]]);
  assert.equal(half.head_bone.rotation, 20);
  assert.equal(half.mouth.active, 'mouth_o');
  // In the SVG: the switch shows only the "o" mouth, and the head turns with its bone.
  const svg = svgDocument(doc, schema, { params: { happiness: 0.5, head_turn: 1, viseme: 'o' } });
  assert.match(svg, /data-id="mouth_o"/);
  assert.doesNotMatch(svg, /data-id="mouth_rest"/);
  assert.match(svg, /data-id="head" transform="matrix\(/);
  // Without params, the setup: the first mouth.
  assert.match(svgDocument(doc, schema), /data-id="mouth_rest"/);
});

test('a pose only accepts animatable properties that exist', () => {
  assert.throws(() => op(face(), { op: 'set', target: 'happy', props: { values: { smile: { width: 3 } } } }), /has no animatable "width"/);
  assert.throws(() => op(face(), { op: 'set', target: 'happy', props: { values: { mouth: { active: 'smile' } } } }), /is not a child of mouth/);
  assert.throws(() => op(face(), { op: 'set', target: 'mouth', props: { active: 'nada' } }), /object "nada" does not exist/);
});

test('renaming and deleting update the poses, also the ids that are values', () => {
  let doc = op(face(), { op: 'rename', target: 'mouth_o', id: 'mouth_open' });
  assert.deepEqual(findObject(doc, 'viseme_o').values, { mouth: { active: 'mouth_open' } });
  doc = op(doc, { op: 'delete', target: 'mouth_open' });
  assert.deepEqual(findObject(doc, 'viseme_o').values, {});
  doc = op(doc, { op: 'delete', target: 'happiness' });
  assert.equal(findObject(doc, 'd_happy').param, undefined);
});

// A tail: a 3-point path bound per point to b1, b1 and b2, and a pose that bends b2 and changes the shape.
function tail() {
  let doc = op(
    createDocument({}),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'b1', parent: 'rig', props: { x: 0, y: 100, length: 100 } },
    { op: 'create', type: 'bone', id: 'b2', parent: 'b1', props: { x: 100, length: 100 } },
    { op: 'create', type: 'path', id: 'tail', parent: 'rig', props: { d: 'M0 100 L100 100 L200 100', closed: false } },
  );
  const vertices = findObject(doc, 'tail').vertices.map((v, i) => ({ ...v, bone: i < 2 ? 'b1' : 'b2' }));
  return op(doc, { op: 'set', target: 'tail', props: { vertices } }, { op: 'create', type: 'pose', id: 'bend', props: { values: { b2: { rotation: 90 }, tail: { d: 'M0 100 L100 110 L200 100' } } } });
}

test('a pose that changes the shape keeps the per-point binding of the setup', () => {
  const doc = tail();
  // The pose does not store bone in its vertices.
  assert.ok(findObject(doc, 'bend').values.tail.vertices.every((v) => v.bone === undefined));
  // The third point follows b2, which turns 90° around (100, 100): (200, 100) → (100, 200).
  assert.match(svgDocument(doc, schema, { pose: 'bend' }), /data-id="tail"><path d="M0 100L100 110L100 200"/);
  // Also in the blend, halfway.
  const withParam = op(doc, { op: 'create', type: 'param', id: 'p' }, { op: 'create', type: 'driver', id: 'd', props: { param: 'p', pose: 'bend' } });
  assert.match(svgDocument(withParam, schema, { params: { p: 1 } }), /data-id="tail"><path d="M0 100L100 110L100 200"/);
});

test('the bone an old pose stored in its vertices is ignored', () => {
  const doc = tail();
  // Simulates an older document: the pose stores an old bone (or one that no longer exists) in each vertex.
  const old = structuredClone(doc);
  findObject(old, 'bend').values.tail.vertices = findObject(old, 'bend').values.tail.vertices.map((v) => ({ ...v, bone: 'nope' }));
  assert.match(svgDocument(old, schema, { pose: 'bend' }), /data-id="tail"><path d="M0 100L100 110L100 200"/);
  // When it is saved again, it is cleaned up.
  const clean = op(old, { op: 'set', target: 'bend', props: { values: findObject(old, 'bend').values } });
  assert.ok(findObject(clean, 'bend').values.tail.vertices.every((v) => v.bone === undefined));
});

test('the blend starts from the visible value, with the style', () => {
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'style', id: 'skin', props: { fill: '#ff0000', strokeWidth: 10, stroke: '#000000' } },
    { op: 'create', type: 'rect', id: 'face', props: { style: 'skin', width: 10, height: 10 } },
    { op: 'create', type: 'pose', id: 'pale', props: { values: { face: { fill: '#ff0000', strokeWidth: 10 } } } },
    { op: 'create', type: 'param', id: 'p' },
    { op: 'create', type: 'driver', id: 'd', props: { param: 'p', pose: 'pale' } },
  );
  assert.deepEqual(blendPoses(doc, schema, { p: 0.5 }).values, { face: { fill: '#ff0000', strokeWidth: 10 } });
});

test('writing to a pose: the same batch for the editor and for set_pose', async () => {
  const { mergePose, opsToSetPose } = await import('../src/core/blend.js');
  const previous = { a: { x: 1, y: 2 }, b: { rotation: 5 } };
  // What the editor sends: an object and its fields; undefined removes the property and, if nothing is left, the
  // object.
  assert.deepEqual(mergePose(previous, { a: { x: 3 } }), { a: { x: 3, y: 2 }, b: { rotation: 5 } });
  assert.deepEqual(mergePose(previous, { a: { y: undefined } }), { a: { x: 1 }, b: { rotation: 5 } });
  assert.deepEqual(mergePose(previous, { b: { rotation: undefined } }), { a: { x: 1, y: 2 } });
  assert.deepEqual(mergePose(previous, { c: { opacity: undefined } }), previous);
  // Does not touch what it receives.
  assert.deepEqual(previous, { a: { x: 1, y: 2 }, b: { rotation: 5 } });
  const doc = op(createDocument({}), ...['a', 'b', 'r'].map((id) => ({ op: 'create', type: 'rect', id })), { op: 'create', type: 'pose', id: 'p', props: { values: previous } });
  assert.deepEqual(opsToSetPose(doc, 'p', { r: { x: 4 } }), [{ op: 'set', target: 'p', props: { values: { ...previous, r: { x: 4 } } } }]);
});

test('autokey: opsForKeysInClip sets and removes keyframes at the requested time', async () => {
  const { opsForKeysInClip } = await import('../src/core/animation.js');
  let doc = op(createDocument({}), { op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'animation', id: 'c', props: { duration: 2 } });
  doc = op(doc, ...opsForKeysInClip(doc, schema, 'c', 'r', { x: 10, opacity: 0.5 }, 1));
  assert.deepEqual(findObject(doc, 'c').tracks.r.x.map((k) => [k.t, k.value]), [[1, 10]]);
  assert.deepEqual(findObject(doc, 'c').tracks.r.opacity.map((k) => [k.t, k.value]), [[1, 0.5]]);
  doc = op(doc, ...opsForKeysInClip(doc, schema, 'c', 'r', { x: undefined }, 1));
  assert.equal(findObject(doc, 'c').tracks.r.x, undefined);
  assert.ok(findObject(doc, 'c').tracks.r.opacity);
});
