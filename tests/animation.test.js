import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { findObject, createDocument, validate } from '../src/core/document.js';
import { clipWarnings, evaluateClip, clipPose, valueToSave, localTime, keyTimes, trackValue } from '../src/core/animation.js';
import { applyCurve, curveError } from '../src/core/curves.js';
import { applyOperations } from '../src/core/operations.js';
import { svgDocument } from '../src/render/svg.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema).doc;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// An arm with a bone, a switch mouth, a path with morph and a param that moves a pose (happy face = yellow face).
function puppet(tracks = {}, clip = {}) {
  return op(
    createDocument({ name: 'Muñeco' }),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'arm_bone', parent: 'rig', props: { from: [100, 100], to: [200, 100] } },
    { op: 'create', type: 'rect', id: 'arm', parent: 'rig', props: { x: 150, y: 100, width: 100, height: 10, bone: 'arm_bone' } },
    { op: 'create', type: 'ellipse', id: 'face', parent: 'rig', props: { x: 100, y: 50, width: 40, height: 40, fill: '#000000' } },
    { op: 'create', type: 'switch', id: 'mouth', parent: 'rig' },
    { op: 'create', type: 'rect', id: 'mouth_rest', parent: 'mouth', props: { width: 10, height: 2 } },
    { op: 'create', type: 'ellipse', id: 'mouth_o', parent: 'mouth', props: { width: 8, height: 8 } },
    { op: 'create', type: 'path', id: 'brow', parent: 'rig', props: { closed: false, d: 'M0 0 L10 0' } },
    { op: 'create', type: 'pose', id: 'happy', props: { values: { face: { fill: '#ffff00' }, arm_bone: { rotation: 10 } } } },
    { op: 'create', type: 'param', id: 'happiness' },
    { op: 'create', type: 'driver', id: 'd_happy', props: { param: 'happiness', pose: 'happy' } },
    { op: 'create', type: 'animation', id: 'wave', props: { usage: 'puppet', duration: 1, ...clip, tracks: tracks } },
  );
}

test('curves: linear, step, ease and cubic-bezier as in CSS', () => {
  assert.equal(applyCurve(undefined, 0.3), 0.3);
  assert.equal(applyCurve('step', 0.99), 0);
  near(applyCurve('ease-in-out', 0.5), 0.5, 1e-4);
  assert.ok(applyCurve('ease-in', 0.25) < 0.25 && applyCurve('ease-out', 0.25) > 0.25);
  // cubic-bezier(0.25, 0.1, 0.25, 1) (CSS's "ease") at the halfway point is ~0.8024.
  near(applyCurve([0.25, 0.1, 0.25, 1], 0.5), 0.8024, 1e-3);
  assert.equal(curveError('bounce').startsWith('ease must be one of'), true);
  assert.match(curveError([2, 0, 1, 1]), /x1 and x2/);
  assert.equal(curveError([0.1, -0.5, 0.9, 1.5]), null);
});

test('local time by loop: once, loop and pingpong', () => {
  const clip = (loop) => ({ type: 'animation', duration: 2, loop });
  assert.equal(localTime(schema, clip('once'), 3), 2);
  assert.equal(localTime(schema, clip('loop'), 3), 1);
  assert.equal(localTime(schema, clip('pingpong'), 3), 1);
  assert.equal(localTime(schema, clip('pingpong'), 2.5), 1.5);
  assert.equal(localTime(schema, clip('pingpong'), 4.5), 0.5);
  // Exactly at a keyframe time inside the first cycle: no rounding (0.2 in a 1.2 s loop stays 0.2, not 0.19999…).
  const short = { type: 'animation', duration: 1.2, loop: 'loop' };
  assert.equal(localTime(schema, short, 0.2), 0.2);
  assert.equal(trackValue([{ t: 0, value: 'rest' }, { t: 0.2, value: 'a' }, { t: 1.2, value: 'rest' }], localTime(schema, short, 0.2), 'discreto'), 'a');
  assert.equal(localTime(schema, { ...short, loop: 'pingpong' }, 0.2), 0.2);
  assert.equal(localTime(schema, short, -0.2), 1);
});

test('value of a track: before the first, between keyframes, after the last and step', () => {
  const keys = [{ t: 0.5, value: 10 }, { t: 1, value: 20, ease: 'step' }, { t: 2, value: 40 }];
  assert.equal(trackValue(keys, 0, 'number'), 10);
  assert.equal(trackValue(keys, 0.75, 'number'), 15);
  assert.equal(trackValue(keys, 1.9, 'number'), 20);
  assert.equal(trackValue(keys, 3, 'number'), 40);
  assert.equal(trackValue([{ t: 0, value: '#000000' }, { t: 1, value: '#ffffff' }], 0.5, 'color'), '#808080');
  assert.equal(trackValue([{ t: 0, value: 'a' }, { t: 1, value: 'b' }], 0.9, 'ref'), 'a');
});

