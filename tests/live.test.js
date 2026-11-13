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

// Un muñeco con brazo, cabeza, ojo, boca (switch), un param que mueve una pose y clips de base, gesto y auto.
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
    // Base: idle mueve la cabeza 0 → 0 (quieta); talking abre la boca.
    { op: 'create', type: 'animation', id: 'idle', props: { usage: 'puppet', loop: 'loop', duration: 2, fade: 0.5, description: 'Rest', tracks: { arm_bone: { rotation: still(0, 2) } } } },
    { op: 'create', type: 'animation', id: 'talking', props: { usage: 'puppet', loop: 'loop', duration: 1, fade: 0.5, tracks: { arm_bone: { rotation: still(20) }, mouth: { active: [key(0, 'mouth_o')] } } } },
    // Gesto: wave lleva el brazo a -60 durante 1 s y anima happiness a 1.
    { op: 'create', type: 'animation', id: 'wave', props: { usage: 'puppet', duration: 1, fade: 0.2, description: 'Waves', tracks: { arm_bone: { rotation: still(-60) }, happiness: { value: still(1) } } } },
    ...extra,
  );
}
const rot = (pose, id) => pose.values[id]?.rotation;

test('una base entra con fundido cruzado y reemplaza a la anterior', () => {
  const live = createLive(puppet(), schema);
  assert.equal(rot(live.pose(), 'arm_bone'), undefined); // nada suena: el montaje
  live.play('talking');
  live.advance(0.25); // mitad del fundido de 0.5 s
  near(rot(live.pose(), 'arm_bone'), 10); // suave(0.5) = 0.5 → mitad de 0 a 20
  live.advance(0.25);
  near(rot(live.pose(), 'arm_bone'), 20);
  assert.equal(live.pose().values.mouth.active, 'mouth_o');
  live.play('idle');
  live.advance(0.5);
  near(rot(live.pose(), 'arm_bone'), 0);
  assert.deepEqual(live.state().playing.map((s) => s.clip), ['idle']);
  // Volver a pedir la base que ya suena no la reinicia.
  live.play('idle');
  assert.equal(live.state().playing.length, 1);
});

test('un gesto pisa solo sus pistas encima de la base y sale solo al final', () => {
  const live = createLive(puppet(), schema);
  live.play('talking');
  live.advance(0.5);
  live.play('wave');
  live.advance(0.3);
  const p = live.pose();
  near(rot(p, 'arm_bone'), -60); // el gesto pisa el brazo (happiness 1 suma la pose happy a la cabeza, no al brazo)
  assert.equal(p.values.mouth.active, 'mouth_o'); // la boca sigue la base
  near(p.params.happiness, 1);
  near(rot(p, 'head_bone'), 10);
  live.advance(0.7); // termina el gesto: salió del todo
  near(rot(live.pose(), 'arm_bone'), 20);
  assert.deepEqual(live.state().playing.map((s) => s.clip), ['talking']);
});

test('el param de la app vuelve suave cuando sale el clip que lo anima', () => {
  const live = createLive(puppet(), schema, { params: { happiness: 0.2 } });
  live.play('wave');
  live.advance(0.5);
  near(live.pose().params.happiness, 1);
  live.set('happiness', 0.4); // la app lo cambia mientras suena: gana el clip
  near(live.pose().params.happiness, 1);
  live.advance(0.4); // t = 0.9: a mitad del fundido de salida (empezó en 0.8)
  const h = live.pose().params.happiness;
  assert.ok(h > 0.4 && h < 1, `entre la app y el clip: ${h}`);
  live.advance(0.2);
  near(live.pose().params.happiness, 0.4);
});

test('next encadena un gesto con una base, y stop saca un clip', () => {
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

test('capas auto: el parpadeo se repite solo y la respiración suma encima', () => {
  const doc = puppet([
    { op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, fade: 0, auto: 'repeat', repeat_min: 1, repeat_max: 1, tracks: { eye: { scaleY: [key(0, 0.1), key(0.2, 0.1)] } } } },
    { op: 'create', type: 'animation', id: 'breath', props: { usage: 'puppet', duration: 2, loop: 'loop', auto: 'always', blend: 'additive', tracks: { head_bone: { rotation: [key(0, 0), key(1, 4, 'ease-in-out'), key(2, 0)] } } } },
  ]);
  assert.deepEqual(validate(doc, schema).errors, []);
  const frames = runScript(doc, schema, [{ t: 0, play: 'idle' }, { t: 0, set: { happiness: 1 } }], [0.5, 1.1, 1.5]);
  // En 0.5 s: sin parpadeo; la respiración (4·0.5 = 2 con ease-in-out en la mitad del tramo) suma a la pose happy (10).
  assert.equal(frames[0].pose.values.eye?.scaleY, undefined);
  near(rot(frames[0].pose, 'head_bone'), 10 + 2, 1e-3);
  // En 1.1 s, parpadea (empezó en 1 s y dura 0.2 s); en 1.5 s ya no.
  near(frames[1].pose.values.eye.scaleY, 0.1);
  assert.equal(frames[2].pose.values.eye?.scaleY, undefined);
  // La app no dispara los auto.
  assert.throws(() => createLive(doc, schema).play('blink'), /auto clip/);
});

test('el mismo guion da la misma tira (azar con semilla) y los errores dicen qué hay', () => {
  const doc = puppet([{ op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, fade: 0, auto: 'repeat', tracks: { eye: { scaleY: still(0.1, 0.2) } } } }]);
  const times = Array.from({ length: 200 }, (_, i) => i * 0.05);
  const a = runScript(doc, schema, [], times).map((c) => c.pose.values.eye?.scaleY ?? 1);
  const b = runScript(doc, schema, [], times).map((c) => c.pose.values.eye?.scaleY ?? 1);
  assert.deepEqual(a, b);
  assert.ok(a.includes(0.1), 'parpadea en 10 s');
  const live = createLive(doc, schema);
  assert.throws(() => live.play('wav'), /Clips you can play: idle, talking, wave/);
  assert.throws(() => live.set('joy', 1), /Params: happiness/);
});

