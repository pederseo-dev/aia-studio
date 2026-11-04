import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../servidor/esquema.js';
import { buscar, crearDocumento, esqueletoDe, validar } from '../src/core/documento.js';
import { deltaDe, enlacesPorCercania, evaluarEsqueleto, puntaDe, repartirEntreHuesos, soltarEnlacesAjenos } from '../src/core/esqueleto.js';
import { aplicar, multiplicar } from '../src/core/geometria.js';
import { migrarAEsqueletos } from '../src/core/migracion.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';
import { svgDocumento } from '../src/render/svg.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema).doc;
const cerca = (p, q, eps = 0.01) => Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps;
const matrizDe = (svg, id) => svg.match(new RegExp(`data-id="${id}" transform="matrix\\(([^)]+)\\)"`))[1].split(' ').map(Number);

// Un brazo: un skeleton sin transformación con el hombro en (100, 100) apuntando a la derecha, el antebrazo
// encadenado en la punta y la mano enlazada al antebrazo.
function brazo() {
  return op(
    crearDocumento({ name: 'Brazo' }),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'upper', parent: 'rig', props: { x: 100, y: 100, length: 50 } },
    { op: 'create', type: 'bone', id: 'lower', parent: 'upper', props: { x: 50, length: 40 } },
    { op: 'create', type: 'rect', id: 'hand', parent: 'rig', props: { x: 190, y: 100, width: 10, height: 10, bone: 'lower' } },
    { op: 'create', type: 'pose', id: 'up', props: { values: { upper: { rotation: -90 } } } },
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
  const [, , , , e, f] = matrizDe(svgDocumento(doc, esquema, { pose: 'up' }), 'hand');
  assert.ok(cerca([e, f], [100, 10]));
  // Los huesos son hijos del skeleton pero no se dibujan.
  assert.doesNotMatch(svgDocumento(doc, esquema), /data-id="upper"/);
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

test('pertenencia: los huesos van dentro de un skeleton, y solo tienen huesos como hijos', () => {
  assert.throws(() => op(crearDocumento(), { op: 'create', type: 'bone', id: 'b' }), /no puede estar en la raíz: va dentro de skeleton o bone\. Crea primero un skeleton/);
  assert.throws(() => op(brazo(), { op: 'create', type: 'bone', id: 'b' }), /Esqueletos del documento: rig/);
  assert.throws(() => op(brazo(), { op: 'create', type: 'group', id: 'g' }, { op: 'create', type: 'bone', id: 'b', parent: 'g' }), /solo puede estar dentro de skeleton o bone \(su padre "g" es un group\)/);
  assert.throws(() => op(brazo(), { op: 'create', type: 'rect', id: 'x', parent: 'upper' }), /el dibujo va dentro del skeleton \(rig\)/);
  assert.throws(() => op(brazo(), { op: 'move', target: 'upper', parent: null }), /no puede estar en la raíz/);
  assert.equal(esqueletoDe(brazo(), 'lower'), 'rig');
  assert.equal(esqueletoDe(brazo(), 'rig'), null);
  assert.throws(() => op(brazo(), { op: 'set', target: 'up', props: { values: { uper: { rotation: 1 } } } }), /¿Quisiste decir "upper"\?/);
  assert.throws(() => op(brazo(), { op: 'set', target: 'up', props: { values: { upper: { angle: 1 } } } }), /no tiene "angle" animable/);
});

test('enlace limitado a su skeleton, por capa y por punto, con mensajes que orientan', () => {
  const doc = op(brazo(), { op: 'create', type: 'skeleton', id: 'otro' }, { op: 'create', type: 'bone', id: 'tail_bone', parent: 'otro' }, { op: 'create', type: 'ellipse', id: 'suelta' });
  // Fuera de todo skeleton.
  assert.throws(() => op(doc, { op: 'set', target: 'suelta', props: { bone: 'upper' } }), /suelta\.bone: "upper" es un hueso del skeleton "rig" y suelta no está dentro de ningún skeleton.*mételo dentro de "rig"/);
  // En otro skeleton: lista los huesos que sí sirven, con sugerencia.
  assert.throws(() => op(doc, { op: 'set', target: 'hand', props: { bone: 'tail_bone' } }), /hand está en el skeleton "rig" y solo puede enlazarse a sus huesos: upper, lower/);
  assert.throws(() => op(doc, { op: 'set', target: 'hand', props: { bone: 'lowr' } }), /no existe el hueso "lowr"\. ¿Quisiste decir "lower"\?/);
  // Un skeleton no se enlaza a sus propios huesos.
  assert.throws(() => op(doc, { op: 'set', target: 'rig', props: { bone: 'upper' } }), /rig no está dentro de ningún skeleton/);
  // Por punto, igual.
  assert.throws(() => op(doc, { op: 'create', type: 'path', id: 'p', parent: 'otro', props: { vertices: [{ x: 0, y: 0, bone: 'upper' }, { x: 1, y: 1 }] } }), /p\.vertices\[0\]\.bone: "upper" es un hueso del skeleton "rig", pero p está en el skeleton "otro"/);
  // Sacar un dibujo del skeleton deja un enlace ajeno: el editor lo suelta con soltarEnlacesAjenos.
  const fuera = structuredClone(doc);
  buscar(fuera, 'hand').parent = null;
  assert.ok(validar(fuera, esquema).errores.some((e) => /hand\.bone/.test(e)));
  assert.deepEqual(soltarEnlacesAjenos(fuera, esquema), [{ op: 'unset', target: 'hand', props: ['bone'] }]);
});

test('un skeleton transformado lleva sus huesos: from/to en el documento y poses en su marco', () => {
  // El skeleton está en (300, 200) y girado 90°: su eje x apunta hacia abajo en pantalla.
  let doc = op(
    crearDocumento(),
    { op: 'create', type: 'skeleton', id: 'rig', props: { x: 300, y: 200, rotation: 90 } },
    { op: 'create', type: 'bone', id: 'b', parent: 'rig', props: { from: [300, 200], to: [300, 260] } },
    { op: 'create', type: 'bone', id: 'c', parent: 'b', props: { from: [300, 260], to: [340, 260] } },
    { op: 'create', type: 'rect', id: 'r', parent: 'rig', props: { x: 60, y: -40, width: 4, height: 4, bone: 'c' } },
    { op: 'create', type: 'pose', id: 'p', props: { values: { b: { rotation: 90 } } } },
  );
  // Relativo al skeleton: b nace en su origen y apunta por su eje x (0°); c gira -90° respecto de b.
  assert.deepEqual([buscar(doc, 'b').x, buscar(doc, 'b').y, buscar(doc, 'b').rotation, buscar(doc, 'b').length], [0, 0, 0, 60]);
  assert.deepEqual([buscar(doc, 'c').x, buscar(doc, 'c').rotation, buscar(doc, 'c').length], [60, -90, 40]);
  const ev = evaluarEsqueleto(doc, esquema, buscar(doc, 'p'));
  assert.ok(cerca(puntaDe(esquema, buscar(doc, 'c'), ev.reposo.get('c')), [340, 260]));
  // La pose gira b 90° más (en pantalla apunta a la izquierda) y c, a -90° de b, cuelga: su punta queda en (240, 240).
  assert.ok(cerca(puntaDe(esquema, buscar(doc, 'c'), ev.posado.get('c')), [240, 240]));
  // r está en la punta de c en el montaje: (x 60, y -40) del skeleton = (340, 260) en pantalla, y la sigue.
  const [, , , , e, f] = matrizDe(svgDocumento(doc, esquema, { pose: 'p' }), 'r');
  assert.ok(cerca(aplicar([0, 1, -1, 0, 300, 200], e, f), [240, 240]));
  // Mover el skeleton mueve el esqueleto y el dibujo juntos, sin tocar los huesos.
  doc = op(doc, { op: 'set', target: 'rig', props: { x: 400 } });
  assert.ok(cerca(puntaDe(esquema, buscar(doc, 'c'), evaluarEsqueleto(doc, esquema).reposo.get('c')), [440, 260]));
  assert.deepEqual([buscar(doc, 'b').x, buscar(doc, 'b').rotation], [0, 0]);
});

test('un skeleton anidado sigue al hueso del de afuera', () => {
  const doc = op(
    brazo(),
    { op: 'create', type: 'skeleton', id: 'mano', parent: 'rig', props: { bone: 'lower' } },
    { op: 'create', type: 'bone', id: 'finger', parent: 'mano', props: { from: [190, 100], to: [200, 100] } },
    { op: 'create', type: 'rect', id: 'nail', parent: 'mano', props: { x: 200, y: 100, bone: 'finger' } },
  );
  const ev = evaluarEsqueleto(doc, esquema, buscar(doc, 'up'));
  // El hombro gira -90°: el dedo, en la punta del antebrazo, sube con él a (100, 10) → (100, 0).
  assert.ok(cerca(puntaDe(esquema, buscar(doc, 'finger'), ev.posado.get('finger')), [100, 0]));
  // En el SVG, la uña (dentro de mano) termina en la punta del dedo.
  const svg = svgDocumento(doc, esquema, { pose: 'up' });
  assert.ok(cerca(aplicar(multiplicar(matrizDe(svg, 'mano'), matrizDe(svg, 'nail')), 0, 0), [100, 0]));
  assert.throws(() => op(doc, { op: 'set', target: 'nail', props: { bone: 'lower' } }), /nail está en el skeleton "mano"/);
});

test('renombrar y borrar un hueso actualiza enlaces y poses, y deshacer los recupera', () => {
  let doc = op(brazo(), { op: 'rename', target: 'upper', id: 'arm' });
  assert.deepEqual(buscar(doc, 'up').values, { arm: { rotation: -90 } });
  const { doc: sin, inversas } = aplicarOperaciones(doc, [{ op: 'delete', target: 'arm' }], esquema);
  assert.equal(buscar(sin, 'hand').bone, undefined);
  assert.deepEqual(buscar(sin, 'up').values, {});
  doc = aplicarOperaciones(sin, inversas, esquema).doc;
  assert.equal(buscar(doc, 'hand').bone, 'lower');
  assert.deepEqual(buscar(doc, 'up').values, { arm: { rotation: -90 } });
});

test('duplicar un skeleton copia sus huesos y los enlaces apuntan a las copias', () => {
  let doc = op(brazo(), { op: 'create', type: 'path', id: 'tira', parent: 'rig', props: { closed: false, vertices: [{ x: 100, y: 100, bone: 'upper' }, { x: 190, y: 100, bone: 'lower' }] } });
  doc = op(doc, { op: 'duplicate', target: 'rig', suffix: 'b' });
  assert.equal(buscar(doc, 'hand_b').bone, 'lower_b');
  assert.deepEqual(buscar(doc, 'tira_b').vertices.map((v) => v.bone), ['upper_b', 'lower_b']);
  assert.equal(esqueletoDe(doc, 'lower_b'), 'rig_b');
});

test('la vista previa puede dibujar el esqueleto encima, posado', () => {
  const doc = brazo();
  assert.doesNotMatch(svgDocumento(doc, esquema), /data-huesos/);
  const svg = svgDocumento(doc, esquema, { huesos: true, pose: 'up' });
  assert.match(svg, /<g data-huesos="">/);
  assert.match(svg, />lower<\/text>/);
});

test('enlace por punto: un path se dobla con varios huesos y sigue siendo uno solo', () => {
  let doc = brazo();
  // Una tira de (100,100) a (190,100): los dos primeros puntos siguen al hombro, la punta al antebrazo.
  doc = op(doc, {
    op: 'create',
    type: 'path',
    id: 'tira',
    parent: 'rig',
    props: { closed: false, vertices: [{ x: 100, y: 100, bone: 'upper' }, { x: 150, y: 100, bone: 'upper' }, { x: 190, y: 100, bone: 'lower' }] },
  });
  doc = op(doc, { op: 'set', target: 'up', props: { values: { upper: { rotation: -90 }, lower: { rotation: 90 } } } });
  const d = svgDocumento(doc, esquema, { pose: 'up' }).match(/data-id="tira"><path d="([^"]+)"/)[1];
  // El hombro apunta hacia arriba y el antebrazo vuelve a la derecha: el codo queda en (100, 50), la punta en (140, 50).
  assert.equal(d, 'M100 100L100 50L140 50');
  // Renombrar y borrar el hueso actualizan los vértices.
  doc = op(doc, { op: 'rename', target: 'lower', id: 'fore' });
  assert.equal(buscar(doc, 'tira').vertices[2].bone, 'fore');
  doc = op(doc, { op: 'delete', target: 'fore' });
  assert.deepEqual(buscar(doc, 'tira').vertices[2], { x: 190, y: 100 });
  assert.throws(() => op(doc, { op: 'set', target: 'tira', props: { vertices: [{ x: 0, y: 0, bone: 'nada' }, { x: 1, y: 1 }] } }), /no existe el hueso "nada"/);
});

