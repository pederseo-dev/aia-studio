import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../servidor/esquema.js';
import { buscar, crearDocumento, validar } from '../src/core/documento.js';
import { evaluarClip, poseDeClip, tiempoLocal, tiemposDeClaves, valorDePista } from '../src/core/animacion.js';
import { aplicarCurva, errorDeCurva } from '../src/core/curvas.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';
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
    { op: 'create', type: 'animation', id: 'wave', props: { duration: 1, ...clip, tracks: pistas } },
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
  assert.match(errores({ mouth: { active: [{ t: 0, value: 'face' }] } }), /no es hijo de mouth/);
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
  const { planSetKeys, planDeleteKeys, resumenDeClip, tiemposParaTira } = await import('../mcp/animacion.js');
  const { esquemaDelArbol } = await import('../mcp/herramientas.js');
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
  assert.match(resumenDeClip(esquema, buscar(doc, 'wave')), /^puppet, 1.5 s, once; anima arm_bone.rotation, happiness.value, face.fill; keys en 0, 0.5, 1.5$/);
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
  const { svgAPng } = await import('../servidor/png.js');
  const doc = muñeco({ arm_bone: { rotation: [{ t: 0, value: 0 }, { t: 1, value: -90 }] } });
  const svg = svgTira(doc, esquema, { animation: 'wave', times: [0, 0.5, 1], huesos: true });
  assert.equal((svg.match(/t = /g) ?? []).length, 3);
  assert.match(svg, /t = 0.5 s/);
  const png = svgAPng(svg, 600);
  assert.ok(png.length > 1000);
});

test('ponerClave y quitarClave: reemplazan en el mismo t, conservan la curva y no tocan las pistas recibidas', async () => {
  const { ponerClave, quitarClave } = await import('../src/core/animacion.js');
  const pistas = { a: { x: [{ t: 0, value: 1 }, { t: 0.5, value: 2, ease: 'step' }] } };
  const otras = ponerClave(pistas, 'a', 'x', 0.5, 9);
  assert.deepEqual(otras.a.x[1], { t: 0.5, value: 9, ease: 'step' });
  assert.equal(pistas.a.x[1].value, 2);
  assert.deepEqual(ponerClave(pistas, 'a', 'x', 0.25, 5, 'linear').a.x.map((c) => c.t), [0, 0.25, 0.5]);
  assert.deepEqual(ponerClave({}, 'p', 'vertices', 0, [{ x: 0, y: 0, bone: 'b' }]).p.vertices[0].value, [{ x: 0, y: 0 }]);
  assert.deepEqual(quitarClave(quitarClave(pistas, 'a', 'x', 0), 'a', 'x', 0.5), {});
});
