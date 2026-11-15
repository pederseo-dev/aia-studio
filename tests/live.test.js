import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { createDocument, validate } from '../src/core/document.js';
import { applyOperations } from '../src/core/operations.js';
import { runScript, createLive } from '../src/core/live.js';
import { manifest, manifestText } from '../src/core/manifest.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema).doc;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const key = (t, value, ease) => ({ t, value, ...(ease ? { ease } : {}) });
const still = (value, d = 1) => [key(0, value), key(d, value)];

// A puppet with arm, head, eye, mouth (switch), a param that moves a pose and base, gesture and auto clips.
function puppet(extra = []) {
  return op(
    createDocument({ name: 'Bot' }),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'arm_bone', parent: 'rig', props: { from: [100, 100], to: [200, 100] } },
    { op: 'create', type: 'bone', id: 'head_bone', parent: 'rig', props: { from: [100, 50], to: [150, 50] } },
    { op: 'create', type: 'rect', id: 'arm', parent: 'rig', props: { x: 150, y: 100, width: 100, height: 10, bone: 'arm_bone' } },
    { op: 'create', type: 'ellipse', id: 'eye', parent: 'rig', props: { x: 100, y: 40, width: 10, height: 10 } },
    { op: 'create', type: 'switch', id: 'mouth', parent: 'rig' },
    { op: 'create', type: 'rect', id: 'mouth_rest', parent: 'mouth', props: { width: 10, height: 2 } },
    { op: 'create', type: 'ellipse', id: 'mouth_o', parent: 'mouth', props: { width: 8, height: 8 } },
    { op: 'create', type: 'pose', id: 'happy', props: { values: { head_bone: { rotation: 10 } } } },
    { op: 'create', type: 'param', id: 'happiness', props: { description: 'How happy it looks' } },
    { op: 'create', type: 'driver', id: 'd_happy', props: { param: 'happiness', pose: 'happy' } },
    // Base: idle moves the head 0 → 0 (still); talking opens the mouth.
    { op: 'create', type: 'animation', id: 'idle', props: { usage: 'puppet', loop: 'loop', duration: 2, fade: 0.5, description: 'Rest', tracks: { arm_bone: { rotation: still(0, 2) } } } },
    { op: 'create', type: 'animation', id: 'talking', props: { usage: 'puppet', loop: 'loop', duration: 1, fade: 0.5, tracks: { arm_bone: { rotation: still(20) }, mouth: { active: [key(0, 'mouth_o')] } } } },
    // Gesture: wave takes the arm to -60 for 1 s and animates happiness to 1.
    { op: 'create', type: 'animation', id: 'wave', props: { usage: 'puppet', duration: 1, fade: 0.2, description: 'Waves', tracks: { arm_bone: { rotation: still(-60) }, happiness: { value: still(1) } } } },
    ...extra,
  );
}
const rot = (pose, id) => pose.values[id]?.rotation;

test('a base comes in with a crossfade and replaces the previous one', () => {
  const live = createLive(puppet(), schema);
  assert.equal(rot(live.pose(), 'arm_bone'), undefined); // nothing playing: the setup
  live.play('talking');
  live.advance(0.25); // halfway through the 0.5 s fade
  near(rot(live.pose(), 'arm_bone'), 10); // smooth(0.5) = 0.5 → halfway from 0 to 20
  live.advance(0.25);
  near(rot(live.pose(), 'arm_bone'), 20);
  assert.equal(live.pose().values.mouth.active, 'mouth_o');
  live.play('idle');
  live.advance(0.5);
  near(rot(live.pose(), 'arm_bone'), 0);
  assert.deepEqual(live.state().playing.map((s) => s.clip), ['idle']);
  // Requesting the base that is already playing again does not restart it.
  live.play('idle');
  assert.equal(live.state().playing.length, 1);
});

test('a gesture overrides only its tracks on top of the base and leaves by itself at the end', () => {
  const live = createLive(puppet(), schema);
  live.play('talking');
  live.advance(0.5);
  live.play('wave');
  live.advance(0.3);
  const p = live.pose();
  near(rot(p, 'arm_bone'), -60); // the gesture overrides the arm (happiness 1 adds the happy pose to the head, not the arm)
  assert.equal(p.values.mouth.active, 'mouth_o'); // the mouth follows the base
  near(p.params.happiness, 1);
  near(rot(p, 'head_bone'), 10);
  live.advance(0.7); // the gesture ends: fully out
  near(rot(live.pose(), 'arm_bone'), 20);
  assert.deepEqual(live.state().playing.map((s) => s.clip), ['talking']);
});

