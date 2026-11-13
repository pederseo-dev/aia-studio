// Imágenes como capa (tipo `image`): leer el formato y el tamaño de un archivo desde sus bytes, darle un nombre de
// asset y armar la operación que la agrega. Lo usan el servidor (al guardar el archivo), el editor y el MCP, así que
// es código puro: sin disco ni DOM.

import { findObject, idError } from './document.js';
import { ASSET_FILE, readMeta } from './schema.js';
import { apply, invert, worldMatrix } from './geometry.js';

/** Formatos aceptados: extensión del archivo guardado y tipo MIME. */
export const IMAGE_FORMATS = {
  png: { extension: 'png', mime: 'image/png' },
  jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  webp: { extension: 'webp', mime: 'image/webp' },
  svg: { extension: 'svg', mime: 'image/svg+xml' },
};

/** Tamaño máximo de un archivo de imagen, en bytes. */
export const IMAGE_MAX = 25 * 1024 * 1024;

const MIME_BY_EXTENSION = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

/** Tipo MIME de un asset por su extensión (null si no es una imagen aceptada). */
export const assetMime = (name) => MIME_BY_EXTENSION[/\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase()] ?? null;

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/**
 * Formato y tamaño natural de una imagen a partir de sus bytes (solo lee la cabecera; en un SVG, width/height o el
 * viewBox). Lanza si no es PNG, JPEG, WebP ni SVG.
 * @param {Uint8Array} b
 * @returns {{ format: 'png' | 'jpeg' | 'webp' | 'svg', naturalWidth: number, naturalHeight: number }}
 */
export function readImage(b) {
  if (!b?.length) throw new Error('The image file is empty');
  if (b.length > IMAGE_MAX) throw new Error(`The image is too big (${Math.round(b.length / 1048576)} MB; at most ${IMAGE_MAX / 1048576} MB)`);
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return measure('png', u32be(b, 16), u32be(b, 20));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return measure('jpeg', ...jpegSize(b));
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return measure('webp', ...webpSize(b));
  const text = new TextDecoder().decode(b.subarray(0, 64 * 1024)).replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(text)) return measure('svg', ...svgSize(text));
  throw new Error('Not a PNG, JPEG, WebP or SVG image');
}

function measure(format, naturalWidth, naturalHeight) {
  if (!(naturalWidth > 0 && naturalHeight > 0)) throw new Error(`Couldn't read the size of the ${format.toUpperCase()} image`);
  return { format, naturalWidth, naturalHeight };
}

function jpegSize(b) {
  // Marcadores hasta un SOF (C0–CF salvo C4, C8 y CC): ahí están alto y ancho.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return [0, 0];
    const mark = b[i + 1];
    if (mark === 0xff) {
      i++;
      continue;
    }
    if (mark >= 0xc0 && mark <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mark)) return [u16be(b, i + 7), u16be(b, i + 5)];
    i += 2 + u16be(b, i + 2);
  }
  return [0, 0];
}