test('from/to crean huesos con coordenadas del documento, también encadenados', () => {
  let doc = op(
    crearDocumento({ name: 'Desde hasta' }),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'spine_bone', parent: 'rig', props: { from: [300, 400], to: [300, 300] } },
    { op: 'create', type: 'bone', id: 'arm_bone', parent: 'spine_bone', props: { from: [320, 320], to: [380, 320] } },
  );
  assert.deepEqual(buscar(doc, 'spine_bone'), { id: 'spine_bone', type: 'bone', parent: 'rig', x: 300, y: 400, rotation: -90, length: 100 });
  const arm = buscar(doc, 'arm_bone');
  assert.deepEqual([arm.x, arm.y, arm.rotation, arm.length], [80, 20, 90, 60]);
  // Con solo `to` se conserva el origen.
  doc = op(doc, { op: 'set', target: 'arm_bone', props: { to: [320, 260] } });
  assert.deepEqual([buscar(doc, 'arm_bone').x, buscar(doc, 'arm_bone').rotation, buscar(doc, 'arm_bone').length], [80, 0, 60]);
  assert.throws(() => op(doc, { op: 'create', type: 'rect', id: 'r', props: { from: [0, 0] } }), /solo sirven en huesos/);
});

test('repartir los puntos de un path entre los huesos más cercanos de su skeleton', () => {
  const doc = op(brazo(), { op: 'create', type: 'path', id: 'tira', parent: 'rig', props: { closed: false, vertices: [{ x: 100, y: 100 }, { x: 140, y: 100 }, { x: 180, y: 100 }] } });
  assert.deepEqual(repartirEntreHuesos(doc, esquema, 'tira').map((v) => v.bone), ['upper', 'upper', 'lower']);
  const conOtro = op(doc, { op: 'create', type: 'skeleton', id: 'otro' }, { op: 'create', type: 'bone', id: 'x_bone', parent: 'otro' });
  assert.throws(() => repartirEntreHuesos(conOtro, esquema, 'tira', ['upper', 'x_bone']), /x_bone no es un hueso del skeleton "rig"/);
  const suelto = op(doc, { op: 'move', target: 'tira', parent: null });
  assert.throws(() => repartirEntreHuesos(suelto, esquema, 'tira'), /no está dentro de un skeleton/);
});