test('the app param returns smoothly when the clip that animates it leaves', () => {
  const live = createLive(puppet(), schema, { params: { happiness: 0.2 } });
  live.play('wave');
  live.advance(0.5);
  near(live.pose().params.happiness, 1);
  live.set('happiness', 0.4); // the app changes it while it plays: the clip wins
  near(live.pose().params.happiness, 1);
  live.advance(0.4); // t = 0.9: halfway through the fade-out (started at 0.8)
  const h = live.pose().params.happiness;
  assert.ok(h > 0.4 && h < 1, `between the app and the clip: ${h}`);
  live.advance(0.2);
  near(live.pose().params.happiness, 0.4);
});

test('next chains a gesture with a base, and stop takes a clip out', () => {
  const doc = op(puppet(), { op: 'set', target: 'wave', props: { next: 'idle' } });
  const live = createLive(doc, schema);
  live.play('talking');
  live.advance(0.5);
  live.play('wave');
  live.advance(1);
  assert.ok(live.state().playing.some((s) => s.clip === 'idle' && !s.leaving));
  live.advance(1);
  assert.deepEqual(live.state().playing.map((s) => s.clip), ['idle']);
  live.stop('idle');
  live.advance(0.5);
  assert.equal(live.state().playing.length, 0);
});

test('auto layers: the blink repeats by itself and the breathing adds on top', () => {
  const doc = puppet([
    { op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, fade: 0, auto: 'repeat', repeat_min: 1, repeat_max: 1, tracks: { eye: { scaleY: [key(0, 0.1), key(0.2, 0.1)] } } } },
    { op: 'create', type: 'animation', id: 'breath', props: { usage: 'puppet', duration: 2, loop: 'loop', auto: 'always', blend: 'additive', tracks: { head_bone: { rotation: [key(0, 0), key(1, 4, 'ease-in-out'), key(2, 0)] } } } },
  ]);
  assert.deepEqual(validate(doc, schema).errors, []);
  const frames = runScript(doc, schema, [{ t: 0, play: 'idle' }, { t: 0, set: { happiness: 1 } }], [0.5, 1.1, 1.5]);
  // At 0.5 s: no blink; breathing (4·0.5 = 2 with ease-in-out at the middle of the span) adds to the happy pose (10).
  assert.equal(frames[0].pose.values.eye?.scaleY, undefined);
  near(rot(frames[0].pose, 'head_bone'), 10 + 2, 1e-3);
  // At 1.1 s it blinks (started at 1 s and lasts 0.2 s); at 1.5 s no longer.
  near(frames[1].pose.values.eye.scaleY, 0.1);
  assert.equal(frames[2].pose.values.eye?.scaleY, undefined);
  // The app does not trigger the auto ones.
  assert.throws(() => createLive(doc, schema).play('blink'), /auto clip/);
});

test('the same script gives the same strip (seeded randomness) and the errors say what there is', () => {
  const doc = puppet([{ op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, fade: 0, auto: 'repeat', tracks: { eye: { scaleY: still(0.1, 0.2) } } } }]);
  const times = Array.from({ length: 200 }, (_, i) => i * 0.05);
  const a = runScript(doc, schema, [], times).map((c) => c.pose.values.eye?.scaleY ?? 1);
  const b = runScript(doc, schema, [], times).map((c) => c.pose.values.eye?.scaleY ?? 1);
  assert.deepEqual(a, b);
  assert.ok(a.includes(0.1), 'blinks within 10 s');
  const live = createLive(doc, schema);
  assert.throws(() => live.play('wav'), /Clips you can play: idle, talking, wave/);
  assert.throws(() => live.set('joy', 1), /Params: happiness/);
});

test('validation: Live settings belong to Puppet, next goes from a once clip to one the app triggers', () => {
  const doc = puppet([{ op: 'create', type: 'animation', id: 'scene_1', props: { duration: 2 } }]);
  assert.throws(() => op(doc, { op: 'set', target: 'scene_1', props: { auto: 'always' } }), /only work in Puppet clips/);
  assert.throws(() => op(doc, { op: 'set', target: 'idle', props: { next: 'wave' } }), /only once clips end/);
  assert.throws(() => op(doc, { op: 'set', target: 'wave', props: { next: 'scene_1' } }), /next must be a Puppet clip/);
  assert.throws(() => op(doc, { op: 'set', target: 'wave', props: { repeat_min: 5, repeat_max: 2 } }), /greater than repeat_max/);
  // Renaming the clip in next follows it.
  const renamed = op(op(doc, { op: 'set', target: 'wave', props: { next: 'idle' } }), { op: 'rename', target: 'idle', id: 'rest' });
  assert.equal(renamed.objects.find((o) => o.id === 'wave').next, 'rest');
});

