import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { loadSchema } from '../server/schema.js';
import { createStore } from '../server/store.js';
import { embedImages, svgToPng } from '../server/png.js';
import { findObject, createDocument, validate } from '../src/core/document.js';
import { validateValue } from '../src/core/schema.js';
import { boxOf } from '../src/core/skeleton.js';
import { usedAssets, readImage, assetName, freeName, planAddImage, planReplaceImage } from '../src/core/images.js';
import { guideForAI } from '../src/core/guide.js';
import { applyOperations } from '../src/core/operations.js';
import { svgDocument } from '../src/render/svg.js';
import { imageBytes, treeOutline, addImage, documentText } from '../mcp/tools.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema).doc;

/** A real PNG (drawn by resvg): a square of one color, width × height. */
const png = (naturalWidth, naturalHeight, color = '#ff0000') =>
  new Uint8Array(svgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${naturalWidth}" height="${naturalHeight}"><rect width="${naturalWidth}" height="${naturalHeight}" fill="${color}"/></svg>`, naturalWidth));

async function withStore(fn) {
  const folder = await mkdtemp(path.join(tmpdir(), 'aia-img-'));
  try {
    await fn(createStore({ schema, folder }), folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('readImage: format and size of PNG, JPEG, WebP (lossy, lossless, extended) and SVG', () => {
  assert.deepEqual(readImage(png(30, 20)), { format: 'png', naturalWidth: 30, naturalHeight: 20 });
  // JPEG: SOI, an APP0 and the SOF0 with height 200 and width 320.
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 200, 1, 64, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(readImage(jpeg), { format: 'jpeg', naturalWidth: 320, naturalHeight: 200 });
  const riff = (piece, body) => Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...`WEBP${piece}`].map((c) => c.charCodeAt(0)), [0, 0, 0, 0], body, Array(10).fill(0)));
  // VP8L: 0x2f and width-1, height-1 in 14 bits each (99 → 100, 49 → 50).
  const bits = 99 | (49 << 14);
  assert.deepEqual(readImage(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255])), { format: 'webp', naturalWidth: 100, naturalHeight: 50 });
  // VP8X: flags, 3 reserved, width-1 and height-1 in 24 bits.
  assert.deepEqual(readImage(riff('VP8X', [0, 0, 0, 0, 255, 1, 0, 127, 0, 0])), { format: 'webp', naturalWidth: 512, naturalHeight: 128 });
  // VP8: frame tag, start code, width and height in 14 bits.
  assert.deepEqual(readImage(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 1, 240, 0])), { format: 'webp', naturalWidth: 320, naturalHeight: 240 });
  const svg = (s) => new TextEncoder().encode(s);
  assert.deepEqual(readImage(svg('<?xml version="1.0"?>\n<!-- hola --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"></svg>')), { format: 'svg', naturalWidth: 40, naturalHeight: 10 });
  assert.deepEqual(readImage(svg('<svg width="200px" viewBox="0 0 40 10"/>')), { format: 'svg', naturalWidth: 200, naturalHeight: 50 });
  assert.deepEqual(readImage(svg('<svg width="100%" height="100%"/>')), { format: 'svg', naturalWidth: 300, naturalHeight: 150 });
  assert.throws(() => readImage(svg('hola')), /Not a PNG, JPEG, WebP or SVG/);
  assert.throws(() => readImage(new Uint8Array()), /empty/);
});

test('asset names: clean, with the extension of their real format, and free', () => {
  assert.equal(assetName('C:\\fotos\\Mi Foto Ñandú.JPEG', 'jpeg'), 'mi_foto_nandu.jpg');
  assert.equal(assetName('logo.png', 'webp'), 'logo.webp');
  assert.equal(assetName('...', 'png'), 'image.png');
  assert.equal(freeName('sol.png', (n) => ['sol.png', 'sol_2.png'].includes(n)), 'sol_3.png');
  assert.equal(validateValue(schema.types.get('image').properties.src, 'sol.png'), null);
  for (const bad of ['../x.png', 'a/b.png', 'X.png', 'sol.gif', 'sol']) assert.match(validateValue(schema.types.get('image').properties.src, bad), /asset/);
});

