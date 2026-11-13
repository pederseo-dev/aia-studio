import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../server/schema.js';
import { buscar, crearDocumento, validar } from '../src/core/document.js';
import { avisosDeClip, evaluarClip, poseDeClip, valorAGuardar, tiempoLocal, tiemposDeClaves, valorDePista } from '../src/core/animation.js';
import { aplicarCurva, errorDeCurva } from '../src/core/curves.js';
import { aplicarOperaciones } from '../src/core/operations.js';
import { svgDocumento } from '../src/render/svg.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema).doc;
const cerca = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// Un brazo con hueso, una boca switch, un path con morph y un param que mueve una pose (cara feliz = cara amarilla).
function muñeco(pistas = {}, clip = {}) {
  return op(
    crearDocumento({ name: 'Muñeco' }),
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
    { op: 'create', type: 'animation', id: 'wave', props: { usage: 'puppet', duration: 1, ...clip, tracks: pistas } },
  );
}

test('curvas: linear, step, ease y cubic-bezier como en CSS', () => {
  assert.equal(aplicarCurva(undefined, 0.3), 0.3);
  assert.equal(aplicarCurva('step', 0.99), 0);
  cerca(aplicarCurva('ease-in-out', 0.5), 0.5, 1e-4);
  assert.ok(aplicarCurva('ease-in', 0.25) < 0.25 && aplicarCurva('ease-out', 0.25) > 0.25);
  // cubic-bezier(0.25, 0.1, 0.25, 1) (el "ease" de CSS) a la mitad vale ~0.8024.
  cerca(aplicarCurva([0.25, 0.1, 0.25, 1], 0.5), 0.8024, 1e-3);
  assert.equal(errorDeCurva('bounce').startsWith('ease must be one of'), true);
  assert.match(errorDeCurva([2, 0, 1, 1]), /x1 and x2/);
  assert.equal(errorDeCurva([0.1, -0.5, 0.9, 1.5]), null);
});

test('tiempo local según loop: once, loop y pingpong', () => {
  const clip = (loop) => ({ type: 'animation', duration: 2, loop });
  assert.equal(tiempoLocal(esquema, clip('once'), 3), 2);
  assert.equal(tiempoLocal(esquema, clip('loop'), 3), 1);
  assert.equal(tiempoLocal(esquema, clip('pingpong'), 3), 1);
  assert.equal(tiempoLocal(esquema, clip('pingpong'), 2.5), 1.5);
  assert.equal(tiempoLocal(esquema, clip('pingpong'), 4.5), 0.5);
});

test('valor de una pista: antes del primero, entre keyframes, después del último y step', () => {
  const claves = [{ t: 0.5, value: 10 }, { t: 1, value: 20, ease: 'step' }, { t: 2, value: 40 }];
  assert.equal(valorDePista(claves, 0, 'number'), 10);
  assert.equal(valorDePista(claves, 0.75, 'number'), 15);
  assert.equal(valorDePista(claves, 1.9, 'number'), 20);
  assert.equal(valorDePista(claves, 3, 'number'), 40);
  assert.equal(valorDePista([{ t: 0, value: '#000000' }, { t: 1, value: '#ffffff' }], 0.5, 'color'), '#808080');
  assert.equal(valorDePista([{ t: 0, value: 'a' }, { t: 1, value: 'b' }], 0.9, 'ref'), 'a');
});

test('un clip anima huesos, colores, switch, morph y params; los drivers suman encima', () => {
  const doc = muñeco({
    arm_bone: { rotation: [{ t: 0, value: 0 }, { t: 1, value: -60 }] },
    mouth: { active: [{ t: 0, value: 'mouth_rest' }, { t: 0.5, value: 'mouth_o' }] },
    brow: { d: [{ t: 0, value: 'M0 0 L10 0' }, { t: 1, value: 'M0 -4 L10 0' }] },
    happiness: { value: [{ t: 0, value: 0 }, { t: 1, value: 1 }] },
  });
  assert.equal(validar(doc, esquema).errores.length, 0);
  // `d` se guardó como pista de vértices.
  assert.equal(buscar(doc, 'wave').tracks.brow.vertices.length, 2);
  const { values, params } = evaluarClip(doc, esquema, buscar(doc, 'wave'), 0.5);
  assert.equal(values.arm_bone.rotation, -30);
  assert.equal(values.mouth.active, 'mouth_o');
  cerca(values.brow.vertices[0].y, -2);
  assert.equal(params.happiness, 0.5);
  // La pose final: el driver (happiness 0.5) suma la mitad de su diferencia con el montaje (10 → +5) a lo animado.
  const pose = poseDeClip(doc, esquema, 'wave', 0.5);
  assert.equal(pose.values.arm_bone.rotation, -25);
  assert.equal(pose.values.face.fill, '#808000');
  // Los params del clip pisan a los de afuera; los demás vienen de afuera.
  assert.equal(poseDeClip(doc, esquema, 'wave', 0.5, { happiness: 1 }).params.happiness, 0.5);
  const svg = svgDocumento(doc, esquema, { animation: 'wave', time: 0.5 });
  assert.match(svg, /data-id="mouth_o"/);
  assert.doesNotMatch(svg, /data-id="mouth_rest"/);
  assert.deepEqual(tiemposDeClaves(buscar(doc, 'wave')), [0, 0.5, 1]);
});

