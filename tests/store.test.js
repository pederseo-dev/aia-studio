import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSchema } from '../server/schema.js';
import { createStore } from '../server/store.js';

/** @type {string} */
let folder;
/** @type {ReturnType<typeof createStore>} */
let store;

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'aia-store-'));
  store = createStore({ folder, schema: loadSchema() });
});

afterEach(() => fs.rm(folder, { recursive: true, force: true }));

const layers = (state) => state.document.objects.map((o) => o.id);

test('create saves a new document with a free id from its name', async () => {
  const first = await store.create({ name: 'Robot Dog', width: 400 });
  const second = await store.create({ name: 'Robot Dog' });
  assert.equal(first.id, 'robot_dog');
  assert.equal(second.id, 'robot_dog_2');
  assert.deepEqual(first.document, { aia: 1, meta: { name: 'Robot Dog', width: 400 }, objects: [] });
  assert.deepEqual(await store.list(), [
    { id: 'robot_dog', name: 'Robot Dog' },
    { id: 'robot_dog_2', name: 'Robot Dog' },
  ]);
  const saved = JSON.parse(await fs.readFile(path.join(folder, 'robot_dog', 'document.json'), 'utf8'));
  assert.deepEqual(saved, first.document);
});

test('a refused batch changes nothing and says why', async () => {
  const { id } = await store.create({ name: 'Doc' });
  await assert.rejects(store.apply(id, [{ op: 'delete', target: 'nose' }], { origin: 'user' }), (/** @type {any} */ e) => e.status === 400);
  assert.deepEqual((await store.get(id, 'user')).document.objects, []);
  await assert.rejects(store.get('missing', 'user'), (/** @type {any} */ e) => e.status === 404);
});

