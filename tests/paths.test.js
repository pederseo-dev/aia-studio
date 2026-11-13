import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarEsquema } from '../server/schema.js';
import { crearDocumento } from '../src/core/document.js';
import { aplicarOperaciones } from '../src/core/operations.js';
import { dividirTramo, muestrearTramo, parsearD, tangentes, transformarVertices, verticesAD } from '../src/core/paths.js';
import { svgDocumento } from '../src/render/svg.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema);
const cerca = (a, b, eps = 0.02) => Math.abs(a - b) < eps;

// Puntos de la curva muestreados: sirve para comparar dos trazados por su forma, no por su texto.
function forma(vertices, closed) {
  const tramos = closed ? vertices.length : vertices.length - 1;
  return Array.from({ length: tramos }, (_, i) => muestrearTramo(vertices, i, 8).map((m) => m.p)).flat();
}

test('líneas y comandos relativos', () => {
  const [s] = parsearD('M10 10 h20 v20 l-20 0 z');
  assert.equal(s.closed, true);
  assert.deepEqual(s.vertices, [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }]);
  assert.equal(verticesAD(s.vertices, true), 'M10 10L30 10L30 30L10 30L10 10Z');
});

test('las curvas se guardan como tangentes en polares y vuelven a la misma forma', () => {
  const d = 'M0 0 C 0 -40 60 -40 60 0 S 120 40 120 0';
  const [s] = parsearD(d);
  assert.equal(s.closed, false);
  // El vértice del medio tiene tangentes opuestas e iguales: mirrored, apuntando hacia abajo.
  assert.deepEqual(s.vertices[1], { x: 60, y: 0, mode: 'mirrored', angle: 90, dist: 40 });
  const [otra] = parsearD(verticesAD(s.vertices, false));
  forma(s.vertices, false).forEach((p, i) => {
    const q = forma(otra.vertices, false)[i];
    assert.ok(cerca(p[0], q[0]) && cerca(p[1], q[1]), `${p} ≠ ${q}`);
  });
});

test('cuadráticas, T y arcos se convierten a cúbicas', () => {
  const [q] = parsearD('M0 0 Q50 -50 100 0 T200 0');
  assert.equal(q.vertices.length, 3);
  const [circulo] = parsearD('M-50 0 A50 50 0 1 0 50 0 A50 50 0 1 0 -50 0 Z');
  assert.equal(circulo.closed, true);
  // Todos los puntos muestreados quedan a 50 del centro.
  for (const [x, y] of forma(circulo.vertices, true)) assert.ok(Math.abs(Math.hypot(x, y) - 50) < 0.2, `${x},${y}`);
  assert.deepEqual(parsearD('M0 0L10 0M20 0L30 0').length, 2);
  assert.throws(() => parsearD('M0 0 X10'), /comando desconocido/);
});

test('esquina redondeada', () => {
  const d = verticesAD([{ x: 0, y: 0, radius: 10 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], true);
  assert.match(d, /^M0 10C0 4\.477 4\.477 0 10 0L100 0/);
});

test('transformar y dividir conservan la forma', () => {
  const [s] = parsearD('M0 0 C0 -40 60 -40 60 0');
  const movido = transformarVertices(s.vertices, [0, 1, -1, 0, 10, 5]); // girar 90° y trasladar
  const original = forma(s.vertices, false);
  forma(movido, false).forEach(([x, y], i) => {
    const [ox, oy] = original[i];
    assert.ok(cerca(x, -oy + 10) && cerca(y, ox + 5));
  });
  const dividido = dividirTramo(s.vertices, 0, 0.5);
  assert.equal(dividido.length, 3);
  assert.ok(cerca(dividido[1].x, 30) && cerca(dividido[1].y, -30));
  assert.deepEqual(tangentes(dividido[1]).entrada.map((v) => Math.round(v) || 0), [-15, 0]);
  assert.deepEqual(dividirTramo([{ x: 0, y: 0 }, { x: 100, y: 0 }], 0, 0.25), [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 100, y: 0 }]);
});

test('un path acepta d, valida sus vértices y se dibuja', () => {
  let doc = op(crearDocumento(), { op: 'create', type: 'path', id: 'ear', props: { x: 100, y: 100, d: 'M0 0 L20 -40 L40 0 Z', fill: '#ff8800' } }).doc;
  const ear = doc.objects[0];
  assert.equal(ear.d, undefined);
  assert.equal(ear.closed, true);
  assert.equal(ear.vertices.length, 3);
  assert.match(svgDocumento(doc, esquema), /<path d="M0 0L20 -40L40 0L0 0Z" fill="#ff8800"/);
  doc = op(doc, { op: 'set', target: 'ear', props: { d: 'M0 0 L10 10' } }).doc;
  assert.equal(doc.objects[0].closed, false);
  assert.throws(() => op(doc, { op: 'set', target: 'ear', props: { vertices: [{ x: 0, y: 0, mode: 'mirrored' }] } }), /vertices \[0\] falta angle/);
  assert.throws(() => op(doc, { op: 'set', target: 'ear', props: { vertices: [{ x: 0, y: 0, cx: 1 }] } }), /campo "cx" no va/);
  assert.throws(() => op(doc, { op: 'set', target: 'ear', props: { d: 'M0 0L1 1M5 5L6 6' } }), /2 subtrazados/);
  assert.throws(() => op(crearDocumento(), { op: 'create', type: 'rect', id: 'r', props: { d: 'M0 0' } }), /solo sirve en tipos con vértices/);
});

test('estilos compartidos y degradados', () => {
  let doc = op(
    crearDocumento(),
    { op: 'create', type: 'linear_gradient', id: 'skin_shade', props: { stops: [{ offset: 0, color: '#ffe0c0' }, { offset: 1, color: '#e0a080', opacity: 0.5 }] } },
    { op: 'create', type: 'style', id: 'skin', props: { fill: '#f2c4a0', stroke: '#3a2a1a', strokeWidth: 3 } },
    { op: 'create', type: 'ellipse', id: 'face', props: { style: 'skin' } },
    { op: 'create', type: 'ellipse', id: 'nose', props: { style: 'skin', fill: '#ff0000', fillGradient: 'skin_shade' } },
  ).doc;
  const svg = svgDocumento(doc, esquema);
  assert.match(svg, /<defs><linearGradient id="aia-skin_shade" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#ffe0c0"\/><stop offset="1" stop-color="#e0a080" stop-opacity="0.5"\/>/);
  assert.match(svg, /data-id="face"><ellipse rx="50" ry="50" fill="#f2c4a0" stroke="#3a2a1a" stroke-width="3"\/>/);
  assert.match(svg, /data-id="nose"><ellipse rx="50" ry="50" fill="url\(#aia-skin_shade\)"/);
  assert.doesNotMatch(svg, /data-id="skin"/);

  // Cambiar el estilo cambia todas las formas que lo usan.
  doc = op(doc, { op: 'set', target: 'skin', props: { fill: '#c08060' } }).doc;
  assert.match(svgDocumento(doc, esquema), /data-id="face"><ellipse rx="50" ry="50" fill="#c08060"/);

  assert.throws(() => op(doc, { op: 'set', target: 'face', props: { style: 'skin_shade' } }), /es un linear_gradient; se esperaba style/);
  assert.throws(() => op(doc, { op: 'create', type: 'style', id: 's2', parent: 'face' }), /no puede tener hijos|va en la raíz/);
  assert.throws(() => op(doc, { op: 'set', target: 'skin_shade', props: { stops: [{ offset: 1, color: '#fff' }, { offset: 0, color: '#000' }] } }), /orden de offset/);
});