test('validación de pistas: objetos, propiedades, tiempos, orden, curvas y params', () => {
  const errores = (pistas, clip) => {
    try {
      return validar(muñeco(pistas, clip), esquema).errores.join('\n');
    } catch (e) {
      return e.message;
    }
  };
  assert.match(errores({ nadie: { x: [{ t: 0, value: 1 }] } }), /object "nadie" does not exist/);
  assert.match(errores({ arm: { width2: [{ t: 0, value: 1 }] } }), /no animatable "width2"/);
  assert.match(errores({ arm: { x: [{ t: 2, value: 1 }] } }), /outside the clip \(0…1 s\)/);
  assert.match(errores({ arm: { x: [{ t: 0.5, value: 1 }, { t: 0.2, value: 2 }] } }), /in order of t/);
  assert.match(errores({ arm: { x: [{ t: 0, value: 1, ease: 'boing' }] } }), /ease must be one of/);
  assert.match(errores({ arm: { x: [{ t: 0, value: 'a' }] } }), /value debe ser un número/);
  assert.match(errores({ happiness: { rotation: [{ t: 0, value: 1 }] } }), /a param only animates "value"/);
  assert.match(errores({ mouth: { active: [{ t: 0, value: 'face' }] } }), /Clip "wave" makes switch mouth show "face" at t 0 s.*delete_keys with targets \["mouth\.active"\] and times \[0\]/);
  assert.equal(errores({ arm: { x: [{ t: 0, value: 1 }] } }, { duration: 3, loop: 'pingpong', usage: 'puppet' }), '');
});

test('renombrar y borrar objetos actualiza las pistas', () => {
  let doc = muñeco({
    arm_bone: { rotation: [{ t: 0, value: 0 }] },
    mouth: { active: [{ t: 0, value: 'mouth_rest' }, { t: 0.5, value: 'mouth_o' }] },
  });
  doc = op(doc, { op: 'rename', target: 'arm_bone', id: 'brazo_bone' }, { op: 'rename', target: 'mouth_o', id: 'boca_o' });
  assert.deepEqual(Object.keys(buscar(doc, 'wave').tracks), ['brazo_bone', 'mouth']);
  assert.equal(buscar(doc, 'wave').tracks.mouth.active[1].value, 'boca_o');
  const { doc: sinBoca, inversas } = aplicarOperaciones(doc, [{ op: 'delete', target: 'boca_o' }, { op: 'delete', target: 'brazo_bone' }], esquema);
  assert.deepEqual(buscar(sinBoca, 'wave').tracks, { mouth: { active: [{ t: 0, value: 'mouth_rest' }] } });
  assert.equal(validar(sinBoca, esquema).errores.length, 0);
  // Deshacer devuelve las pistas.
  const vuelto = aplicarOperaciones(sinBoca, inversas, esquema).doc;
  assert.deepEqual(buscar(vuelto, 'wave').tracks, buscar(doc, 'wave').tracks);
});

