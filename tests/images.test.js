// Image layers: reading pictures, the layer's model and drawing, the assets folder, and `aia image`.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { loadSchema } from '../server/schema.js';
import { createStore } from '../server/store.js';
import { createAia } from '../server/aia.js';
import { svgToPng } from '../server/png.js';
import { newDocument } from '../src/core/document.js';
import { applyOps } from '../src/core/operations.js';
import { toSvg } from '../src/core/draw.js';
import { addImageOps, assetName, freeAssetName, readImage, replaceImageOps, usedAssets } from '../src/core/images.js';
import { contentBounds, worldOf } from '../src/core/transform.js';
import { apply } from '../src/core/geometry.js';

const schema = loadSchema();

/** A real PNG: a red w × h picture. @param {number} w @param {number} h */
const redPng = (w, h) =>
  new Uint8Array(svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#ff0000"/></svg>`, w));

/** @param {import('../src/core/document.js').Doc} doc @param {any[]} ops */
const applied = (doc, ops) => applyOps(schema, doc, ops).document;

test('a picture says its format and size from its header', () => {
  assert.deepEqual(readImage(redPng(30, 20)), { format: 'png', naturalWidth: 30, naturalHeight: 20 });
  const svg = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"></svg>');
  assert.deepEqual(readImage(svg), { format: 'svg', naturalWidth: 120, naturalHeight: 60 });
  assert.throws(() => readImage(new TextEncoder().encode('hello')), /Not a PNG, JPEG, WebP or SVG/);
  assert.throws(() => readImage(new Uint8Array()), /empty/);
});

test('asset names come from the file name, with the real format and a free number', () => {
  assert.equal(assetName('C:\\refs\\Mi Foto Ñandú.PNG', 'png'), 'mi_foto_nandu.png');
  assert.equal(assetName('photo.jpeg', 'jpeg'), 'photo.jpg');
  assert.equal(assetName('???', 'webp'), 'image.webp');
  assert.equal(freeAssetName('a.png', (n) => n === 'a.png' || n === 'a_2.png'), 'a_3.png');
});

test('an image layer is sized to fit the artboard and centered, also inside a moved group', () => {
  const doc = newDocument({ width: 400, height: 300 });
  const { id, ops } = addImageOps(doc, { src: 'ref.png', naturalWidth: 1000, naturalHeight: 500 });
  assert.equal(id, 'ref');
  // 90 % of 400 wide: 360 × 180, centered on 200, 150.
  assert.deepEqual(ops[0].props, { src: 'ref.png', width: 360, height: 180, x: 20, y: 60 });
  const one = applied(doc, ops);
  assert.equal(addImageOps(one, { src: 'ref.png', naturalWidth: 10, naturalHeight: 10 }).id, 'ref_2');
  assert.deepEqual(addImageOps(doc, { src: 'ref.png', naturalWidth: 100, naturalHeight: 50, height: 20 }).ops[0].props.width, 40);

  const grouped = applied(doc, [{ op: 'create', type: 'group', id: 'refs', props: { x: 50, y: 10 } }]);
  const plan = addImageOps(grouped, { src: 'ref.png', naturalWidth: 120, naturalHeight: 80, parent: 'refs', at: { x: 100, y: 100 } });
  const after = applied(grouped, plan.ops);
  const layer = /** @type {any} */ (after.objects.find((o) => o.id === plan.id));
  const center = apply(worldOf(after, layer.id), { x: layer.width / 2, y: layer.height / 2 });
  assert.deepEqual(center, { x: 100, y: 100 });
  assert.deepEqual(contentBounds(after, layer), { x: 0, y: 0, width: 120, height: 80 });
  assert.deepEqual(usedAssets(after), ['ref.png']);
  assert.throws(() => addImageOps(doc, { src: 'Bad Name.png', naturalWidth: 1, naturalHeight: 1 }), /Invalid asset name/);
});

test('the schema checks an image layer: an asset name, opacity from 0 to 1, no parts inside', () => {
  const doc = newDocument();
  assert.throws(() => applied(doc, [{ op: 'create', type: 'image', id: 'a', props: { src: '../secret.png' } }]), /assets folder/);
  assert.throws(() => applied(doc, [{ op: 'create', type: 'image', id: 'a', props: { opacity: 2 } }]), /at most 1/);
  assert.throws(
    () => applied(doc, [{ op: 'create', type: 'image', id: 'a' }, { op: 'create', type: 'path', id: 'p', parent: 'a', props: { vertices: [] } }]),
    /cannot go inside "a" \(image\)/,
  );
  const replaced = replaceImageOps(applied(doc, [{ op: 'create', type: 'image', id: 'a', props: { src: 'a.png', width: 200, height: 50 } }]), 'a', {
    src: 'b.png',
    naturalWidth: 100,
    naturalHeight: 100,
  });
  assert.deepEqual(replaced, [{ op: 'set', target: 'a', props: { src: 'b.png', height: 200 } }]);
});

test('an image layer draws as its picture inside the layer transform; a missing file draws nothing', () => {
  const doc = applied(newDocument({ width: 100, height: 100 }), [
    { op: 'create', type: 'image', id: 'ref', props: { src: 'ref.png', width: 50, height: 40, x: 10, opacity: 0.4 } },
  ]);
  const svg = toSvg(doc, { assetUrl: (src) => `/files/${src}` });
  assert.match(svg, /<g data-id="ref" transform="matrix\(1 0 0 1 10 0\)"><image href="\/files\/ref.png" width="50" height="40" preserveAspectRatio="none" opacity="0.4"\/><\/g>/);
  assert.match(toSvg(doc, { assetUrl: () => null }), /<g data-id="ref" transform="[^"]*"\/>/);
  assert.match(toSvg(doc), /href="assets\/ref.png"/);
});

/** @type {string} */
let folder;
/** @type {ReturnType<typeof createStore>} */
let store;
/** @type {ReturnType<typeof createAia>} */
let aia;

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'aia-images-'));
  store = createStore({ folder, schema });
  aia = createAia({ store, schema });
});