test('bind all by proximity: cada pieza sin enlace va al hueso más cercano, sin tocar lo ya enlazado', () => {
  const doc = op(
    brazo(),
    // Un grupo sin nada enlazado va entero; su centro (180, 110) cae sobre el antebrazo.
    { op: 'create', type: 'group', id: 'glove', parent: 'rig', props: { x: 180, y: 110 } },
    { op: 'create', type: 'rect', id: 'palm', parent: 'glove', props: { width: 20, height: 20 } },
    // Un grupo con algo enlazado adentro se recorre: solo se enlaza lo que falta.
    { op: 'create', type: 'group', id: 'sleeve', parent: 'rig' },
    { op: 'create', type: 'ellipse', id: 'cuff', parent: 'sleeve', props: { x: 120, y: 100, width: 10, height: 10 } },
    { op: 'create', type: 'ellipse', id: 'patch', parent: 'sleeve', props: { x: 180, y: 100, width: 10, height: 10, bone: 'upper' } },
    // Un path enlazado por punto ya está decidido.
    { op: 'create', type: 'path', id: 'tira', parent: 'rig', props: { closed: false, vertices: [{ x: 100, y: 100, bone: 'upper' }, { x: 190, y: 100 }] } },
    // Lo de afuera del skeleton no cuenta.
    { op: 'create', type: 'rect', id: 'fondo', props: { x: 100, y: 100 } },
  );
  assert.deepEqual(enlacesPorCercania(doc, esquema, 'rig'), [
    { id: 'glove', bone: 'lower' },
    { id: 'cuff', bone: 'upper' },
  ]);
  assert.throws(() => enlacesPorCercania(op(crearDocumento(), { op: 'create', type: 'skeleton', id: 's' }), esquema, 's'), /no tiene huesos/);
  assert.throws(() => enlacesPorCercania(doc, esquema, 'hand'), /no es un skeleton/);
});

