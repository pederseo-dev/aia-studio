import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../servidor/esquema.js';
import { buscar, crearDocumento, validar } from '../src/core/documento.js';
import { evaluarEnPose, puntaDe } from '../src/core/esqueleto.js';
import { guiaParaIA } from '../src/core/guia.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';
import { fusionarPose, opsParaFijarPose as opsDeSetPose } from '../src/core/mezcla.js';
import { comprobarBorrado, esquemaDelArbol, planBindByProximity, planBindPoints, planReparentBone, recortesDePose } from '../mcp/herramientas.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema).doc;

test('cada bloque JSON de la guía se aplica sin errores', () => {
  const bloques = [...guiaParaIA(esquema).matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(bloques.length >= 4);
  // Lo que los ejemplos dan por hecho que ya existe en el personaje.
  const base = op(
    crearDocumento({}),
    { op: 'create', type: 'group', id: 'body' },
    { op: 'create', type: 'group', id: 'head' },
    { op: 'create', type: 'group', id: 'arm_l' },
    { op: 'create', type: 'path', id: 'mouth_line', props: { d: 'M-20 0 L20 0', closed: false } },
    { op: 'create', type: 'rect', id: 'brow_l' },
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_o', parent: 'mouth' },
  );
  for (const [i, bloque] of bloques.entries()) {
    if (bloque.format) {
      // El ejemplo de documento completo.
      assert.deepEqual(validar(bloque, esquema).errores, [], `bloque ${i}`);
      continue;
    }
    const ops = Array.isArray(bloque) ? bloque : [bloque];
    assert.doesNotThrow(() => op(base, ...ops), `bloque ${i}`);
  }
});

test('set_pose suma a lo que había, saca objetos con {} y un d reemplaza los vértices', () => {
  const previos = { head_bone: { rotation: 10 }, mouth: { active: 'a' }, smile: { vertices: [{ x: 0, y: 0 }], opacity: 0.5 } };
  assert.deepEqual(fusionarPose(previos, { head_bone: { x: 5 }, mouth: {}, smile: { d: 'M0 0 L1 1' } }), {
    head_bone: { rotation: 10, x: 5 },
    smile: { opacity: 0.5, d: 'M0 0 L1 1' },
  });
  assert.deepEqual(fusionarPose(previos, { head_bone: { x: 5 } }, true), { head_bone: { x: 5 } });
  // El lote: create si no existe, set si existe; y no pisa un objeto que no es pose.
  const doc = op(crearDocumento({}), { op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'path', id: 'smile', props: { d: 'M0 0 L10 0' } });
  assert.equal(opsDeSetPose(doc, 'happy', { r: { x: 1 } })[0].op, 'create');
  assert.throws(() => opsDeSetPose(doc, 'r', {}), /already exists and is a rect/);
  const conPose = op(doc, ...opsDeSetPose(doc, 'happy', { smile: { d: 'M0 5 L10 5' } }));
  assert.deepEqual(buscar(conPose, 'happy').values.smile.vertices.map((v) => v.y), [5, 5]);
});

test('set_pose avisa lo que recortan minAngle y maxAngle', () => {
  const doc = op(crearDocumento({}), { op: 'create', type: 'skeleton', id: 'rig' }, { op: 'create', type: 'bone', id: 'b', parent: 'rig', props: { minAngle: -20, maxAngle: 20 } });
  assert.deepEqual(recortesDePose(doc, esquema, { b: { rotation: 45 } }), ['b.rotation 45 queda en 20 por minAngle/maxAngle']);
  assert.deepEqual(recortesDePose(doc, esquema, { b: { rotation: 10 } }), []);
});

function rig() {
  return op(
    crearDocumento({}),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'a', parent: 'rig', props: { from: [0, 0], to: [100, 0] } },
    { op: 'create', type: 'bone', id: 'b', parent: 'a', props: { from: [100, 0], to: [200, 0] } },
    { op: 'create', type: 'rect', id: 'near_a', parent: 'rig', props: { x: 40, y: 5, width: 10, height: 10 } },
    { op: 'create', type: 'rect', id: 'near_b', parent: 'rig', props: { x: 160, y: 5, width: 10, height: 10 } },
    { op: 'create', type: 'path', id: 'tail', parent: 'rig', props: { d: 'M0 0 L90 0 L190 0', closed: false } },
  );
}