afterEach(() => fs.rm(folder, { recursive: true, force: true }));

test('the store keeps pictures in the document’s assets folder, once each', async () => {
  await store.create({ name: 'Trace' });
  const first = await store.saveAsset('trace', 'My Ref.png', redPng(20, 10));
  assert.deepEqual(first, { src: 'my_ref.png', format: 'png', naturalWidth: 20, naturalHeight: 10, reused: false });
  assert.equal((await store.saveAsset('trace', 'my_ref.png', redPng(20, 10))).reused, true);
  const other = await store.saveAsset('trace', 'my_ref.png', redPng(8, 8));
  assert.equal(other.src, 'my_ref_2.png');
  assert.equal((await store.saveAsset('trace', 'again.png', redPng(8, 8))).src, 'again.png');
  assert.deepEqual(await store.assets('trace'), ['again.png', 'my_ref.png', 'my_ref_2.png']);
  assert.equal((await store.readAsset('trace', 'my_ref.png')).mime, 'image/png');
  await assert.rejects(store.readAsset('trace', 'nope.png'), /has no asset/);
  await assert.rejects(store.readAsset('trace', '../document.json'), /not an asset name/);
  await assert.rejects(store.saveAsset('trace', 'x.png', new TextEncoder().encode('not a picture')), /Not a PNG/);
});

test('aia image adds a reference to trace, and render and export carry the picture inside', async () => {
  await store.create({ name: 'Trace', width: 200, height: 100 });
  const file = path.join(folder, 'Robot Front.png');
  await fs.writeFile(file, redPng(400, 200));
  const added = await aia.run(['image', 'trace', file, '--id', 'ref', '--opacity', '0.5']);
  assert.ok(added.ok, added.text);
  assert.match(added.text, /Added the image layer ref: robot_front.png \(400 × 200 px\), drawn 180 × 90 at 10, 5/);
  const { document } = await store.get('trace', 'ai');
  assert.deepEqual(document.objects, [
    // Placed with x, y it is a transformed layer, so its origin is fixed at the middle of the picture, as any layer's.
    { id: 'ref', type: 'image', parent: null, src: 'robot_front.png', width: 180, height: 90, x: 10, y: 5, opacity: 0.5, originX: 90, originY: 45 },
  ]);
  assert.match((await store.history('trace')).at(-1)?.note ?? '', /Image layer ref/);

  // The PNG shows the picture: the middle of the artboard is red over white (half opaque).
  const render = await aia.run('render trace');
  assert.ok(render.ok && render.image);
  const png = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><image href="data:image/png;base64,${render.image.toString('base64')}" width="200" height="100"/></svg>`).render();
  const at = (/** @type {number} */ x, /** @type {number} */ y) => [...png.pixels.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  assert.deepEqual(at(100, 50), [255, 128, 128]);
  assert.deepEqual(at(2, 2), [255, 255, 255]);

  const html = await aia.run('export trace --format html');
  assert.match(String(html.file?.data), /<script type="application\/json" id="aia-assets">\{"robot_front.png":"data:image\/png;base64,/);
  const svg = await aia.run('export trace --format svg');
  assert.match(String(svg.file?.data), /<image href="data:image\/png;base64,/);

  // The layer transforms as any layer, and --replace changes the picture.
  assert.ok((await aia.run('transform trace ref --rotate 90')).ok);
  await fs.writeFile(path.join(folder, 'square.png'), redPng(50, 50));
  const replaced = await aia.run(['image', 'trace', path.join(folder, 'square.png'), '--replace', 'ref']);
  assert.ok(replaced.ok, replaced.text);
  const after = /** @type {any} */ ((await store.get('trace', 'ai')).document.objects[0]);
  assert.equal(after.src, 'square.png');
  assert.equal(after.height, 180);
  assert.equal(after.rotation, 90);

  const missing = await aia.run(['image', 'trace', path.join(folder, 'nope.png')]);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /Can't read the file/);
});
