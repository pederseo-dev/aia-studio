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
    await assert.rejects(a.deshacer('robot', 'user'), /nada tuyo/);

    const { entradas, ai, user } = await a.historial('robot');
    assert.deepEqual(entradas.map((e) => `${e.origen}:${e.tipo}`), ['ai:crear', 'ai:cambio', 'user:cambio', 'ai:cambio', 'ai:deshacer', 'ai:rehacer', 'user:deshacer']);
    assert.deepEqual(ai, { deshacer: true, rehacer: false });
    assert.deepEqual(user, { deshacer: false, rehacer: true });
  }));

test('deshacer avisa si el documento ya no encaja', () =>
  conAlmacen(async (a) => {
    await a.crear('robot', {}, { origen: 'user' });
    await a.operar('robot', [{ op: 'create', type: 'group', id: 'head' }], { origen: 'ai' });
    await a.operar('robot', [{ op: 'create', type: 'rect', id: 'face', parent: 'head' }], { origen: 'user' });
    // Deshacer el grupo de la IA dejaría a "face" sin padre... pero delete arrastra a los hijos, así que se puede.
    // En cambio, si el usuario renombra el grupo, la inversa de la IA ya no encuentra "head".
    await a.operar('robot', [{ op: 'rename', target: 'head', id: 'cabeza' }], { origen: 'user' });
    await assert.rejects(a.deshacer('robot', 'ai'), /el documento cambió después/);
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
    assert.deepEqual((await a.historial('c')).entradas.map((e) => e.nota), ['copia de b']);
    await assert.rejects(a.leer('zzz'), /No existe/);
    await assert.rejects(a.leer('../x'), /inválido/);
  }));
