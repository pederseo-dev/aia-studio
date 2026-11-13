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
import { usedAssets, readImage, assetName, freeName, planAddImage } from '../src/core/images.js';
import { guideForAI } from '../src/core/guide.js';
import { applyOperations } from '../src/core/operations.js';
import { svgDocument } from '../src/render/svg.js';
import { imageBytes, treeOutline } from '../mcp/tools.js';

const schema = loadSchema();
const op = (doc, ...ops) => applyOperations(doc, ops, schema).doc;

/** Un PNG de verdad (lo dibuja resvg): un cuadrado de un color, de ancho × alto. */
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

test('leerImagen: formato y tamaño de PNG, JPEG, WebP (lossy, lossless, extendido) y SVG', () => {
  assert.deepEqual(readImage(png(30, 20)), { format: 'png', naturalWidth: 30, naturalHeight: 20 });
  // JPEG: SOI, un APP0 y el SOF0 con alto 200 y ancho 320.
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 200, 1, 64, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(readImage(jpeg), { format: 'jpeg', naturalWidth: 320, naturalHeight: 200 });
  const riff = (piece, body) => Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...`WEBP${piece}`].map((c) => c.charCodeAt(0)), [0, 0, 0, 0], body, Array(10).fill(0)));
  // VP8L: 0x2f y ancho-1, alto-1 en 14 bits cada uno (99 → 100, 49 → 50).
  const bits = 99 | (49 << 14);
  assert.deepEqual(readImage(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255])), { format: 'webp', naturalWidth: 100, naturalHeight: 50 });
  // VP8X: banderas, 3 reservados, ancho-1 y alto-1 en 24 bits.
  assert.deepEqual(readImage(riff('VP8X', [0, 0, 0, 0, 255, 1, 0, 127, 0, 0])), { format: 'webp', naturalWidth: 512, naturalHeight: 128 });
  // VP8: etiqueta de cuadro, código de inicio, ancho y alto en 14 bits.
  assert.deepEqual(readImage(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 1, 240, 0])), { format: 'webp', naturalWidth: 320, naturalHeight: 240 });
  const svg = (s) => new TextEncoder().encode(s);
  assert.deepEqual(readImage(svg('<?xml version="1.0"?>\n<!-- hola --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"></svg>')), { format: 'svg', naturalWidth: 40, naturalHeight: 10 });
  assert.deepEqual(readImage(svg('<svg width="200px" viewBox="0 0 40 10"/>')), { format: 'svg', naturalWidth: 200, naturalHeight: 50 });
  assert.deepEqual(readImage(svg('<svg width="100%" height="100%"/>')), { format: 'svg', naturalWidth: 300, naturalHeight: 150 });
  assert.throws(() => readImage(svg('hola')), /Not a PNG, JPEG, WebP or SVG/);
  assert.throws(() => readImage(new Uint8Array()), /empty/);
});

test('nombres de asset: limpios, con la extensión de su formato real, y libres', () => {
  assert.equal(assetName('C:\\fotos\\Mi Foto Ñandú.JPEG', 'jpeg'), 'mi_foto_nandu.jpg');
  assert.equal(assetName('logo.png', 'webp'), 'logo.webp');
  assert.equal(assetName('...', 'png'), 'image.png');
  assert.equal(freeName('sol.png', (n) => ['sol.png', 'sol_2.png'].includes(n)), 'sol_3.png');
  assert.equal(validateValue(schema.types.get('image').properties.src, 'sol.png'), null);
  for (const bad of ['../x.png', 'a/b.png', 'X.png', 'sol.gif', 'sol']) assert.match(validateValue(schema.types.get('image').properties.src, bad), /asset/);
});

test('planAgregarImagen: centrada, de tamaño natural o achicada, con id libre y en las coordenadas del padre', () => {
  let doc = op(createDocument({ width: 400, height: 300 }), { op: 'create', type: 'group', id: 'g', props: { x: 100, y: 50 } });
  const { id, ops } = planAddImage(doc, schema, { src: 'sun.png', naturalWidth: 40, naturalHeight: 20 });
  assert.equal(id, 'sun');
  assert.deepEqual(ops[0], { op: 'create', type: 'image', id: 'sun', parent: null, props: { src: 'sun.png', x: 200, y: 150, width: 40, height: 20 } });
  doc = op(doc, ...ops);
  // Grande: entra en el 90 % del lienzo, en proporción. El id ya está tomado: sun_2. Dentro de g: el centro visto desde g.
  const large = planAddImage(doc, schema, { src: 'sun.png', naturalWidth: 1000, naturalHeight: 500, parent: 'g' });
  assert.equal(large.id, 'sun_2');
  assert.deepEqual(large.ops[0].props, { src: 'sun.png', x: 100, y: 100, width: 360, height: 180 });
  // Solo width: alto en proporción; un punto del documento (donde se soltó) también pasa a las coordenadas del padre.
  assert.deepEqual(planAddImage(doc, schema, { src: 'sun.png', naturalWidth: 40, naturalHeight: 20, width: 10, parent: 'g', point: [110, 60] }).ops[0].props, { src: 'sun.png', x: 10, y: 10, width: 10, height: 5 });
  // Nombre de archivo que no sirve como id.
  assert.equal(planAddImage(doc, schema, { src: '2024-foto.png', naturalWidth: 1, naturalHeight: 1 }).id, 'foto');
  assert.throws(() => planAddImage(doc, schema, { src: 'sun.png', naturalWidth: 1, naturalHeight: 1, id: 'g' }), /already/);
  assert.deepEqual(usedAssets(doc), ['sun.png']);
  assert.deepEqual(validate(doc, schema).errors, []);
});