test('the manifest lists params with their poses, triggerable clips and the automatic ones', () => {
  const doc = puppet([{ op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, auto: 'repeat', description: 'Blinks', tracks: { eye: { scaleY: still(0.1, 0.2) } } } }]);
  const m = manifest(doc, schema);
  assert.equal(m.name, 'Bot');
  assert.deepEqual(m.params, [{ id: 'happiness', kind: 'number', description: 'How happy it looks', min: 0, max: 1, initial: 0, moves: [{ pose: 'happy', objects: ['head_bone'] }] }]);
  assert.deepEqual(m.clips.map((c) => [c.id, c.role]), [['idle', 'base'], ['talking', 'base'], ['wave', 'gesture']]);
  assert.deepEqual(m.clips.find((c) => c.id === 'wave').animatesParams, ['happiness']);
  assert.deepEqual(m.auto, [{ id: 'blink', auto: 'repeat', every: [2, 6], description: 'Blinks', animates: ['eye'] }]);
  const text = manifestText(m);
  assert.match(text, /happiness \(0…1, initial 0\): How happy it looks → happy/);
  assert.match(text, /talking \(base, 1 s, loop, fade 0.5 s\) — no description\n {4}overrides: arm_bone, mouth/);
  assert.match(text, /wave \(gesture, 1 s, once, fade 0.2 s\): Waves\n {4}overrides: params happiness; arm_bone/);
  assert.deepEqual(m.problems, ['clips without description: talking']);
  assert.match(text, /Problems for the app’s AI:\n- clips without description: talking/);
});

