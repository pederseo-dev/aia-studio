import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../servidor/esquema.js';
import { crearDocumento, validar } from '../src/core/documento.js';
import { aplicarOperaciones, compactar, resumirOperaciones } from '../src/core/operaciones.js';
import { aplicar, matrizMundo } from '../src/core/geometria.js';
import { guiaParaIA } from '../src/core/guia.js';
import { DIBUJAR, svgDocumento } from '../src/render/svg.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema);

function robot() {
  return op(
    crearDocumento({ name: 'Robot' }),
    { op: 'create', type: 'group', id: 'body', props: { x: 300, y: 400 } },
    { op: 'create', type: 'rect', id: 'torso', parent: 'body', props: { width: 160, height: 200 } },
    { op: 'create', type: 'group', id: 'head', parent: 'body', props: { y: -100 } },
    { op: 'create', type: 'ellipse', id: 'eye_l', parent: 'head', props: { x: -30, y: -60, width: 20, height: 20 } },
    { op: 'create', type: 'ellipse', id: 'eye_r', parent: 'head', props: { x: 30, y: -60, width: 20, height: 20 } },
  ).doc;
}

test('el esquema resuelve la herencia y solo expone tipos concretos', () => {
  assert.deepEqual([...esquema.tipos.keys()].sort(), ['animation', 'bone', 'driver', 'ellipse', 'group', 'linear_gradient', 'param', 'path', 'pose', 'radial_gradient', 'rect', 'skeleton', 'style', 'switch']);
  assert.equal(esquema.tipos.get('style').resource, true);
  assert.equal(esquema.tipos.get('path').resource, false);
  const rect = esquema.tipos.get('rect');
  assert.ok(rect.properties.x && rect.properties.fill && rect.properties.width);
  assert.equal(esquema.tipos.get('group').container, true);
  assert.equal(rect.container, false);
});

test('cada tipo concreto que no es recurso tiene cómo dibujarse', () => {
  for (const [nombre, tipo] of esquema.tipos) if (!tipo.resource) assert.ok(nombre in DIBUJAR, `falta DIBUJAR.${nombre}`);
});

test('crear arma la jerarquía y el orden de dibujo', () => {
  const doc = robot();
  assert.deepEqual(validar(doc, esquema).errores, []);
  assert.deepEqual(doc.objects.map((o) => o.id), ['body', 'torso', 'head', 'eye_l', 'eye_r']);
  const fondo = op(doc, { op: 'create', type: 'rect', id: 'antenna', parent: 'head', index: 0 }).doc;
  assert.deepEqual(fondo.objects.filter((o) => o.parent === 'head').map((o) => o.id), ['antenna', 'eye_l', 'eye_r']);
});

test('cada operación se deshace exactamente con sus inversas', () => {
  const doc = robot();
  const lotes = [
    [{ op: 'set', target: 'torso', props: { width: 10, fill: '#ff0000' } }],
    [{ op: 'unset', target: 'eye_l', props: ['x', 'width'] }],
    [{ op: 'set', target: 'meta', props: { width: 600, background: null } }],
    [{ op: 'delete', target: 'head' }],
    [{ op: 'move', target: 'eye_r', parent: null, index: 0 }],
    [{ op: 'move', target: 'torso', index: 5 }],
    [{ op: 'rename', target: 'head', id: 'cabeza' }],
    [{ op: 'move', target: 'body', parent: null, index: 0 }, { op: 'delete', target: 'body' }],
  ];
  for (const ops of lotes) {
    const { doc: cambiado, inversas } = op(doc, ...ops);
    assert.notDeepEqual(cambiado, doc, JSON.stringify(ops));
    assert.deepEqual(op(cambiado, ...inversas).doc, doc, JSON.stringify(ops));
  }
});

test('duplicate copia el subárbol con ids nuevos y se deshace', () => {
  const doc = robot();
  const { doc: copia, inversas } = op(doc, { op: 'duplicate', target: 'head', id: 'head_b', suffix: 'b', props: { x: 50 } });
  const ids = copia.objects.map((o) => o.id);
  assert.deepEqual(ids.slice(0, 5), ['body', 'torso', 'head', 'eye_l', 'eye_r']);
  assert.deepEqual(copia.objects.filter((o) => o.parent === 'body').map((o) => o.id), ['torso', 'head', 'head_b']);
  assert.deepEqual(copia.objects.filter((o) => o.parent === 'head_b').map((o) => o.id), ['eye_l_b', 'eye_r_b']);
  assert.equal(copia.objects.find((o) => o.id === 'head_b').x, 50);
  assert.deepEqual(op(copia, ...inversas).doc, doc);
  assert.throws(() => op(copia, { op: 'duplicate', target: 'head', suffix: 'b' }), /ya existe un objeto "head_b"/);
  assert.throws(() => op(copia, { op: 'duplicate', target: 'head', id: 'head_c', suffix: 'b' }), /ya existe un objeto "eye_l_b"/);
  const raiz = op(doc, { op: 'duplicate', target: 'eye_l', parent: null, index: 0 }).doc;
  assert.equal(raiz.objects.filter((o) => (o.parent ?? null) === null)[0].id, 'eye_l_copy');
});