// Un documento de antes del modelo de capa de huesos: huesos en la raíz y el grupo `cat` enlazado a uno de ellos.
function documentoViejo({ conGiro = false } = {}) {
  return {
    format: crearDocumento().format,
    meta: { name: 'Viejo' },
    objects: [
      { id: 'cat', type: 'group', parent: null, x: 300, y: 400, ...(conGiro ? { rotation: 30, scaleX: 2, scaleY: 2 } : {}), bone: 'body_bone' },
      { id: 'torso', type: 'rect', parent: 'cat', width: 80, height: 120 },
      { id: 'head', type: 'group', parent: 'cat', y: -100, bone: 'head_bone' },
      { id: 'face', type: 'ellipse', parent: 'head' },
      { id: 'tail', type: 'path', parent: 'cat', closed: false, vertices: [{ x: 40, y: 40, bone: 'tail_bone' }, { x: 80, y: 40, bone: 'tail_bone' }] },
      { id: 'body_bone', type: 'bone', parent: null, x: 300, y: 460, rotation: -90, length: 120, minAngle: -100 },
      { id: 'head_bone', type: 'bone', parent: 'body_bone', x: 120, length: 60 },
      { id: 'tail_bone', type: 'bone', parent: 'body_bone', x: 20, y: 40, rotation: 90, length: 40 },
      { id: 'nod', type: 'pose', parent: null, values: { body_bone: { rotation: -80, x: 310 }, head_bone: { rotation: 20 } } },
    ],
  };
}