test('the manifest warns about the param an auto clip drives and lists its params; render_preview live with times, until and auto: false', async () => {
  const { planLiveView, previewError, rotationWarnings } = await import('../mcp/animation.js');
  const doc = puppet([
    { op: 'create', type: 'param', id: 'blinking' },
    { op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, fade: 0, auto: 'repeat', repeat_min: 1, repeat_max: 1, tracks: { blinking: { value: still(1, 0.2) } } } },
  ]);
  const m = manifest(doc, schema);
  assert.deepEqual(m.auto[0].animatesParams, ['blinking']);
  assert.deepEqual(m.params.find((p) => p.id === 'blinking').drivenBy, ['blink']);
  assert.match(manifestText(m), /blinking .*\[also animated by the auto clip blink: while it plays, it overrides what the app set\]/);
  assert.match(m.problems.join('\n'), /params without description: blinking/);
  // live with times (before, "time and times need animation") and the auto repetition, which falls between frames.
  assert.equal(previewError({ live: [], times: [1] }), null);
  const view = planLiveView(doc, schema, { live: [{ t: 0, play: 'idle' }], times: [0.5, 2] });
  assert.match(view.text, /Auto repeat clips that played .*blink 1–1\.1\d* s/);
  assert.doesNotMatch(planLiveView(doc, schema, { live: [{ t: 0, play: 'idle' }], auto: false, until: 2 }).text, /that played|blink \(auto/);
  // long until: 24 frames spread out and it says so; by default, until the end of the last gesture.
  assert.match(planLiveView(doc, schema, { live: [{ t: 0, play: 'idle' }], until: 9.2 }).text, /24 frames \(every 0.4 s until 9.2 s; to look closer/);
  assert.match(planLiveView(doc, schema, { live: [{ t: 0, play: 'idle' }, { t: 1, play: 'wave' }] }).text, /every 0.25 s until 2.25 s/);
  // An angle more than 180° from the setup turns almost a full turn in the fade.
  const rotation = op(doc, { op: 'set', target: 'wave', props: { tracks: { arm_bone: { rotation: still(300) } } } });
  assert.match(rotationWarnings(rotation, schema, rotation.objects.find((o) => o.id === 'wave')).join(), /arm_bone.rotation: 300 at t 0, 300 at t 1 is more than 180° from the setup \(0\).*use -60/);
});

test('MCP: set_keys stores the Live settings, render_preview with live runs the script and the summary says so', async () => {
  const { planSetKeys, planLiveView, previewError, clipSummary } = await import('../mcp/animation.js');
  let doc = puppet();
  const plan = planSetKeys(doc, schema, 'surprised', { usage: 'puppet', duration: 0.5, fade: 0.1, next: 'idle', keys: [{ t: 0, values: { arm_bone: { rotation: 30 } } }, { t: 0.5, values: { arm_bone: { rotation: 30 } } }] });
  doc = op(doc, ...plan.ops);
  const clip = doc.objects.find((o) => o.id === 'surprised');
  assert.equal(clip.next, 'idle');
  assert.equal(clipSummary(schema, clip), 'puppet, 0.5 s, once, gesture, fade 0.1 s, next idle; animates arm_bone.rotation; keys at 0, 0.5');
  const view = planLiveView(doc, schema, { live: [{ t: 0, play: 'talking' }, { t: 0.5, play: 'surprised' }], times: [0.25, 0.75, 1.5] });
  assert.match(view.svg, /^<svg/);
  assert.match(view.text, /t = 0.25 s: talking \(base, 50%\)/);
  assert.match(view.text, /t = 0.75 s: talking \(base, 100%\), surprised \(gesture, 100%\)/);
  assert.match(view.text, /t = 1.5 s: idle \(base, 100%\)/);
  assert.throws(() => planLiveView(doc, schema, { live: [{ t: 0, play: 'idle', set: { happiness: 1 } }] }), /exactly one of play, stop or set/);
  assert.throws(() => planLiveView(doc, schema, { live: [{ t: 0, play: 'wav' }] }), /Clips you can play/);
  assert.match(previewError({ live: [], animation: 'wave' }), /does not go with animation/);
});

test('audit: fade between equal bases, always with loop once, long fade, unknown stop, returning to a base and update', () => {
  const doc = puppet([
    { op: 'create', type: 'animation', id: 'a', props: { usage: 'puppet', loop: 'loop', fade: 0.5, tracks: { arm_bone: { rotation: still(30) } } } },
    { op: 'create', type: 'animation', id: 'b', props: { usage: 'puppet', loop: 'loop', fade: 0.5, tracks: { arm_bone: { rotation: still(30) } } } },
    { op: 'create', type: 'animation', id: 'breath', props: { usage: 'puppet', duration: 1, auto: 'always', blend: 'additive', tracks: { head_bone: { rotation: [key(0, 0), key(0.5, 10), key(1, 0)] } } } },
    { op: 'create', type: 'animation', id: 'corto', props: { usage: 'puppet', duration: 0.3, fade: 0.2, tracks: { arm_bone: { rotation: still(-60, 0.3) } } } },
  ]);
  // 1. Two bases with the arm at 30: the crossfade does not let the setup show through (before it dropped to 23).
  const live = createLive(doc, schema, { auto: false });
  live.play('a');
  live.advance(1);
  live.play('b');
  for (let i = 0; i < 6; i++) {
    live.advance(0.1);
    near(rot(live.pose(), 'arm_bone'), 30);
  }
  // 7. a → b → a within the fade reuses a's entry (there are not two a's).
  live.play('a');
  live.advance(0.1);
  live.play('b');
  live.play('a');
  assert.equal(live.state().playing.filter((s) => s.clip === 'a').length, 1);
  near(rot(live.pose(), 'arm_bone'), 30);
  // 6. stop with an id that does not exist or an auto: error that says what there is.
  assert.throws(() => live.stop('idel'), /Clips you can stop: .*idle/);
  assert.throws(() => createLive(doc, schema).stop('breath'), /can't be stopped/);
  // 2. auto always with the default loop (once) keeps playing in a loop.
  const breathes = runScript(doc, schema, [], [0.25, 0.5, 1.25, 1.5]).map((c) => rot(c.pose, 'head_bone'));
  breathes.forEach((r, i) => near(r, [5, 10, 5, 10][i], 1e-6));
  // 4. A gesture with fade ≥ duration/2 still reaches 100% (the fade is shortened to half).
  const g = createLive(doc, schema, { auto: false });
  g.play('corto');
  g.advance(0.15);
  near(rot(g.pose(), 'arm_bone'), -60);
  // 9. update: a deleted clip leaves; a base that becomes once leaves the base layer.
  const v = createLive(doc, schema, { auto: false });
  v.play('a');
  v.play('wave');
  v.advance(0.3);
  v.update(op(doc, { op: 'delete', target: 'wave' }, { op: 'set', target: 'a', props: { loop: 'once' } }));
  assert.deepEqual(v.state().playing, []);
});

test('audit: next on an auto clip is an error; set_keys without moments does not touch tracks; live shows the blended param and the app one', async () => {
  const { planSetKeys, planLiveView } = await import('../mcp/animation.js');
  const doc = puppet([{ op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, auto: 'repeat', tracks: { eye: { scaleY: still(0.1, 0.2) } } } }]);
  assert.throws(() => op(doc, { op: 'set', target: 'blink', props: { next: 'idle' } }), /auto clip and plays by itself/);
  assert.deepEqual(planSetKeys(doc, schema, 'wave', { fade: 0.4 }).ops, [{ op: 'set', target: 'wave', props: { fade: 0.4 } }]);
  const view = planLiveView(doc, schema, { live: [{ t: 0, play: 'wave' }], times: [0.5], auto: false });
  assert.match(view.text, /Params in the last frame \(blended with the clips\): happiness 1 \(the app: 0\)/);
});