test('compactar junta los set seguidos y el resumen es legible', () => {
  const ops = [
    { op: 'set', target: 'head', props: { x: 1 } },
    { op: 'set', target: 'head', props: { x: 2, y: 5 } },
    { op: 'set', target: 'torso', props: { x: 3 } },
  ];
  assert.deepEqual(compactar(ops), [{ op: 'set', target: 'head', props: { x: 2, y: 5 } }, ops[2]]);
  assert.deepEqual(resumirOperaciones([...ops, { op: 'create', type: 'rect', id: 'a' }]), ['head.x', 'head.y', 'torso.x', 'crear a']);
});

test('rename actualiza a los hijos', () => {
  const doc = op(robot(), { op: 'rename', target: 'head', id: 'cabeza' }).doc;
  assert.equal(doc.objects.find((o) => o.id === 'eye_l').parent, 'cabeza');
});

test('los errores son claros y el lote no se aplica a medias', () => {
  const doc = robot();
  assert.throws(() => op(doc, { op: 'set', target: 'hed', props: { x: 1 } }), /Operación 1 \(set\): no existe el objeto "hed". ¿Quisiste decir "head"\?/);
  assert.throws(() => op(doc, { op: 'create', type: 'rectangle', id: 'x' }), /¿Quisiste decir "rect"\?/);
  assert.throws(() => op(doc, { op: 'create', type: 'rect', id: 'r', parent: 'torso' }), /no puede tener hijos/);
  assert.throws(() => op(doc, { op: 'move', target: 'body', parent: 'head' }), /dentro de sí mismo/);
  assert.throws(() => op(doc, { op: 'set', target: 'torso', props: { fill: 'red' } }), /torso.fill debe ser un color/);
  assert.throws(() => op(doc, { op: 'set', target: 'torso', props: { opacity: 2 } }), /≤ 1/);
  assert.throws(() => op(doc, { op: 'set', target: 'torso', props: { parent: 'head' } }), /usa move/);
  assert.throws(
    () => op(doc, { op: 'set', target: 'torso', props: { x: 5 } }, { op: 'delete', target: 'nada' }),
    /Operación 2/,
  );
  assert.equal(doc.objects.find((o) => o.id === 'torso').x, undefined);
});

test('las propiedades desconocidas se conservan con un aviso', () => {
  const { doc, avisos } = op(robot(), { op: 'set', target: 'torso', props: { widht: 5 } });
  assert.equal(doc.objects.find((o) => o.id === 'torso').widht, 5);
  assert.match(avisos[0], /desconocida "widht".*¿Quisiste decir "width"\?/);
});

test('la matriz del mundo compone la jerarquía', () => {
  const doc = op(robot(), { op: 'set', target: 'head', props: { rotation: 90 } }).doc;
  const [x, y] = aplicar(matrizMundo(doc, esquema, 'eye_l'), 0, 0);
  // body (300,400) → head (0,-100) girado 90° → eye_l (-30,-60) pasa a (60,-30)
  assert.ok(Math.abs(x - 360) < 1e-9 && Math.abs(y - 270) < 1e-9, `${x},${y}`);
});

test('el SVG respeta jerarquía, valores por defecto y orden', () => {
  const svg = svgDocumento(robot(), esquema);
  assert.match(svg, /^<svg[^>]+viewBox="0 0 800 800"/);
  assert.match(svg, /<g data-id="head" transform="translate\(0 -100\)"><g data-id="eye_l"/);
  assert.match(svg, /<rect x="-80" y="-100" width="160" height="200" fill="#c8c2d4"\/>/);
});

test('la guía para la IA sale del esquema', () => {
  const guia = guiaParaIA(esquema);
  for (const tipo of esquema.tipos.keys()) assert.ok(guia.includes(`### \`${tipo}\``));
  assert.ok(guia.includes('`cornerRadius`'));
});

test('originX/originY corren el pivote dentro de rectángulos y elipses', () => {
  const { doc } = op(
    crearDocumento({ name: 'Origen' }),
    { op: 'create', type: 'rect', id: 'r', props: { width: 40, height: 20, originY: 1 } },
    { op: 'create', type: 'ellipse', id: 'e', props: { width: 40, height: 20, originX: 0 } },
  );
  const svg = svgDocumento(doc, esquema);
  assert.match(svg, /<rect x="-20" y="-20" width="40" height="20"/);
  assert.match(svg, /<ellipse cx="20" rx="20" ry="10"/);
});

