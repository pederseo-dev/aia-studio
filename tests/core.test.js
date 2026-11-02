import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validar } from '../src/core/documento.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';
import { evaluar, matricesDelMundo } from '../src/core/pose.js';
import { svgComoTexto } from '../src/core/svg.js';

const prueba = JSON.parse(readFileSync(new URL('../personajes/prueba.json', import.meta.url), 'utf8'));

test('el personaje de prueba es válido', () => {
  assert.deepEqual(validar(prueba), []);
});

test('set, add y remove se deshacen con sus inversas', () => {
  const ops = [
    { op: 'set', path: 'rig.bones.head.rotation', value: 12 },
    { op: 'add', path: 'rig.bones', value: { id: 'hat', parent: 'head', x: 0, y: -200 } },
    { op: 'remove', path: 'drivers.blink_r' },
  ];
  const { doc, inversas } = aplicarOperaciones(prueba, ops);
  assert.equal(doc.rig.bones.find((b) => b.id === 'head').rotation, 12);
  assert.ok(doc.rig.bones.some((b) => b.id === 'hat'));
  assert.ok(!doc.drivers.some((d) => d.id === 'blink_r'));
  assert.deepEqual(aplicarOperaciones(doc, inversas).doc, prueba);
});

test('un lote inválido no se aplica', () => {
  assert.throws(() => aplicarOperaciones(prueba, [{ op: 'set', path: 'rig.bones.head.parent', value: 'eye_l' }]), /Ciclo/);
  assert.throws(() => aplicarOperaciones(prueba, [{ op: 'set', path: 'rig.parts.face.svg', value: '<script>x</script>' }]), /scripts/);
  assert.throws(() => aplicarOperaciones(prueba, [{ op: 'remove', path: 'rig.bones.mouth' }]), /inexistente/);
});

test('los drivers mueven la pose', () => {
  const pose = evaluar(prueba, { happiness: 1, mouth_open: 0, blink: 1, look_x: 0.5 });
  assert.equal(pose.slots.mouth.active, 'smile');
  assert.equal(pose.parts.blush.opacity, 0.6);
  assert.ok(Math.abs(pose.bones.eye_l.scaleY - 0.1) < 1e-9);
  assert.equal(pose.bones.pupil_l.x, 3);
  assert.equal(evaluar(prueba, { happiness: 1, mouth_open: 0.8 }).slots.mouth.active, 'open');
  assert.equal(evaluar(prueba, { happiness: -1 }).slots.mouth.active, 'sad');
});

test('los hijos heredan la transformación del padre', () => {
  const mundo = matricesDelMundo(prueba, evaluar(prueba));
  // head = root(200,395) + neck(0,-120) + head(0,-20)
  assert.deepEqual(mundo.head.slice(4), [200, 255]);
  const girado = matricesDelMundo(prueba, evaluar(prueba, { head_turn: 1 }));
  assert.notDeepEqual(girado.eye_l, mundo.eye_l);
  assert.deepEqual(girado.neck, mundo.neck);
  assert.match(svgComoTexto(prueba, evaluar(prueba), mundo), /data-slot="mouth"/);
});
