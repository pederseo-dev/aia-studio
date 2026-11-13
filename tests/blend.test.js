import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../server/schema.js';
import { buscar, crearDocumento } from '../src/core/document.js';
import { mezclarPoses, pesoDeDriver, valoresDeParams } from '../src/core/blend.js';
import { aplicarOperaciones } from '../src/core/operations.js';
import { svgDocumento } from '../src/render/svg.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema).doc;

// Una cara: boca como switch (rest / o) y como path con la misma cantidad de puntos (para el morph), cabeza que gira.
function cara() {
  return op(
    crearDocumento({ name: 'Cara' }),
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

test('valores iniciales de los params y peso de los drivers', () => {
  const doc = cara();
  assert.deepEqual(valoresDeParams(doc, esquema), { happiness: 0, head_turn: 0, viseme: 'rest' });
  assert.deepEqual(valoresDeParams(doc, esquema, { head_turn: 5, viseme: 'x' }).head_turn, 1);
  assert.equal(pesoDeDriver(doc, esquema, buscar(doc, 'd_happy'), 0.25), 0.25);
  assert.equal(pesoDeDriver(doc, esquema, buscar(doc, 'd_turn'), -1), 0);
  assert.equal(pesoDeDriver(doc, esquema, buscar(doc, 'd_o'), 'o'), 1);
});

test('la mezcla suma números, interpola vértices y elige el switch', () => {
  const doc = cara();
  const mitad = mezclarPoses(doc, esquema, { happiness: 0.5, head_turn: 1, viseme: 'o' }).values;
  assert.equal(mitad.head.opacity, 0.75);
  assert.deepEqual(mitad.smile.vertices.map((v) => [v.x, v.y]), [[-20, -5], [0, 5], [20, -5]]);
  assert.equal(mitad.head_bone.rotation, 20);
  assert.equal(mitad.mouth.active, 'mouth_o');
  // En el SVG: el switch muestra solo la boca "o", y la cabeza gira con su hueso.
  const svg = svgDocumento(doc, esquema, { params: { happiness: 0.5, head_turn: 1, viseme: 'o' } });
  assert.match(svg, /data-id="mouth_o"/);
  assert.doesNotMatch(svg, /data-id="mouth_rest"/);
  assert.match(svg, /data-id="head" transform="matrix\(/);
  // Sin params, el montaje: la primera boca.
  assert.match(svgDocumento(doc, esquema), /data-id="mouth_rest"/);
});

test('una pose solo acepta propiedades animables que existan', () => {
  assert.throws(() => op(cara(), { op: 'set', target: 'happy', props: { values: { smile: { width: 3 } } } }), /no tiene "width" animable/);
  assert.throws(() => op(cara(), { op: 'set', target: 'happy', props: { values: { mouth: { active: 'smile' } } } }), /is not a child of mouth/);
  assert.throws(() => op(cara(), { op: 'set', target: 'mouth', props: { active: 'nada' } }), /no existe/);
});

test('renombrar y borrar actualizan las poses, también los ids que son valores', () => {
  let doc = op(cara(), { op: 'rename', target: 'mouth_o', id: 'mouth_open' });
  assert.deepEqual(buscar(doc, 'viseme_o').values, { mouth: { active: 'mouth_open' } });
  doc = op(doc, { op: 'delete', target: 'mouth_open' });
  assert.deepEqual(buscar(doc, 'viseme_o').values, {});
  doc = op(doc, { op: 'delete', target: 'happiness' });
  assert.equal(buscar(doc, 'd_happy').param, undefined);
});

// Una cola: un path de 3 puntos enlazados por punto a b1, b1 y b2, y una pose que dobla b2 y cambia la forma.
function cola() {
  let doc = op(
    crearDocumento({}),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'b1', parent: 'rig', props: { x: 0, y: 100, length: 100 } },
    { op: 'create', type: 'bone', id: 'b2', parent: 'b1', props: { x: 100, length: 100 } },
    { op: 'create', type: 'path', id: 'tail', parent: 'rig', props: { d: 'M0 100 L100 100 L200 100', closed: false } },
  );
  const vertices = buscar(doc, 'tail').vertices.map((v, i) => ({ ...v, bone: i < 2 ? 'b1' : 'b2' }));
  return op(doc, { op: 'set', target: 'tail', props: { vertices } }, { op: 'create', type: 'pose', id: 'bend', props: { values: { b2: { rotation: 90 }, tail: { d: 'M0 100 L100 110 L200 100' } } } });
}

test('una pose que cambia la forma conserva el enlace por punto del montaje', () => {
  const doc = cola();
  // La pose no guarda bone en sus vértices.
  assert.ok(buscar(doc, 'bend').values.tail.vertices.every((v) => v.bone === undefined));
  // El tercer punto sigue a b2, que gira 90° en (100, 100): (200, 100) → (100, 200).
  assert.match(svgDocumento(doc, esquema, { pose: 'bend' }), /data-id="tail"><path d="M0 100L100 110L100 200"/);
  // También en la mezcla, a mitad de camino.
  const conParam = op(doc, { op: 'create', type: 'param', id: 'p' }, { op: 'create', type: 'driver', id: 'd', props: { param: 'p', pose: 'bend' } });
  assert.match(svgDocumento(conParam, esquema, { params: { p: 1 } }), /data-id="tail"><path d="M0 100L100 110L100 200"/);
});

test('el bone que una pose vieja guardó en sus vértices se ignora', () => {
  const doc = cola();
  // Simula un documento de antes: la pose guarda un bone viejo (o que ya no existe) en cada vértice.
  const viejo = structuredClone(doc);
  buscar(viejo, 'bend').values.tail.vertices = buscar(viejo, 'bend').values.tail.vertices.map((v) => ({ ...v, bone: 'nope' }));
  assert.match(svgDocumento(viejo, esquema, { pose: 'bend' }), /data-id="tail"><path d="M0 100L100 110L100 200"/);
  // Al guardarla de nuevo, se limpia.
  const limpio = op(viejo, { op: 'set', target: 'bend', props: { values: buscar(viejo, 'bend').values } });
  assert.ok(buscar(limpio, 'bend').values.tail.vertices.every((v) => v.bone === undefined));
});

test('la mezcla parte del valor que se ve, con el estilo', () => {
  const doc = op(
    crearDocumento({}),
    { op: 'create', type: 'style', id: 'skin', props: { fill: '#ff0000', strokeWidth: 10, stroke: '#000000' } },
    { op: 'create', type: 'rect', id: 'face', props: { style: 'skin', width: 10, height: 10 } },
    { op: 'create', type: 'pose', id: 'pale', props: { values: { face: { fill: '#ff0000', strokeWidth: 10 } } } },
    { op: 'create', type: 'param', id: 'p' },
    { op: 'create', type: 'driver', id: 'd', props: { param: 'p', pose: 'pale' } },
  );
  assert.deepEqual(mezclarPoses(doc, esquema, { p: 0.5 }).values, { face: { fill: '#ff0000', strokeWidth: 10 } });
});

test('escribir en una pose: el mismo lote para el editor y para set_pose', async () => {
  const { fusionarPose, opsParaFijarPose } = await import('../src/core/blend.js');
  const previos = { a: { x: 1, y: 2 }, b: { rotation: 5 } };
  // Lo que manda el editor: un objeto y sus campos; undefined saca la propiedad y, si no queda nada, el objeto.
  assert.deepEqual(fusionarPose(previos, { a: { x: 3 } }), { a: { x: 3, y: 2 }, b: { rotation: 5 } });
  assert.deepEqual(fusionarPose(previos, { a: { y: undefined } }), { a: { x: 1 }, b: { rotation: 5 } });
  assert.deepEqual(fusionarPose(previos, { b: { rotation: undefined } }), { a: { x: 1, y: 2 } });
  assert.deepEqual(fusionarPose(previos, { c: { opacity: undefined } }), previos);
  // No toca lo que recibe.
  assert.deepEqual(previos, { a: { x: 1, y: 2 }, b: { rotation: 5 } });
  const doc = op(crearDocumento({}), ...['a', 'b', 'r'].map((id) => ({ op: 'create', type: 'rect', id })), { op: 'create', type: 'pose', id: 'p', props: { values: previos } });
  assert.deepEqual(opsParaFijarPose(doc, 'p', { r: { x: 4 } }), [{ op: 'set', target: 'p', props: { values: { ...previos, r: { x: 4 } } } }]);
});

test('autokey: opsParaClavesEnClip pone y quita keyframes en el tiempo pedido', async () => {
  const { opsParaClavesEnClip } = await import('../src/core/animation.js');
  let doc = op(crearDocumento({}), { op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'animation', id: 'c', props: { duration: 2 } });
  doc = op(doc, ...opsParaClavesEnClip(doc, esquema, 'c', 'r', { x: 10, opacity: 0.5 }, 1));
  assert.deepEqual(buscar(doc, 'c').tracks.r.x.map((k) => [k.t, k.value]), [[1, 10]]);
  assert.deepEqual(buscar(doc, 'c').tracks.r.opacity.map((k) => [k.t, k.value]), [[1, 0.5]]);
  doc = op(doc, ...opsParaClavesEnClip(doc, esquema, 'c', 'r', { x: undefined }, 1));
  assert.equal(buscar(doc, 'c').tracks.r.x, undefined);
  assert.ok(buscar(doc, 'c').tracks.r.opacity);
});