test('set_keys: momentos con values, pose y params; reemplaza en el mismo t, alarga la duración y quita pistas', async () => {
  const { planSetKeys, planDeleteKeys, resumenDeClip, tiemposParaTira } = await import('../mcp/animation.js');
  const { esquemaDelArbol } = await import('../mcp/tools.js');
  let doc = muñeco();
  doc = op(doc, { op: 'delete', target: 'wave' });
  let plan = planSetKeys(doc, esquema, 'wave', {
    usage: 'puppet',
    description: 'Waves',
    keys: [
      { t: 0, values: { arm_bone: { rotation: 0 }, brow: { d: 'M0 0 L10 0' } }, params: { happiness: 0 } },
      { t: 0.5, pose: 'happy', values: { arm_bone: { rotation: -60 } }, ease: 'ease-out' },
      { t: 1.5, values: { arm_bone: { rotation: 0 } } },
    ],
  });
  assert.equal(plan.ops[0].op, 'create');
  assert.equal(plan.alargadaDesde, 1);
  doc = op(doc, ...plan.ops);
  const clip = buscar(doc, 'wave');
  assert.equal(clip.duration, 1.5);
  assert.deepEqual(clip.tracks.arm_bone.rotation, [{ t: 0, value: 0 }, { t: 0.5, value: -60, ease: 'ease-out' }, { t: 1.5, value: 0 }]);
  assert.deepEqual(clip.tracks.face.fill, [{ t: 0.5, value: '#ffff00', ease: 'ease-out' }]);
  assert.equal(clip.tracks.brow.vertices[0].value.length, 2);
  // El mismo t reemplaza y conserva la curva.
  doc = op(doc, ...planSetKeys(doc, esquema, 'wave', { keys: [{ t: 0.5, values: { arm_bone: { rotation: -80 } } }], remove: ['brow'] }).ops);
  assert.deepEqual(buscar(doc, 'wave').tracks.arm_bone.rotation[1], { t: 0.5, value: -80, ease: 'ease-out' });
  assert.equal(buscar(doc, 'wave').tracks.brow, undefined);
  assert.equal(buscar(doc, 'wave').duration, 1.5);
  assert.throws(() => planSetKeys(doc, esquema, 'wave', { keys: [{ t: 0, pose: 'hapy' }] }), /there is no pose "hapy".*"happy"/);
  assert.throws(() => planSetKeys(doc, esquema, 'wave', { keys: [{ t: 0 }] }), /sets nothing/);
  assert.throws(() => planSetKeys(doc, esquema, 'face', {}), /is a ellipse/);
  assert.match(resumenDeClip(esquema, buscar(doc, 'wave')), /^puppet, 1.5 s, once, gesto, fade 0.2 s; anima arm_bone.rotation, happiness.value, face.fill; keys en 0, 0.5, 1.5$/);
  assert.match(esquemaDelArbol(doc, esquema), /- wave \(animation\) puppet, 1.5 s/);
  assert.deepEqual(tiemposParaTira(buscar(doc, 'wave')), [0, 0.5, 1.5]);
  // delete_keys: por tiempo y pista, o la pista entera.
  let borrar = planDeleteKeys(doc, 'wave', { times: [0.5], targets: ['arm_bone.rotation'] });
  assert.equal(borrar.quitadas, 1);
  doc = op(doc, ...borrar.ops);
  assert.deepEqual(buscar(doc, 'wave').tracks.arm_bone.rotation.map((c) => c.t), [0, 1.5]);
  doc = op(doc, ...planDeleteKeys(doc, 'wave', { targets: ['face'] }).ops);
  assert.equal(buscar(doc, 'wave').tracks.face, undefined);
  assert.throws(() => planDeleteKeys(doc, 'wav', { times: [0] }), /no animation "wav".*"wave"/);
});

test('tira de cuadros: un cuadro por tiempo con su rótulo, y se convierte a PNG', async () => {
  const { svgTira } = await import('../src/render/svg.js');
  const { svgAPng } = await import('../server/png.js');
  const doc = muñeco({ arm_bone: { rotation: [{ t: 0, value: 0 }, { t: 1, value: -90 }] } });
  const svg = svgTira(doc, esquema, { animation: 'wave', times: [0, 0.5, 1], huesos: true });
  assert.equal((svg.match(/t = /g) ?? []).length, 3);
  assert.match(svg, /t = 0.5 s/);
  const png = svgAPng(svg, 600);
  assert.ok(png.length > 1000);
});

test('ponerClave y quitarClave: reemplazan en el mismo t, conservan la curva y no tocan las pistas recibidas', async () => {
  const { ponerClave, quitarClave } = await import('../src/core/animation.js');
  const pistas = { a: { x: [{ t: 0, value: 1 }, { t: 0.5, value: 2, ease: 'step' }] } };
  const otras = ponerClave(pistas, 'a', 'x', 0.5, 9);
  assert.deepEqual(otras.a.x[1], { t: 0.5, value: 9, ease: 'step' });
  assert.equal(pistas.a.x[1].value, 2);
  assert.deepEqual(ponerClave(pistas, 'a', 'x', 0.25, 5, 'linear').a.x.map((c) => c.t), [0, 0.25, 0.5]);
  assert.deepEqual(ponerClave({}, 'p', 'vertices', 0, [{ x: 0, y: 0, bone: 'b' }]).p.vertices[0].value, [{ x: 0, y: 0 }]);
  assert.deepEqual(quitarClave(quitarClave(pistas, 'a', 'x', 0), 'a', 'x', 0.5), {});
});

