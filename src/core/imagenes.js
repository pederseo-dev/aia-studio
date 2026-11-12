// Imágenes como capa (tipo `image`): leer el formato y el tamaño de un archivo desde sus bytes, darle un nombre de
// asset y armar la operación que la agrega. Lo usan el servidor (al guardar el archivo), el editor y el MCP, así que
// es código puro: sin disco ni DOM.

import { buscar, errorDeId } from './documento.js';
import { ARCHIVO_DE_ASSET, leerMeta } from './esquema.js';
import { aplicar, invertir, matrizMundo } from './geometria.js';

/** Formatos aceptados: extensión del archivo guardado y tipo MIME. */
export const FORMATOS_DE_IMAGEN = {
  png: { extension: 'png', mime: 'image/png' },
  jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  webp: { extension: 'webp', mime: 'image/webp' },
  svg: { extension: 'svg', mime: 'image/svg+xml' },
};

/** Tamaño máximo de un archivo de imagen, en bytes. */
export const MAXIMO_DE_IMAGEN = 25 * 1024 * 1024;

const MIME_POR_EXTENSION = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

/** Tipo MIME de un asset por su extensión (null si no es una imagen aceptada). */
export const mimeDeAsset = (nombre) => MIME_POR_EXTENSION[/\.([a-z]+)$/i.exec(nombre)?.[1]?.toLowerCase()] ?? null;

const ascii = (b, desde, hasta) => String.fromCharCode(...b.subarray(desde, hasta));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/**
 * Formato y tamaño natural de una imagen a partir de sus bytes (solo lee la cabecera; en un SVG, width/height o el
 * viewBox). Lanza si no es PNG, JPEG, WebP ni SVG.
 * @param {Uint8Array} b
 * @returns {{ formato: 'png' | 'jpeg' | 'webp' | 'svg', ancho: number, alto: number }}
 */
export function leerImagen(b) {
  if (!b?.length) throw new Error('The image file is empty');
  if (b.length > MAXIMO_DE_IMAGEN) throw new Error(`The image is too big (${Math.round(b.length / 1048576)} MB; at most ${MAXIMO_DE_IMAGEN / 1048576} MB)`);
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return medida('png', u32be(b, 16), u32be(b, 20));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return medida('jpeg', ...tamanoJpeg(b));
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return medida('webp', ...tamanoWebp(b));
  const texto = new TextDecoder().decode(b.subarray(0, 64 * 1024)).replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(texto)) return medida('svg', ...tamanoSvg(texto));
  throw new Error('Not a PNG, JPEG, WebP or SVG image');
}

function medida(formato, ancho, alto) {
  if (!(ancho > 0 && alto > 0)) throw new Error(`Couldn't read the size of the ${formato.toUpperCase()} image`);
  return { formato, ancho, alto };
}

function tamanoJpeg(b) {
  // Marcadores hasta un SOF (C0–CF salvo C4, C8 y CC): ahí están alto y ancho.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return [0, 0];
    const marca = b[i + 1];
    if (marca === 0xff) {
      i++;
      continue;
    }
    if (marca >= 0xc0 && marca <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marca)) return [u16be(b, i + 7), u16be(b, i + 5)];
    i += 2 + u16be(b, i + 2);
  }
  return [0, 0];
}

