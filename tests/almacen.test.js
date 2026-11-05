import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cargarEsquema } from '../servidor/esquema.js';
import { crearAlmacen } from '../servidor/almacen.js';

const esquema = cargarEsquema();

async function conAlmacen(fn) {
  const carpeta = await mkdtemp(path.join(tmpdir(), 'aia-'));
  try {
    await fn(crearAlmacen({ esquema, carpeta }));
  } finally {
    await rm(carpeta, { recursive: true, force: true });
  }
}

test('deshacer y rehacer van por origen', () =>
  conAlmacen(async (a) => {
    await a.crear('robot', { name: 'Robot' }, { origen: 'ai' });
    await a.operar('robot', [{ op: 'create', type: 'rect', id: 'torso' }], { origen: 'ai', nota: 'torso' });
    await a.operar('robot', [{ op: 'set', target: 'torso', props: { fill: '#ff0000' } }], { origen: 'user', nota: 'rojo' });
    await a.operar('robot', [{ op: 'create', type: 'ellipse', id: 'head' }], { origen: 'ai', nota: 'cabeza' });

    // La IA deshace lo suyo; el retoque del usuario se mantiene.
    let { doc, entrada } = await a.deshacer('robot', 'ai');
    assert.deepEqual(doc.objects.map((o) => o.id), ['torso']);
    assert.equal(doc.objects[0].fill, '#ff0000');
    assert.deepEqual({ ...entrada, lote: entrada.lote.map((o) => o.op) }, { n: 4, nota: 'cabeza', ops: 1, lote: ['create'] });

    ({ doc } = await a.rehacer('robot', 'ai'));
    assert.deepEqual(doc.objects.map((o) => o.id), ['torso', 'head']);

    ({ doc } = await a.deshacer('robot', 'user'));
    assert.equal(doc.objects[0].fill, undefined);
    await assert.rejects(a.deshacer('robot', 'user'), /Nothing of yours/);

    const { entradas, ai, user } = await a.historial('robot');
    assert.deepEqual(entradas.map((e) => `${e.origen}:${e.tipo}`), ['ai:crear', 'ai:cambio', 'user:cambio', 'ai:cambio', 'ai:deshacer', 'ai:rehacer', 'user:deshacer']);
    assert.deepEqual(ai, { deshacer: true, rehacer: false });
    assert.deepEqual(user, { deshacer: false, rehacer: true });
  }));

