import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSchema } from '../server/schema.js';
import { createDocument } from '../src/core/document.js';
import { applyOperations } from '../src/core/operations.js';
import { splitSpan, sampleSpan, parseD, tangents, transformVertices, verticesAD } from '../src/core/paths.js';
import { svgDocument } from '../src/render/svg.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema);
const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps;

// Puntos de la curva muestreados: sirve para comparar dos trazados por su forma, no por su texto.
function shape(vertices, closed) {
  const spans = closed ? vertices.length : vertices.length - 1;
  return Array.from({ length: spans }, (_, i) => sampleSpan(vertices, i, 8).map((m) => m.p)).flat();
}

test('líneas y comandos relativos', () => {
  const [s] = parseD('M10 10 h20 v20 l-20 0 z');
  assert.equal(s.closed, true);
  assert.deepEqual(s.vertices, [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }]);
  assert.equal(verticesAD(s.vertices, true), 'M10 10L30 10L30 30L10 30L10 10Z');
});

test('las curvas se guardan como tangentes en polares y vuelven a la misma forma', () => {
  const d = 'M0 0 C 0 -40 60 -40 60 0 S 120 40 120 0';
  const [s] = parseD(d);
  assert.equal(s.closed, false);
  // El vértice del medio tiene tangentes opuestas e iguales: mirrored, apuntando hacia abajo.
  assert.deepEqual(s.vertices[1], { x: 60, y: 0, mode: 'mirrored', angle: 90, dist: 40 });
  const [other] = parseD(verticesAD(s.vertices, false));
  shape(s.vertices, false).forEach((p, i) => {
    const q = shape(other.vertices, false)[i];
    assert.ok(near(p[0], q[0]) && near(p[1], q[1]), `${p} ≠ ${q}`);
  });
});

test('cuadráticas, T y arcos se convierten a cúbicas', () => {
  const [q] = parseD('M0 0 Q50 -50 100 0 T200 0');
  assert.equal(q.vertices.length, 3);
  const [circle] = parseD('M-50 0 A50 50 0 1 0 50 0 A50 50 0 1 0 -50 0 Z');
  assert.equal(circle.closed, true);
  // Todos los puntos muestreados quedan a 50 del centro.
  for (const [x, y] of shape(circle.vertices, true)) assert.ok(Math.abs(Math.hypot(x, y) - 50) < 0.2, `${x},${y}`);
  assert.deepEqual(parseD('M0 0L10 0M20 0L30 0').length, 2);
  assert.throws(() => parseD('M0 0 X10'), /comando desconocido/);
});

test('esquina redondeada', () => {
  const d = verticesAD([{ x: 0, y: 0, radius: 10 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], true);
  assert.match(d, /^M0 10C0 4\.477 4\.477 0 10 0L100 0/);
});

test('transformar y dividir conservan la forma', () => {
  const [s] = parseD('M0 0 C0 -40 60 -40 60 0');
  const moved = transformVertices(s.vertices, [0, 1, -1, 0, 10, 5]); // girar 90° y trasladar
  const original = shape(s.vertices, false);
  shape(moved, false).forEach(([x, y], i) => {
    const [ox, oy] = original[i];
    assert.ok(near(x, -oy + 10) && near(y, ox + 5));
  });
  const split = splitSpan(s.vertices, 0, 0.5);
  assert.equal(split.length, 3);
  assert.ok(near(split[1].x, 30) && near(split[1].y, -30));
  assert.deepEqual(tangents(split[1]).entrada.map((v) => Math.round(v) || 0), [-15, 0]);
  assert.deepEqual(splitSpan([{ x: 0, y: 0 }, { x: 100, y: 0 }], 0, 0.25), [{ x: 0, y: 0 }, { x: 25, y: 0 }, { x: 100, y: 0 }]);
});

test('un path acepta d, valida sus vértices y se dibuja', () => {
  let doc = op(createDocument(), { op: 'create', type: 'path', id: 'ear', props: { x: 100, y: 100, d: 'M0 0 L20 -40 L40 0 Z', fill: '#ff8800' } }).doc;
  const ear = doc.objects[0];
  assert.equal(ear.d, undefined);
  assert.equal(ear.closed, true);
  assert.equal(ear.vertices.length, 3);
  assert.match(svgDocument(doc, schema), /<path d="M0 0L20 -40L40 0L0 0Z" fill="#ff8800"/);
  doc = op(doc, { op: 'set', target: 'ear', props: { d: 'M0 0 L10 10' } }).doc;
  assert.equal(doc.objects[0].closed, false);
  assert.throws(() => op(doc, { op: 'set', target: 'ear', props: { vertices: [{ x: 0, y: 0, mode: 'mirrored' }] } }), /vertices \[0\] falta angle/);
  assert.throws(() => op(doc, { op: 'set', target: 'ear', props: { vertices: [{ x: 0, y: 0, cx: 1 }] } }), /campo "cx" no va/);
  assert.throws(() => op(doc, { op: 'set', target: 'ear', props: { d: 'M0 0L1 1M5 5L6 6' } }), /2 subtrazados/);
  assert.throws(() => op(createDocument(), { op: 'create', type: 'rect', id: 'r', props: { d: 'M0 0' } }), /solo sirve en tipos con vértices/);
});

test('estilos compartidos y degradados', () => {
  let doc = op(
    createDocument(),
    { op: 'create', type: 'linear_gradient', id: 'skin_shade', props: { stops: [{ offset: 0, color: '#ffe0c0' }, { offset: 1, color: '#e0a080', opacity: 0.5 }] } },
    { op: 'create', type: 'style', id: 'skin', props: { fill: '#f2c4a0', stroke: '#3a2a1a', strokeWidth: 3 } },
    { op: 'create', type: 'ellipse', id: 'face', props: { style: 'skin' } },
    { op: 'create', type: 'ellipse', id: 'nose', props: { style: 'skin', fill: '#ff0000', fillGradient: 'skin_shade' } },
  ).doc;
  const svg = svgDocument(doc, schema);
  assert.match(svg, /<defs><linearGradient id="aia-skin_shade" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#ffe0c0"\/><stop offset="1" stop-color="#e0a080" stop-opacity="0.5"\/>/);
  assert.match(svg, /data-id="face"><ellipse rx="50" ry="50" fill="#f2c4a0" stroke="#3a2a1a" stroke-width="3"\/>/);
  assert.match(svg, /data-id="nose"><ellipse rx="50" ry="50" fill="url\(#aia-skin_shade\)"/);
  assert.doesNotMatch(svg, /data-id="skin"/);

  // Cambiar el estilo cambia todas las formas que lo usan.
  doc = op(doc, { op: 'set', target: 'skin', props: { fill: '#c08060' } }).doc;
  assert.match(svgDocument(doc, schema), /data-id="face"><ellipse rx="50" ry="50" fill="#c08060"/);

  assert.throws(() => op(doc, { op: 'set', target: 'face', props: { style: 'skin_shade' } }), /es un linear_gradient; se esperaba style/);
  assert.throws(() => op(doc, { op: 'create', type: 'style', id: 's2', parent: 'face' }), /no puede tener hijos|va en la raíz/);
  assert.throws(() => op(doc, { op: 'set', target: 'skin_shade', props: { stops: [{ offset: 1, color: '#fff' }, { offset: 0, color: '#000' }] } }), /orden de offset/);
});