test('planAddImage: centered, at natural size or shrunk, with a free id and in the parent coordinates', () => {
  let doc = op(createDocument({ width: 400, height: 300 }), { op: 'create', type: 'group', id: 'g', props: { x: 100, y: 50 } });
  const { id, ops } = planAddImage(doc, schema, { src: 'sun.png', naturalWidth: 40, naturalHeight: 20 });
  assert.equal(id, 'sun');
  assert.deepEqual(ops[0], { op: 'create', type: 'image', id: 'sun', parent: null, props: { src: 'sun.png', x: 200, y: 150, width: 40, height: 20 } });
  doc = op(doc, ...ops);
  // Large: fits in 90 % of the canvas, in proportion. The id is taken: sun_2. Inside g: the center seen from g.
  const large = planAddImage(doc, schema, { src: 'sun.png', naturalWidth: 1000, naturalHeight: 500, parent: 'g' });
  assert.equal(large.id, 'sun_2');
  assert.deepEqual(large.ops[0].props, { src: 'sun.png', x: 100, y: 100, width: 360, height: 180 });
  // Only width: height in proportion; a document point (where it was dropped) also goes to the parent's coordinates.
  assert.deepEqual(planAddImage(doc, schema, { src: 'sun.png', naturalWidth: 40, naturalHeight: 20, width: 10, parent: 'g', point: [110, 60] }).ops[0].props, { src: 'sun.png', x: 10, y: 10, width: 10, height: 5 });
  // File name that does not work as an id.
  assert.equal(planAddImage(doc, schema, { src: '2024-foto.png', naturalWidth: 1, naturalHeight: 1 }).id, 'foto');
  assert.throws(() => planAddImage(doc, schema, { src: 'sun.png', naturalWidth: 1, naturalHeight: 1, id: 'g' }), /already/);
  assert.deepEqual(usedAssets(doc), ['sun.png']);
  assert.deepEqual(validate(doc, schema).errors, []);
});

test('render: image in the SVG (pivot, stretched, pixelated) and in the PNG with the asset bytes', () => {
  const doc = op(
    createDocument({ width: 100, height: 100, background: '#ffffff' }),
    { op: 'create', type: 'image', id: 'a', props: { src: 'rojo.png', x: 25, y: 50, width: 50, height: 100 } },
    { op: 'create', type: 'image', id: 'b', props: { src: 'falta.png', x: 75, y: 50, width: 50, height: 100, originX: 0, originY: 0, pixelated: true } },
  );
  const svg = svgDocument(doc, schema);
  assert.match(svg, /<image href="rojo\.png" x="-25" y="-50" width="50" height="100" preserveAspectRatio="none"\/>/);
  assert.match(svg, /<image href="falta\.png" x="0" y="0" width="50" height="100" preserveAspectRatio="none" style="image-rendering:pixelated"\/>/);
  assert.match(svgDocument(doc, schema, { assets: (src) => `/x/${src}` }), /href="\/x\/rojo\.png"/);
  // To PNG: the asset that exists is shown; the missing one is not drawn (the background remains).
  const result = new Resvg(embedImages(svg, new Map([['rojo.png', png(4, 4)]]))).render();
  const pixel = (x, y) => [...result.pixels.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)];
  assert.deepEqual(pixel(10, 50), [255, 0, 0]);
  assert.deepEqual(pixel(90, 90), [255, 255, 255]);
  // WebP (resvg does not read it): a gray box with a cross in its place.
  const webp = embedImages('<image href="w.webp" x="-5" y="-5" width="10" height="20" preserveAspectRatio="none"/>', new Map([['w.webp', new Uint8Array([1])]]));
  assert.match(webp, /^<rect x="-5" y="-5" width="10" height="20" [^>]*\/><path d="M-5 -5L5 15M5 -5L-5 15"/);
});

test('an image sticks to a bone and is animated in poses and clips like the other layers', () => {
  const doc = op(
    createDocument({}),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'b', parent: 'rig', props: { length: 50 } },
    { op: 'create', type: 'image', id: 'foto', parent: 'rig', props: { src: 'foto.png', bone: 'b' } },
    { op: 'create', type: 'pose', id: 'grande', props: { values: { foto: { width: 300, opacity: 0.5, visible: false } } } },
    { op: 'create', type: 'animation', id: 'clip', props: { duration: 1, tracks: { foto: { rotation: [{ t: 0, value: 0 }, { t: 1, value: 90 }], width: [{ t: 0, value: 100 }, { t: 1, value: 200 }] } } } },
  );
  assert.deepEqual(validate(doc, schema).errors, []);
  assert.match(svgDocument(doc, schema, { pose: 'grande' }), /data-id="foto"[^>]*opacity="0\.5" display="none"><image href="foto\.png" x="-150" y="-50" width="300"/);
  assert.match(svgDocument(doc, schema, { animation: 'clip', time: 0.5 }), /<image href="foto\.png" x="-75" y="-50" width="150"/);
  assert.throws(() => op(doc, { op: 'set', target: 'grande', props: { values: { foto: { src: 'otra.png' } } } }), /src/);
  // Its box counts for binding by proximity (like a rect's): 100 × 100 centered on the origin.
  assert.deepEqual(boxOf(doc, schema, 'foto'), [-50, -50, 50, 50]);
});

