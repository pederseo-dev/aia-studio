import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSchema } from '../server/schema.js';
import { createStore } from '../server/store.js';
import { compactJson, createAia, tokenize } from '../server/aia.js';
import { classifyChange } from '../server/events.js';
import { guide } from '../src/core/guide.js';

const schema = loadSchema();
/** @type {string} */
let folder;
/** @type {ReturnType<typeof createStore>} */
let store;
/** @type {ReturnType<typeof createAia>} */
let aia;

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'aia-cli-'));
  store = createStore({ folder, schema });
  aia = createAia({ store, schema });
});

afterEach(() => fs.rm(folder, { recursive: true, force: true }));

/** Runs a command and says what it printed; fails the test if the command failed. @param {string | string[]} command */
async function ok(command) {
  const result = await aia.run(command);
  assert.ok(result.ok, `${command} → ${result.text}`);
  return result.text;
}

test('a command line splits like a shell, and a JSON batch takes the rest of the line', () => {
  assert.deepEqual(tokenize('aia new "Robot Dog" --width 400'), ['new', 'Robot Dog', '--width', '400']);
  assert.deepEqual(tokenize(`ops face --note 'two words' [{"op":"delete","target":"a b"}]`), ['ops', 'face', '--note', 'two words', '[{"op":"delete","target":"a b"}]']);
  assert.throws(() => tokenize('new "Robot'), /not closed/);
});

test('the AI makes a document, changes it, looks at it and undoes only its own steps', async () => {
  assert.match(await ok('new "Face" --width 400 --height 300'), /Created face/);
  const batch = JSON.stringify([
    { op: 'create', type: 'vector', id: 'head' },
    { op: 'create', type: 'path', id: 'jaw', parent: 'head', props: { vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }] } },
  ]);
  assert.match(await ok(['ops', 'face', '--note', 'the head', batch]), /created: head, jaw/);
  // The person changes something in the editor.
  await store.apply('face', [{ op: 'set', target: 'jaw', props: { fill: '#ff0000' } }], { origin: 'user' });
  assert.match(await ok('history face'), /#1 ai {3}2 ops — the head\n#2 user 1 op/);
  assert.match(await ok('show face jaw'), /"fill": "#ff0000"/);
  const render = await aia.run('render face --width 200');
  assert.ok(render.ok && render.image && render.image.subarray(1, 4).toString() === 'PNG');
  assert.match(render.text, /200 × 150/);
  await ok('undo face');
  const { document } = await store.get('face', 'ai');
  assert.deepEqual(document.objects, [], 'the AI undid its batch');
  assert.equal((await aia.run('undo face')).text, 'Nothing to undo');
});

test('mistakes come back as a reason to read, not as a crash', async () => {
  await ok('new Face');
  const fails = async (command, pattern) => {
    const result = await aia.run(command);
    assert.equal(result.ok, false, command);
    assert.match(result.text, pattern);
  };
  await fails('draw face', /no command "draw"/);
  await fails('ops face [{"op":"delete","target":"nose"}]', /no object "nose"/);
  await fails('ops face [{"op":', /not valid JSON/);
  await fails('show nobody', /no document "nobody"/);
  await fails('delete face', /--yes/);
  await fails('guide dragons', /no guide topic/);
  assert.match(await ok('delete face --yes'), /Deleted face/);
});

test('help and the guide cover every command and every type', async () => {
  const help = await ok('help');
  for (const name of Object.keys(aia.commands)) assert.match(help, new RegExp(`aia ${name}`));
  for (const type of [...schema.values()].filter((t) => !t.abstract && t.name !== 'meta')) {
    assert.ok(guide(schema, type.name)?.includes(type.description), type.name);
    assert.match(await ok('guide types'), new RegExp(`\\b${type.name}\\b`));
  }
  assert.match(await ok('help ops'), /atomic/);
});

test('show prints small objects on one line', () => {
  const text = compactJson({ vertices: Array.from({ length: 8 }, (_, i) => ({ x: i * 100, y: i * 50 })) });
  assert.equal(text.split('\n')[2], '    {"x":0,"y":0},');
});

test('changes on disk become notices for the editor', () => {
  const exists = (/** @type {string} */ p) => !p.startsWith('gone');
  assert.deepEqual(classifyChange(path.join('face', 'document.json'), exists), { event: 'document', id: 'face' });
  assert.deepEqual(classifyChange(path.join('face', 'history.jsonl'), exists), { event: 'document', id: 'face' });
  assert.deepEqual(classifyChange('gone', exists), { event: 'deleted', id: 'gone' });
  assert.equal(classifyChange(path.join('face', 'notes.txt'), exists), null);
  assert.equal(classifyChange('.git', exists), null);
});

test('aia move moves points by name in one step', async () => {
  await ok('new Face');
  await ok(['ops', 'face', JSON.stringify([
    { op: 'create', type: 'vector', id: 'head' },
    { op: 'create', type: 'path', id: 'jaw', parent: 'head', props: { vertices: [{ x: 0, y: 0 }, { x: 50, y: 80, name: 'chin', out: { x: 5, y: 0 } }, { x: 100, y: 0 }] } },
  ])]);
  assert.match(await ok('move face jaw.chin jaw.0 --by -10,5'), /Moved jaw.chin, jaw.0 by -10, 5\. Changed: jaw\./);
  const { document } = await store.get('face', 'ai');
  assert.deepEqual(/** @type {any[]} */ (document.objects[1].vertices).slice(0, 2), [{ x: -10, y: 5 }, { x: 40, y: 85, name: 'chin', out: { x: 5, y: 0 } }]);
  assert.match((await aia.run('move face jaw.chin')).text, /--by dx,dy/);
  assert.match((await aia.run('move face jaw.chin --by 1')).text, /two numbers/);
  assert.match((await aia.run('move face jaw.lip --by 1,1')).text, /named points: chin/);
  await ok('undo face');
  assert.deepEqual((await store.get('face', 'ai')).document.objects[1].vertices[0], { x: 0, y: 0 });
});