test('set_keys: setup vuelve al montaje y un momento con solo ease cambia la curva', async () => {
  const { planSetKeys } = await import('../mcp/animation.js');
  let doc = muñeco();
  doc = op(doc, { op: 'delete', target: 'wave' });
  // setup va al final aunque esté primero: también vuelve al montaje lo que agregan los otros momentos (la pose).
  doc = op(doc, ...planSetKeys(doc, esquema, 'hi', {
    usage: 'puppet',
    keys: [
      { t: 0, setup: true },
      { t: 0.5, pose: 'happy', params: { happiness: 1 } },
      { t: 1, setup: true, values: { arm_bone: { rotation: 5 } } },
    ],
  }).ops);
  const pistas = buscar(doc, 'hi').tracks;
  assert.deepEqual(pistas.face.fill.map((c) => c.value), ['#000000', '#ffff00', '#000000']);
  assert.deepEqual(pistas.arm_bone.rotation.map((c) => c.value), [0, 10, 5]);
  assert.deepEqual(pistas.happiness.value.map((c) => c.value), [0, 1, 0]);
  // Solo ease: cambia la curva de lo que ya hay en ese t, sin tocar valores (con targets, solo esas pistas).
  doc = op(doc, ...planSetKeys(doc, esquema, 'hi', { keys: [{ t: 0.5, ease: 'ease-out', targets: ['arm_bone'] }] }).ops);
  assert.deepEqual(buscar(doc, 'hi').tracks.arm_bone.rotation[1], { t: 0.5, value: 10, ease: 'ease-out' });
  assert.equal(buscar(doc, 'hi').tracks.face.fill[1].ease, undefined);
  assert.throws(() => planSetKeys(doc, esquema, 'hi', { keys: [{ t: 0.7, ease: 'step' }] }), /no keyframes at t 0.7.*Keys at: 0, 0.5, 1/);
});

// ---------- Arreglos de la auditoría de la fase 5 ----------

// Una caja con un param numérico que arranca en 1 (su driver la inclina +30) y una boca switch elegida por un enum.
function conDrivers(pistas = {}) {
  return op(
    crearDocumento({ name: 'Drivers' }),
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
    { op: 'create', type: 'animation', id: 'talk', props: { usage: 'puppet', duration: 2, loop: 'loop', tracks: pistas } },
  );
}

test('loop: el final de la vuelta es el final, no el principio', () => {
  const doc = conDrivers({ box: { rotation: [{ t: 0, value: 0 }, { t: 2, value: 90 }] } });
  const clip = buscar(doc, 'talk');
  assert.equal(tiempoLocal(esquema, clip, 2), 2);
  assert.equal(tiempoLocal(esquema, clip, 4), 2);
  assert.equal(tiempoLocal(esquema, clip, 0), 0);
  assert.equal(tiempoLocal(esquema, clip, 2.5), 0.5);
  assert.equal(evaluarClip(doc, esquema, clip, 2).values.box.rotation, 90);
});

test('una pista del clip en algo que no se suma gana sobre un driver activo (enum en peso 1)', () => {
  const doc = conDrivers({ mouth: { active: [{ t: 0, value: 'mouth_o' }, { t: 1, value: 'mouth_rest' }] } });
  assert.equal(poseDeClip(doc, esquema, 'talk', 0.5).values.mouth.active, 'mouth_o');
  assert.equal(poseDeClip(doc, esquema, 'talk', 1.5).values.mouth.active, 'mouth_rest');
  // Sin pista, el driver sigue eligiendo.
  const sinPista = conDrivers({ box: { x: [{ t: 0, value: 0 }] } });
  assert.equal(poseDeClip(sinPista, esquema, 'talk', 0, { viseme: 'o' }).values.mouth.active, 'mouth_o');
});

test('autokey con drivers: se guarda lo que fija el clip, sin lo que suman los drivers', async () => {
  const { valorAGuardar, avisosDeClip } = await import('../src/core/animation.js');
  const doc = conDrivers({ box: { rotation: [{ t: 0, value: 0 }] } });
  // Se ve 30 (0 del clip + 30 del driver de lean = 1). Para que se vea 30, el clip guarda 0; para ver 45, guarda 15.
  assert.equal(poseDeClip(doc, esquema, 'talk', 0).values.box.rotation, 30);
  assert.equal(valorAGuardar(doc, esquema, 'talk', 0, {}, 'box', 'rotation', 30), 0);
  assert.equal(valorAGuardar(doc, esquema, 'talk', 0, {}, 'box', 'rotation', 45), 15);
  // Con lean en 0 no hay aporte; lo discreto se guarda tal cual.
  assert.equal(valorAGuardar(doc, esquema, 'talk', 0, { lean: 0 }, 'box', 'rotation', 45), 45);
  assert.equal(valorAGuardar(doc, esquema, 'talk', 0, {}, 'mouth', 'active', 'mouth_o'), 'mouth_o');
  // El aviso nombra la pista y el driver que le suma.
  const avisos = avisosDeClip(doc, esquema, 'talk');
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /^box\.rotation: the clip keys it and driver d_lean \(lean = 1\) adds pose leaning on top/);
});

