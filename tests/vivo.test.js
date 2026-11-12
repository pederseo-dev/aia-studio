import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../servidor/esquema.js';
import { crearDocumento, validar } from '../src/core/documento.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';
import { correrGuion, crearVivo } from '../src/core/vivo.js';
import { manifiesto, textoDeManifiesto } from '../src/core/manifiesto.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema).doc;
const cerca = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const clave = (t, value, ease) => ({ t, value, ...(ease ? { ease } : {}) });
const quieto = (valor, d = 1) => [clave(0, valor), clave(d, valor)];

// Un muñeco con brazo, cabeza, ojo, boca (switch), un param que mueve una pose y clips de base, gesto y auto.
function muñeco(extra = []) {
  return op(
    crearDocumento({ name: 'Bot' }),
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
    { op: 'create', type: 'animation', id: 'idle', props: { usage: 'puppet', loop: 'loop', duration: 2, fade: 0.5, description: 'Rest', tracks: { arm_bone: { rotation: quieto(0, 2) } } } },
    { op: 'create', type: 'animation', id: 'talking', props: { usage: 'puppet', loop: 'loop', duration: 1, fade: 0.5, tracks: { arm_bone: { rotation: quieto(20) }, mouth: { active: [clave(0, 'mouth_o')] } } } },
    // Gesto: wave lleva el brazo a -60 durante 1 s y anima happiness a 1.
    { op: 'create', type: 'animation', id: 'wave', props: { usage: 'puppet', duration: 1, fade: 0.2, description: 'Waves', tracks: { arm_bone: { rotation: quieto(-60) }, happiness: { value: quieto(1) } } } },
    ...extra,
  );
}
const rot = (pose, id) => pose.values[id]?.rotation;

test('una base entra con fundido cruzado y reemplaza a la anterior', () => {
  const vivo = crearVivo(muñeco(), esquema);
  assert.equal(rot(vivo.pose(), 'arm_bone'), undefined); // nada suena: el montaje
  vivo.play('talking');
  vivo.avanzar(0.25); // mitad del fundido de 0.5 s
  cerca(rot(vivo.pose(), 'arm_bone'), 10); // suave(0.5) = 0.5 → mitad de 0 a 20
  vivo.avanzar(0.25);
  cerca(rot(vivo.pose(), 'arm_bone'), 20);
  assert.equal(vivo.pose().values.mouth.active, 'mouth_o');
  vivo.play('idle');
  vivo.avanzar(0.5);
  cerca(rot(vivo.pose(), 'arm_bone'), 0);
  assert.deepEqual(vivo.estado().sonando.map((s) => s.clip), ['idle']);
  // Volver a pedir la base que ya suena no la reinicia.
  vivo.play('idle');
  assert.equal(vivo.estado().sonando.length, 1);
});

test('un gesto pisa solo sus pistas encima de la base y sale solo al final', () => {
  const vivo = crearVivo(muñeco(), esquema);
  vivo.play('talking');
  vivo.avanzar(0.5);
  vivo.play('wave');
  vivo.avanzar(0.3);
  const p = vivo.pose();
  cerca(rot(p, 'arm_bone'), -60); // el gesto pisa el brazo (happiness 1 suma la pose happy a la cabeza, no al brazo)
  assert.equal(p.values.mouth.active, 'mouth_o'); // la boca sigue la base
  cerca(p.params.happiness, 1);
  cerca(rot(p, 'head_bone'), 10);
  vivo.avanzar(0.7); // termina el gesto: salió del todo
  cerca(rot(vivo.pose(), 'arm_bone'), 20);
  assert.deepEqual(vivo.estado().sonando.map((s) => s.clip), ['talking']);
});

test('el param de la app vuelve suave cuando sale el clip que lo anima', () => {
  const vivo = crearVivo(muñeco(), esquema, { params: { happiness: 0.2 } });
  vivo.play('wave');
  vivo.avanzar(0.5);
  cerca(vivo.pose().params.happiness, 1);
  vivo.set('happiness', 0.4); // la app lo cambia mientras suena: gana el clip
  cerca(vivo.pose().params.happiness, 1);
  vivo.avanzar(0.4); // t = 0.9: a mitad del fundido de salida (empezó en 0.8)
  const h = vivo.pose().params.happiness;
  assert.ok(h > 0.4 && h < 1, `entre la app y el clip: ${h}`);
  vivo.avanzar(0.2);
  cerca(vivo.pose().params.happiness, 0.4);
});

test('next encadena un gesto con una base, y stop saca un clip', () => {
  const doc = op(muñeco(), { op: 'set', target: 'wave', props: { next: 'idle' } });
  const vivo = crearVivo(doc, esquema);
  vivo.play('talking');
  vivo.avanzar(0.5);
  vivo.play('wave');
  vivo.avanzar(1);
  assert.ok(vivo.estado().sonando.some((s) => s.clip === 'idle' && !s.saliendo));
  vivo.avanzar(1);
  assert.deepEqual(vivo.estado().sonando.map((s) => s.clip), ['idle']);
  vivo.stop('idle');
  vivo.avanzar(0.5);
  assert.equal(vivo.estado().sonando.length, 0);
});