test('bind_points y bind_by_proximity reparten por cercanía', () => {
  const doc = rig();
  const puntos = planBindPoints(doc, esquema, 'tail');
  assert.equal(puntos.reparto, 'a [0, 1]; b [2]');
  assert.throws(() => planBindPoints(doc, esquema, 'near_a'), /no es un path/);
  assert.equal(planBindByProximity(doc, esquema, 'rig').reparto, 'a ← near_a, tail; b ← near_b');
  // Un path enlazado por punto no se toca; después de enlazar, no queda nada.
  const porPunto = op(doc, ...puntos.ops);
  const cerca = planBindByProximity(porPunto, esquema, 'rig');
  assert.equal(cerca.reparto, 'a ← near_a; b ← near_b');
  const enlazado = op(porPunto, ...cerca.ops);
  assert.equal(planBindByProximity(enlazado, esquema, 'rig').ops.length, 0);
});

test('reparent_bone avisa en qué poses el hueso cambia de lugar y, si se pide, las compensa', () => {
  const doc = op(rig(), { op: 'create', type: 'pose', id: 'up', props: { values: { a: { rotation: -90 } } } }, { op: 'create', type: 'pose', id: 'bend', props: { values: { b: { rotation: 30 } } } });
  const punta = (d, pose) => puntaDe(esquema, buscar(d, 'b'), evaluarEnPose(d, esquema, buscar(d, pose)).posado.get('b')).map(Math.round);
  assert.deepEqual(punta(doc, 'up'), [0, -200]);
  // Sin compensar: en "up" (que gira al padre viejo) el hueso queda en otro lugar, y la respuesta lo dice.
  const aviso = planReparentBone(doc, esquema, 'b', 'rig');
  assert.deepEqual(aviso.movidas, ['up']);
  assert.match(aviso.texto, /en las poses up ahora queda en otro lugar/);
  assert.deepEqual(punta(op(doc, ...aviso.ops), 'bend'), punta(doc, 'bend'));
  // Compensando: queda donde estaba en todas las poses.
  const quieto = planReparentBone(doc, esquema, 'b', 'rig', true);
  assert.deepEqual(quieto.movidas, []);
  const despues = op(doc, ...quieto.ops);
  assert.deepEqual(punta(despues, 'up'), [0, -200]);
  assert.deepEqual(punta(despues, 'bend'), punta(doc, 'bend'));
  assert.equal(planReparentBone(doc, esquema, 'b', 'a').ops.length, 0);
});


test('el switch se maneja igual en el editor y en el MCP: set active, sin herramienta aparte', () => {
  const guia = guiaParaIA(esquema);
  assert.doesNotMatch(guia, /create_switch_control|Create control/);
  assert.match(guia, /`set` con `\{ "active": "<hijo>" \}`/);
  // Lo que hace el selector del editor (elegirVariante) es este mismo set.
  const doc = op(
    crearDocumento({}),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_a', parent: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_o', parent: 'mouth' },
    { op: 'set', target: 'mouth', props: { active: 'mouth_o' } },
  );
  assert.equal(buscar(doc, 'mouth').active, 'mouth_o');
});

test('set_pose con remove saca una sola propiedad, y así la variante puede salir del switch', () => {
  const doc = op(
    crearDocumento({}),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_a', parent: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_o', parent: 'mouth' },
    { op: 'create', type: 'pose', id: 'turn', props: { values: { mouth: { x: 12, active: 'mouth_o' } } } },
  );
  assert.throws(() => op(doc, { op: 'move', target: 'mouth_o', parent: null }), /remove: \["mouth\.active"\]/);
  // {} sacaría también la x; remove saca solo active.
  assert.deepEqual(fusionarPose(buscar(doc, 'turn').values, { mouth: {} }), {});
  const sinActive = op(doc, ...opsDeSetPose(doc, 'turn', {}, false, ['mouth.active']));
  assert.deepEqual(buscar(sinActive, 'turn').values, { mouth: { x: 12 } });
  assert.doesNotThrow(() => op(sinActive, { op: 'move', target: 'mouth_o', parent: null }));
  // Un id solo saca el objeto entero; un nombre mal formado avisa.
  assert.deepEqual(fusionarPose({ a: { x: 1 }, b: { y: 2 } }, {}, false, ['a']), { b: { y: 2 } });
  assert.throws(() => fusionarPose({}, {}, false, ['a.b.c']), /should be "object\.property"/);
});