test('store: saves assets (reuses identical ones, renames different ones), serves them, warns about missing ones and copies them', () =>
  withStore(async (a, folder) => {
    await a.create('doc', { width: 200, height: 200 }, { origin: 'user' });
    const red = png(10, 10);
    assert.deepEqual(await a.saveAsset('doc', 'Sol.PNG', red), { src: 'sol.png', naturalWidth: 10, naturalHeight: 10, format: 'png', reused: false });
    assert.deepEqual(await a.saveAsset('doc', 'otro.png', red), { src: 'sol.png', naturalWidth: 10, naturalHeight: 10, format: 'png', reused: true });
    assert.equal((await a.saveAsset('doc', 'sol.png', png(10, 10, '#00ff00'))).src, 'sol_2.png');
    await assert.rejects(a.saveAsset('doc', 'x.png', new TextEncoder().encode('hola')), /Not a PNG/);
    await assert.rejects(a.saveAsset('nada', 'x.png', red), /There is no document/);
    assert.deepEqual(await a.listAssets('doc'), ['sol.png', 'sol_2.png']);
    const { bytes, mime } = await a.readAsset('doc', 'sol.png');
    assert.equal(mime, 'image/png');
    assert.ok(Buffer.from(red).equals(bytes));
    await assert.rejects(a.readAsset('doc', '../doc/document.json'), /Invalid asset/);
    await assert.rejects(a.readAsset('doc', 'nada.png'), /no asset/);

    const { warnings } = await a.applyOps('doc', [{ op: 'create', type: 'image', id: 's', props: { src: 'sol.png' } }, { op: 'create', type: 'image', id: 't', props: { src: 'nube.png' } }], { origin: 'ai' });
    assert.deepEqual(warnings.length, 1);
    assert.match(warnings[0], /t \(nube\.png\)/);
    const images = await a.imagesOf('doc', await a.read('doc'));
    assert.deepEqual([...images.keys()], ['sol.png']);

    // A copy of the document carries its assets.
    await a.create('copia', {}, { origin: 'user', copyFrom: 'doc' });
    assert.deepEqual(await a.listAssets('copia'), ['sol.png', 'sol_2.png']);
    assert.ok(Buffer.from(red).equals(await readFile(path.join(folder, 'copia', 'assets', 'sol.png'))));
  }));

test('MCP: imageBytes reads absolute paths and rejects the rest; the tree shows the file', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'aia-img-'));
  try {
    const file = path.join(folder, 'Logo.png');
    await writeFile(file, png(3, 3));
    const { bytes, name } = await imageBytes({ path: file });
    assert.equal(name, 'Logo.png');
    assert.equal(readImage(bytes).naturalWidth, 3);
    await assert.rejects(imageBytes({ path: 'Logo.png' }), /absolute/);
    await assert.rejects(imageBytes({ path: path.join(folder, 'nada.png') }), /No file/);
    await assert.rejects(imageBytes({}), /exactly one/);
    await assert.rejects(imageBytes({ url: 'file:///etc/passwd' }), /http or https/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  const doc = op(createDocument({}), { op: 'create', type: 'image', id: 'logo', props: { src: 'logo.png', width: 64, height: 32 } });
  assert.match(treeOutline(doc, schema), /- logo \(image\) \[logo\.png, 64×32\]/);
  assert.ok(findObject(doc, 'logo'));
  assert.match(guideForAI(schema), /add_image/);
});

test('add_image: a layer that fails leaves no file in assets/; replace keeps the width; get_document lists the files', () =>
  withStore(async (a) => {
    await a.create('doc', { width: 200, height: 200 }, { origin: 'user' });
    const entry = { origin: 'ai' };
    const first = await addImage(a, schema, 'doc', { bytes: png(20, 10), name: 'logo.png', layer: 'logo' }, entry);
    assert.equal(first.layerId, 'logo');
    // Same id again with a different file: the batch fails and the new file does not stay.
    await assert.rejects(addImage(a, schema, 'doc', { bytes: png(8, 8, '#0000ff'), name: 'blue.png', layer: 'logo' }, entry), /already an object with id "logo"/);
    assert.deepEqual(await a.listAssets('doc'), ['logo.png']);
    // A file that is reused (same bytes) is not deleted when the layer fails.
    await assert.rejects(addImage(a, schema, 'doc', { bytes: png(20, 10), name: 'otra.png', parent: 'nada' }, entry));
    assert.deepEqual(await a.listAssets('doc'), ['logo.png']);
    // replace: another file in the same layer, same width, height in the new proportion.
    const { doc } = await addImage(a, schema, 'doc', { bytes: png(10, 20, '#00ff00'), name: 'tall.png', replace: 'logo' }, entry);
    const logo = findObject(doc, 'logo');
    assert.deepEqual([logo.src, logo.width, logo.height], ['tall.png', first.doc.objects[0].width, first.doc.objects[0].width * 2]);
    assert.throws(() => planReplaceImage(doc, 'nada', { src: 'tall.png', naturalWidth: 1, naturalHeight: 1 }), /no object "nada"/);
    // get_document: files with their size and who uses them.
    const text = documentText(doc, schema, { json: false, assets: await a.assetsInfo('doc', doc) });
    assert.match(text, /- logo\.png \(20×10 px\) unused/);
    assert.match(text, /- tall\.png \(10×20 px\) used by logo/);
    // An unused file can be discarded; a used one is kept.
    assert.equal(await a.discardAsset('doc', 'tall.png'), false);
    assert.equal(await a.discardAsset('doc', 'logo.png'), true);
    assert.deepEqual(await a.listAssets('doc'), ['tall.png']);
  }));