function webpSize(b) {
  const piece = ascii(b, 12, 16);
  if (piece === 'VP8 ') return [(b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff];
  if (piece === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (piece === 'VP8X') return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  return [0, 0];
}

function svgSize(text) {
  const label = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const attribute = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(label)?.[1];
  // Solo px (o sin unidad): un 100% o 10cm no dice cuánto mide en el lienzo.
  const px = (v) => (v != null && /^\s*[\d.]+\s*(px)?\s*$/i.test(v) ? parseFloat(v) : null);
  const box = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = box?.length === 4 && box.every(Number.isFinite) ? [box[2], box[3]] : [null, null];
  let [w, h] = [px(attribute('width')), px(attribute('height'))];
  if (w == null && h == null) [w, h] = vw && vh ? [vw, vh] : [300, 150];
  else if (w == null) w = vw && vh ? (h * vw) / vh : h;
  else if (h == null) h = vw && vh ? (w * vh) / vw : w;
  return [w, h];
}

/**
 * Nombre de asset para un archivo: el nombre original en minúsculas y sin caracteres raros, con la extensión de su
 * formato real ("Mi Foto.JPEG" → "mi_foto.jpg").
 */
export function assetName(original, format) {
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
  const name = `${base}.${IMAGE_FORMATS[format].extension}`;
  if (!ASSET_FILE.test(name)) throw new Error(`Invalid asset name "${name}"`);
  return name;
}

/** El mismo nombre con _2, _3... antes de la extensión, hasta uno que `ocupado` no tenga. */
export function freeName(name, taken) {
  if (!taken(name)) return name;
  const [, base, ext] = /^(.*)(\.[a-z]+)$/.exec(name);
  for (let n = 2; ; n++) if (!taken(`${base}_${n}${ext}`)) return `${base}_${n}${ext}`;
}

const round = (v) => Math.round(v * 100) / 100;

/**
 * Operación para agregar una capa `image` que usa el asset `src` (de tamaño natural `ancho` × `alto`).
 * Por defecto: id libre a partir del nombre del archivo, centrada en el lienzo (o en `punto`, en coordenadas del
 * documento: donde se soltó el archivo; `x`/`y` en cambio son las del padre) y de su
 * tamaño natural, achicada en proporción si no entra en el 90 % del lienzo. Con solo `width` o solo `height`, el otro
 * sale en proporción. Lo usan el editor (Add image, soltar o pegar un archivo) y el MCP (add_image).
 * @param {any} doc @param {any} schema
 * @param {{ src: string, naturalWidth: number, naturalHeight: number, id?: string, parent?: string | null, index?: number, x?: number, y?: number, point?: number[], width?: number, height?: number }} options
 * @returns {{ id: string, ops: import('./types.js').Operation[] }}
 */
export function planAddImage(doc, schema, { src, naturalWidth, naturalHeight, id, parent = null, index, x, y, point, width, height }) {
  if (!ASSET_FILE.test(src ?? '')) throw new Error(`Invalid asset name "${src}"`);
  if (!(naturalWidth > 0 && naturalHeight > 0)) throw new Error(`The image "${src}" has no size`);
  if (id != null) {
    const error = idError(id);
    if (error) throw new Error(error);
    if (findObject(doc, id)) throw new Error(`There is already an object with id "${id}"`);
  } else {
    const base = src.replace(/\.[a-z]+$/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '') || 'image';
    id = findObject(doc, base) || idError(base) ? free(doc, base) : base;
  }
  let [w, h] = [naturalWidth, naturalHeight];
  if (width != null && height != null) [w, h] = [width, height];
  else if (width != null) [w, h] = [width, (width * naturalHeight) / naturalWidth];
  else if (height != null) [w, h] = [(height * naturalWidth) / naturalHeight, height];
  else {
    const scale = Math.min(1, (readMeta(schema, doc, 'width') * 0.9) / naturalWidth, (readMeta(schema, doc, 'height') * 0.9) / naturalHeight);
    [w, h] = [naturalWidth * scale, naturalHeight * scale];
  }
  // El centro del lienzo (o el punto dado), visto desde el padre.
  const [px, py] = point ?? [readMeta(schema, doc, 'width') / 2, readMeta(schema, doc, 'height') / 2];
  const [cx, cy] = apply(invert(worldMatrix(doc, schema, parent)), px, py);
  const props = { src, x: round(x ?? cx), y: round(y ?? cy), width: round(w), height: round(h) };
  /** @type {import('./types.js').Operation} */
  const op = { op: 'create', type: 'image', id, parent, props };
  if (index != null) op.index = index;
  return { id, ops: [op] };
}

function free(doc, base) {
  for (let n = 2; ; n++) if (!findObject(doc, `${base}_${n}`)) return `${base}_${n}`;
}

/** Los archivos de assets que usan las capas `image` del documento. */
export const usedAssets = (doc) => [...new Set(doc.objects.filter((o) => o.type === 'image' && typeof o.src === 'string').map((o) => o.src))];