test('delete_document pide repetir el id en confirm', () => {
  assert.doesNotThrow(() => comprobarBorrado('prueba_x', 'prueba_x'));
  assert.throws(() => comprobarBorrado('prueba_x', 'otro'), /confirm has to be "prueba_x"/);
  assert.throws(() => comprobarBorrado('prueba_x', undefined), /can't be undone/);
});

test('el árbol dice qué params eligen la variante de un switch', () => {
  const doc = op(
    crearDocumento({}),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_a', parent: 'mouth' },
    { op: 'create', type: 'rect', id: 'mouth_o', parent: 'mouth' },
    { op: 'create', type: 'param', id: 'viseme', props: { kind: 'enum', options: ['a', 'o'] } },
    { op: 'create', type: 'pose', id: 'viseme_o', props: { values: { mouth: { active: 'mouth_o' } } } },
    { op: 'create', type: 'driver', id: 'viseme_o_driver', props: { param: 'viseme', pose: 'viseme_o', equals: 'o' } },
    { op: 'create', type: 'switch', id: 'eyes' },
  );
  const arbol = esquemaDelArbol(doc, esquema);
  assert.match(arbol, /- mouth \(switch\) \(muestra el primero; lo elige el param viseme\)/);
  assert.match(arbol, /- eyes \(switch\) \(muestra el primero\)/);
});

test('lecturas del MCP sin el servidor: get_document, get_history y render_preview', async () => {
  const { planVistaPrevia, resumenDeHistorial, textoDeDocumento } = await import('../mcp/herramientas.js');
  const doc = op(
    crearDocumento({}),
    { op: 'create', type: 'rect', id: 'r', props: { x: 1 } },
    { op: 'create', type: 'pose', id: 'up', props: { values: { r: { y: 5 } } } },
    { op: 'create', type: 'param', id: 'p' },
    { op: 'create', type: 'driver', id: 'd', props: { param: 'p', pose: 'up' } },
  );
  // get_document: árbol y JSON; sin JSON si se pide.
  assert.match(textoDeDocumento(doc, esquema), /^Árbol \(del fondo al frente\):[\s\S]*JSON:\n\{/);
  assert.doesNotMatch(textoDeDocumento(doc, esquema, { json: false }), /JSON:/);
  // get_history: filtra por origen, corta y resume lo que tocó cada lote.
  const entradas = [
    { n: 1, origen: 'ai', nota: 'a', ops: [{ op: 'set', target: 'r', props: { x: 2, vertices: [1, 2, 3] } }], inversas: [] },
    { n: 2, origen: 'user', nota: 'b', ops: [{ op: 'set', target: 'r', props: { y: 3 } }], inversas: [] },
  ];
  const resumen = resumenDeHistorial(entradas, { origin: 'ai' });
  assert.equal(resumen.length, 1);
  assert.deepEqual(resumen[0].valores, { 'r.x': 2, 'r.vertices': '(3 elementos)' });
  assert.equal(resumen[0].inversas, undefined);
  assert.deepEqual(resumenDeHistorial(entradas, { limit: 1, detail: true })[0].ops, entradas[1].ops);
  // render_preview: el montaje, una pose, params con sus pesos, y errores claros.
  assert.match(planVistaPrevia(doc, esquema).texto, /en el montaje/);
  assert.match(planVistaPrevia(doc, esquema, { pose: 'up' }).texto, /en la pose "up"/);
  assert.match(planVistaPrevia(doc, esquema, { params: { p: 1 } }).texto, /poses: up 100%/);
  assert.equal(planVistaPrevia(doc, esquema).ancho, 600);
  assert.throws(() => planVistaPrevia(doc, esquema, { pose: 'nada' }), /no existe la pose "nada"/);
  assert.throws(() => planVistaPrevia(doc, esquema, { params: { q: 1 } }), /no existe el param "q"/);
});