test('capas auto: el parpadeo se repite solo y la respiración suma encima', () => {
  const doc = muñeco([
    { op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, fade: 0, auto: 'repeat', repeat_min: 1, repeat_max: 1, tracks: { eye: { scaleY: [clave(0, 0.1), clave(0.2, 0.1)] } } } },
    { op: 'create', type: 'animation', id: 'breath', props: { usage: 'puppet', duration: 2, loop: 'loop', auto: 'always', blend: 'additive', tracks: { head_bone: { rotation: [clave(0, 0), clave(1, 4, 'ease-in-out'), clave(2, 0)] } } } },
  ]);
  assert.deepEqual(validar(doc, esquema).errores, []);
  const cuadros = correrGuion(doc, esquema, [{ t: 0, play: 'idle' }, { t: 0, set: { happiness: 1 } }], [0.5, 1.1, 1.5]);
  // En 0.5 s: sin parpadeo; la respiración (4·0.5 = 2 con ease-in-out en la mitad del tramo) suma a la pose happy (10).
  assert.equal(cuadros[0].pose.values.eye?.scaleY, undefined);
  cerca(rot(cuadros[0].pose, 'head_bone'), 10 + 2, 1e-3);
  // En 1.1 s, parpadea (empezó en 1 s y dura 0.2 s); en 1.5 s ya no.
  cerca(cuadros[1].pose.values.eye.scaleY, 0.1);
  assert.equal(cuadros[2].pose.values.eye?.scaleY, undefined);
  // La app no dispara los auto.
  assert.throws(() => crearVivo(doc, esquema).play('blink'), /auto clip/);
});

test('el mismo guion da la misma tira (azar con semilla) y los errores dicen qué hay', () => {
  const doc = muñeco([{ op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, fade: 0, auto: 'repeat', tracks: { eye: { scaleY: quieto(0.1, 0.2) } } } }]);
  const tiempos = Array.from({ length: 200 }, (_, i) => i * 0.05);
  const a = correrGuion(doc, esquema, [], tiempos).map((c) => c.pose.values.eye?.scaleY ?? 1);
  const b = correrGuion(doc, esquema, [], tiempos).map((c) => c.pose.values.eye?.scaleY ?? 1);
  assert.deepEqual(a, b);
  assert.ok(a.includes(0.1), 'parpadea en 10 s');
  const vivo = crearVivo(doc, esquema);
  assert.throws(() => vivo.play('wav'), /Clips you can play: idle, talking, wave/);
  assert.throws(() => vivo.set('joy', 1), /Params: happiness/);
});

test('validación: lo de Live es de Puppet, next apunta a un clip once y a uno que la app dispara', () => {
  const doc = muñeco([{ op: 'create', type: 'animation', id: 'scene_1', props: { duration: 2 } }]);
  assert.throws(() => op(doc, { op: 'set', target: 'scene_1', props: { auto: 'always' } }), /only work in Puppet clips/);
  assert.throws(() => op(doc, { op: 'set', target: 'idle', props: { next: 'wave' } }), /only once clips end/);
  assert.throws(() => op(doc, { op: 'set', target: 'wave', props: { next: 'scene_1' } }), /next must be a Puppet clip/);
  assert.throws(() => op(doc, { op: 'set', target: 'wave', props: { repeat_min: 5, repeat_max: 2 } }), /greater than repeat_max/);
  // Renombrar el clip de next lo sigue.
  const renombrado = op(op(doc, { op: 'set', target: 'wave', props: { next: 'idle' } }), { op: 'rename', target: 'idle', id: 'rest' });
  assert.equal(renombrado.objects.find((o) => o.id === 'wave').next, 'rest');
});

test('el manifiesto dice params con sus poses, clips que se disparan y los automáticos', () => {
  const doc = muñeco([{ op: 'create', type: 'animation', id: 'blink', props: { usage: 'puppet', duration: 0.2, auto: 'repeat', description: 'Blinks', tracks: { eye: { scaleY: quieto(0.1, 0.2) } } } }]);
  const m = manifiesto(doc, esquema);
  assert.equal(m.name, 'Bot');
  assert.deepEqual(m.params, [{ id: 'happiness', kind: 'number', description: 'How happy it looks', min: 0, max: 1, initial: 0, moves: [{ pose: 'happy', objects: ['head_bone'] }] }]);
  assert.deepEqual(m.clips.map((c) => [c.id, c.role]), [['idle', 'base'], ['talking', 'base'], ['wave', 'gesture']]);
  assert.deepEqual(m.clips.find((c) => c.id === 'wave').animatesParams, ['happiness']);
  assert.deepEqual(m.auto, [{ id: 'blink', auto: 'repeat', every: [2, 6], description: 'Blinks', animates: ['eye'] }]);
  const texto = textoDeManifiesto(m);
  assert.match(texto, /happiness \(0…1, initial 0\): How happy it looks → happy/);
  assert.match(texto, /talking \(base, 1 s, loop\) — no description/);
});
