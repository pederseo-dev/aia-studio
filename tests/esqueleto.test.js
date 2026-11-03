import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../servidor/esquema.js';
import { buscar, crearDocumento } from '../src/core/documento.js';
import { deltaDe, evaluarEsqueleto, puntaDe } from '../src/core/esqueleto.js';
import { aplicar } from '../src/core/geometria.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';
import { svgDocumento } from '../src/render/svg.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema).doc;
const cerca = (p, q, eps = 0.01) => Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps;

// Un brazo: hombro en (100, 100) apuntando a la derecha, antebrazo encadenado en la punta.
function brazo() {
  return op(
    crearDocumento({ name: 'Brazo' }),
    { op: 'create', type: 'bone', id: 'upper', props: { x: 100, y: 100, length: 50 } },
    { op: 'create', type: 'bone', id: 'lower', parent: 'upper', props: { x: 50, length: 40 } },
    { op: 'create', type: 'rect', id: 'hand', props: { x: 190, y: 100, width: 10, height: 10, bone: 'lower' } },
    { op: 'create', type: 'pose', id: 'up', props: { bones: { upper: { rotation: -90 } } } },
  );
}

test('los huesos encadenan sus matrices y la pose no toca el montaje', () => {
  const doc = brazo();
  const montaje = evaluarEsqueleto(doc, esquema);
  assert.ok(cerca(puntaDe(esquema, buscar(doc, 'lower'), montaje.reposo.get('lower')), [190, 100]));
  const pose = evaluarEsqueleto(doc, esquema, buscar(doc, 'up'));
  // Girar el hombro -90° (hacia arriba) lleva la punta del antebrazo a (100, 10).
  assert.ok(cerca(puntaDe(esquema, buscar(doc, 'lower'), pose.posado.get('lower')), [100, 10]));
  assert.ok(cerca(puntaDe(esquema, buscar(doc, 'lower'), pose.reposo.get('lower')), [190, 100]));
  assert.equal(buscar(doc, 'upper').rotation, undefined);
});

test('lo enlazado sigue al hueso solo en la pose, y en el SVG queda donde corresponde', () => {
  const doc = brazo();
  const pose = evaluarEsqueleto(doc, esquema, buscar(doc, 'up'));
  assert.ok(cerca(aplicar(deltaDe(doc, pose, 'hand'), 190, 100), [100, 10]));
  assert.ok(cerca(aplicar(deltaDe(doc, evaluarEsqueleto(doc, esquema), 'hand'), 190, 100), [190, 100]));
  assert.match(svgDocumento(doc, esquema), /data-id="hand" transform="translate\(190 100\)"/);
  const m = svgDocumento(doc, esquema, { pose: 'up' }).match(/data-id="hand" transform="matrix\(([^)]+)\)"/);
  const [, , , , e, f] = m[1].split(' ').map(Number);
  assert.ok(cerca([e, f], [100, 10]));
});

test('ángulo independiente y límites', () => {
  let doc = op(brazo(), { op: 'set', target: 'lower', props: { independentAngle: true } });
  const pose = evaluarEsqueleto(doc, esquema, buscar(doc, 'up'));
  // El antebrazo se mueve con el hombro pero sigue apuntando a la derecha.
  assert.ok(cerca(puntaDe(esquema, buscar(doc, 'lower'), pose.posado.get('lower')), [140, 50]));
  doc = op(doc, { op: 'set', target: 'upper', props: { minAngle: -45 } });
  const limitada = evaluarEsqueleto(doc, esquema, buscar(doc, 'up'));
  const [a, b] = limitada.posado.get('upper');
  assert.ok(Math.abs((Math.atan2(b, a) * 180) / Math.PI + 45) < 0.01);
});

test('los huesos solo tienen huesos como hijos', () => {
  assert.throws(() => op(brazo(), { op: 'create', type: 'rect', id: 'x', parent: 'upper' }), /propiedad bone/);
  assert.throws(() => op(brazo(), { op: 'create', type: 'group', id: 'g' }, { op: 'create', type: 'bone', id: 'b', parent: 'g' }), /solo puede estar en la raíz o dentro de bone/);
  assert.throws(() => op(brazo(), { op: 'set', target: 'up', props: { bones: { uper: { rotation: 1 } } } }), /¿Quisiste decir "upper"\?/);
  assert.throws(() => op(brazo(), { op: 'set', target: 'up', props: { bones: { upper: { angle: 1 } } } }), /solo van/);
});

test('renombrar y borrar un hueso actualiza enlaces y poses, y deshacer los recupera', () => {
  let doc = op(brazo(), { op: 'rename', target: 'upper', id: 'arm' });
  assert.deepEqual(buscar(doc, 'up').bones, { arm: { rotation: -90 } });
  const { doc: sin, inversas } = aplicarOperaciones(doc, [{ op: 'delete', target: 'arm' }], esquema);
  assert.equal(buscar(sin, 'hand').bone, undefined);
  assert.deepEqual(buscar(sin, 'up').bones, {});
  doc = aplicarOperaciones(sin, inversas, esquema).doc;
  assert.equal(buscar(doc, 'hand').bone, 'lower');
  assert.deepEqual(buscar(doc, 'up').bones, { arm: { rotation: -90 } });
});

test('la vista previa puede dibujar el esqueleto encima, posado', () => {
  const doc = brazo();
  assert.doesNotMatch(svgDocumento(doc, esquema), /data-huesos/);
  const svg = svgDocumento(doc, esquema, { huesos: true, pose: 'up' });
  assert.match(svg, /<g data-huesos="">/);
  assert.match(svg, />lower<\/text>/);
});
