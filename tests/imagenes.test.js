import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { cargarEsquema } from '../servidor/esquema.js';
import { crearAlmacen } from '../servidor/almacen.js';
import { incrustarImagenes, svgAPng } from '../servidor/png.js';
import { buscar, crearDocumento, validar } from '../src/core/documento.js';
import { validarValor } from '../src/core/esquema.js';
import { cajaDe } from '../src/core/esqueleto.js';
import { assetsUsados, leerImagen, nombreDeAsset, nombreLibre, planAgregarImagen } from '../src/core/imagenes.js';
import { guiaParaIA } from '../src/core/guia.js';
import { aplicarOperaciones } from '../src/core/operaciones.js';
import { svgDocumento } from '../src/render/svg.js';
import { bytesDeImagen, esquemaDelArbol } from '../mcp/herramientas.js';

const esquema = cargarEsquema();
const op = (doc, ...ops) => aplicarOperaciones(doc, ops, esquema).doc;

/** Un PNG de verdad (lo dibuja resvg): un cuadrado de un color, de ancho × alto. */
const png = (ancho, alto, color = '#ff0000') =>
  new Uint8Array(svgAPng(`<svg xmlns="http://www.w3.org/2000/svg" width="${ancho}" height="${alto}"><rect width="${ancho}" height="${alto}" fill="${color}"/></svg>`, ancho));

async function conAlmacen(fn) {
  const carpeta = await mkdtemp(path.join(tmpdir(), 'aia-img-'));
  try {
    await fn(crearAlmacen({ esquema, carpeta }), carpeta);
  } finally {
    await rm(carpeta, { recursive: true, force: true });
  }
}

test('leerImagen: formato y tamaño de PNG, JPEG, WebP (lossy, lossless, extendido) y SVG', () => {
  assert.deepEqual(leerImagen(png(30, 20)), { formato: 'png', ancho: 30, alto: 20 });
  // JPEG: SOI, un APP0 y el SOF0 con alto 200 y ancho 320.
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0, 200, 1, 64, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(leerImagen(jpeg), { formato: 'jpeg', ancho: 320, alto: 200 });
  const riff = (trozo, cuerpo) => Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...`WEBP${trozo}`].map((c) => c.charCodeAt(0)), [0, 0, 0, 0], cuerpo, Array(10).fill(0)));
  // VP8L: 0x2f y ancho-1, alto-1 en 14 bits cada uno (99 → 100, 49 → 50).
  const bits = 99 | (49 << 14);
  assert.deepEqual(leerImagen(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255])), { formato: 'webp', ancho: 100, alto: 50 });
  // VP8X: banderas, 3 reservados, ancho-1 y alto-1 en 24 bits.
  assert.deepEqual(leerImagen(riff('VP8X', [0, 0, 0, 0, 255, 1, 0, 127, 0, 0])), { formato: 'webp', ancho: 512, alto: 128 });
  // VP8: etiqueta de cuadro, código de inicio, ancho y alto en 14 bits.
  assert.deepEqual(leerImagen(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 1, 240, 0])), { formato: 'webp', ancho: 320, alto: 240 });
  const svg = (s) => new TextEncoder().encode(s);
  assert.deepEqual(leerImagen(svg('<?xml version="1.0"?>\n<!-- hola --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"></svg>')), { formato: 'svg', ancho: 40, alto: 10 });
  assert.deepEqual(leerImagen(svg('<svg width="200px" viewBox="0 0 40 10"/>')), { formato: 'svg', ancho: 200, alto: 50 });
  assert.deepEqual(leerImagen(svg('<svg width="100%" height="100%"/>')), { formato: 'svg', ancho: 300, alto: 150 });
  assert.throws(() => leerImagen(svg('hola')), /Not a PNG, JPEG, WebP or SVG/);
  assert.throws(() => leerImagen(new Uint8Array()), /empty/);
});

test('nombres de asset: limpios, con la extensión de su formato real, y libres', () => {
  assert.equal(nombreDeAsset('C:\\fotos\\Mi Foto Ñandú.JPEG', 'jpeg'), 'mi_foto_nandu.jpg');
  assert.equal(nombreDeAsset('logo.png', 'webp'), 'logo.webp');
  assert.equal(nombreDeAsset('...', 'png'), 'image.png');
  assert.equal(nombreLibre('sol.png', (n) => ['sol.png', 'sol_2.png'].includes(n)), 'sol_3.png');
  assert.equal(validarValor(esquema.tipos.get('image').properties.src, 'sol.png'), null);
  for (const malo of ['../x.png', 'a/b.png', 'X.png', 'sol.gif', 'sol']) assert.match(validarValor(esquema.tipos.get('image').properties.src, malo), /asset/);
});

