import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { loadSchema } from '../server/schema.js';
import { createDocument } from '../src/core/document.js';
import { createStore } from '../server/store.js';

const schema = loadSchema();

async function withStore(fn) {
  const folder = await mkdtemp(path.join(tmpdir(), 'aia-'));
  try {
    await fn(createStore({ schema, folder }));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('deshacer y rehacer van por origen', () =>
  withStore(async (a) => {
    await a.crear('robot', { name: 'Robot' }, { origin: 'ai' });
    await a.applyOps('robot', [{ op: 'create', type: 'rect', id: 'torso' }], { origin: 'ai', note: 'torso' });
    await a.applyOps('robot', [{ op: 'set', target: 'torso', props: { fill: '#ff0000' } }], { origin: 'user', note: 'rojo' });
    await a.applyOps('robot', [{ op: 'create', type: 'ellipse', id: 'head' }], { origin: 'ai', note: 'cabeza' });

    // La IA deshace lo suyo; el retoque del usuario se mantiene.
    let { doc, entrada: entry } = await a.undo('robot', 'ai');
    assert.deepEqual(doc.objects.map((o) => o.id), ['torso']);
    assert.equal(doc.objects[0].fill, '#ff0000');
    assert.deepEqual({ ...entry, lote: entry.lote.map((o) => o.op) }, { n: 4, note: 'cabeza', ops: 1, lote: ['create'] });

    ({ doc } = await a.redo('robot', 'ai'));
    assert.deepEqual(doc.objects.map((o) => o.id), ['torso', 'head']);

    ({ doc } = await a.undo('robot', 'user'));
    assert.equal(doc.objects[0].fill, undefined);
    await assert.rejects(a.undo('robot', 'user'), /Nothing of yours/);

    const { entries, ai, user } = await a.history('robot');
    assert.deepEqual(entries.map((e) => `${e.origin}:${e.kind}`), ['ai:create', 'ai:change', 'user:change', 'ai:change', 'ai:undo', 'ai:redo', 'user:undo']);
    assert.deepEqual(ai, { undo: true, redo: false });
    assert.deepEqual(user, { undo: false, redo: true });
  }));

test('deshacer se niega si un lote posterior del otro origen tocó lo mismo', () =>
  withStore(async (a) => {
    await a.crear('robot', {}, { origin: 'user' });
    await a.applyOps('robot', [{ op: 'create', type: 'rect', id: 'r' }], { origin: 'ai', note: 'crear' });
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { x: 10 } }], { origin: 'ai', note: 'ai x' });
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { x: 20 } }], { origin: 'user', note: 'user x' });
    // La IA no puede deshacer su x: pisaría la del usuario. El error dice qué y quién.
    await assert.rejects(a.undo('robot', 'ai'), /r\.x \(changed by the user in #4 "user x"\)/);
    assert.equal((await a.read('robot')).objects[0].x, 20);
    // Si el usuario deshace lo suyo, el cambio se anula y la IA ya puede.
    await a.undo('robot', 'user');
    const { doc } = await a.undo('robot', 'ai');
    assert.equal(doc.objects[0].x, undefined);
    // Vale igual al revés: el usuario no pisa lo que la IA cambió después.
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { fill: '#ff0000' } }], { origin: 'user', note: 'rojo' });
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { fill: '#00ff00' } }], { origin: 'ai', note: 'verde' });
    await assert.rejects(a.undo('robot', 'user'), /r\.fill \(changed by the AI/);
    // Otras propiedades no chocan.
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { y: 5 } }], { origin: 'user', note: 'y' });
    await a.undo('robot', 'user');
  }));

