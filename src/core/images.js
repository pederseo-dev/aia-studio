// Image layers: read the format and size of a picture from its bytes, give its file a name in the document's assets
// folder, and build the operations that add an image layer or change its picture. The store (when it saves the file),
// the editor and the aia commands use it, so it is pure code: no disk, no DOM.

import { ID, findObject, idFromName } from './document.js';
import { apply, round2 } from './geometry.js';
import { ASSET_FILE } from './schema.js';
import { invert, worldOf } from './transform.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {'png' | 'jpeg' | 'webp' | 'svg'} ImageFormat
 * @typedef {{ format: ImageFormat, naturalWidth: number, naturalHeight: number }} ImageInfo
 */

/** The accepted formats: the extension of the saved file and the MIME type. */
export const IMAGE_FORMATS = /** @type {const} */ ({
  png: { extension: 'png', mime: 'image/png' },
  jpeg: { extension: 'jpg', mime: 'image/jpeg' },
  webp: { extension: 'webp', mime: 'image/webp' },
  svg: { extension: 'svg', mime: 'image/svg+xml' },
});

/** The biggest picture accepted, in bytes. */
export const IMAGE_MAX = 25 * 1024 * 1024;

/** @type {Record<string, string>} */
const MIME_BY_EXTENSION = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

/** The MIME type of an asset by its extension, or null if it is not an accepted picture. @param {string} name */
export const assetMime = (name) => MIME_BY_EXTENSION[/\.([a-z]+)$/.exec(name)?.[1] ?? ''] ?? null;

/** @param {Uint8Array} b @param {number} from @param {number} to */
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
/** @param {Uint8Array} b @param {number} i */
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
/** @param {Uint8Array} b @param {number} i */
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
/** @param {Uint8Array} b @param {number} i */
const u32be = (b, i) => b[i] * 2 ** 24 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

/**
 * The format and natural size of a picture from its bytes (only its header is read; for an SVG, its width and height
 * or its viewBox). Throws if it is not a PNG, JPEG, WebP or SVG.
 * @param {Uint8Array} b
 * @returns {ImageInfo}
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

/** @param {ImageFormat} format @param {number} naturalWidth @param {number} naturalHeight @returns {ImageInfo} */
function measure(format, naturalWidth, naturalHeight) {
  if (!(naturalWidth > 0 && naturalHeight > 0)) throw new Error(`Couldn't read the size of the ${format.toUpperCase()} image`);
  return { format, naturalWidth, naturalHeight };
}

