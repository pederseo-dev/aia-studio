// Vector layers (as in Moho): a mesh of points and curves, and shapes that fill and stroke curves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { createDocument, validate, findObject } from '../src/core/document.js';
import { applyOperations } from '../src/core/operations.js';
import { svgDocument } from '../src/render/svg.js';
import { blendPoses } from '../src/core/blend.js';
import { clipPose } from '../src/core/animation.js';
import { distributeBetweenBones } from '../src/core/skeleton.js';
import { apply, worldMatrix } from '../src/core/geometry.js';

const schema = loadSchema();
const run = (doc, ops) => applyOperations(doc, ops, schema).doc;

const square = () =>
  run(createDocument(), [
    { op: 'create', type: 'vector', id: 'body', props: { x: 100, y: 100 } },
    { op: 'create', type: 'shape', id: 'box', parent: 'body', props: { d: 'M0 0 L40 0 L40 40 L0 40 Z', fill: '#ff0000' } },
  ]);

test('a shape with d adds its points and curves to the layer', () => {
  const doc = square();
  const body = findObject(doc, 'body');
  assert.deepEqual(Object.keys(body.points), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(body.curves.c1, { closed: true, points: ['p1', 'p2', 'p3', 'p4'] });
  assert.deepEqual(findObject(doc, 'box').curves, ['c1']);
  assert.equal(findObject(doc, 'box').d, undefined);
});

test('several shapes live in one layer and a shared point welds their curves', () => {
  const doc = run(square(), [{ op: 'create', type: 'shape', id: 'roof', parent: 'body', props: { d: 'M0 0 L20 -20 L40 0 Z', fill: '#00ff00' } }]);
  const body = findObject(doc, 'body');
  assert.deepEqual(Object.keys(body.points), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(body.curves.c2.points, ['p1', 'p5', 'p2']);
  // Moving the shared point moves both shapes.
  const moved = run(doc, [{ op: 'set', target: 'body', props: { points: { ...body.points, p2: { x: 50, y: 0 } } } }]);
  const svg = svgDocument(moved, schema);
  assert.match(svg, /data-id="box" d="M0 0L50 0L40 40L0 40L0 0Z"/);
  assert.match(svg, /data-id="roof" d="M0 0L20 -20L50 0L0 0Z"/);
});

test('undo of a shape with d restores the layer', () => {
  const doc = square();
  const { doc: next, inverses } = applyOperations(doc, [{ op: 'create', type: 'shape', id: 'roof', parent: 'body', props: { d: 'M0 0 L20 -20 L40 0 Z' } }], schema);
  assert.deepEqual(run(next, inverses), doc);
});

test('a shape with several curves cuts holes with evenodd', () => {
  const doc = run(createDocument(), [
    { op: 'create', type: 'vector', id: 'ring' },
    { op: 'create', type: 'shape', id: 'donut', parent: 'ring', props: { d: 'M0 0 H100 V100 H0 Z M25 25 H75 V75 H25 Z' } },
  ]);
  assert.deepEqual(findObject(doc, 'donut').curves, ['c1', 'c2']);
  assert.match(svgDocument(doc, schema), /fill-rule="evenodd"/);
});

test('set with d replaces the curves of the shape and drops the unused ones', () => {
  const doc = run(square(), [{ op: 'set', target: 'box', props: { d: 'M0 0 L10 0 L10 10 Z' } }]);
  const body = findObject(doc, 'body');
  assert.deepEqual(findObject(doc, 'box').curves, ['c2']);
  assert.deepEqual(Object.keys(body.curves), ['c2']);
  // p1 (0, 0) is reused; p2, p3, p4 of the old square are gone.
  assert.deepEqual(Object.keys(body.points).sort(), ['p1', 'p5', 'p6']);
});

test('the document checks the references of the mesh', () => {
  const doc = square();
  assert.throws(() => run(doc, [{ op: 'set', target: 'body', props: { curves: { c1: { closed: true, points: ['p1', 'p9'] } } } }]), /"p9" is not in body\.points/);
  assert.throws(() => run(doc, [{ op: 'set', target: 'box', props: { curves: ['c7'] } }]), /"c7" is not a curve of layer body/);
  assert.throws(() => run(doc, [{ op: 'create', type: 'shape', id: 'loose', props: { d: 'M0 0 L1 1' } }]), /a shape goes inside a vector layer/);
  assert.throws(() => run(doc, [{ op: 'create', type: 'rect', id: 'r', parent: 'body' }]), /can only have shape children/);
  assert.throws(() => run(doc, [{ op: 'set', target: 'body', props: { points: { p1: { x: 0 } } } }]), /p1\.y is missing/);
  assert.throws(() => run(doc, [{ op: 'set', target: 'body', props: { curves: { c1: { points: [{ p: 'p1', bone: 'b' }, 'p2'] } } } }]), /bone goes on the point/);
});

test('a pose lists only the points it moves; the rest stay as in the setup', () => {
  const doc = run(square(), [
    { op: 'create', type: 'pose', id: 'stretch', props: { values: { body: { points: { p3: { x: 80, y: 40 } } } } } },
    { op: 'create', type: 'param', id: 'amount', props: { min: 0, max: 1 } },
    { op: 'create', type: 'driver', id: 'amount_stretch', props: { param: 'amount', pose: 'stretch' } },
  ]);
  assert.match(svgDocument(doc, schema, { pose: 'stretch' }), /data-id="box" d="M0 0L40 0L80 40L0 40L0 0Z"/);
  const half = blendPoses(doc, schema, { amount: 0.5 });
  assert.deepEqual(half.values.body.points.p3, { x: 60, y: 40 });
  assert.deepEqual(half.values.body.points.p1, { x: 0, y: 0 });
  assert.throws(() => run(doc, [{ op: 'create', type: 'pose', id: 'bad', props: { values: { body: { points: { p9: { x: 0, y: 0 } } } } } }]), /p9 is not in the layer's points/);
});

test('keyframes of points are interpolated point by point', () => {
  const doc = run(square(), [
    {
      op: 'create',
      type: 'animation',
      id: 'wobble',
      props: { duration: 1, tracks: { body: { points: [{ t: 0, value: { p3: { x: 40, y: 40 } } }, { t: 1, value: { p3: { x: 40, y: 80 } } }] } } },
    },
  ]);
  const pose = clipPose(doc, schema, 'wobble', 0.5);
  assert.deepEqual(pose.values.body.points.p3, { x: 40, y: 60 });
  assert.match(svgDocument(doc, schema, { animation: 'wobble', time: 0.5 }), /L40 60L0 40/);
});

test('mesh points follow their own bone in a pose', () => {
  const doc = run(createDocument(), [
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'base_bone', parent: 'rig', props: { x: 0, y: 0, length: 50 } },
    { op: 'create', type: 'bone', id: 'tip_bone', parent: 'base_bone', props: { x: 50, y: 0, length: 50 } },
    { op: 'create', type: 'vector', id: 'tail', parent: 'rig' },
    { op: 'create', type: 'shape', id: 'tail_line', parent: 'tail', props: { d: 'M0 0 L50 0 L100 0', fill: null, stroke: '#000000' } },
  ]);
  const points = distributeBetweenBones(doc, schema, 'tail');
  assert.equal(points.p3.bone, 'tip_bone');
  const bound = run(doc, [
    { op: 'set', target: 'tail', props: { points } },
    { op: 'create', type: 'pose', id: 'bend', props: { values: { tip_bone: { rotation: 90 } } } },
  ]);
  assert.match(svgDocument(bound, schema, { pose: 'bend' }), /d="M0 0L50 0L50 50"/);
  // Deleting the bone releases the points; renaming it follows.
  assert.equal(findObject(run(bound, [{ op: 'delete', target: 'tip_bone' }]), 'tail').points.p3.bone, undefined);
  assert.equal(findObject(run(bound, [{ op: 'rename', target: 'tip_bone', id: 'end_bone' }]), 'tail').points.p3.bone, 'end_bone');
  assert.deepEqual(validate(bound, schema).errors, []);
});

test('the editor draws with the same batch as the AI: a new layer and a shape with d', async () => {
  const { rectD, ellipseD } = await import('../src/core/mesh.js');
  const doc = run(createDocument(), [
    { op: 'create', type: 'vector', id: 'layer_1', props: { x: 50, y: 50 } },
    { op: 'create', type: 'shape', id: 'shape_1', parent: 'layer_1', props: { d: rectD(-20, -10, 40, 20) } },
    { op: 'create', type: 'shape', id: 'shape_2', parent: 'layer_1', props: { d: ellipseD(0, 0, 30, 20) } },
  ]);
  const layer = findObject(doc, 'layer_1');
  assert.equal(Object.keys(layer.curves).length, 2);
  assert.deepEqual(layer.curves.c1.points, ['p1', 'p2', 'p3', 'p4']);
  // The ellipse: 4 points with mirrored tangents.
  assert.ok(layer.curves.c2.points.every((e) => e.mode === 'mirrored'));
});

test('pivot moves the pivot of a vector layer without moving its drawing, also in poses and clips', () => {
  const doc = run(square(), [
    { op: 'create', type: 'pose', id: 'stretch', props: { values: { body: { points: { p3: { x: 80, y: 40 } } } } } },
    { op: 'create', type: 'animation', id: 'wobble', props: { duration: 1, tracks: { body: { points: [{ t: 0, value: { p3: { x: 40, y: 60 } } }] } } } },
    { op: 'set', target: 'body', props: { rotation: 90 } },
  ]);
  const { doc: moved, inverses } = applyOperations(doc, [{ op: 'set', target: 'body', props: { pivot: [120, 110] } }], schema);
  const body = findObject(moved, 'body');
  assert.deepEqual([body.x, body.y], [120, 110]);
  // Rotated 90°: moving the pivot 20 right and 10 down is (10, -20) in the layer's frame.
  assert.deepEqual(body.points.p1, { x: -10, y: 20 });
  // What is seen does not move: every point stays at the same place in the document.
  const world = (d, id) => apply(worldMatrix(d, schema, 'body'), findObject(d, 'body').points[id].x, findObject(d, 'body').points[id].y).map((v) => Math.round(v * 100) / 100);
  for (const id of ['p1', 'p2', 'p3', 'p4']) assert.deepEqual(world(moved, id), world(doc, id));
  assert.deepEqual(findObject(moved, 'stretch').values.body.points.p3, { x: 70, y: 60 });
  assert.deepEqual(findObject(moved, 'wobble').tracks.body.points[0].value.p3, { x: 30, y: 80 });
  assert.deepEqual(run(moved, inverses), doc);
  assert.throws(() => run(doc, [{ op: 'create', type: 'group', id: 'g' }, { op: 'set', target: 'g', props: { pivot: [0, 0] } }]), /only works on vector layers/);
});

test('a shape without curves is accepted with a warning', () => {
  const { warnings } = applyOperations(square(), [{ op: 'create', type: 'shape', id: 'empty', parent: 'body' }], schema);
  assert.ok(warnings.some((w) => /empty: the shape has no curves/.test(w)));
});

test('pivot also moves the x/y of the layer that poses and clips set, so the drawing stays put there', () => {
  const doc = run(square(), [
    { op: 'create', type: 'pose', id: 'up', props: { values: { body: { y: 50 } } } },
    { op: 'create', type: 'animation', id: 'rise', props: { duration: 1, tracks: { body: { y: [{ t: 0, value: 100 }, { t: 1, value: 50 }] } } } },
  ]);
  const moved = run(doc, [{ op: 'set', target: 'body', props: { pivot: [120, 120] } }]);
  assert.equal(findObject(moved, 'up').values.body.y, 70);
  assert.deepEqual(findObject(moved, 'rise').tracks.body.y.map((k) => k.value), [120, 70]);
  // The corner p1 is drawn at the same place in the pose: (100, 50) before, (120 − 20, 70 − 20) after.
  assert.match(svgDocument(moved, schema, { pose: 'up' }), /translate\(120 70\)"[^>]*><path data-id="box" d="M-20 -20/);
});

test('deleting a shape takes its unused curves and points along, also out of poses and clips, and undo brings them back', () => {
  const doc = run(square(), [
    { op: 'create', type: 'shape', id: 'roof', parent: 'body', props: { d: 'M0 0 L20 -20 L40 0 Z' } },
    { op: 'create', type: 'pose', id: 'peak', props: { values: { body: { points: { p5: { x: 20, y: -40 }, p1: { x: -5, y: 0 } } } } } },
    { op: 'create', type: 'animation', id: 'wave', props: { duration: 1, tracks: { body: { points: [{ t: 0, value: { p5: { x: 20, y: -30 } } }] } } } },
  ]);
  const { doc: next, inverses } = applyOperations(doc, [{ op: 'delete', target: 'roof' }], schema);
  const body = findObject(next, 'body');
  assert.deepEqual(Object.keys(body.curves), ['c1']);
  // p1 and p2 stay (the box uses them); p5 only belonged to the roof.
  assert.deepEqual(Object.keys(body.points), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(findObject(next, 'peak').values.body.points, { p1: { x: -5, y: 0 } });
  assert.equal(findObject(next, 'wave').tracks.body, undefined);
  assert.deepEqual(run(next, inverses), doc);
});

test('set d on a shape also releases the points a pose moved', () => {
  const doc = run(square(), [{ op: 'create', type: 'pose', id: 'stretch', props: { values: { body: { points: { p3: { x: 80, y: 40 } } } } } }]);
  const next = run(doc, [{ op: 'set', target: 'box', props: { d: 'M0 0 L10 0 L10 10 Z' } }]);
  assert.equal(findObject(next, 'stretch').values.body, undefined);
});

test('errors that teach: a partial set of points, and moving a shape to another layer', () => {
  const doc = run(square(), [{ op: 'create', type: 'vector', id: 'other' }]);
  assert.throws(() => run(doc, [{ op: 'set', target: 'body', props: { points: { p3: { x: 60, y: 60 } } } }]), /replaces the whole map: send every point/);
  assert.throws(() => run(doc, [{ op: 'move', target: 'box', parent: 'other' }]), /A shape cannot change layer/);
});

test('per-point bones on a mesh follow duplicate and leave on moving out of the skeleton', async () => {
  const { releaseForeignBindings } = await import('../src/core/skeleton.js');
  const doc = run(createDocument(), [
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'arm_bone', parent: 'rig', props: { length: 50 } },
    { op: 'create', type: 'vector', id: 'arm', parent: 'rig', props: { points: { a: { x: 0, y: 0, bone: 'arm_bone' }, b: { x: 50, y: 0 } }, curves: { c1: { points: ['a', 'b'] } } } },
  ]);
  const copy = run(doc, [{ op: 'duplicate', target: 'rig', suffix: 'r' }]);
  assert.equal(findObject(copy, 'arm_r').points.a.bone, 'arm_bone_r');
  // Moving it out alone is invalid (a foreign bone); the editor releases the binding first, with this batch.
  assert.throws(() => run(doc, [{ op: 'move', target: 'arm', parent: null }]), /arm\.points\.a\.bone/);
  const moved = structuredClone(doc);
  findObject(moved, 'arm').parent = null;
  assert.deepEqual(releaseForeignBindings(moved, schema), [{ op: 'set', target: 'arm', props: { points: { a: { x: 0, y: 0 }, b: { x: 50, y: 0 } } } }]);
});

test('curves in a pose bend only the tangents, and must go through the same points', () => {
  const doc = run(square(), [{ op: 'create', type: 'pose', id: 'bulge', props: { values: { body: { curves: { c1: { closed: true, points: ['p1', { p: 'p2', mode: 'mirrored', angle: 90, dist: 20 }, 'p3', 'p4'] } } } } } }]);
  assert.match(svgDocument(doc, schema, { pose: 'bulge' }), /C/);
  assert.throws(() => run(doc, [{ op: 'set', target: 'bulge', props: { values: { body: { curves: { c1: { points: ['p1', 'p3'] } } } } } }]), /must go through the same points/);
});

test('the MCP tree and bind_points speak of vector layers', async () => {
  const { treeOutline, planBindPoints } = await import('../mcp/tools.js');
  const doc = square();
  assert.match(treeOutline(doc, schema), /- body \(vector\) \[4 points, 1 curve\]\n {2}- box \(shape\) \[points p1 \(0, 0\), p2 \(40, 0\), p3 \(40, 40\), p4 \(0, 40\); curves c1; fill #ff0000\]/);
  const rigged = run(createDocument(), [
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'a', parent: 'rig', props: { length: 50 } },
    { op: 'create', type: 'bone', id: 'b', parent: 'a', props: { x: 50, length: 50 } },
    { op: 'create', type: 'vector', id: 'tail', parent: 'rig' },
    { op: 'create', type: 'shape', id: 'line', parent: 'tail', props: { d: 'M0 0 L40 0 L100 0', fill: null, stroke: '#000000' } },
  ]);
  const plan = planBindPoints(rigged, schema, 'tail');
  assert.equal(plan.distribution, 'a [p1, p2]; b [p3]');
});

test('transformPoints moves, rotates and scales the points of a shape with their tangents, as Transform Points', () => {
  const doc = run(createDocument(), [
    { op: 'create', type: 'vector', id: 'face' },
    { op: 'create', type: 'shape', id: 'box', parent: 'face', props: { d: 'M0 0 H40 V40 H0 Z' } },
    { op: 'create', type: 'shape', id: 'eye', parent: 'face', props: { d: 'M100 0 A10 10 0 1 1 120 0 A10 10 0 1 1 100 0 Z' } },
  ]);
  const pts = (d) => findObject(d, 'face').points;
  // Translate: only the box's points move.
  const moved = run(doc, [{ op: 'set', target: 'face', props: { transformPoints: { shape: 'box', translate: [10, 5] } } }]);
  assert.deepEqual(pts(moved).p1, { x: 10, y: 5 });
  assert.deepEqual(pts(moved).p5, pts(doc).p5);
  // Rotate 90° around the center of its box (20, 20): the corner (0, 0) goes to (40, 0).
  const turned = run(doc, [{ op: 'set', target: 'face', props: { transformPoints: { shape: 'box', rotate: 90 } } }]);
  assert.deepEqual(pts(turned).p1, { x: 40, y: 0 });
  // The eye's tangents rotate with it and scale with it.
  const eye = (d) => findObject(d, 'face').curves.c2.points[0];
  const spun = run(doc, [{ op: 'set', target: 'face', props: { transformPoints: { shape: 'eye', rotate: 90, scale: [2, 2] } } }]);
  assert.equal(eye(spun).angle, eye(doc).angle + 90);
  assert.equal(eye(spun).dist, eye(doc).dist * 2);
  // A list of points and an explicit origin.
  const one = run(doc, [{ op: 'set', target: 'face', props: { transformPoints: { points: ['p3'], scale: [2, 2], origin: [0, 0] } } }]);
  assert.deepEqual(pts(one).p3, { x: 80, y: 80 });
  assert.throws(() => run(doc, [{ op: 'set', target: 'face', props: { transformPoints: { shape: 'nope' } } }]), /not a shape of layer face \(box, eye\)/);
  assert.throws(() => run(doc, [{ op: 'set', target: 'face', props: { transformPoints: { points: ['p9'], translate: [1, 1] } } }]), /p9 is not in face\.points/);
  assert.throws(() => run(doc, [{ op: 'set', target: 'face', props: { transformPoints: { translate: [1, 1] } } }]), /needs "shape"/);
  assert.throws(() => run(doc, [{ op: 'set', target: 'eye', props: { transformPoints: { rotate: 10 } } }]), /goes on the shape's layer: \{ "op": "set", "target": "face"/);
});

test('transformPoints: composition order, welded points, exact undo, and grouping keeps each relative step', async () => {
  const { compact } = await import('../src/core/operations.js');
  const doc = run(square(), [{ op: 'create', type: 'shape', id: 'roof', parent: 'body', props: { d: 'M0 0 L20 -20 L40 0 Z' } }]);
  const pts = (d) => findObject(d, 'body').points;
  // Scale ×2 around (0, 0), then rotate 90°, then translate (10, 0): p3 (40, 40) → (80, 80) → (−80, 80) → (−70, 80).
  const all = run(doc, [{ op: 'set', target: 'body', props: { transformPoints: { points: ['p3'], scale: [2, 2], rotate: 90, origin: [0, 0], translate: [10, 0] } } }]);
  assert.deepEqual(pts(all).p3, { x: -70, y: 80 });
  // The box's points p1 and p2 are welded to the roof: moving the box moves the roof's base too, not its peak.
  const { doc: moved, inverses } = applyOperations(doc, [{ op: 'set', target: 'body', props: { transformPoints: { shape: 'box', translate: [0, 10] } } }], schema);
  assert.deepEqual(pts(moved).p1, { x: 0, y: 10 });
  assert.deepEqual(pts(moved).p5, pts(doc).p5);
  assert.deepEqual(run(moved, inverses), doc);
  // Five nudges in a row stay five steps when grouped (each one moves from where the previous left).
  const nudge = { op: 'set', target: 'body', props: { transformPoints: { shape: 'box', translate: [1, 0] } } };
  const grouped = compact([nudge, nudge, nudge, nudge, nudge]);
  assert.equal(grouped.length, 5);
  assert.deepEqual(pts(run(doc, grouped)).p1, { x: 5, y: 0 });
  // Absolute sets still merge.
  assert.equal(compact([{ op: 'set', target: 'body', props: { x: 1 } }, { op: 'set', target: 'body', props: { x: 2 } }]).length, 1);
});

test('transformPoints errors that teach', () => {
  const doc = run(square(), [{ op: 'create', type: 'shape', id: 'empty', parent: 'body' }]);
  const set = (t, extra = {}) => run(doc, [{ op: 'set', target: 'body', props: { transformPoints: t, ...extra } }]);
  assert.throws(() => set({ shape: 'box', points: ['p1'], translate: [1, 0] }), /"shape" or "points", not both/);
  assert.throws(() => set({ shape: 'box', translate: [1, 0] }, { pivot: [0, 0] }), /pivot and transformPoints go in separate operations/);
  assert.throws(() => set({ shape: 'empty', rotate: 30 }), /shape empty has no points/);
  assert.throws(() => set({ shape: 'box', rotate: '30' }), /rotate must be a number of degrees/);
  assert.throws(() => run(doc, [{ op: 'create', type: 'vector', id: 'v2', props: { transformPoints: { points: ['p1'] } } }]), /create v2 first and use "transformPoints" in a later set/);
});

test('poses and keyframes on vector layers: points merge by id, "+=" and transformPoints are relative to the setup, and poses add up', async () => {
  const { mergePose, opsToSetPose } = await import('../src/core/blend.js');
  const { resolveValues } = await import('../src/core/poseValues.js');
  const { planSetKeys } = await import('../mcp/animation.js');
  let doc = run(square(), [{ op: 'create', type: 'skeleton', id: 'rig' }, { op: 'create', type: 'bone', id: 'b', parent: 'rig', props: { rotation: 30 } }]);
  // A second set_pose on the same layer keeps the points it already had.
  assert.deepEqual(mergePose({ body: { points: { p1: { x: 0, y: 5 } } } }, { body: { points: { p3: { x: 40, y: 45 } } } }), { body: { points: { p1: { x: 0, y: 5 }, p3: { x: 40, y: 45 } } } });
  assert.deepEqual(mergePose({ body: { points: { p1: { x: 0, y: 5 }, p3: { x: 1, y: 1 } } } }, {}, false, ['body.points.p1']), { body: { points: { p3: { x: 1, y: 1 } } } });
  assert.throws(() => mergePose({}, {}, false, ['body.x.p1']), /one point or curve of a vector layer/);
  // transformPoints in a pose: only the moved points, from the setup (twice gives the same).
  const values = resolveValues(doc, schema, { body: { transformPoints: { points: ['p3', 'p4'], translate: [0, 10] } }, b: { rotation: '+=15' } }, 'values');
  assert.deepEqual(values, { body: { points: { p3: { x: 40, y: 50 }, p4: { x: 0, y: 50 } } }, b: { rotation: 45 } });
  assert.throws(() => resolveValues(doc, schema, { box: { transformPoints: { translate: [1, 1] } } }, 'values'), /goes on the shape's layer: \{ "body"/);
  doc = run(doc, opsToSetPose(doc, 'down', values));
  doc = run(doc, opsToSetPose(doc, 'down', resolveValues(doc, schema, { body: { transformPoints: { points: ['p1'], translate: [0, 2] } } }, 'values')));
  assert.deepEqual(Object.keys(findObject(doc, 'down').values.body.points), ['p3', 'p4', 'p1']);
  // Two poses that move the same point add their moves.
  doc = run(doc, [
    ...opsToSetPose(doc, 'right', { body: { points: { p3: { x: 50, y: 40 } } } }),
    { op: 'create', type: 'param', id: 'a' },
    { op: 'create', type: 'param', id: 'c' },
    { op: 'create', type: 'driver', id: 'd1', props: { param: 'a', pose: 'down' } },
    { op: 'create', type: 'driver', id: 'd2', props: { param: 'c', pose: 'right' } },
  ]);
  assert.deepEqual(blendPoses(doc, schema, { a: 1, c: 1 }).values.body.points.p3, { x: 50, y: 50 });
  // set_keys: transformPoints in a moment, and a second moment at the same time adds points.
  const plan1 = planSetKeys(doc, schema, 'clip', { keys: [{ t: 0.5, values: { body: { transformPoints: { points: ['p2'], translate: [5, 0] } } } }] });
  doc = run(doc, plan1.ops);
  const plan2 = planSetKeys(doc, schema, 'clip', { keys: [{ t: 0.5, values: { body: { points: { p4: { x: 0, y: 60 } } } } }] });
  doc = run(doc, plan2.ops);
  assert.deepEqual(findObject(doc, 'clip').tracks.body.points[0].value, { p2: { x: 45, y: 0 }, p4: { x: 0, y: 60 } });
});

test('MCP: the tree gives a bone its stored rotation, and set_keys warns about an ease on the last keyframe', async () => {
  const { treeOutline } = await import('../mcp/tools.js');
  const { planSetKeys } = await import('../mcp/animation.js');
  const doc = run(square(), [{ op: 'create', type: 'skeleton', id: 'rig' }, { op: 'create', type: 'bone', id: 'a', parent: 'rig', props: { rotation: 90 } }, { op: 'create', type: 'bone', id: 'b', parent: 'a', props: { rotation: -170.84 } }]);
  assert.match(treeOutline(doc, schema), /- b \(bone\) from .*, rotation -170\.8 \(-81° on screen\)/);
  const plan = planSetKeys(doc, schema, 'clip', { keys: [{ t: 0, values: { a: { rotation: 0 } } }, { t: 1, values: { a: { rotation: 20 } }, ease: 'ease-out' }] });
  assert.match(plan.warnings[0], /the ease at t 1 s does nothing: it is the last keyframe/);
  assert.deepEqual(planSetKeys(doc, schema, 'clip', { keys: [{ t: 0, values: { a: { rotation: 0 } }, ease: 'ease-out' }, { t: 1, values: { a: { rotation: 20 } } }] }).warnings, []);
});

test('bind_points binds only the points of a shape or a list to one bone, and release unbinds them', async () => {
  const { planBindPoints } = await import('../mcp/tools.js');
  let doc = run(createDocument(), [
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'a', parent: 'rig', props: { from: [0, 0], to: [100, 0] } },
    { op: 'create', type: 'bone', id: 'b', parent: 'a', props: { from: [100, 0], to: [200, 0] } },
    { op: 'create', type: 'vector', id: 'v', parent: 'rig' },
    { op: 'create', type: 'shape', id: 's1', parent: 'v', props: { d: 'M0 0 L10 0 L10 10 Z' } },
    { op: 'create', type: 'shape', id: 's2', parent: 'v', props: { d: 'M150 0 L160 0 L160 10 Z' } },
  ]);
  doc = run(doc, planBindPoints(doc, schema, 'v', ['b'], { shape: 's1' }).ops);
  const pts = findObject(doc, 'v').points;
  assert.deepEqual(['p1', 'p2', 'p3'].map((k) => pts[k].bone), ['b', 'b', 'b']);
  assert.equal(pts.p4.bone, undefined);
  doc = run(doc, planBindPoints(doc, schema, 'v', undefined, { points: ['p1'], release: true }).ops);
  assert.equal(findObject(doc, 'v').points.p1.bone, undefined);
  assert.equal(findObject(doc, 'v').points.p2.bone, 'b');
  assert.throws(() => planBindPoints(doc, schema, 'v', undefined, { shape: 'nope' }), /is not a shape of v \(s1, s2\)/);
});