test('deshacer se niega si un lote posterior del otro origen tocó lo mismo', () =>
  conAlmacen(async (a) => {
    await a.crear('robot', {}, { origen: 'user' });
    await a.operar('robot', [{ op: 'create', type: 'rect', id: 'r' }], { origen: 'ai', nota: 'crear' });
    await a.operar('robot', [{ op: 'set', target: 'r', props: { x: 10 } }], { origen: 'ai', nota: 'ai x' });
    await a.operar('robot', [{ op: 'set', target: 'r', props: { x: 20 } }], { origen: 'user', nota: 'user x' });
    // La IA no puede deshacer su x: pisaría la del usuario. El error dice qué y quién.
    await assert.rejects(a.deshacer('robot', 'ai'), /r\.x \(changed by the user in #4 "user x"\)/);
    assert.equal((await a.leer('robot')).objects[0].x, 20);
    // Si el usuario deshace lo suyo, el cambio se anula y la IA ya puede.
    await a.deshacer('robot', 'user');
    const { doc } = await a.deshacer('robot', 'ai');
    assert.equal(doc.objects[0].x, undefined);
    // Vale igual al revés: el usuario no pisa lo que la IA cambió después.
    await a.operar('robot', [{ op: 'set', target: 'r', props: { fill: '#ff0000' } }], { origen: 'user', nota: 'rojo' });
    await a.operar('robot', [{ op: 'set', target: 'r', props: { fill: '#00ff00' } }], { origen: 'ai', nota: 'verde' });
    await assert.rejects(a.deshacer('robot', 'user'), /r\.fill \(changed by the AI/);
    // Otras propiedades no chocan.
    await a.operar('robot', [{ op: 'set', target: 'r', props: { y: 5 } }], { origen: 'user', nota: 'y' });
    await a.deshacer('robot', 'user');
  }));

test('deshacer la creación de un contenedor se niega si el otro origen le metió algo o lo renombró', () =>
  conAlmacen(async (a) => {
    await a.crear('robot', {}, { origen: 'user' });
    await a.operar('robot', [{ op: 'create', type: 'group', id: 'head' }], { origen: 'ai' });
    await a.operar('robot', [{ op: 'create', type: 'rect', id: 'face', parent: 'head' }], { origen: 'user', nota: 'cara' });
    await assert.rejects(a.deshacer('robot', 'ai'), /head\.children \(changed by the user/);
    await a.operar('robot', [{ op: 'rename', target: 'head', id: 'cabeza' }], { origen: 'user', nota: 'renombrar' });
    await assert.rejects(a.deshacer('robot', 'ai'), /head \(changed by the user in #4 "renombrar"\)/);
  }));

test('listar y errores de documento', () =>
  conAlmacen(async (a) => {
    await a.crear('b', { name: 'Bee' }, { origen: 'user' });
    await a.crear('a', {}, { origen: 'user' });
    assert.deepEqual(await a.listar(), [{ id: 'a', name: 'Sin nombre' }, { id: 'b', name: 'Bee' }].map((d) => (d.id === 'a' ? { id: 'a', name: 'a' } : d)));
    await assert.rejects(a.crear('a', {}, { origen: 'user' }), /Ya existe/);
    await a.operar('b', [{ op: 'create', type: 'rect', id: 'r' }], { origen: 'user' });
    const copia = await a.crear('c', { name: 'Bee 2' }, { origen: 'ai', copiarDe: 'b' });
    assert.deepEqual(copia.objects.map((o) => o.id), ['r']);
    assert.equal(copia.meta.name, 'Bee 2');
    assert.deepEqual((await a.historial('c')).entradas.map((e) => e.nota), ['copy of b']);
    await assert.rejects(a.leer('zzz'), /No existe/);
    await assert.rejects(a.leer('../x'), /inválido/);
  }));

test('en una pose, deshacer compara y restaura por objeto y propiedad, no la pose entera', () =>
  conAlmacen(async (a) => {
    await a.crear('cara', {}, { origen: 'user' });
    await a.operar('cara', [{ op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'rect', id: 'q' }, { op: 'create', type: 'pose', id: 'po' }], { origen: 'ai', nota: 'base' });
    await a.operar('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 1 } } } }], { origen: 'ai', nota: 'ai r' });
    await a.operar('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 1 }, q: { y: 2 } } } }], { origen: 'user', nota: 'user q' });
    // La IA deshace lo suyo (r) y lo del usuario en la misma pose (q) se queda.
    let { doc } = await a.deshacer('cara', 'ai');
    assert.deepEqual(doc.objects.find((o) => o.id === 'po').values, { q: { y: 2 } });
    ({ doc } = await a.rehacer('cara', 'ai'));
    assert.deepEqual(doc.objects.find((o) => o.id === 'po').values, { q: { y: 2 }, r: { x: 1 } });
    // Si el usuario cambia la misma propiedad de la pose, sí choca, y el error nombra la clave.
    await a.operar('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 5 }, q: { y: 2 } } } }], { origen: 'user', nota: 'user r' });
    await assert.rejects(a.deshacer('cara', 'ai'), /po\.values\.r\.x \(changed by the user/);
  }));

test('eliminar borra el documento y su historial, y avisa si no existe', () =>
  conAlmacen(async (a) => {
    await a.crear('borrame', {}, { origen: 'user' });
    await a.eliminar('borrame');
    assert.deepEqual(await a.listar(), []);
    await assert.rejects(a.leer('borrame'), /No existe/);
    await assert.rejects(a.eliminar('borrame'), /No existe el documento "borrame"/);
  }));

test('en un clip, deshacer compara y restaura por pista, no el clip entero', () =>
  conAlmacen(async (a) => {
    await a.crear('clip', {}, { origen: 'user' });
    await a.operar('clip', [{ op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'animation', id: 'c', props: { usage: 'puppet' } }], { origen: 'ai', nota: 'base' });
    const r = [{ t: 0, value: 1 }, { t: 1, value: 2 }];
    await a.operar('clip', [{ op: 'set', target: 'c', props: { tracks: { r: { x: r } } } }], { origen: 'ai', nota: 'ai r.x' });
    await a.operar('clip', [{ op: 'set', target: 'c', props: { tracks: { r: { x: r, y: [{ t: 0.5, value: 9 }] } } } }], { origen: 'user', nota: 'user r.y' });
    let { doc } = await a.deshacer('clip', 'ai');
    assert.deepEqual(doc.objects.find((o) => o.id === 'c').tracks, { r: { y: [{ t: 0.5, value: 9 }] } });
    ({ doc } = await a.rehacer('clip', 'ai'));
    assert.deepEqual(doc.objects.find((o) => o.id === 'c').tracks.r.x, r);
    await a.operar('clip', [{ op: 'set', target: 'c', props: { tracks: { r: { x: [{ t: 0, value: 5 }], y: [{ t: 0.5, value: 9 }] } } } }], { origen: 'user', nota: 'user r.x' });
    await assert.rejects(a.deshacer('clip', 'ai'), /c\.tracks\.r\.x \(changed by the user/);
  }));