test('deshacer la creación de un contenedor se niega si el otro origen le metió algo o lo renombró', () =>
  withStore(async (a) => {
    await a.crear('robot', {}, { origin: 'user' });
    await a.applyOps('robot', [{ op: 'create', type: 'group', id: 'head' }], { origin: 'ai' });
    await a.applyOps('robot', [{ op: 'create', type: 'rect', id: 'face', parent: 'head' }], { origin: 'user', note: 'cara' });
    await assert.rejects(a.undo('robot', 'ai'), /head\.children \(changed by the user/);
    await a.applyOps('robot', [{ op: 'rename', target: 'head', id: 'cabeza' }], { origin: 'user', note: 'renombrar' });
    await assert.rejects(a.undo('robot', 'ai'), /head \(changed by the user in #4 "renombrar"\)/);
  }));

test('listar y errores de documento', () =>
  withStore(async (a) => {
    await a.crear('b', { name: 'Bee' }, { origin: 'user' });
    await a.crear('a', {}, { origin: 'user' });
    assert.deepEqual(await a.list(), [{ id: 'a', name: 'Sin nombre' }, { id: 'b', name: 'Bee' }].map((d) => (d.id === 'a' ? { id: 'a', name: 'a' } : d)));
    await assert.rejects(a.crear('a', {}, { origin: 'user' }), /Ya existe/);
    await a.applyOps('b', [{ op: 'create', type: 'rect', id: 'r' }], { origin: 'user' });
    const copy = await a.crear('c', { name: 'Bee 2' }, { origin: 'ai', copyFrom: 'b' });
    assert.deepEqual(copy.objects.map((o) => o.id), ['r']);
    assert.equal(copy.meta.name, 'Bee 2');
    assert.deepEqual((await a.history('c')).entries.map((e) => e.note), ['copy of b']);
    await assert.rejects(a.read('zzz'), /No existe/);
    await assert.rejects(a.read('../x'), /inválido/);
  }));

test('en una pose, deshacer compara y restaura por objeto y propiedad, no la pose entera', () =>
  withStore(async (a) => {
    await a.crear('cara', {}, { origin: 'user' });
    await a.applyOps('cara', [{ op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'rect', id: 'q' }, { op: 'create', type: 'pose', id: 'po' }], { origin: 'ai', note: 'base' });
    await a.applyOps('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 1 } } } }], { origin: 'ai', note: 'ai r' });
    await a.applyOps('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 1 }, q: { y: 2 } } } }], { origin: 'user', note: 'user q' });
    // La IA deshace lo suyo (r) y lo del usuario en la misma pose (q) se queda.
    let { doc } = await a.undo('cara', 'ai');
    assert.deepEqual(doc.objects.find((o) => o.id === 'po').values, { q: { y: 2 } });
    ({ doc } = await a.redo('cara', 'ai'));
    assert.deepEqual(doc.objects.find((o) => o.id === 'po').values, { q: { y: 2 }, r: { x: 1 } });
    // Si el usuario cambia la misma propiedad de la pose, sí choca, y el error nombra la clave.
    await a.applyOps('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 5 }, q: { y: 2 } } } }], { origin: 'user', note: 'user r' });
    await assert.rejects(a.undo('cara', 'ai'), /po\.values\.r\.x \(changed by the user/);
  }));

test('eliminar borra el documento y su historial, y avisa si no existe', () =>
  withStore(async (a) => {
    await a.crear('borrame', {}, { origin: 'user' });
    await a.eliminar('borrame');
    assert.deepEqual(await a.list(), []);
    await assert.rejects(a.read('borrame'), /No existe/);
    await assert.rejects(a.eliminar('borrame'), /No existe el documento "borrame"/);
  }));

test('en un clip, deshacer compara y restaura por pista, no el clip entero', () =>
  withStore(async (a) => {
    await a.crear('clip', {}, { origin: 'user' });
    await a.applyOps('clip', [{ op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'animation', id: 'c', props: { usage: 'puppet' } }], { origin: 'ai', note: 'base' });
    const r = [{ t: 0, value: 1 }, { t: 1, value: 2 }];
    await a.applyOps('clip', [{ op: 'set', target: 'c', props: { tracks: { r: { x: r } } } }], { origin: 'ai', note: 'ai r.x' });
    await a.applyOps('clip', [{ op: 'set', target: 'c', props: { tracks: { r: { x: r, y: [{ t: 0.5, value: 9 }] } } } }], { origin: 'user', note: 'user r.y' });
    let { doc } = await a.undo('clip', 'ai');
    assert.deepEqual(doc.objects.find((o) => o.id === 'c').tracks, { r: { y: [{ t: 0.5, value: 9 }] } });
    ({ doc } = await a.redo('clip', 'ai'));
    assert.deepEqual(doc.objects.find((o) => o.id === 'c').tracks.r.x, r);
    await a.applyOps('clip', [{ op: 'set', target: 'c', props: { tracks: { r: { x: [{ t: 0, value: 5 }], y: [{ t: 0.5, value: 9 }] } } } }], { origin: 'user', note: 'user r.x' });
    await assert.rejects(a.undo('clip', 'ai'), /c\.tracks\.r\.x \(changed by the user/);
  }));

test('leer migra una escena vieja que anima params: pasa a Puppet una sola vez, con una entrada en el historial', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const folder = await mkdtemp(path.join(tmpdir(), 'aia-'));
  try {
    const a = createStore({ schema, folder });
    await a.crear('viejo', { name: 'Viejo' }, { origin: 'user' });
    await a.applyOps('viejo', [{ op: 'create', type: 'param', id: 'happiness' }, { op: 'create', type: 'animation', id: 'escena', props: { usage: 'puppet', duration: 1, tracks: { happiness: { value: [{ t: 0, value: 1 }] } } } }], { origin: 'user', note: 'clip' });
    // Como lo dejaba la versión de antes: una escena con pista de param (hoy no valida).
    const file = path.join(folder, 'viejo', 'document.json');
    const old = JSON.parse(await readFile(file, 'utf8'));
    old.objects.find((o) => o.id === 'escena').usage = 'animate';
    await writeFile(file, JSON.stringify(old));
    const [d1, d2] = await Promise.all([a.read('viejo'), a.read('viejo')]);
    assert.equal(d1.objects.find((o) => o.id === 'escena').usage, 'puppet');
    assert.equal(d2.objects.find((o) => o.id === 'escena').usage, 'puppet');
    const { entries } = await a.history('viejo');
    assert.equal(entries.filter((e) => e.kind === 'migration').length, 1);
    assert.match(entries.at(-1).note, /Scene "escena" animated parameters/);
    // Y vuelve a aceptar operaciones.
    await a.applyOps('viejo', [{ op: 'set', target: 'escena', props: { duration: 2 } }], { origin: 'user' });
    assert.match(await readFile(file, 'utf8'), /"usage": "puppet"/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('formato viejo en disco: personajes/, documento.json e historial.jsonl en español pasan al nuevo una vez', async () => {
  const { migrateLegacyFolder, entryFromLegacy } = await import('../server/store.js');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aia-legacy-'));
  try {
    const old = path.join(base, 'personajes', 'gato');
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, 'documento.json'), JSON.stringify(createDocument({ name: 'Gato' })));
    const lines = [
      { n: 1, fecha: '2026-01-01T00:00:00Z', origen: 'ai', tipo: 'crear', nota: 'document created', ops: [], inversas: [] },
      { n: 2, fecha: '2026-01-01T00:00:01Z', origen: 'user', tipo: 'deshacer', ref: 1, nota: 'undo: x', ops: [], inversas: [] },
    ];
    await fs.writeFile(path.join(old, 'historial.jsonl'), lines.map((l) => JSON.stringify(l) + '\n').join(''));
    const folder = path.join(base, 'documents');
    migrateLegacyFolder(folder);
    migrateLegacyFolder(folder); // repetible
    const dir = path.join(folder, 'gato');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['document.json', 'history.jsonl']);
    const entries = (await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(entries[1], { n: 2, date: '2026-01-01T00:00:01Z', origin: 'user', kind: 'undo', ref: 1, note: 'undo: x', ops: [], inverses: [] });
    // El almacén lee lo migrado: deshacer y rehacer siguen funcionando sobre esas entradas.
    const a = createStore({ schema, folder });
    assert.equal((await a.read('gato')).meta.name, 'Gato');
    assert.deepEqual((await a.history('gato')).entries.map((e) => `${e.origin}:${e.kind}`), ['ai:create', 'user:undo']);
    // Una entrada nueva queda igual.
    assert.deepEqual(entryFromLegacy(entries[0]), entries[0]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