test('planAgregarImagen: centrada, de tamaño natural o achicada, con id libre y en las coordenadas del padre', () => {
  let doc = op(crearDocumento({ width: 400, height: 300 }), { op: 'create', type: 'group', id: 'g', props: { x: 100, y: 50 } });
  const { id, ops } = planAgregarImagen(doc, esquema, { src: 'sun.png', ancho: 40, alto: 20 });
  assert.equal(id, 'sun');
  assert.deepEqual(ops[0], { op: 'create', type: 'image', id: 'sun', parent: null, props: { src: 'sun.png', x: 200, y: 150, width: 40, height: 20 } });
  doc = op(doc, ...ops);
  // Grande: entra en el 90 % del lienzo, en proporción. El id ya está tomado: sun_2. Dentro de g: el centro visto desde g.
  const grande = planAgregarImagen(doc, esquema, { src: 'sun.png', ancho: 1000, alto: 500, parent: 'g' });
  assert.equal(grande.id, 'sun_2');
  assert.deepEqual(grande.ops[0].props, { src: 'sun.png', x: 100, y: 100, width: 360, height: 180 });
  // Solo width: alto en proporción; un punto del documento (donde se soltó) también pasa a las coordenadas del padre.
  assert.deepEqual(planAgregarImagen(doc, esquema, { src: 'sun.png', ancho: 40, alto: 20, width: 10, parent: 'g', punto: [110, 60] }).ops[0].props, { src: 'sun.png', x: 10, y: 10, width: 10, height: 5 });
  // Nombre de archivo que no sirve como id.
  assert.equal(planAgregarImagen(doc, esquema, { src: '2024-foto.png', ancho: 1, alto: 1 }).id, 'foto');
  assert.throws(() => planAgregarImagen(doc, esquema, { src: 'sun.png', ancho: 1, alto: 1, id: 'g' }), /already/);
  assert.deepEqual(assetsUsados(doc), ['sun.png']);
  assert.deepEqual(validar(doc, esquema).errores, []);
});

test('render: image en el SVG (pivote, estirada, pixelated) y en el PNG con los bytes del asset', () => {
  const doc = op(
    crearDocumento({ width: 100, height: 100, background: '#ffffff' }),
    { op: 'create', type: 'image', id: 'a', props: { src: 'rojo.png', x: 25, y: 50, width: 50, height: 100 } },
    { op: 'create', type: 'image', id: 'b', props: { src: 'falta.png', x: 75, y: 50, width: 50, height: 100, originX: 0, originY: 0, pixelated: true } },
  );
  const svg = svgDocumento(doc, esquema);
  assert.match(svg, /<image href="rojo\.png" x="-25" y="-50" width="50" height="100" preserveAspectRatio="none"\/>/);
  assert.match(svg, /<image href="falta\.png" x="0" y="0" width="50" height="100" preserveAspectRatio="none" style="image-rendering:pixelated"\/>/);
  assert.match(svgDocumento(doc, esquema, { assets: (src) => `/x/${src}` }), /href="\/x\/rojo\.png"/);
  // A PNG: el asset que está se ve; el que falta no se dibuja (queda el fondo).
  const resultado = new Resvg(incrustarImagenes(svg, new Map([['rojo.png', png(4, 4)]]))).render();
  const pixel = (x, y) => [...resultado.pixels.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)];
  assert.deepEqual(pixel(10, 50), [255, 0, 0]);
  assert.deepEqual(pixel(90, 90), [255, 255, 255]);
  // WebP (resvg no lo lee): un recuadro gris con una cruz en su lugar.
  const webp = incrustarImagenes('<image href="w.webp" x="-5" y="-5" width="10" height="20" preserveAspectRatio="none"/>', new Map([['w.webp', new Uint8Array([1])]]));
  assert.match(webp, /^<rect x="-5" y="-5" width="10" height="20" [^>]*\/><path d="M-5 -5L5 15M5 -5L-5 15"/);
});

