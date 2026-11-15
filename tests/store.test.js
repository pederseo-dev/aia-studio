import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('undo and redo go by origin', () =>
  withStore(async (a) => {
    await a.create('robot', { name: 'Robot' }, { origin: 'ai' });
    await a.applyOps('robot', [{ op: 'create', type: 'rect', id: 'torso' }], { origin: 'ai', note: 'torso' });
    await a.applyOps('robot', [{ op: 'set', target: 'torso', props: { fill: '#ff0000' } }], { origin: 'user', note: 'rojo' });
    await a.applyOps('robot', [{ op: 'create', type: 'ellipse', id: 'head' }], { origin: 'ai', note: 'cabeza' });

    // The AI undoes its own; the user's touch-up stays.
    let { doc, in: entry } = await a.undo('robot', 'ai');
    assert.deepEqual(doc.objects.map((o) => o.id), ['torso']);
    assert.equal(doc.objects[0].fill, '#ff0000');
    assert.deepEqual({ ...entry, batch: entry.batch.map((o) => o.op) }, { n: 4, note: 'cabeza', ops: 1, batch: ['create'] });

    let redone;
    ({ doc, in: redone } = await a.redo('robot', 'ai'));
    assert.deepEqual(doc.objects.map((o) => o.id), ['torso', 'head']);
    // A redo names the batch it brings back (#4), not the undo entry it reverts.
    assert.equal(redone.n, 4);

    ({ doc } = await a.undo('robot', 'user'));
    assert.equal(doc.objects[0].fill, undefined);
    await assert.rejects(a.undo('robot', 'user'), /Nothing of yours/);

    const { entries, ai, user } = await a.history('robot');
    assert.deepEqual(entries.map((e) => `${e.origin}:${e.kind}`), ['ai:create', 'ai:change', 'user:change', 'ai:change', 'ai:undo', 'ai:redo', 'user:undo']);
    assert.deepEqual(ai, { undo: true, redo: false });
    assert.deepEqual(user, { undo: false, redo: true });
  }));

test('undo refuses if a later batch from the other origin touched the same thing', () =>
  withStore(async (a) => {
    await a.create('robot', {}, { origin: 'user' });
    await a.applyOps('robot', [{ op: 'create', type: 'rect', id: 'r' }], { origin: 'ai', note: 'crear' });
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { x: 10 } }], { origin: 'ai', note: 'ai x' });
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { x: 20 } }], { origin: 'user', note: 'user x' });
    // The AI cannot undo its x: it would overwrite the user's. The error says what and who.
    await assert.rejects(a.undo('robot', 'ai'), /r\.x \(changed by the user in #4 "user x"\)/);
    assert.equal((await a.read('robot')).objects[0].x, 20);
    // If the user undoes their own, the change cancels out and the AI can now.
    await a.undo('robot', 'user');
    const { doc } = await a.undo('robot', 'ai');
    assert.equal(doc.objects[0].x, undefined);
    // The same holds the other way around: the user does not overwrite what the AI changed later.
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { fill: '#ff0000' } }], { origin: 'user', note: 'rojo' });
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { fill: '#00ff00' } }], { origin: 'ai', note: 'verde' });
    await assert.rejects(a.undo('robot', 'user'), /r\.fill \(changed by the AI/);
    // Other properties do not clash.
    await a.applyOps('robot', [{ op: 'set', target: 'r', props: { y: 5 } }], { origin: 'user', note: 'y' });
    await a.undo('robot', 'user');
  }));

test('undoing the creation of a container refuses if the other origin put something in it or renamed it', () =>
  withStore(async (a) => {
    await a.create('robot', {}, { origin: 'user' });
    await a.applyOps('robot', [{ op: 'create', type: 'group', id: 'head' }], { origin: 'ai' });
    await a.applyOps('robot', [{ op: 'create', type: 'rect', id: 'face', parent: 'head' }], { origin: 'user', note: 'cara' });
    await assert.rejects(a.undo('robot', 'ai'), /head\.children \(changed by the user/);
    await a.applyOps('robot', [{ op: 'rename', target: 'head', id: 'cabeza' }], { origin: 'user', note: 'renombrar' });
    await assert.rejects(a.undo('robot', 'ai'), /head \(changed by the user in #4 "renombrar"\)/);
  }));

test('listing and document errors', () =>
  withStore(async (a) => {
    await a.create('b', { name: 'Bee' }, { origin: 'user' });
    await a.create('a', {}, { origin: 'user' });
    assert.deepEqual(await a.list(), [{ id: 'a', name: 'Untitled' }, { id: 'b', name: 'Bee' }].map((d) => (d.id === 'a' ? { id: 'a', name: 'a' } : d)));
    await assert.rejects(a.create('a', {}, { origin: 'user' }), /already exists/);
    await a.applyOps('b', [{ op: 'create', type: 'rect', id: 'r' }], { origin: 'user' });
    const copy = await a.create('c', { name: 'Bee 2' }, { origin: 'ai', copyFrom: 'b' });
    assert.deepEqual(copy.objects.map((o) => o.id), ['r']);
    assert.equal(copy.meta.name, 'Bee 2');
    assert.deepEqual((await a.history('c')).entries.map((e) => e.note), ['copy of b']);
    await assert.rejects(a.read('zzz'), /There is no document/);
    await assert.rejects(a.read('../x'), /Invalid document id/);
  }));

test('in a pose, undo compares and restores per object and property, not the whole pose', () =>
  withStore(async (a) => {
    await a.create('cara', {}, { origin: 'user' });
    await a.applyOps('cara', [{ op: 'create', type: 'rect', id: 'r' }, { op: 'create', type: 'rect', id: 'q' }, { op: 'create', type: 'pose', id: 'po' }], { origin: 'ai', note: 'base' });
    await a.applyOps('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 1 } } } }], { origin: 'ai', note: 'ai r' });
    await a.applyOps('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 1 }, q: { y: 2 } } } }], { origin: 'user', note: 'user q' });
    // The AI undoes its own (r) and the user's in the same pose (q) stays.
    let { doc } = await a.undo('cara', 'ai');
    assert.deepEqual(doc.objects.find((o) => o.id === 'po').values, { q: { y: 2 } });
    ({ doc } = await a.redo('cara', 'ai'));
    assert.deepEqual(doc.objects.find((o) => o.id === 'po').values, { q: { y: 2 }, r: { x: 1 } });
    // If the user changes the same property of the pose, it does clash, and the error names the key.
    await a.applyOps('cara', [{ op: 'set', target: 'po', props: { values: { r: { x: 5 }, q: { y: 2 } } } }], { origin: 'user', note: 'user r' });
    await assert.rejects(a.undo('cara', 'ai'), /po\.values\.r\.x \(changed by the user/);
  }));

test('delete removes the document and its history, and warns if it does not exist', () =>
  withStore(async (a) => {
    await a.create('borrame', {}, { origin: 'user' });
    await a.delete('borrame');
    assert.deepEqual(await a.list(), []);
    await assert.rejects(a.read('borrame'), /There is no document/);
    await assert.rejects(a.delete('borrame'), /There is no document "borrame"/);
  }));

test('in a clip, undo compares and restores per track, not the whole clip', () =>
  withStore(async (a) => {
    await a.create('clip', {}, { origin: 'user' });
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