test('meta es un id reservado: no se crea, no se renombra a meta ni se duplica con ese id', () => {
  const doc = op(crearDocumento({}), { op: 'create', type: 'rect', id: 'r' }).doc;
  assert.throws(() => op(doc, { op: 'create', type: 'rect', id: 'meta' }), /reserved id/);
  assert.throws(() => op(doc, { op: 'rename', target: 'r', id: 'meta' }), /reserved id/);
  assert.throws(() => op(doc, { op: 'duplicate', target: 'r', id: 'meta' }), /reserved id/);
  assert.match(validar({ ...doc, objects: [{ id: 'meta', type: 'rect' }] }, esquema).errores.join(), /reserved id/);
});

test('params y drivers: initial y equals tienen que ser opciones, y min no puede pasar a max', () => {
  const base = op(crearDocumento({}), { op: 'create', type: 'param', id: 'v', props: { kind: 'enum', options: ['a', 'b'] } }, { op: 'create', type: 'pose', id: 'pp' }).doc;
  assert.throws(() => op(base, { op: 'set', target: 'v', props: { initial: 'zz' } }), /v\.initial "zz" is not one of its options: "a", "b"/);
  assert.throws(() => op(base, { op: 'create', type: 'driver', id: 'dd', props: { param: 'v', pose: 'pp', equals: 'c' } }), /param v has options "a", "b", but driver dd\.equals "c" uses a value that is not among them/);
  assert.throws(() => op(base, { op: 'create', type: 'param', id: 'n', props: { min: 2, max: 1 } }), /min \(2\) is greater than max \(1\)/);
  assert.throws(() => op(base, { op: 'create', type: 'param', id: 'n', props: { max: -1 } }), /min \(0\) is greater than max \(-1\)/);
  // Quitar la opción que usa un driver también avisa.
  const conDriver = op(base, { op: 'create', type: 'driver', id: 'dd', props: { param: 'v', pose: 'pp', equals: 'b' } }).doc;
  const dos = op(conDriver, { op: 'create', type: 'driver', id: 'dd2', props: { param: 'v', pose: 'pp', equals: 'b' } }).doc;
  assert.throws(() => op(dos, { op: 'set', target: 'v', props: { options: ['a'] } }), /drivers dd\.equals "b", dd2\.equals "b" use values .*change those drivers’ equals in the same batch \(for example \{ "op": "set", "target": "dd", "props": \{ "equals": "a" \} \}\)/);
  // Cambiando los equals en el mismo lote, pasa.
  assert.doesNotThrow(() => op(dos, { op: 'set', target: 'v', props: { options: ['a'] } }, { op: 'set', target: 'dd', props: { equals: 'a' } }, { op: 'delete', target: 'dd2' }));
});

test('sacar de un switch una variante que usa una pose dice las dos salidas', () => {
  const doc = op(
    crearDocumento({}),
    { op: 'create', type: 'switch', id: 'mouth' },
    { op: 'create', type: 'rect', id: 'm_a', parent: 'mouth' },
    { op: 'create', type: 'rect', id: 'm_o', parent: 'mouth' },
    { op: 'create', type: 'pose', id: 'o', props: { values: { mouth: { active: 'm_o' } } } },
  ).doc;
  assert.throws(() => op(doc, { op: 'move', target: 'm_o', parent: null }), /Pose "o" makes switch mouth show "m_o".*remove only mouth's active from pose "o".*Puppet → View → Pose: o, select mouth and click ↺ next to active.*set_pose with remove: \["mouth\.active"\].*or keep "m_o" inside mouth/);
});

test('move con keepPosition deja el objeto en el mismo lugar de la pantalla, y se deshace', () => {
  const doc = op(crearDocumento({}), { op: 'create', type: 'group', id: 'g', props: { x: 100, y: 50, rotation: 90 } }, { op: 'create', type: 'rect', id: 'r', props: { x: 10, y: 20 } }).doc;
  const { doc: movido, inversas } = op(doc, { op: 'move', target: 'r', parent: 'g', keepPosition: true });
  assert.deepEqual(aplicar(matrizMundo(movido, esquema, 'r'), 0, 0).map(Math.round), [10, 20]);
  assert.deepEqual(op(movido, ...inversas).doc, doc);
  // Sin keepPosition conserva x/y (y se corre).
  assert.deepEqual(aplicar(matrizMundo(op(doc, { op: 'move', target: 'r', parent: 'g' }).doc, esquema, 'r'), 0, 0).map(Math.round), [80, 60]);
  assert.throws(() => op(op(movido, { op: 'create', type: 'skeleton', id: 's' }, { op: 'create', type: 'bone', id: 'b', parent: 's' }).doc, { op: 'move', target: 'b', parent: 'g', keepPosition: true }), /reparent_bone/);
});

test('cada tipo y propiedad tiene una ayuda en inglés para el editor', () => {
  const sinAyuda = [];
  for (const t of [esquema.meta, ...esquema.tipos.values()]) {
    if (!t.help) sinAyuda.push(t.name);
    for (const [k, p] of Object.entries(t.properties)) if (!p.help) sinAyuda.push(`${t.name}.${k}`);
  }
  assert.deepEqual(sinAyuda, []);
});