test('moverClave y la tolerancia compartida de «mismo tiempo»', async () => {
  const { moverClave, ponerClave, quitarClave } = await import('../src/core/animation.js');
  const pistas = { a: { x: [{ t: 0, value: 1 }, { t: 0.5, value: 2, ease: 'ease-out' }, { t: 1, value: 3 }] } };
  assert.deepEqual(moverClave(pistas, 'a', 'x', 0.5, 0.75).a.x, [{ t: 0, value: 1 }, { t: 0.75, value: 2, ease: 'ease-out' }, { t: 1, value: 3 }]);
  assert.throws(() => moverClave(pistas, 'a', 'x', 0.5, 1.0004), /already has a keyframe at 1\.0004 s/);
  assert.equal(moverClave(pistas, 'a', 'x', 0.3, 0.4), null);
  // 0.3333 y 0.3335 son el mismo momento: poner reemplaza y quitar quita uno solo.
  const cerca = ponerClave(ponerClave({}, 'b', 'y', 0.3333, 5), 'b', 'y', 0.3335, 6);
  assert.deepEqual(cerca.b.y, [{ t: 0.3335, value: 6 }]);
  assert.deepEqual(quitarClave({ b: { y: [{ t: 0.3, value: 1 }, { t: 0.31, value: 2 }] } }, 'b', 'y', 0.3).b.y, [{ t: 0.31, value: 2 }]);
  // La validación no deja dos keyframes a menos de 1 ms.
  assert.throws(() => conDrivers({ box: { x: [{ t: 0.3333, value: 1 }, { t: 0.3335, value: 2 }] } }), /at least 1 ms apart/);
});