function tamanoWebp(b) {
  const trozo = ascii(b, 12, 16);
  if (trozo === 'VP8 ') return [(b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff];
  if (trozo === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (trozo === 'VP8X') return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  return [0, 0];
}

function tamanoSvg(texto) {
  const etiqueta = /<svg\b[^>]*>/i.exec(texto)?.[0] ?? '';
  const atributo = (nombre) => new RegExp(`\\s${nombre}\\s*=\\s*["']([^"']*)["']`, 'i').exec(etiqueta)?.[1];
  // Solo px (o sin unidad): un 100% o 10cm no dice cuánto mide en el lienzo.
  const px = (v) => (v != null && /^\s*[\d.]+\s*(px)?\s*$/i.test(v) ? parseFloat(v) : null);
  const caja = atributo('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = caja?.length === 4 && caja.every(Number.isFinite) ? [caja[2], caja[3]] : [null, null];
  let [w, h] = [px(atributo('width')), px(atributo('height'))];
  if (w == null && h == null) [w, h] = vw && vh ? [vw, vh] : [300, 150];
  else if (w == null) w = vw && vh ? (h * vw) / vh : h;
  else if (h == null) h = vw && vh ? (w * vh) / vw : w;
  return [w, h];
}

/**
 * Nombre de asset para un archivo: el nombre original en minúsculas y sin caracteres raros, con la extensión de su
 * formato real ("Mi Foto.JPEG" → "mi_foto.jpg").
 */
export function nombreDeAsset(original, formato) {
  const base =
    String(original ?? '')
      .replace(/^.*[\\/]/, '')
      .replace(/\.[a-z0-9]+$/i, '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^[^a-z0-9]+|_+$/g, '')
      .slice(0, 40) || 'image';
  const nombre = `${base}.${FORMATOS_DE_IMAGEN[formato].extension}`;
  if (!ARCHIVO_DE_ASSET.test(nombre)) throw new Error(`Invalid asset name "${nombre}"`);
  return nombre;
}

/** El mismo nombre con _2, _3... antes de la extensión, hasta uno que `ocupado` no tenga. */
export function nombreLibre(nombre, ocupado) {
  if (!ocupado(nombre)) return nombre;
  const [, base, ext] = /^(.*)(\.[a-z]+)$/.exec(nombre);
  for (let n = 2; ; n++) if (!ocupado(`${base}_${n}${ext}`)) return `${base}_${n}${ext}`;
}

const redondear = (v) => Math.round(v * 100) / 100;

/**
 * Operación para agregar una capa `image` que usa el asset `src` (de tamaño natural `ancho` × `alto`).
 * Por defecto: id libre a partir del nombre del archivo, centrada en el lienzo (o en `punto`, en coordenadas del
 * documento: donde se soltó el archivo; `x`/`y` en cambio son las del padre) y de su
 * tamaño natural, achicada en proporción si no entra en el 90 % del lienzo. Con solo `width` o solo `height`, el otro
 * sale en proporción. Lo usan el editor (Add image, soltar o pegar un archivo) y el MCP (add_image).
 * @param {any} doc @param {any} esquema
 * @param {{ src: string, ancho: number, alto: number, id?: string, parent?: string | null, index?: number, x?: number, y?: number, punto?: number[], width?: number, height?: number }} opciones
 * @returns {{ id: string, ops: import('./tipos.js').Operacion[] }}
 */
export function planAgregarImagen(doc, esquema, { src, ancho, alto, id, parent = null, index, x, y, punto, width, height }) {
  if (!ARCHIVO_DE_ASSET.test(src ?? '')) throw new Error(`Invalid asset name "${src}"`);
  if (!(ancho > 0 && alto > 0)) throw new Error(`The image "${src}" has no size`);
  if (id != null) {
    const error = errorDeId(id);
    if (error) throw new Error(error);
    if (buscar(doc, id)) throw new Error(`There is already an object with id "${id}"`);
  } else {
    const base = src.replace(/\.[a-z]+$/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '') || 'image';
    id = buscar(doc, base) || errorDeId(base) ? libre(doc, base) : base;
  }
  let [w, h] = [ancho, alto];
  if (width != null && height != null) [w, h] = [width, height];
  else if (width != null) [w, h] = [width, (width * alto) / ancho];
  else if (height != null) [w, h] = [(height * ancho) / alto, height];
  else {
    const escala = Math.min(1, (leerMeta(esquema, doc, 'width') * 0.9) / ancho, (leerMeta(esquema, doc, 'height') * 0.9) / alto);
    [w, h] = [ancho * escala, alto * escala];
  }
  // El centro del lienzo (o el punto dado), visto desde el padre.
  const [px, py] = punto ?? [leerMeta(esquema, doc, 'width') / 2, leerMeta(esquema, doc, 'height') / 2];
  const [cx, cy] = aplicar(invertir(matrizMundo(doc, esquema, parent)), px, py);
  const props = { src, x: redondear(x ?? cx), y: redondear(y ?? cy), width: redondear(w), height: redondear(h) };
  /** @type {import('./tipos.js').Operacion} */
  const op = { op: 'create', type: 'image', id, parent, props };
  if (index != null) op.index = index;
  return { id, ops: [op] };
}

function libre(doc, base) {
  for (let n = 2; ; n++) if (!buscar(doc, `${base}_${n}`)) return `${base}_${n}`;
}

/** Los archivos de assets que usan las capas `image` del documento. */
export const assetsUsados = (doc) => [...new Set(doc.objects.filter((o) => o.type === 'image' && typeof o.src === 'string').map((o) => o.src))];
