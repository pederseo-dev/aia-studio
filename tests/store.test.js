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