test('a clip animates bones, colors, switch, morph and params; the drivers add on top', () => {
  const doc = puppet({
    arm_bone: { rotation: [{ t: 0, value: 0 }, { t: 1, value: -60 }] },
    mouth: { active: [{ t: 0, value: 'mouth_rest' }, { t: 0.5, value: 'mouth_o' }] },
    brow: { d: [{ t: 0, value: 'M0 0 L10 0' }, { t: 1, value: 'M0 -4 L10 0' }] },
    happiness: { value: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
  });
  assert.equal(validate(doc, schema).errors.length, 0);
  // `d` was saved as a vertices track.
  assert.equal(findObject(doc, 'wave').tracks.brow.vertices.length, 2);
  const { values, params } = evaluateClip(doc, schema, findObject(doc, 'wave'), 0.5);
  assert.equal(values.arm_bone.rotation, -30);
  assert.equal(values.mouth.active, 'mouth_o');
  near(values.brow.vertices[0].y, -2);
  assert.equal(params.happiness, 0.5);
  // The final pose: the driver (happiness 0.5) adds half its difference from the setup (10 → +5) to the
  // animated values.
  const pose = clipPose(doc, schema, 'wave', 0.5);
  assert.equal(pose.values.arm_bone.rotation, -25);
  assert.equal(pose.values.face.fill, '#808000');
  // The clip's params override the outside ones; the rest come from outside.
  assert.equal(clipPose(doc, schema, 'wave', 0.5, { happiness: 1 }).params.happiness, 0.5);
  const svg = svgDocument(doc, schema, { animation: 'wave', time: 0.5 });
  assert.match(svg, /data-id="mouth_o"/);
  assert.doesNotMatch(svg, /data-id="mouth_rest"/);
  assert.deepEqual(keyTimes(findObject(doc, 'wave')), [0, 0.5, 1]);
});

test('track validation: objects, properties, times, order, curves and params', () => {
  const errors = (tracks, clip) => {
    try {
      return validate(puppet(tracks, clip), schema).errors.join('\n');
    } catch (e) {
      return e.message;
    }
  };
  assert.match(errors({ nadie: { x: [{ t: 0, value: 1 }] } }), /object "nadie" does not exist/);
  assert.match(errors({ arm: { width2: [{ t: 0, value: 1 }] } }), /no animatable "width2"/);
  assert.match(errors({ arm: { x: [{ t: 2, value: 1 }] } }), /outside the clip \(0…1 s\)/);
  assert.match(errors({ arm: { x: [{ t: 0.5, value: 1 }, { t: 0.2, value: 2 }] } }), /in order of t/);
  assert.match(errors({ arm: { x: [{ t: 0, value: 1, ease: 'boing' }] } }), /ease must be one of/);
  assert.match(errors({ arm: { x: [{ t: 0, value: 'a' }] } }), /value must be a number/);
  assert.match(errors({ happiness: { rotation: [{ t: 0, value: 1 }] } }), /a param only animates "value"/);
  assert.match(errors({ mouth: { active: [{ t: 0, value: 'face' }] } }), /Clip "wave" makes switch mouth show "face" at t 0 s.*delete_keys with targets \["mouth\.active"\] and times \[0\]/);
  assert.equal(errors({ arm: { x: [{ t: 0, value: 1 }] } }, { duration: 3, loop: 'pingpong', usage: 'puppet' }), '');
});

test('renaming and deleting objects updates the tracks', () => {
  let doc = puppet({
    arm_bone: { rotation: [{ t: 0, value: 0 }] },
    mouth: { active: [{ t: 0, value: 'mouth_rest' }, { t: 0.5, value: 'mouth_o' }] },
  });
  doc = op(doc, { op: 'rename', target: 'arm_bone', id: 'brazo_bone' }, { op: 'rename', target: 'mouth_o', id: 'boca_o' });
  assert.deepEqual(Object.keys(findObject(doc, 'wave').tracks), ['brazo_bone', 'mouth']);
  assert.equal(findObject(doc, 'wave').tracks.mouth.active[1].value, 'boca_o');
  const { doc: withoutMouth, inverses } = applyOperations(doc, [{ op: 'delete', target: 'boca_o' }, { op: 'delete', target: 'brazo_bone' }], schema);
  assert.deepEqual(findObject(withoutMouth, 'wave').tracks, { mouth: { active: [{ t: 0, value: 'mouth_rest' }] } });
  assert.equal(validate(withoutMouth, schema).errors.length, 0);
  // Undo restores the tracks.
  const returned = applyOperations(withoutMouth, inverses, schema).doc;
  assert.deepEqual(findObject(returned, 'wave').tracks, findObject(doc, 'wave').tracks);
});

test('set_keys: moments with values, pose and params; replaces at the same t, extends the duration and removes tracks', async () => {
  const { planSetKeys, planDeleteKeys, clipSummary, timesForStrip } = await import('../mcp/animation.js');
  const { treeOutline } = await import('../mcp/tools.js');
  let doc = puppet();
  doc = op(doc, { op: 'delete', target: 'wave' });
  let plan = planSetKeys(doc, schema, 'wave', {
    usage: 'puppet',
    description: 'Waves',
    keys: [
      { t: 0, values: { arm_bone: { rotation: 0 }, brow: { d: 'M0 0 L10 0' } }, params: { happiness: 0 } },
      { t: 0.5, pose: 'happy', values: { arm_bone: { rotation: -60 } }, ease: 'ease-out' },
      { t: 1.5, values: { arm_bone: { rotation: 0 } } },
    ],
  });
  assert.equal(plan.ops[0].op, 'create');
  assert.equal(plan.extendedFrom, 1);
  doc = op(doc, ...plan.ops);
  const clip = findObject(doc, 'wave');
  assert.equal(clip.duration, 1.5);
  assert.deepEqual(clip.tracks.arm_bone.rotation, [{ t: 0, value: 0 }, { t: 0.5, value: -60, ease: 'ease-out' }, { t: 1.5, value: 0 }]);
  assert.deepEqual(clip.tracks.face.fill, [{ t: 0.5, value: '#ffff00', ease: 'ease-out' }]);
  assert.equal(clip.tracks.brow.vertices[0].value.length, 2);
  // The same t replaces and keeps the curve.
  doc = op(doc, ...planSetKeys(doc, schema, 'wave', { keys: [{ t: 0.5, values: { arm_bone: { rotation: -80 } } }], remove: ['brow'] }).ops);
  assert.deepEqual(findObject(doc, 'wave').tracks.arm_bone.rotation[1], { t: 0.5, value: -80, ease: 'ease-out' });
  assert.equal(findObject(doc, 'wave').tracks.brow, undefined);
  assert.equal(findObject(doc, 'wave').duration, 1.5);
  assert.throws(() => planSetKeys(doc, schema, 'wave', { keys: [{ t: 0, pose: 'hapy' }] }), /there is no pose "hapy".*"happy"/);
  assert.throws(() => planSetKeys(doc, schema, 'wave', { keys: [{ t: 0 }] }), /sets nothing/);
  assert.throws(() => planSetKeys(doc, schema, 'face', {}), /is a ellipse/);
  assert.match(clipSummary(schema, findObject(doc, 'wave')), /^puppet, 1.5 s, once, gesture, fade 0.2 s; animates arm_bone.rotation, happiness.value, face.fill; keys at 0, 0.5, 1.5$/);
  assert.match(treeOutline(doc, schema), /- wave \(animation\) puppet, 1.5 s/);
  assert.deepEqual(timesForStrip(findObject(doc, 'wave')), [0, 0.5, 1.5]);
  // delete_keys: by time and track, or the whole track.
  let erase = planDeleteKeys(doc, 'wave', { times: [0.5], targets: ['arm_bone.rotation'] });
  assert.equal(erase.removed, 1);
  doc = op(doc, ...erase.ops);
  assert.deepEqual(findObject(doc, 'wave').tracks.arm_bone.rotation.map((c) => c.t), [0, 1.5]);
  doc = op(doc, ...planDeleteKeys(doc, 'wave', { targets: ['face'] }).ops);
  assert.equal(findObject(doc, 'wave').tracks.face, undefined);
  assert.throws(() => planDeleteKeys(doc, 'wav', { times: [0] }), /no animation "wav".*"wave"/);
});

test('frame strip: one frame per time with its label, and it converts to PNG', async () => {
  const { svgStrip } = await import('../src/render/svg.js');
  const { svgToPng } = await import('../server/png.js');
  const doc = puppet({ arm_bone: { rotation: [{ t: 0, value: 0 }, { t: 1, value: -90 }] } });
  const svg = svgStrip(doc, schema, { animation: 'wave', times: [0, 0.5, 1], bones: true });
  assert.equal((svg.match(/t = /g) ?? []).length, 3);
  assert.match(svg, /t = 0.5 s/);
  const png = svgToPng(svg, 600);
  assert.ok(png.length > 1000);
});

test('putKey and removeKey: replace at the same t, keep the curve and do not touch the tracks they receive', async () => {
  const { putKey, removeKey } = await import('../src/core/animation.js');
  const tracks = { a: { x: [{ t: 0, value: 1 }, { t: 0.5, value: 2, ease: 'step' }] } };
  const others = putKey(tracks, 'a', 'x', 0.5, 9);
  assert.deepEqual(others.a.x[1], { t: 0.5, value: 9, ease: 'step' });
  assert.equal(tracks.a.x[1].value, 2);
  assert.deepEqual(putKey(tracks, 'a', 'x', 0.25, 5, 'linear').a.x.map((c) => c.t), [0, 0.25, 0.5]);
  assert.deepEqual(putKey({}, 'p', 'vertices', 0, [{ x: 0, y: 0, bone: 'b' }]).p.vertices[0].value, [{ x: 0, y: 0 }]);
  assert.deepEqual(removeKey(removeKey(tracks, 'a', 'x', 0), 'a', 'x', 0.5), {});
});

test('set_keys: setup goes back to the setup and a moment with only ease changes the curve', async () => {
  const { planSetKeys } = await import('../mcp/animation.js');
  let doc = puppet();
  doc = op(doc, { op: 'delete', target: 'wave' });
  // setup goes last even if it is first: what the other moments add (the pose) also goes back to the setup.
  doc = op(doc, ...planSetKeys(doc, schema, 'hi', {
    usage: 'puppet',
    keys: [
      { t: 0, setup: true },
      { t: 0.5, pose: 'happy', params: { happiness: 1 } },
      { t: 1, setup: true, values: { arm_bone: { rotation: 5 } } },
    ],
  }).ops);
  const tracks = findObject(doc, 'hi').tracks;
  assert.deepEqual(tracks.face.fill.map((c) => c.value), ['#000000', '#ffff00', '#000000']);
  assert.deepEqual(tracks.arm_bone.rotation.map((c) => c.value), [0, 10, 5]);
  assert.deepEqual(tracks.happiness.value.map((c) => c.value), [0, 1, 0]);
  // Only ease: changes the curve of what is already at that t, without touching values (with targets, only those
  // tracks).
  doc = op(doc, ...planSetKeys(doc, schema, 'hi', { keys: [{ t: 0.5, ease: 'ease-out', targets: ['arm_bone'] }] }).ops);
  assert.deepEqual(findObject(doc, 'hi').tracks.arm_bone.rotation[1], { t: 0.5, value: 10, ease: 'ease-out' });
  assert.equal(findObject(doc, 'hi').tracks.face.fill[1].ease, undefined);
  assert.throws(() => planSetKeys(doc, schema, 'hi', { keys: [{ t: 0.7, ease: 'step' }] }), /no keyframes at t 0.7.*Keys at: 0, 0.5, 1/);
});

// ---------- Fixes from the phase 5 audit ----------

// A box with a numeric param that starts at 1 (its driver tilts it +30) and a switch mouth picked by an enum.
function withDrivers(tracks = {}) {
  return op(
    createDocument({ name: 'Drivers' }),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_rest', parent: 'mouth', props: { width: 10, height: 2 } },
    { op: 'create', type: 'ellipse', id: 'mouth_o', parent: 'mouth', props: { width: 8, height: 8 } },
    { op: 'create', type: 'rect', id: 'box', props: { width: 10, height: 10 } },
    { op: 'create', type: 'param', id: 'viseme', props: { kind: 'enum', options: ['rest', 'o'] } },
    { op: 'create', type: 'pose', id: 'v_rest', props: { values: { mouth: { active: 'mouth_rest' } } } },
    { op: 'create', type: 'pose', id: 'v_o', props: { values: { mouth: { active: 'mouth_o' } } } },
    { op: 'create', type: 'driver', id: 'd_rest', props: { param: 'viseme', pose: 'v_rest', equals: 'rest' } },
    { op: 'create', type: 'driver', id: 'd_o', props: { param: 'viseme', pose: 'v_o', equals: 'o' } },
    { op: 'create', type: 'param', id: 'lean', props: { min: 0, max: 1, default: 1 } },
    { op: 'create', type: 'pose', id: 'leaning', props: { values: { box: { rotation: 30 } } } },
    { op: 'create', type: 'driver', id: 'd_lean', props: { param: 'lean', pose: 'leaning' } },
    { op: 'create', type: 'animation', id: 'talk', props: { usage: 'puppet', duration: 2, loop: 'loop', tracks: tracks } },
  );
}

test('loop: the end of the cycle is the end, not the start', () => {
  const doc = withDrivers({ box: { rotation: [{ t: 0, value: 0 }, { t: 2, value: 90 }] } });
  const clip = findObject(doc, 'talk');
  assert.equal(localTime(schema, clip, 2), 2);
  assert.equal(localTime(schema, clip, 4), 2);
  assert.equal(localTime(schema, clip, 0), 0);
  assert.equal(localTime(schema, clip, 2.5), 0.5);
  assert.equal(evaluateClip(doc, schema, clip, 2).values.box.rotation, 90);
});

test('a clip track on something that does not add up wins over an active driver (enum at weight 1)', () => {
  const doc = withDrivers({ mouth: { active: [{ t: 0, value: 'mouth_o' }, { t: 1, value: 'mouth_rest' }] } });
  assert.equal(clipPose(doc, schema, 'talk', 0.5).values.mouth.active, 'mouth_o');
  assert.equal(clipPose(doc, schema, 'talk', 1.5).values.mouth.active, 'mouth_rest');
  // Without a track, the driver keeps picking.
  const withoutTrack = withDrivers({ box: { x: [{ t: 0, value: 0 }] } });
  assert.equal(clipPose(withoutTrack, schema, 'talk', 0, { viseme: 'o' }).values.mouth.active, 'mouth_o');
});

test('autokey with drivers: what the clip sets is stored, without what the drivers add', async () => {
  const { valueToSave, clipWarnings } = await import('../src/core/animation.js');
  const doc = withDrivers({ box: { rotation: [{ t: 0, value: 0 }] } });
  // 30 shows (0 from the clip + 30 from the lean driver = 1). To show 30, the clip stores 0; to see 45, it stores 15.
  assert.equal(clipPose(doc, schema, 'talk', 0).values.box.rotation, 30);
  assert.equal(valueToSave(doc, schema, 'talk', 0, {}, 'box', 'rotation', 30), 0);
  assert.equal(valueToSave(doc, schema, 'talk', 0, {}, 'box', 'rotation', 45), 15);
  // With lean at 0 there is no contribution; discrete values are stored as is.
  assert.equal(valueToSave(doc, schema, 'talk', 0, { lean: 0 }, 'box', 'rotation', 45), 45);
  assert.equal(valueToSave(doc, schema, 'talk', 0, {}, 'mouth', 'active', 'mouth_o'), 'mouth_o');
  // The warning names the track and the driver that adds to it.
  const warnings = clipWarnings(doc, schema, 'talk');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^box\.rotation: the clip keys it and driver d_lean \(lean = 1\) adds pose leaning on top/);
});