test('MCP: duration corta, setup sin pistas, move_keys, delete_keys con tiempos cercanos y resumen de pistas', async () => {
  const { planDeleteKeys, planMoveKeys, planSetKeys, lineasDePistas } = await import('../mcp/animation.js');
  const { esquemaDelArbol } = await import('../mcp/tools.js');
  let doc = conDrivers({ box: { rotation: [{ t: 0, value: 0 }, { t: 1.5, value: 10, ease: 'ease-out' }] } });
  assert.throws(() => planSetKeys(doc, esquema, 'talk', { duration: 0.5 }), /duration 0\.5 s is shorter than the keyframes, which go up to 1\.5 s/);
  assert.throws(() => planSetKeys(doc, esquema, 'nuevo', { keys: [{ t: 0, setup: true }] }), /this clip animates nothing yet/);
  // move_keys: conserva valor y curva; no pisa otro keyframe ni pasa la duración.
  doc = op(doc, ...planMoveKeys(doc, esquema, 'talk', { from: 1.5, to: 1 }).ops);
  assert.deepEqual(buscar(doc, 'talk').tracks.box.rotation[1], { t: 1, value: 10, ease: 'ease-out' });
  assert.throws(() => planMoveKeys(doc, esquema, 'talk', { from: 1, to: 0 }), /already has a keyframe at 0 s/);
  assert.throws(() => planMoveKeys(doc, esquema, 'talk', { from: 1, to: 3 }), /between 0 and the clip's duration \(2 s\)/);
  assert.throws(() => planMoveKeys(doc, esquema, 'talk', { from: 0.7, to: 0.8 }), /no keyframes at t 0\.7.*Keys at: 0, 1/);
  // delete_keys: un tiempo a 0.5 ms de otro keyframe es el mismo momento; uno a 10 ms, no.
  doc = op(doc, ...planSetKeys(doc, esquema, 'talk', { keys: [{ t: 0.3, values: { box: { rotation: 5 } } }, { t: 0.31, values: { box: { rotation: 6 } } }] }).ops);
  const borrado = planDeleteKeys(doc, 'talk', { times: [0.3005] });
  assert.equal(borrado.quitadas, 1);
  assert.deepEqual(borrado.ops[0].props.tracks.box.rotation.map((c) => c.t), [0, 0.31, 1]);
  // El árbol lista cada pista con sus keyframes.
  assert.deepEqual(lineasDePistas(buscar(doc, 'talk')), ['box.rotation: 0 = 0 · 0.3 = 5 · 0.31 = 6 · 1 = 10 ease-out']);
  assert.match(esquemaDelArbol(doc, esquema), /- talk \(animation\) puppet, 2 s, loop, base, fade 0.2 s; .*\n {4}box\.rotation: 0 = 0/);
});

test('render_preview con animation: tira, avisos de drivers y opciones incompatibles', async () => {
  const { planVistaDeClip, errorDeVistaPrevia } = await import('../mcp/animation.js');
  const doc = conDrivers({ box: { rotation: [{ t: 0, value: 0 }, { t: 2, value: 90 }] }, viseme: { value: [{ t: 0, value: 'o' }] } });
  const tira = planVistaDeClip(doc, esquema, { animation: 'talk' });
  // Los tiempos de los keyframes: el último cuadro de un loop es el final (90°), no el principio.
  assert.equal((tira.svg.match(/t = /g) ?? []).length, 2);
  assert.match(tira.svg, /t = 2 s/);
  assert.match(tira.svg, /rotate\(120\)/); // 90 del clip + 30 del driver de lean
  assert.match(tira.texto, /el clip anima los params viseme/);
  assert.match(tira.texto, /Ojo, drivers que suman encima del clip:\n- box\.rotation: the clip keys it and driver d_lean/);
  const cuadro = planVistaDeClip(doc, esquema, { animation: 'talk', time: 1, params: { lean: 0 } });
  assert.match(cuadro.svg, /rotate\(45\)/);
  assert.doesNotMatch(cuadro.texto, /Ojo/);
  assert.throws(() => planVistaDeClip(doc, esquema, { animation: 'tlak' }), /no animation "tlak".*"talk"/);
  assert.match(errorDeVistaPrevia({ pose: 'v_o', animation: 'talk' }), /either pose or animation/);
  assert.match(errorDeVistaPrevia({ time: 1 }), /need animation/);
  assert.equal(errorDeVistaPrevia({ animation: 'talk', time: 1 }), null);
});

test('una escena de Animate no anima params; un clip de Puppet sí', () => {
  const base = op(
    crearDocumento({ name: 'P' }),
    { op: 'create', type: 'param', id: 'happiness' },
  );
  const pista = { happiness: { value: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } };
  assert.throws(() => op(base, { op: 'create', type: 'animation', id: 'escena', props: { duration: 1, tracks: pista } }), /can't animate params: params belong to Puppet/);
  const doc = op(base, { op: 'create', type: 'animation', id: 'gesto', props: { usage: 'puppet', duration: 1, tracks: pista } });
  assert.equal(evaluarClip(doc, esquema, buscar(doc, 'gesto'), 1).params.happiness, 1);
});

test('una escena de Animate se ve sin drivers: montaje + keyframes, sin avisos; render_preview rechaza params', async () => {
  const { planVistaDeClip } = await import('../mcp/animation.js');
  // lean arranca en 1: en un clip de Puppet su driver gira la caja 30°; en una escena, no.
  const pistas = { box: { x: [{ t: 0, value: 0 }, { t: 1, value: 50 }] } };
  let doc = conDrivers(pistas);
  assert.equal(poseDeClip(doc, esquema, 'talk', 1).values.box.rotation, 30);
  assert.equal(avisosDeClip(doc, esquema, 'talk').length, 0); // no anima la rotación: nada que avisar
  doc = op(doc, { op: 'create', type: 'animation', id: 'escena', props: { duration: 1, tracks: { box: { rotation: [{ t: 0, value: 5 }] } } } });
  const vista = poseDeClip(doc, esquema, 'escena', 0.5, { lean: 1 });
  assert.equal(vista.values.box.rotation, 5);
  assert.equal(vista.values.mouth, undefined); // el driver de viseme tampoco suma
  assert.deepEqual(vista.params, {});
  assert.deepEqual(avisosDeClip(doc, esquema, 'escena', { lean: 1 }), []);
  // El autokey guarda lo que se ve (no hay aporte de drivers que restar).
  assert.equal(valorAGuardar(doc, esquema, 'escena', 0, {}, 'box', 'rotation', 12), 12);
  assert.throws(() => planVistaDeClip(doc, esquema, { animation: 'escena', params: { lean: 1 } }), /is a scene \(Animate\).*set_keys and pose/);
  assert.doesNotThrow(() => planVistaDeClip(doc, esquema, { animation: 'escena', time: 0 }));
});

test('params en una escena: pasar un clip de Puppet a Animate, set_keys sobre una escena nueva y la migración', async () => {
  const { planSetKeys } = await import('../mcp/animation.js');
  const { migrarEscenasConParams } = await import('../src/core/migration.js');
  const doc = muñeco({ happiness: { value: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } });
  // Un clip de Puppet con pistas de params no puede pasar a escena: el error dice cómo seguir.
  assert.throws(() => op(doc, { op: 'set', target: 'wave', props: { usage: 'animate' } }), /if this is a Puppet clip, pass usage: "puppet".*delete_keys with targets: \["happiness"\]/i);
  // set_keys con params sobre una escena nueva (usage por defecto animate): rechazado.
  const plan = planSetKeys(doc, esquema, 'intro', { keys: [{ t: 0, params: { happiness: 1 } }] });
  assert.throws(() => op(doc, ...plan.ops), /scene "intro" \(Animate\) can't animate params/);
  assert.doesNotThrow(() => op(doc, ...planSetKeys(doc, esquema, 'intro', { usage: 'puppet', keys: [{ t: 0, params: { happiness: 1 } }] }).ops));
  // Un documento viejo con una escena que anima params: la migración la pasa a Puppet sin perder keyframes.
  const viejo = structuredClone(doc);
  buscar(viejo, 'wave').usage = 'animate';
  assert.ok(validar(viejo, esquema).errores.length);
  const { doc: migrado, cambios } = migrarEscenasConParams(viejo, esquema);
  assert.equal(buscar(migrado, 'wave').usage, 'puppet');
  assert.deepEqual(buscar(migrado, 'wave').tracks, buscar(viejo, 'wave').tracks);
  assert.match(cambios[0], /Scene "wave" animated parameters.*now a Puppet clip/);
  assert.deepEqual(validar(migrado, esquema).errores, []);
  assert.equal(migrarEscenasConParams(doc, esquema).doc, doc);
});

test('move_keys: con targets mueve solo esas pistas; from == to es un error', async () => {
  const { planMoveKeys } = await import('../mcp/animation.js');
  let doc = conDrivers({ box: { rotation: [{ t: 0, value: 0 }, { t: 1, value: 10 }], x: [{ t: 0, value: 0 }, { t: 1, value: 50 }] } });
  doc = op(doc, ...planMoveKeys(doc, esquema, 'talk', { from: 1, to: 1.5, targets: ['box.x'] }).ops);
  assert.deepEqual(buscar(doc, 'talk').tracks.box.x.map((c) => c.t), [0, 1.5]);
  assert.deepEqual(buscar(doc, 'talk').tracks.box.rotation.map((c) => c.t), [0, 1]);
  assert.throws(() => planMoveKeys(doc, esquema, 'talk', { from: 1, to: 1.0004 }), /same time.*nothing to move/);
});

test('scale_time: el clip entero en proporción, un tramo con los de después corridos, factor y errores', async () => {
  const { planScaleTime } = await import('../mcp/animation.js');
  const pistas = { arm_bone: { rotation: [{ t: 0, value: 0 }, { t: 0.9, value: 40, ease: 'ease-out' }, { t: 1.8, value: 0 }] }, happiness: { value: [{ t: 0.6, value: 1 }] } };
  let doc = muñeco(pistas, { duration: 1.8 });
  // Entero: 1.8 → 1 s, un solo set (un paso de deshacer), con valor y curva.
  const plan = planScaleTime(doc, esquema, 'wave', { duration: 1 });
  assert.equal(plan.ops.length, 1);
  doc = op(doc, ...plan.ops);
  const clip = buscar(doc, 'wave');
  assert.equal(clip.duration, 1);
  assert.deepEqual(clip.tracks.arm_bone.rotation.map((c) => c.t), [0, 0.5, 1]);
  assert.equal(clip.tracks.arm_bone.rotation[1].ease, 'ease-out');
  cerca(clip.tracks.happiness.value[0].t, 1 / 3);
  // Un tramo: 0…0.5 pasa a durar 1 s; lo de después se corre 0.5 s y la duración también.
  doc = op(doc, ...planScaleTime(doc, esquema, 'wave', { from: 0, to: 0.5, duration: 1 }).ops);
  assert.deepEqual(buscar(doc, 'wave').tracks.arm_bone.rotation.map((c) => c.t), [0, 1, 1.5]);
  assert.equal(buscar(doc, 'wave').duration, 1.5);
  // factor 2: el doble de largo.
  doc = op(doc, ...planScaleTime(doc, esquema, 'wave', { factor: 2 }).ops);
  assert.equal(buscar(doc, 'wave').duration, 3);
  assert.throws(() => planScaleTime(doc, esquema, 'wave', {}), /duration.*or factor/);
  assert.throws(() => planScaleTime(doc, esquema, 'wave', { duration: 1, factor: 2 }), /one of the two/);
  assert.throws(() => planScaleTime(doc, esquema, 'wave', { from: 2, to: 1, duration: 1 }), /from < to/);
  assert.throws(() => planScaleTime(doc, esquema, 'wave', { duration: 0.0005 }), /same time/);
});

test('set_keys: pose con only o except, valores relativos al montaje y curvas fuertes con nombre', async () => {
  const { planSetKeys } = await import('../mcp/animation.js');
  const doc = muñeco();
  const pistas = (keys) => planSetKeys(doc, esquema, 'wave', { keys }).ops[0].props.tracks;
  // only copia solo eso de la pose; except, todo menos eso.
  let t = pistas([{ t: 0.5, pose: 'happy', only: ['face'] }]);
  assert.deepEqual(Object.keys(t), ['face']);
  t = pistas([{ t: 0.5, pose: 'happy', except: ['face.fill'] }]);
  assert.deepEqual(Object.keys(t), ['arm_bone']);
  assert.throws(() => pistas([{ t: 0, pose: 'happy', only: ['tail'] }]), /doesn't set "tail".*It sets: face\.fill, arm_bone\.rotation/);
  assert.throws(() => pistas([{ t: 0, pose: 'happy', only: ['face'], except: ['arm_bone'] }]), /not both/);
  assert.throws(() => pistas([{ t: 0, only: ['face'] }]), /pass pose too/);
  // Con setup, la pose filtrada dice qué vuelve al montaje.
  t = pistas([{ t: 0, setup: true, pose: 'happy', only: ['arm_bone'] }]);
  assert.deepEqual(Object.keys(t), ['arm_bone']);
  // Relativos: "+=n" y "-=n" sobre el valor del montaje; solo en números.
  const conBrazo = op(doc, { op: 'set', target: 'arm', props: { opacity: 0.8 } });
  t = planSetKeys(conBrazo, esquema, 'wave', { keys: [{ t: 0.2, values: { arm_bone: { rotation: '+=14' }, arm: { opacity: '-=0.3' } } }] }).ops[0].props.tracks;
  assert.equal(t.arm_bone.rotation[0].value, 14);
  cerca(t.arm.opacity[0].value, 0.5);
  assert.throws(() => pistas([{ t: 0, values: { face: { fill: '+=1' } } }]), /relative to the setup.*number properties/);
  // Curvas fuertes: con nombre, válidas y con la forma esperada.
  assert.equal(errorDeCurva('ease-in-expo'), null);
  assert.ok(aplicarCurva('ease-in-expo', 0.5) < 0.1, 'ease-in-expo casi no se mueve a la mitad');
  assert.ok(aplicarCurva('ease-out-back', 0.7) > 1, 'ease-out-back se pasa del valor');
  assert.ok(aplicarCurva('ease-in-back', 0.2) < 0, 'ease-in-back toma impulso hacia atrás');
  t = pistas([{ t: 0, values: { arm_bone: { rotation: 0 } }, ease: 'ease-in-out-cubic' }, { t: 1, values: { arm_bone: { rotation: 10 } } }]);
  assert.equal(t.arm_bone.rotation[0].ease, 'ease-in-out-cubic');
});

test('qué poses mueve cada param animado: set_keys y render_preview lo listan; una escena no', async () => {
  const { planVistaDeClip } = await import('../mcp/animation.js');
  const { lineasDePosesDeParams } = await import('../src/core/animation.js');
  let doc = muñeco({ happiness: { value: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } });
  doc = op(doc, { op: 'create', type: 'pose', id: 'look_up', props: { values: { arm_bone: { rotation: -5 } } } }, { op: 'create', type: 'driver', id: 'd_look', props: { param: 'happiness', pose: 'look_up' } });
  assert.deepEqual(lineasDePosesDeParams(doc, esquema, 'wave'), ['happiness → happy (face, arm_bone), look_up (arm_bone)']);
  const { texto } = planVistaDeClip(doc, esquema, { animation: 'wave', time: 0.5 });
  assert.match(texto, /poses que mueven[\s\S]*happiness → happy \(face, arm_bone\), look_up \(arm_bone\)/);
  doc = op(doc, { op: 'set', target: 'wave', props: { usage: 'animate', tracks: {} } });
  assert.deepEqual(lineasDePosesDeParams(doc, esquema, 'wave'), []);
});

test('cada curva con nombre tiene su descripción en la guía', async () => {
  const { DESCRIPCION_DE_CURVAS, NOMBRES_DE_CURVA } = await import('../src/core/curves.js');
  const descritas = DESCRIPCION_DE_CURVAS.flatMap(([nombres]) => nombres.split(', '));
  assert.deepEqual([...descritas].sort(), [...NOMBRES_DE_CURVA].sort());
});