test('render: image en el SVG (pivote, estirada, pixelated) y en el PNG con los bytes del asset', () => {
  const doc = op(
    createDocument({ width: 100, height: 100, background: '#ffffff' }),
    { op: 'create', type: 'image', id: 'a', props: { src: 'rojo.png', x: 25, y: 50, width: 50, height: 100 } },
    { op: 'create', type: 'image', id: 'b', props: { src: 'falta.png', x: 75, y: 50, width: 50, height: 100, originX: 0, originY: 0, pixelated: true } },
  );
  const svg = svgDocument(doc, schema);
  assert.match(svg, /<image href="rojo\.png" x="-25" y="-50" width="50" height="100" preserveAspectRatio="none"\/>/);
  assert.match(svg, /<image href="falta\.png" x="0" y="0" width="50" height="100" preserveAspectRatio="none" style="image-rendering:pixelated"\/>/);
  assert.match(svgDocument(doc, schema, { assets: (src) => `/x/${src}` }), /href="\/x\/rojo\.png"/);
  // A PNG: el asset que está se ve; el que falta no se dibuja (queda el fondo).
  const result = new Resvg(embedImages(svg, new Map([['rojo.png', png(4, 4)]]))).render();
  const pixel = (x, y) => [...result.pixels.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)];
  assert.deepEqual(pixel(10, 50), [255, 0, 0]);
  assert.deepEqual(pixel(90, 90), [255, 255, 255]);
  // WebP (resvg no lo lee): un recuadro gris con una cruz en su lugar.
  const webp = embedImages('<image href="w.webp" x="-5" y="-5" width="10" height="20" preserveAspectRatio="none"/>', new Map([['w.webp', new Uint8Array([1])]]));
  assert.match(webp, /^<rect x="-5" y="-5" width="10" height="20" [^>]*\/><path d="M-5 -5L5 15M5 -5L-5 15"/);
});

test('una image se pega a un hueso y se anima en poses y clips como las demás capas', () => {
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
  // Su caja cuenta para enlazar por cercanía (como la de un rect): 100 × 100 centrada en el origen.
  assert.deepEqual(boxOf(doc, schema, 'foto'), [-50, -50, 50, 50]);
});

test('almacén: guarda assets (reusa los iguales, renombra los distintos), los sirve, avisa los que faltan y los copia', () =>
  withStore(async (a, folder) => {
    await a.crear('doc', { width: 200, height: 200 }, { origen: 'user' });
    const red = png(10, 10);
    assert.deepEqual(await a.saveAsset('doc', 'Sol.PNG', red), { src: 'sol.png', naturalWidth: 10, naturalHeight: 10, format: 'png', reused: false });
    assert.deepEqual(await a.saveAsset('doc', 'otro.png', red), { src: 'sol.png', naturalWidth: 10, naturalHeight: 10, format: 'png', reused: true });
    assert.equal((await a.saveAsset('doc', 'sol.png', png(10, 10, '#00ff00'))).src, 'sol_2.png');
    await assert.rejects(a.saveAsset('doc', 'x.png', new TextEncoder().encode('hola')), /Not a PNG/);
    await assert.rejects(a.saveAsset('nada', 'x.png', red), /No existe/);
    assert.deepEqual(await a.listAssets('doc'), ['sol.png', 'sol_2.png']);
    const { bytes, mime } = await a.readAsset('doc', 'sol.png');
    assert.equal(mime, 'image/png');
    assert.ok(Buffer.from(red).equals(bytes));
    await assert.rejects(a.readAsset('doc', '../doc/documento.json'), /Invalid asset/);
    await assert.rejects(a.readAsset('doc', 'nada.png'), /no asset/);

    const { warnings } = await a.applyOps('doc', [{ op: 'create', type: 'image', id: 's', props: { src: 'sol.png' } }, { op: 'create', type: 'image', id: 't', props: { src: 'nube.png' } }], { origen: 'ai' });
    assert.deepEqual(warnings.length, 1);
    assert.match(warnings[0], /t \(nube\.png\)/);
    const images = await a.imagesOf('doc', await a.read('doc'));
    assert.deepEqual([...images.keys()], ['sol.png']);

    // Una copia del documento lleva sus assets.
    await a.crear('copia', {}, { origen: 'user', copyFrom: 'doc' });
    assert.deepEqual(await a.listAssets('copia'), ['sol.png', 'sol_2.png']);
    assert.ok(Buffer.from(red).equals(await readFile(path.join(folder, 'copia', 'assets', 'sol.png'))));
  }));

test('MCP: bytesDeImagen lee rutas absolutas y rechaza lo demás; el árbol muestra el archivo', async () => {
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