test('validación: lo de Live es de Puppet, next apunta a un clip once y a uno que la app dispara', () => {
  const doc = puppet([{ op: 'create', type: 'animation', id: 'scene_1', props: { duration: 2 } }]);
  assert.throws(() => op(doc, { op: 'set', target: 'scene_1', props: { auto: 'always' } }), /only work in Puppet clips/);
  assert.throws(() => op(doc, { op: 'set', target: 'idle', props: { next: 'wave' } }), /only once clips end/);
  assert.throws(() => op(doc, { op: 'set', target: 'wave', props: { next: 'scene_1' } }), /next must be a Puppet clip/);
  assert.throws(() => op(doc, { op: 'set', target: 'wave', props: { repeat_min: 5, repeat_max: 2 } }), /greater than repeat_max/);
  // Renombrar el clip de next lo sigue.
  const renamed = op(op(doc, { op: 'set', target: 'wave', props: { next: 'idle' } }), { op: 'rename', target: 'idle', id: 'rest' });
  assert.equal(renamed.objects.find((o) => o.id === 'wave').next, 'rest');
});

test('el manifiesto dice params con sus poses, clips que se disparan y los automáticos', () => {
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

test('el manifiesto avisa del param que maneja un auto y lista sus params; render_preview live con times, until y auto: false', async () => {
  const { planLiveView, previewError, rotationWarnings } = await import('../mcp/animation.js');
  const doc = puppet([
    { op: 'create', type: 'param', id: 'blinking' },
    { op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, fade: 0, auto: 'repeat', repeat_min: 1, repeat_max: 1, tracks: { blinking: { value: still(1, 0.2) } } } },
  ]);
  const m = manifest(doc, schema);
  assert.deepEqual(m.auto[0].animatesParams, ['blinking']);
  assert.deepEqual(m.params.find((p) => p.id === 'blinking').drivenBy, ['blink']);
  assert.match(manifestText(m), /blinking .*\[driven by auto blink: don't set it\]/);
  assert.match(m.problems.join('\n'), /params without description: blinking/);
  // live con times (antes, «time and times need animation») y la repetición del auto, que cae entre cuadros.
  assert.equal(previewError({ live: [], times: [1] }), null);
  const view = planLiveView(doc, schema, { live: [{ t: 0, play: 'idle' }], times: [0.5, 2] });
  assert.match(view.text, /Clips auto repeat que sonaron .*blink 1–1\.1\d* s/);
  assert.doesNotMatch(planLiveView(doc, schema, { live: [{ t: 0, play: 'idle' }], auto: false, until: 2 }).text, /sonaron|blink \(auto/);
  // until largo: 24 cuadros repartidos y lo dice; por defecto, hasta el final del último gesto.
  assert.match(planLiveView(doc, schema, { live: [{ t: 0, play: 'idle' }], until: 9.2 }).text, /24 cuadros \(cada 0.4 s hasta 9.2 s; para ver más de cerca/);
  assert.match(planLiveView(doc, schema, { live: [{ t: 0, play: 'idle' }, { t: 1, play: 'wave' }] }).text, /cada 0.25 s hasta 2.25 s/);
  // Un ángulo a más de 180° del montaje gira casi una vuelta en el fundido.
  const rotation = op(doc, { op: 'set', target: 'wave', props: { tracks: { arm_bone: { rotation: still(300) } } } });
  assert.match(rotationWarnings(rotation, schema, rotation.objects.find((o) => o.id === 'wave')).join(), /arm_bone.rotation: 300 en t 0, 300 en t 1 queda a más de 180° del montaje \(0\).*usa -60/);
});

test('MCP: set_keys guarda lo de Live, render_preview con live corre el guion y el resumen lo dice', async () => {
  const { planSetKeys, planLiveView, previewError, clipSummary } = await import('../mcp/animation.js');
  let doc = puppet();
  const plan = planSetKeys(doc, schema, 'surprised', { usage: 'puppet', duration: 0.5, fade: 0.1, next: 'idle', keys: [{ t: 0, values: { arm_bone: { rotation: 30 } } }, { t: 0.5, values: { arm_bone: { rotation: 30 } } }] });
  doc = op(doc, ...plan.ops);
  const clip = doc.objects.find((o) => o.id === 'surprised');
  assert.equal(clip.next, 'idle');
  assert.equal(clipSummary(schema, clip), 'puppet, 0.5 s, once, gesto, fade 0.1 s, next idle; anima arm_bone.rotation; keys en 0, 0.5');
  const view = planLiveView(doc, schema, { live: [{ t: 0, play: 'talking' }, { t: 0.5, play: 'surprised' }], times: [0.25, 0.75, 1.5] });
  assert.match(view.svg, /^<svg/);
  assert.match(view.text, /t = 0.25 s: talking \(base, 50%\)/);
  assert.match(view.text, /t = 0.75 s: talking \(base, 100%\), surprised \(gesto, 100%\)/);
  assert.match(view.text, /t = 1.5 s: idle \(base, 100%\)/);
  assert.throws(() => planLiveView(doc, schema, { live: [{ t: 0, play: 'idle', set: { happiness: 1 } }] }), /exactly one of play, stop or set/);
  assert.throws(() => planLiveView(doc, schema, { live: [{ t: 0, play: 'wav' }] }), /Clips you can play/);
  assert.match(previewError({ live: [], animation: 'wave' }), /does not go with animation/);
});

test('auditoría: fundido entre bases iguales, always con loop once, fade largo, stop desconocido, volver a una base y actualizar', () => {
  const doc = puppet([
    { op: 'create', type: 'animation', id: 'a', props: { usage: 'puppet', loop: 'loop', fade: 0.5, tracks: { arm_bone: { rotation: still(30) } } } },
    { op: 'create', type: 'animation', id: 'b', props: { usage: 'puppet', loop: 'loop', fade: 0.5, tracks: { arm_bone: { rotation: still(30) } } } },
    { op: 'create', type: 'animation', id: 'breath', props: { usage: 'puppet', duration: 1, auto: 'always', blend: 'additive', tracks: { head_bone: { rotation: [key(0, 0), key(0.5, 10), key(1, 0)] } } } },
    { op: 'create', type: 'animation', id: 'corto', props: { usage: 'puppet', duration: 0.3, fade: 0.2, tracks: { arm_bone: { rotation: still(-60, 0.3) } } } },
  ]);
  // 1. Dos bases con el brazo en 30: el fundido cruzado no deja asomar el montaje (antes bajaba a 23).
  const live = createLive(doc, schema, { auto: false });
  live.play('a');
  live.advance(1);
  live.play('b');
  for (let i = 0; i < 6; i++) {
    live.advance(0.1);
    near(rot(live.pose(), 'arm_bone'), 30);
  }
  // 7. a → b → a dentro del fundido reutiliza la entrada de a (no hay dos a).
  live.play('a');
  live.advance(0.1);
  live.play('b');
  live.play('a');
  assert.equal(live.state().playing.filter((s) => s.clip === 'a').length, 1);
  near(rot(live.pose(), 'arm_bone'), 30);
  // 6. stop con un id que no existe o un auto: error que dice qué hay.
  assert.throws(() => live.stop('idel'), /Clips you can stop: .*idle/);
  assert.throws(() => createLive(doc, schema).stop('breath'), /can't be stopped/);
  // 2. auto always con el loop por defecto (once) sigue sonando en loop.
  const breathes = runScript(doc, schema, [], [0.25, 0.5, 1.25, 1.5]).map((c) => rot(c.pose, 'head_bone'));
  breathes.forEach((r, i) => near(r, [5, 10, 5, 10][i], 1e-6));
  // 4. Un gesto con fade ≥ duración/2 llega igual al 100% (el fundido se acorta a la mitad).
  const g = createLive(doc, schema, { auto: false });
  g.play('corto');
  g.advance(0.15);
  near(rot(g.pose(), 'arm_bone'), -60);
  // 9. actualizar: un clip borrado sale; una base que pasa a once sale de la capa de bases.
  const v = createLive(doc, schema, { auto: false });
  v.play('a');
  v.play('wave');
  v.advance(0.3);
  v.update(op(doc, { op: 'delete', target: 'wave' }, { op: 'set', target: 'a', props: { loop: 'once' } }));
  assert.deepEqual(v.state().playing, []);
});

test('auditoría: next en un auto es un error; set_keys sin momentos no toca tracks; live dice el param mezclado y el de la app', async () => {
  const { planSetKeys, planLiveView } = await import('../mcp/animation.js');
  const doc = puppet([{ op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, auto: 'repeat', tracks: { eye: { scaleY: still(0.1, 0.2) } } } }]);
  assert.throws(() => op(doc, { op: 'set', target: 'blink', props: { next: 'idle' } }), /auto clip and plays by itself/);
  assert.deepEqual(planSetKeys(doc, schema, 'wave', { fade: 0.4 }).ops, [{ op: 'set', target: 'wave', props: { fade: 0.4 } }]);
  const view = planLiveView(doc, schema, { live: [{ t: 0, play: 'wave' }], times: [0.5], auto: false });
  assert.match(view.text, /Params en el último cuadro \(mezclados con los clips\): happiness 1 \(la app: 0\)/);
});