test('migración: el grupo raíz pasa a ser el skeleton y nada se mueve, ni en el montaje ni en las poses', () => {
  for (const conGiro of [false, true]) {
    const viejo = documentoViejo({ conGiro });
    assert.ok(validar(viejo, esquema).errores.some((e) => /body_bone: un bone no puede estar en la raíz/.test(e)));
    const { doc, cambios } = migrarAEsqueletos(viejo, esquema);
    assert.deepEqual(validar(doc, esquema).errores, []);
    assert.match(cambios[0], /Group cat is now a Skeleton/);
    assert.equal(buscar(doc, 'cat').type, 'skeleton');
    assert.equal(buscar(doc, 'cat').bone, undefined);
    assert.equal(buscar(doc, 'body_bone').parent, 'cat');
    // Lo que heredaba body_bone a través de cat ahora lo tiene propio; lo que tenía el suyo, lo conserva.
    assert.deepEqual(['torso', 'head', 'tail'].map((id) => buscar(doc, id).bone), ['body_bone', 'head_bone', 'body_bone']);
    // Los huesos quedan donde estaban en pantalla, en el montaje y en la pose.
    for (const pose of [null, 'nod']) {
      const antes = evaluarEsqueleto(viejo, esquema, pose && buscar(viejo, pose));
      const despues = evaluarEsqueleto(doc, esquema, pose && buscar(doc, pose));
      for (const id of ['body_bone', 'head_bone', 'tail_bone']) assert.ok(antes.posado.get(id).every((v, i) => Math.abs(v - despues.posado.get(id)[i]) < 1e-4), `${id} en ${pose}`);
    }
    assert.equal(svgDocumento(doc, esquema).length > 0, true);
    // Volver a migrar no cambia nada.
    assert.deepEqual(migrarAEsqueletos(doc, esquema).cambios, []);
  }
  // Sin giro, el hueso raíz solo se corre al marco de cat.
  const { doc } = migrarAEsqueletos(documentoViejo(), esquema);
  assert.deepEqual([buscar(doc, 'body_bone').x, buscar(doc, 'body_bone').y, buscar(doc, 'body_bone').rotation], [0, 60, -90]);
  assert.deepEqual(buscar(doc, 'nod').values.body_bone, { rotation: -80, x: 10, y: 60 });
});

test('migración: dibujo enlazado suelto en la raíz va a un skeleton nuevo sin cambiar el orden de dibujo', () => {
  const viejo = {
    format: crearDocumento().format,
    meta: {},
    objects: [
      { id: 'fondo', type: 'rect', parent: null },
      { id: 'a', type: 'ellipse', parent: null, bone: 'b1' },
      { id: 'medio', type: 'rect', parent: null },
      { id: 'c', type: 'ellipse', parent: null, bone: 'b2' },
      { id: 'frente', type: 'rect', parent: null },
      { id: 'b1', type: 'bone', parent: null, x: 10 },
      { id: 'b2', type: 'bone', parent: 'b1' },
      { id: 'b3', type: 'bone', parent: null },
    ],
  };
  const { doc, cambios } = migrarAEsqueletos(viejo, esquema);
  assert.deepEqual(validar(doc, esquema).errores, []);
  assert.match(cambios[0], /New Skeleton skeleton with the bones and a, medio, c/);
  assert.deepEqual(doc.objects.filter((o) => o.parent == null).map((o) => o.id), ['fondo', 'skeleton', 'frente']);
  assert.deepEqual(doc.objects.filter((o) => o.parent === 'skeleton').map((o) => o.id), ['a', 'medio', 'c', 'b1', 'b3']);
  assert.equal(buscar(doc, 'b1').x, 10);
  assert.equal(svgDocumento(doc, esquema), svgDocumento(viejo, esquema).replace('<g data-id="a">', '<g data-id="skeleton"><g data-id="a">').replace('<g data-id="frente">', '</g><g data-id="frente">'));
});
