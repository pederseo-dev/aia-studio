import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../servidor/esquema.js';
import { crearDocumento, validar } from '../src/core/documento.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';
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
  assert.deepEqual([...esquema.tipos.keys()].sort(), ['ellipse', 'group', 'rect']);
  const rect = esquema.tipos.get('rect');
  assert.ok(rect.properties.x && rect.properties.fill && rect.properties.width);
  assert.equal(esquema.tipos.get('group').container, true);
  assert.equal(rect.container, false);
});

test('cada tipo concreto tiene cómo dibujarse', () => {
  for (const tipo of esquema.tipos.keys()) assert.ok(DIBUJAR[tipo], `falta DIBUJAR.${tipo}`);
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
