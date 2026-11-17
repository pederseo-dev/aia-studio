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
  // Undoing its batch would delete the jaw the person recolored afterwards: refused, and the AI can skip it.
  assert.match((await aia.run('undo face')).text, /Cannot undo step #1 \(the head\): it would delete jaw, which the person changed/);
  await ok('undo face --skip');
  const { document } = await store.get('face', 'ai');
  assert.equal(document.objects.length, 2, 'nothing changed');
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

test('the AI welds, names, adds points, follows and groups by name, as the editor does', async () => {
  await ok('new Face');
  await ok(['ops', 'face', JSON.stringify([
    { op: 'create', type: 'vector', id: 'head' },
    { op: 'create', type: 'path', id: 'jaw', parent: 'head', props: { closed: false, fill: null, vertices: [{ x: 0, y: 0 }, { x: 50, y: 80 }, { x: 100, y: 0 }] } },
    { op: 'create', type: 'path', id: 'skin', parent: 'head', props: { vertices: [{ x: 0, y: 1 }, { x: 99, y: 1 }, { x: 50, y: -60 }] } },
    { op: 'create', type: 'path', id: 'mouth', parent: 'head', props: { closed: false, fill: null, vertices: [{ x: 30, y: 30 }, { x: 70, y: 31 }] } },
  ])]);
  await ok('name face jaw.1 chin');
  assert.match(await ok('weld face skin.0 jaw.0'), /Weld skin.0 to jaw.jaw_1/);
  await ok('weld face skin.1 jaw.2');
  assert.match(await ok('follow face skin.0 skin.1'), /skin follows jaw/);
  await ok('weld face mouth.1 --on jaw');
  assert.match(await ok('add-point face mouth --at 50,20 --name mid'), /Added mouth.mid at \d/);
  await ok('group face head.lower jaw.chin mouth.mid');
  const shown = await ok('show face skin --resolved');
  assert.match(shown, /"ref":"jaw.jaw_1","follow":"jaw","x":0,"y":0/);
  // Deleting the jaw keeps what shared its points where it was (as in the editor), instead of refusing.
  await ok('ops face [{"op":"delete","target":"jaw"}]');
  const { document } = await store.get('face', 'ai');
  assert.deepEqual(/** @type {any[]} */ (document.objects.find((o) => o.id === 'skin')?.vertices).slice(0, 2), [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  assert.deepEqual(document.objects[0].groups, { lower: ['mouth.mid'] });
  assert.match((await aia.run('weld face mouth.0 mouth.mid')).text, /only its two open ends weld/);
  assert.match((await aia.run('follow face mouth.0 mouth.1')).text, /share points|weld them first/);
});

test('aia transform turns a layer without touching its vertices, and --apply puts it into them', async () => {
  await ok('new Robot');
  const box = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  await ok(['ops', 'robot', JSON.stringify([
    { op: 'create', type: 'vector', id: 'arm' },
    { op: 'create', type: 'path', id: 'hand', parent: 'arm', props: { vertices: box } },
  ])]);
  assert.match(await ok('transform robot arm --rotate 90 --move 10,0'), /arm: x 10, y 0, rotation 90/);
  let { document } = await store.get('robot', 'ai');
  assert.deepEqual(document.objects[0], { id: 'arm', type: 'vector', parent: null, x: 10, rotation: 90, originX: 50, originY: 50 });
  assert.deepEqual(document.objects[1].vertices, box);
  await ok('transform robot arm --apply');
  ({ document } = await store.get('robot', 'ai'));
  assert.deepEqual(document.objects[1].vertices, [{ x: 110, y: 0 }, { x: 110, y: 100 }, { x: 10, y: 100 }, { x: 10, y: 0 }]);
  await ok('transform robot hand --scale 0.5');
  ({ document } = await store.get('robot', 'ai'));
  assert.deepEqual(document.objects[1].vertices[0], { x: 85, y: 25 });
  assert.match((await aia.run('transform robot arm')).text, /Say what to do/);
});

test('the AI draws, reshapes, deletes and copies by name, as the editor does', async () => {
  await ok('new Face');
  assert.match(await ok('ellipse face face head --box 0,0,200,200 --points 8 --names top,tr,right,br,bottom,bl,left,tl'), /8 points, named head.top/);
  assert.match(await ok('rect face face box --box 300,0,100,50 --fill none --stroke-width 4'), /4 points/);
  let doc = (await store.get('face', 'ai')).document;
  const head = /** @type {any[]} */ (doc.objects.find((o) => o.id === 'head')?.vertices);
  assert.deepEqual([head[0].x, head[0].y, head[0].name], [100, 0, 'top']);
  assert.deepEqual([Math.round(head[2].x), Math.round(head[2].y)], [200, 100]);
  assert.deepEqual(doc.objects.find((o) => o.id === 'box'), {
    id: 'box', type: 'path', parent: 'face', fill: null, strokeWidth: 4,
    vertices: [{ x: 300, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 50 }, { x: 300, y: 50 }],
  });
  await ok('corner face head.top');
  doc = (await store.get('face', 'ai')).document;
  assert.equal(/** @type {any[]} */ (doc.objects[1].vertices)[0].in, undefined);
  await ok('curve face head.top');
  await ok('weld face box.0 head.right');
  await ok('delete-point face head.right');
  doc = (await store.get('face', 'ai')).document;
  assert.equal(/** @type {any[]} */ (doc.objects[1].vertices).length, 7);
  assert.deepEqual(/** @type {any[]} */ (doc.objects[2].vertices)[0], { x: 200, y: 100 }, 'the shared vertex kept its place');
  assert.match(await ok('copy face box --move 0,100'), /Made box_2/);
  assert.match(await ok('transform face box box_2 --rotate 90 --around 0,0'), /around 0, 0/);
  doc = (await store.get('face', 'ai')).document;
  assert.deepEqual(/** @type {any[]} */ (doc.objects.find((o) => o.id === 'box_2')?.vertices)[1], { x: -100, y: 400 });
  const labeled = await aia.run('render face --labels --width 300');
  assert.ok(labeled.ok && labeled.image);
  assert.match((await aia.run('delete-point face box.0 box.1 box.2')).text, /fewer than 2 points/);
  assert.match((await aia.run('transform face box face')).text, /layers turn one at a time/);
});