test('undo and redo are per origin', async () => {
  const { id } = await store.create({ name: 'Doc' });
  await store.apply(id, [{ op: 'create', type: 'vector', id: 'user_layer' }], { origin: 'user' });
  await store.apply(id, [{ op: 'create', type: 'vector', id: 'ai_layer' }], { origin: 'ai' });

  // The user undoes their own layer; the AI's stays.
  let state = await store.undo(id, 'user');
  assert.deepEqual(layers(state), ['ai_layer']);
  assert.equal(state.canUndo, false);
  assert.equal(state.canRedo, true);
  assert.equal((await store.get(id, 'ai')).canUndo, true);

  state = await store.redo(id, 'user');
  assert.deepEqual(layers(state), ['user_layer', 'ai_layer']);

  // A new batch clears that origin's redo.
  await store.undo(id, 'user');
  state = await store.apply(id, [{ op: 'create', type: 'group', id: 'other' }], { origin: 'user' });
  assert.equal(state.canRedo, false);
  await assert.rejects(store.redo(id, 'user'), (/** @type {any} */ e) => e.status === 409);

  const history = (await fs.readFile(path.join(folder, id, 'history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(
    history.map((e) => `${e.origin}:${e.kind}`),
    ['user:batch', 'ai:batch', 'user:undo', 'user:redo', 'user:undo', 'user:batch'],
  );
});

test('remove deletes the document folder', async () => {
  const { id } = await store.create({ name: 'Doc' });
  await store.remove(id);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.remove('../outside'), (/** @type {any} */ e) => e.status === 400);
});

// From the first audit: what the store does to every batch, whoever sends it.
const face = [
  { op: 'create', type: 'vector', id: 'face' },
  { op: 'create', type: 'path', id: 'jaw', parent: 'face', props: { vertices: [{ x: 0, y: 0 }, { x: 100, y: 100, name: 'chin' }, { x: 200, y: 0 }] } },
];
const object = (state, id) => state.document.objects.find((o) => o.id === id);

test('a reference that never named a point is refused; one whose point this batch deletes keeps its place', async () => {
  const { id } = await store.create({ name: 'Doc' });
  await store.apply(id, face, { origin: 'ai' });
  const refused = (ops, pattern) => assert.rejects(store.apply(id, ops, { origin: 'ai' }), (/** @type {any} */ e) => e.status === 400 && pattern.test(e.message));
  await refused([{ op: 'create', type: 'path', id: 'm', parent: 'face', props: { vertices: [{ x: 5, y: 5 }, { ref: 'jaw.chinn' }] } }], /no such point/);
  await refused([{ op: 'set', target: 'face', props: { groups: { lid: ['jaw.nose', 'jaw.chin'] } } }], /"jaw.nose", but there is no such point/);
  await refused([{ op: 'create', type: 'path', id: 'm', parent: 'face', props: { vertices: [{ ref: 'jaw.chin', follow: 'jw' }, { x: 1, y: 1 }] } }], /no such part/);
  await refused(/** @type {any} */ ([null]), /unknown op/);
  await refused([{ op: 'set', target: 'jaw', props: { vertices: 'abc' } }], /must be a list of vertices/);
  const state = await store.apply(id, [
    { op: 'create', type: 'path', id: 'm', parent: 'face', props: { closed: false, vertices: [{ ref: 'jaw.chin' }, { x: 9, y: 9 }] } },
    { op: 'delete', target: 'jaw' },
  ], { origin: 'ai' });
  assert.deepEqual(object(state, 'm').vertices[0], { x: 100, y: 100 });
});

test('a transformed layer keeps its origin, and moving the origin keeps the layer in place', async () => {
  const { id } = await store.create({ name: 'Doc' });
  await store.apply(id, face, { origin: 'ai' });
  let state = await store.apply(id, [{ op: 'set', target: 'face', props: { rotation: 90 } }], { origin: 'user' });
  assert.deepEqual([object(state, 'face').originX, object(state, 'face').originY], [100, 50]);
  // Adding content far away does not move what was there.
  state = await store.apply(id, [{ op: 'create', type: 'path', id: 'far', parent: 'face', props: { vertices: [{ x: 500, y: 500 }, { x: 510, y: 500 }, { x: 510, y: 510 }] } }], { origin: 'ai' });
  assert.deepEqual([object(state, 'face').originX, object(state, 'face').originY], [100, 50]);
  // The Inspector (or the AI) sets only the origin: x, y make up for it.
  state = await store.apply(id, [{ op: 'set', target: 'face', props: { originX: 0, originY: 0 } }], { origin: 'user' });
  const layer = object(state, 'face');
  assert.deepEqual([layer.originX, layer.originY, layer.x, layer.y], [0, 0, 150, -50]);
});

test('an undo that would take away or overwrite the other side\'s later work is refused, and can be skipped', async () => {
  const { id } = await store.create({ name: 'Doc' });
  await store.apply(id, face, { origin: 'ai', note: 'the face' });
  // The person draws inside the AI's layer.
  await store.apply(id, [{ op: 'create', type: 'path', id: 'mouth', parent: 'face', props: { vertices: [{ x: 1, y: 1 }, { x: 2, y: 2 }] } }], { origin: 'user' });
  await assert.rejects(store.undo(id, 'ai'), /Cannot undo step #1 \(the face\): it would delete mouth, which the person made or changed inside it/);
  let state = await store.undo(id, 'ai', { skip: true });
  assert.equal(state.document.objects.length, 3, 'skipping changes nothing');
  assert.equal(state.canUndo, false);
  // A rename by the AI after the person's change: the person's undo is refused instead of failing, and skipping
  // lets the person undo older steps.
  await store.apply(id, [{ op: 'set', target: 'mouth', props: { fill: '#ff0000' } }], { origin: 'user' });
  await store.apply(id, [{ op: 'rename', target: 'mouth', id: 'lips' }], { origin: 'ai' });
  await assert.rejects(store.undo(id, 'user'), /it would overwrite mouth.fill|it would .* mouth/);
  await store.undo(id, 'user', { skip: true });
  await assert.rejects(store.undo(id, 'user'), /Cannot undo/);
});