test('moveKey and the shared "same time" tolerance', async () => {
  const { moveKey, putKey, removeKey } = await import('../src/core/animation.js');
  const tracks = { a: { x: [{ t: 0, value: 1 }, { t: 0.5, value: 2, ease: 'ease-out' }, { t: 1, value: 3 }] } };
  assert.deepEqual(moveKey(tracks, 'a', 'x', 0.5, 0.75).a.x, [{ t: 0, value: 1 }, { t: 0.75, value: 2, ease: 'ease-out' }, { t: 1, value: 3 }]);
  assert.throws(() => moveKey(tracks, 'a', 'x', 0.5, 1.0004), /already has a keyframe at 1\.0004 s/);
  assert.equal(moveKey(tracks, 'a', 'x', 0.3, 0.4), null);
  // 0.3333 and 0.3335 are the same moment: setting replaces and removing removes only one.
  const near = putKey(putKey({}, 'b', 'y', 0.3333, 5), 'b', 'y', 0.3335, 6);
  assert.deepEqual(near.b.y, [{ t: 0.3335, value: 6 }]);
  assert.deepEqual(removeKey({ b: { y: [{ t: 0.3, value: 1 }, { t: 0.31, value: 2 }] } }, 'b', 'y', 0.3).b.y, [{ t: 0.31, value: 2 }]);
  // Validation does not allow two keyframes less than 1 ms apart.
  assert.throws(() => withDrivers({ box: { x: [{ t: 0.3333, value: 1 }, { t: 0.3335, value: 2 }] } }), /at least 1 ms apart/);
});

