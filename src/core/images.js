// Images as a layer (type `image`): read the format and size of a file from its bytes, give it an asset name and
// build the operation that adds it. The server (when saving the file), the editor and the MCP use it, so it is pure
// code: no disk or DOM.

import { findObject, idError } from './document.js';
import { ASSET_FILE, readMeta } from './schema.js';
import { apply, invert, worldMatrix } from './geometry.js';

/** Accepted formats: extension of the saved file and MIME type. */
export const IMAGE_FORMATS = {
  png: { extension: 'png', mime: 'image/png' },
  jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  webp: { extension: 'webp', mime: 'image/webp' },
  svg: { extension: 'svg', mime: 'image/svg+xml' },
};

/** Maximum size of an image file, in bytes. */
export const IMAGE_MAX = 25 * 1024 * 1024;

const MIME_BY_EXTENSION = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

/** MIME type of an asset by its extension (null if it is not an accepted image). */
export const assetMime = (name) => MIME_BY_EXTENSION[/\.([a-z]+)$/i.exec(name)?.[1]?.toLowerCase()] ?? null;

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/**
 * Format and natural size of an image from its bytes (it only reads the header; in an SVG, width/height or the
 * viewBox). Throws if it is not PNG, JPEG, WebP or SVG.
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
  // Markers up to an SOF (C0–CF except C4, C8 and CC): height and width are there.
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
  // Only px (or no unit): a 100% or 10cm does not say how big it is on the canvas.
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
 * Asset name for a file: the original name in lowercase and without odd characters, with the extension of its
 * real format ("Mi Foto.JPEG" → "mi_foto.jpg").
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

/** The same name with _2, _3... before the extension, until one that `taken` does not have. */
export function freeName(name, taken) {
  if (!taken(name)) return name;
  const [, base, ext] = /^(.*)(\.[a-z]+)$/.exec(name);
  for (let n = 2; ; n++) if (!taken(`${base}_${n}${ext}`)) return `${base}_${n}${ext}`;
}

const round = (v) => Math.round(v * 100) / 100;

/**
 * Operation to add an `image` layer that uses the asset `src` (of natural size `naturalWidth` × `naturalHeight`).
 * By default: free id based on the file name, centered on the canvas (or at `point`, in document coordinates:
 * where the file was dropped; `x`/`y` instead are the parent's) and at its
 * natural size, scaled down proportionally if it does not fit in 90 % of the canvas. With only `width` or only
 * `height`, the other follows proportionally. The editor (Add image, dropping or pasting a file) and the MCP
 * (add_image) use it.
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
  // The center of the canvas (or the given point), seen from the parent.
  const [px, py] = point ?? [readMeta(schema, doc, 'width') / 2, readMeta(schema, doc, 'height') / 2];
  const [cx, cy] = apply(invert(worldMatrix(doc, schema, parent)), px, py);
  const props = { src, x: round(x ?? cx), y: round(y ?? cy), width: round(w), height: round(h) };
  /** @type {import('./types.js').Operation} */
  const op = { op: 'create', type: 'image', id, parent, props };
  if (index != null) op.index = index;
  return { id, ops: [op] };
}

/**
 * Operation to change the file of the image layer `id` to `src`: keeps its width and adapts the height to the new
 * file's proportion. The editor (Replace…) and the MCP (add_image with replace) use it.
 * @param {any} doc @param {string} id
 * @param {{ src: string, naturalWidth: number, naturalHeight: number }} file
 * @returns {import('./types.js').Operation[]}
 */
export function planReplaceImage(doc, id, { src, naturalWidth, naturalHeight }) {
  const obj = findObject(doc, id);
  if (!obj) throw new Error(`There is no object "${id}"`);
  if (obj.type !== 'image') throw new Error(`"${id}" is a ${obj.type}, not an image layer: only image layers can change their file`);
  if (!ASSET_FILE.test(src ?? '')) throw new Error(`Invalid asset name "${src}"`);
  if (!(naturalWidth > 0 && naturalHeight > 0)) throw new Error(`The image "${src}" has no size`);
  const width = obj.width ?? naturalWidth;
  return [{ op: 'set', target: id, props: { src, width, height: round((width * naturalHeight) / naturalWidth) } }];
}

function free(doc, base) {
  for (let n = 2; ; n++) if (!findObject(doc, `${base}_${n}`)) return `${base}_${n}`;
}

/** The asset files used by the document's `image` layers. */
export const usedAssets = (doc) => [...new Set(doc.objects.filter((o) => o.type === 'image' && typeof o.src === 'string').map((o) => o.src))];