test('una image se pega a un hueso y se anima en poses y clips como las demás capas', () => {
  const doc = op(
    crearDocumento({}),
    { op: 'create', type: 'skeleton', id: 'rig' },
    { op: 'create', type: 'bone', id: 'b', parent: 'rig', props: { length: 50 } },
    { op: 'create', type: 'image', id: 'foto', parent: 'rig', props: { src: 'foto.png', bone: 'b' } },
    { op: 'create', type: 'pose', id: 'grande', props: { values: { foto: { width: 300, opacity: 0.5, visible: false } } } },
    { op: 'create', type: 'animation', id: 'clip', props: { duration: 1, tracks: { foto: { rotation: [{ t: 0, value: 0 }, { t: 1, value: 90 }], width: [{ t: 0, value: 100 }, { t: 1, value: 200 }] } } } },
  );
  assert.deepEqual(validar(doc, esquema).errores, []);
  assert.match(svgDocumento(doc, esquema, { pose: 'grande' }), /data-id="foto"[^>]*opacity="0\.5" display="none"><image href="foto\.png" x="-150" y="-50" width="300"/);
  assert.match(svgDocumento(doc, esquema, { animation: 'clip', time: 0.5 }), /<image href="foto\.png" x="-75" y="-50" width="150"/);
  assert.throws(() => op(doc, { op: 'set', target: 'grande', props: { values: { foto: { src: 'otra.png' } } } }), /src/);
  // Su caja cuenta para enlazar por cercanía (como la de un rect): 100 × 100 centrada en el origen.
  assert.deepEqual(cajaDe(doc, esquema, 'foto'), [-50, -50, 50, 50]);
});

test('almacén: guarda assets (reusa los iguales, renombra los distintos), los sirve, avisa los que faltan y los copia', () =>
  conAlmacen(async (a, carpeta) => {
    await a.crear('doc', { width: 200, height: 200 }, { origen: 'user' });
    const rojo = png(10, 10);
    assert.deepEqual(await a.guardarAsset('doc', 'Sol.PNG', rojo), { src: 'sol.png', ancho: 10, alto: 10, formato: 'png', reusado: false });
    assert.deepEqual(await a.guardarAsset('doc', 'otro.png', rojo), { src: 'sol.png', ancho: 10, alto: 10, formato: 'png', reusado: true });
    assert.equal((await a.guardarAsset('doc', 'sol.png', png(10, 10, '#00ff00'))).src, 'sol_2.png');
    await assert.rejects(a.guardarAsset('doc', 'x.png', new TextEncoder().encode('hola')), /Not a PNG/);
    await assert.rejects(a.guardarAsset('nada', 'x.png', rojo), /No existe/);
    assert.deepEqual(await a.listarAssets('doc'), ['sol.png', 'sol_2.png']);
    const { bytes, mime } = await a.leerAsset('doc', 'sol.png');
    assert.equal(mime, 'image/png');
    assert.ok(Buffer.from(rojo).equals(bytes));
    await assert.rejects(a.leerAsset('doc', '../doc/documento.json'), /Invalid asset/);
    await assert.rejects(a.leerAsset('doc', 'nada.png'), /no asset/);

    const { avisos } = await a.operar('doc', [{ op: 'create', type: 'image', id: 's', props: { src: 'sol.png' } }, { op: 'create', type: 'image', id: 't', props: { src: 'nube.png' } }], { origen: 'ai' });
    assert.deepEqual(avisos.length, 1);
    assert.match(avisos[0], /t \(nube\.png\)/);
    const imagenes = await a.imagenesDe('doc', await a.leer('doc'));
    assert.deepEqual([...imagenes.keys()], ['sol.png']);

    // Una copia del documento lleva sus assets.
    await a.crear('copia', {}, { origen: 'user', copiarDe: 'doc' });
    assert.deepEqual(await a.listarAssets('copia'), ['sol.png', 'sol_2.png']);
    assert.ok(Buffer.from(rojo).equals(await readFile(path.join(carpeta, 'copia', 'assets', 'sol.png'))));
  }));

test('MCP: bytesDeImagen lee rutas absolutas y rechaza lo demás; el árbol muestra el archivo', async () => {
  const carpeta = await mkdtemp(path.join(tmpdir(), 'aia-img-'));
  try {
    const archivo = path.join(carpeta, 'Logo.png');
    await writeFile(archivo, png(3, 3));
    const { bytes, nombre } = await bytesDeImagen({ path: archivo });
    assert.equal(nombre, 'Logo.png');
    assert.equal(leerImagen(bytes).ancho, 3);
    await assert.rejects(bytesDeImagen({ path: 'Logo.png' }), /absolute/);
    await assert.rejects(bytesDeImagen({ path: path.join(carpeta, 'nada.png') }), /No file/);
    await assert.rejects(bytesDeImagen({}), /exactly one/);
    await assert.rejects(bytesDeImagen({ url: 'file:///etc/passwd' }), /http or https/);
  } finally {
    await rm(carpeta, { recursive: true, force: true });
  }
  const doc = op(crearDocumento({}), { op: 'create', type: 'image', id: 'logo', props: { src: 'logo.png', width: 64, height: 32 } });
  assert.match(esquemaDelArbol(doc, esquema), /- logo \(image\) \[logo\.png, 64×32\]/);
  assert.ok(buscar(doc, 'logo'));
  assert.match(guiaParaIA(esquema), /add_image/);
});