test('MCP: short duration, setup without tracks, move_keys, delete_keys with close times and track summary', async () => {
  const { planDeleteKeys, planMoveKeys, planSetKeys, trackLines } = await import('../mcp/animation.js');
  const { treeOutline } = await import('../mcp/tools.js');
  let doc = withDrivers({ box: { rotation: [{ t: 0, value: 0 }, { t: 1.5, value: 10, ease: 'ease-out' }] } });
  assert.throws(() => planSetKeys(doc, schema, 'talk', { duration: 0.5 }), /duration 0\.5 s is shorter than the keyframes, which go up to 1\.5 s/);
  assert.throws(() => planSetKeys(doc, schema, 'nuevo', { keys: [{ t: 0, setup: true }] }), /this clip animates nothing yet/);
  // move_keys: keeps value and curve; does not overwrite another keyframe or go past the duration.
  doc = op(doc, ...planMoveKeys(doc, schema, 'talk', { from: 1.5, to: 1 }).ops);
  assert.deepEqual(findObject(doc, 'talk').tracks.box.rotation[1], { t: 1, value: 10, ease: 'ease-out' });
  assert.throws(() => planMoveKeys(doc, schema, 'talk', { from: 1, to: 0 }), /already has a keyframe at 0 s/);
  assert.throws(() => planMoveKeys(doc, schema, 'talk', { from: 1, to: 3 }), /between 0 and the clip's duration \(2 s\)/);
  assert.throws(() => planMoveKeys(doc, schema, 'talk', { from: 0.7, to: 0.8 }), /no keyframes at t 0\.7.*Keys at: 0, 1/);
  // delete_keys: a time 0.5 ms from another keyframe is the same moment; one 10 ms away is not.
  doc = op(doc, ...planSetKeys(doc, schema, 'talk', { keys: [{ t: 0.3, values: { box: { rotation: 5 } } }, { t: 0.31, values: { box: { rotation: 6 } } }] }).ops);
  const deleted = planDeleteKeys(doc, 'talk', { times: [0.3005] });
  assert.equal(deleted.removed, 1);
  assert.deepEqual(deleted.ops[0].props.tracks.box.rotation.map((c) => c.t), [0, 0.31, 1]);
  // The tree lists each track with its keyframes.
  assert.deepEqual(trackLines(findObject(doc, 'talk')), ['box.rotation: 0 = 0 · 0.3 = 5 · 0.31 = 6 · 1 = 10 ease-out']);
  assert.match(treeOutline(doc, schema), /- talk \(animation\) puppet, 2 s, loop, base, fade 0.2 s; .*\n {4}box\.rotation: 0 = 0/);
});

test('render_preview with animation: strip, driver warnings and incompatible options', async () => {
  const { planClipView, previewError } = await import('../mcp/animation.js');
  const doc = withDrivers({ box: { rotation: [{ t: 0, value: 0 }, { t: 2, value: 90 }] }, viseme: { value: [{ t: 0, value: 'o' }] } });
  const strip = planClipView(doc, schema, { animation: 'talk' });
  // The keyframe times: the last frame of a loop is the end (90°), not the start.
  assert.equal((strip.svg.match(/t = /g) ?? []).length, 2);
  assert.match(strip.svg, /t = 2 s/);
  assert.match(strip.svg, /rotate\(120\)/); // 90 from the clip + 30 from the lean driver
  assert.match(strip.text, /the clip animates the params viseme/);
  assert.match(strip.text, /Careful, drivers that add on top of the clip:\n- box\.rotation: the clip keys it and driver d_lean/);
  const frame = planClipView(doc, schema, { animation: 'talk', time: 1, params: { lean: 0 } });
  assert.match(frame.svg, /rotate\(45\)/);
  assert.doesNotMatch(frame.text, /Careful/);
  assert.throws(() => planClipView(doc, schema, { animation: 'tlak' }), /no animation "tlak".*"talk"/);
  assert.match(previewError({ pose: 'v_o', animation: 'talk' }), /either pose or animation/);
  assert.match(previewError({ time: 1 }), /need animation/);
  assert.equal(previewError({ animation: 'talk', time: 1 }), null);
});

test('an Animate scene does not animate params; a Puppet clip does', () => {
  const base = op(
    createDocument({ name: 'P' }),
    { op: 'create', type: 'param', id: 'happiness' },
  );
  const track = { happiness: { value: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } };
  assert.throws(() => op(base, { op: 'create', type: 'animation', id: 'escena', props: { duration: 1, tracks: track } }), /can't animate params: params belong to Puppet/);
  const doc = op(base, { op: 'create', type: 'animation', id: 'gesto', props: { usage: 'puppet', duration: 1, tracks: track } });
  assert.equal(evaluateClip(doc, schema, findObject(doc, 'gesto'), 1).params.happiness, 1);
});

test('an Animate scene is seen without drivers: setup + keyframes, no warnings; render_preview rejects params', async () => {
  const { planClipView } = await import('../mcp/animation.js');
  // lean starts at 1: in a Puppet clip its driver turns the box 30°; in a scene, it does not.
  const tracks = { box: { x: [{ t: 0, value: 0 }, { t: 1, value: 50 }] } };
  let doc = withDrivers(tracks);
  assert.equal(clipPose(doc, schema, 'talk', 1).values.box.rotation, 30);
  assert.equal(clipWarnings(doc, schema, 'talk').length, 0); // does not animate rotation: nothing to warn about
  doc = op(doc, { op: 'create', type: 'animation', id: 'escena', props: { duration: 1, tracks: { box: { rotation: [{ t: 0, value: 5 }] } } } });
  const view = clipPose(doc, schema, 'escena', 0.5, { lean: 1 });
  assert.equal(view.values.box.rotation, 5);
  assert.equal(view.values.mouth, undefined); // the viseme driver does not add either
  assert.deepEqual(view.params, {});
  assert.deepEqual(clipWarnings(doc, schema, 'escena', { lean: 1 }), []);
  // Autokey stores what is shown (there is no driver contribution to subtract).
  assert.equal(valueToSave(doc, schema, 'escena', 0, {}, 'box', 'rotation', 12), 12);
  assert.throws(() => planClipView(doc, schema, { animation: 'escena', params: { lean: 1 } }), /is a scene \(Animate\).*set_keys and pose/);
  assert.doesNotThrow(() => planClipView(doc, schema, { animation: 'escena', time: 0 }));
});

test('params in a scene: turning a Puppet clip into Animate, set_keys on a new scene and the migration', async () => {
  const { planSetKeys } = await import('../mcp/animation.js');
  const { migrateScenesWithParams } = await import('../src/core/migration.js');
  const doc = puppet({ happiness: { value: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } });
  // A Puppet clip with param tracks cannot become a scene: the error says how to proceed.
  assert.throws(() => op(doc, { op: 'set', target: 'wave', props: { usage: 'animate' } }), /if this is a Puppet clip, pass usage: "puppet".*delete_keys with targets: \["happiness"\]/i);
  // set_keys with params on a new scene (default usage animate): rejected.
  const plan = planSetKeys(doc, schema, 'intro', { keys: [{ t: 0, params: { happiness: 1 } }] });
  assert.throws(() => op(doc, ...plan.ops), /scene "intro" \(Animate\) can't animate params/);
  assert.doesNotThrow(() => op(doc, ...planSetKeys(doc, schema, 'intro', { usage: 'puppet', keys: [{ t: 0, params: { happiness: 1 } }] }).ops));
  // An old document with a scene that animates params: the migration turns it into Puppet without losing keyframes.
  const old = structuredClone(doc);
  findObject(old, 'wave').usage = 'animate';
  assert.ok(validate(old, schema).errors.length);
  const { doc: migrated, changes } = migrateScenesWithParams(old, schema);
  assert.equal(findObject(migrated, 'wave').usage, 'puppet');
  assert.deepEqual(findObject(migrated, 'wave').tracks, findObject(old, 'wave').tracks);
  assert.match(changes[0], /Scene "wave" animated parameters.*now a Puppet clip/);
  assert.deepEqual(validate(migrated, schema).errors, []);
  assert.equal(migrateScenesWithParams(doc, schema).doc, doc);
});

test('move_keys: with targets it moves only those tracks; from == to is an error', async () => {
  const { planMoveKeys } = await import('../mcp/animation.js');
  let doc = withDrivers({ box: { rotation: [{ t: 0, value: 0 }, { t: 1, value: 10 }], x: [{ t: 0, value: 0 }, { t: 1, value: 50 }] } });
  doc = op(doc, ...planMoveKeys(doc, schema, 'talk', { from: 1, to: 1.5, targets: ['box.x'] }).ops);
  assert.deepEqual(findObject(doc, 'talk').tracks.box.x.map((c) => c.t), [0, 1.5]);
  assert.deepEqual(findObject(doc, 'talk').tracks.box.rotation.map((c) => c.t), [0, 1]);
  assert.throws(() => planMoveKeys(doc, schema, 'talk', { from: 1, to: 1.0004 }), /same time.*nothing to move/);
});

test('scale_time: the whole clip in proportion, a span with the later ones shifted, factor and errors', async () => {
  const { planScaleTime } = await import('../mcp/animation.js');
  const tracks = { arm_bone: { rotation: [{ t: 0, value: 0 }, { t: 0.9, value: 40, ease: 'ease-out' }, { t: 1.8, value: 0 }] }, happiness: { value: [{ t: 0.6, value: 1 }] } };
  let doc = puppet(tracks, { duration: 1.8 });
  // Whole: 1.8 → 1 s, a single set (one undo step), with value and curve.
  const plan = planScaleTime(doc, schema, 'wave', { duration: 1 });
  assert.equal(plan.ops.length, 1);
  doc = op(doc, ...plan.ops);
  const clip = findObject(doc, 'wave');
  assert.equal(clip.duration, 1);
  assert.deepEqual(clip.tracks.arm_bone.rotation.map((c) => c.t), [0, 0.5, 1]);
  assert.equal(clip.tracks.arm_bone.rotation[1].ease, 'ease-out');
  near(clip.tracks.happiness.value[0].t, 1 / 3);
  // A span: 0…0.5 now lasts 1 s; what comes after shifts 0.5 s and so does the duration.
  doc = op(doc, ...planScaleTime(doc, schema, 'wave', { from: 0, to: 0.5, duration: 1 }).ops);
  assert.deepEqual(findObject(doc, 'wave').tracks.arm_bone.rotation.map((c) => c.t), [0, 1, 1.5]);
  assert.equal(findObject(doc, 'wave').duration, 1.5);
  // factor 2: twice as long.
  doc = op(doc, ...planScaleTime(doc, schema, 'wave', { factor: 2 }).ops);
  assert.equal(findObject(doc, 'wave').duration, 3);
  assert.throws(() => planScaleTime(doc, schema, 'wave', {}), /duration.*or factor/);
  assert.throws(() => planScaleTime(doc, schema, 'wave', { duration: 1, factor: 2 }), /one of the two/);
  assert.throws(() => planScaleTime(doc, schema, 'wave', { from: 2, to: 1, duration: 1 }), /from < to/);
  assert.throws(() => planScaleTime(doc, schema, 'wave', { duration: 0.0005 }), /same time/);
});

test('set_keys: pose with only or except, values relative to the setup and named strong curves', async () => {
  const { planSetKeys } = await import('../mcp/animation.js');
  const doc = puppet();
  const tracks = (keys) => planSetKeys(doc, schema, 'wave', { keys }).ops[0].props.tracks;
  // only copies just that from the pose; except, everything but that.
  let t = tracks([{ t: 0.5, pose: 'happy', only: ['face'] }]);
  assert.deepEqual(Object.keys(t), ['face']);
  t = tracks([{ t: 0.5, pose: 'happy', except: ['face.fill'] }]);
  assert.deepEqual(Object.keys(t), ['arm_bone']);
  assert.throws(() => tracks([{ t: 0, pose: 'happy', only: ['tail'] }]), /doesn't set "tail".*It sets: face\.fill, arm_bone\.rotation/);
  assert.throws(() => tracks([{ t: 0, pose: 'happy', only: ['face'], except: ['arm_bone'] }]), /not both/);
  assert.throws(() => tracks([{ t: 0, only: ['face'] }]), /pass pose too/);
  // With setup, the filtered pose says what goes back to the setup.
  t = tracks([{ t: 0, setup: true, pose: 'happy', only: ['arm_bone'] }]);
  assert.deepEqual(Object.keys(t), ['arm_bone']);
  // Relative: "+=n" and "-=n" over the setup value; numbers only.
  const withArm = op(doc, { op: 'set', target: 'arm', props: { opacity: 0.8 } });
  t = planSetKeys(withArm, schema, 'wave', { keys: [{ t: 0.2, values: { arm_bone: { rotation: '+=14' }, arm: { opacity: '-=0.3' } } }] }).ops[0].props.tracks;
  assert.equal(t.arm_bone.rotation[0].value, 14);
  near(t.arm.opacity[0].value, 0.5);
  assert.throws(() => tracks([{ t: 0, values: { face: { fill: '+=1' } } }]), /relative to the setup.*number properties/);
  assert.throws(() => tracks([{ t: 0, values: { arm_bone: { rotation: '-=-140' } } }]), /"-=-140" is not a relative value: write "\+=n" or "-=n" with a positive number/);
  // Strong curves: named, valid and with the expected shape.
  assert.equal(curveError('ease-in-expo'), null);
  assert.ok(applyCurve('ease-in-expo', 0.5) < 0.1, 'ease-in-expo barely moves at the halfway point');
  assert.ok(applyCurve('ease-out-back', 0.7) > 1, 'ease-out-back overshoots the value');
  assert.ok(applyCurve('ease-in-back', 0.2) < 0, 'ease-in-back winds up backwards');
  t = tracks([{ t: 0, values: { arm_bone: { rotation: 0 } }, ease: 'ease-in-out-cubic' }, { t: 1, values: { arm_bone: { rotation: 10 } } }]);
  assert.equal(t.arm_bone.rotation[0].ease, 'ease-in-out-cubic');
});

test('which poses each animated param moves: set_keys and render_preview list them; a scene does not', async () => {
  const { planClipView } = await import('../mcp/animation.js');
  const { paramPoseLines } = await import('../src/core/animation.js');
  let doc = puppet({ happiness: { value: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } });
  doc = op(doc, { op: 'create', type: 'pose', id: 'look_up', props: { values: { arm_bone: { rotation: -5 } } } }, { op: 'create', type: 'driver', id: 'd_look', props: { param: 'happiness', pose: 'look_up' } });
  assert.deepEqual(paramPoseLines(doc, schema, 'wave'), ['happiness → happy (face, arm_bone), look_up (arm_bone)']);
  const { text } = planClipView(doc, schema, { animation: 'wave', time: 0.5 });
  assert.match(text, /poses they move[\s\S]*happiness → happy \(face, arm_bone\), look_up \(arm_bone\)/);
  doc = op(doc, { op: 'set', target: 'wave', props: { usage: 'animate', tracks: {} } });
  assert.deepEqual(paramPoseLines(doc, schema, 'wave'), []);
});

test('every named curve has its description in the guide', async () => {
  const { CURVE_DESCRIPTIONS, CURVE_NAMES } = await import('../src/core/curves.js');
  const described = CURVE_DESCRIPTIONS.flatMap(([names]) => names.split(', '));
  assert.deepEqual([...described].sort(), [...CURVE_NAMES].sort());
});