/** @param {Uint8Array} b @returns {[number, number]} */
function jpegSize(b) {
  // Markers up to a start of frame (C0–CF, but C4, C8 and CC): the height and width are there.
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

/** @param {Uint8Array} b @returns {[number, number]} */
function webpSize(b) {
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8 ') return [(b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff];
  if (chunk === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8X') return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  return [0, 0];
}

/** @param {string} text @returns {[number, number]} */
function svgSize(text) {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  /** @param {string} name */
  const attribute = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  // Only px (or no unit): 100% or 10cm does not say how big it is on the artboard.
  /** @param {string | undefined} v */
  const px = (v) => (v != null && /^\s*[\d.]+\s*(px)?\s*$/i.test(v) ? parseFloat(v) : null);
  const box = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = box?.length === 4 && box.every(Number.isFinite) ? [box[2], box[3]] : [null, null];
  let [w, h] = [px(attribute('width')), px(attribute('height'))];
  if (w == null && h == null) [w, h] = vw && vh ? [vw, vh] : [300, 150];
  else if (w == null) w = vw && vh ? (Number(h) * vw) / vh : Number(h);
  else if (h == null) h = vw && vh ? (w * vh) / vw : w;
  return [Number(w), Number(h)];
}

/**
 * The asset name for a file: its own name in lowercase, without odd characters, with the extension of its real
 * format ("My Photo.JPEG" → "my_photo.jpg").
 * @param {string} original @param {ImageFormat} format
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
      .replace(/^[^a-z0-9]+|[_-]+$/g, '')
      .slice(0, 40) || 'image';
  const name = `${base}.${IMAGE_FORMATS[format].extension}`;
  if (!ASSET_FILE.test(name)) throw new Error(`Invalid asset name "${name}"`);
  return name;
}

/**
 * The same name with _2, _3… before the extension, until one that is not taken.
 * @param {string} name @param {(name: string) => boolean} taken
 */
export function freeAssetName(name, taken) {
  if (!taken(name)) return name;
  const [, base, extension] = /** @type {RegExpExecArray} */ (/^(.*)(\.[a-z]+)$/.exec(name));
  for (let n = 2; ; n++) if (!taken(`${base}_${n}${extension}`)) return `${base}_${n}${extension}`;
}

/**
 * The operation that adds an image layer showing the asset `src`. By default its id comes from the file's name, it
 * sits on top of `parent`'s layers (the root) and is as big as the picture, made smaller to fit in 90 % of the
 * artboard, centered on `at` (a point of the artboard; its center by default). With only `width` or only `height`,
 * the other keeps the picture's proportion. The picture is drawn from (0, 0) in the layer's coordinates, so the layer's
 * x, y place it. The editor (Image layer, dropping a file) and `aia image` use it.
 * @param {Doc} doc
 * @param {{ src: string, naturalWidth: number, naturalHeight: number, id?: string, parent?: string | null, index?: number,
 *   at?: { x: number, y: number }, width?: number, height?: number }} options
 * @returns {{ id: string, ops: Operation[] }}
 */
export function addImageOps(doc, { src, naturalWidth, naturalHeight, id, parent = null, index, at, width, height }) {
  if (!ASSET_FILE.test(src ?? '')) throw new Error(`Invalid asset name "${src}"`);
  if (!(naturalWidth > 0 && naturalHeight > 0)) throw new Error(`The image "${src}" has no size`);
  if (id != null) {
    if (!ID.test(id)) throw new Error(`"${id}" is not a valid id (lowercase letters, digits and _, starting with a letter)`);
    if (id === 'meta' || findObject(doc, id)) throw new Error(`The id "${id}" is already taken`);
  } else {
    id = idFromName(src.replace(/\.[a-z]+$/, ''), (taken) => taken === 'meta' || !!findObject(doc, taken));
  }
  const artboard = { width: Number(doc.meta.width ?? 800), height: Number(doc.meta.height ?? 600) };
  let [w, h] = [naturalWidth, naturalHeight];
  if (width != null && height != null) [w, h] = [width, height];
  else if (width != null) [w, h] = [width, (width * naturalHeight) / naturalWidth];
  else if (height != null) [w, h] = [(height * naturalWidth) / naturalHeight, height];
  else {
    const fit = Math.min(1, (artboard.width * 0.9) / naturalWidth, (artboard.height * 0.9) / naturalHeight);
    [w, h] = [naturalWidth * fit, naturalHeight * fit];
  }
  // The center, seen from the parent (a transformed group has coordinates of its own).
  const center = apply(invert(worldOf(doc, parent)), at ?? { x: artboard.width / 2, y: artboard.height / 2 });
  /** @type {Record<string, unknown>} */
  const props = { src, width: round2(w), height: round2(h), x: round2(center.x - w / 2), y: round2(center.y - h / 2) };
  /** @type {Operation} */
  const op = { op: 'create', type: 'image', id, parent, props };
  if (index !== undefined) op.index = index;
  return { id, ops: [op] };
}

/**
 * The operation that changes the picture of the image layer `id` to `src`: it keeps its width and takes the new
 * picture's proportion.
 * @param {Doc} doc @param {string} id @param {{ src: string, naturalWidth: number, naturalHeight: number }} file
 * @returns {Operation[]}
 */
export function replaceImageOps(doc, id, { src, naturalWidth, naturalHeight }) {
  const layer = findObject(doc, id);
  if (!layer) throw new Error(`There is no layer "${id}"`);
  if (layer.type !== 'image') throw new Error(`"${id}" is a ${layer.type} layer: only an image layer changes its picture`);
  if (!ASSET_FILE.test(src ?? '')) throw new Error(`Invalid asset name "${src}"`);
  if (!(naturalWidth > 0 && naturalHeight > 0)) throw new Error(`The image "${src}" has no size`);
  const width = Number(layer.width ?? 100);
  return [{ op: 'set', target: id, props: { src, height: round2((width * naturalHeight) / naturalWidth) } }];
}

/** The asset files the document's image layers show. @param {Doc} doc */
export const usedAssets = (doc) => [...new Set(doc.objects.filter((o) => o.type === 'image' && typeof o.src === 'string').map((o) => String(o.src)))];
