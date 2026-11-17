// Layer transforms, as Moho's Transform Layer: a layer (vector, image or group) has x, y, rotation, scaleX and scaleY that
// move, turn and scale everything inside it without changing its parts' vertices. They apply around the layer's
// origin (originX/originY in the layer's own coordinates; null = the center of its content). Groups compose: a
// layer inside a group is transformed by the group too. Parts are only geometry: transforming a part rewrites its
// vertices (decision 8).
//
// Spaces: a part's vertices are in its layer's coordinates. A layer's x, y are in its parent's coordinates (the
// artboard's at the root). worldOf gives the matrix from an object's own coordinates to the artboard's.

import { childrenOf, findObject } from './document.js';
import { apply, applyVector, around, bounds, IDENTITY, multiply, originOf, rotate, round2, scale, transformOrigin, transformPart, translate } from './geometry.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Matrix} Matrix
 * @typedef {import('./geometry.js').Point} Point
 * @typedef {import('./geometry.js').Box} Box
 * @typedef {{ x: number, y: number, rotation: number, scaleX: number, scaleY: number }} LayerTransform
 */

/** Whether an object is a layer (anything in Layers), not a part. @param {DocObject | undefined} o */
export const isLayer = (o) => o?.type === 'vector' || o?.type === 'image' || o?.type === 'group';

/** A layer's transform, with the defaults filled in. @param {DocObject} layer @returns {LayerTransform} */
export function transformOf(layer) {
  return {
    x: Number(layer.x ?? 0),
    y: Number(layer.y ?? 0),
    rotation: Number(layer.rotation ?? 0),
    scaleX: Number(layer.scaleX ?? 1),
    scaleY: Number(layer.scaleY ?? 1),
  };
}

/** Whether a layer has a transform of its own. @param {DocObject} layer */
export function isTransformed(layer) {
  const t = transformOf(layer);
  return t.x !== 0 || t.y !== 0 || t.rotation !== 0 || t.scaleX !== 1 || t.scaleY !== 1;
}

/** The inverse of a matrix. @param {Matrix} m @returns {Matrix} */
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-12;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** A box with its 4 corners through a matrix: the box around them. @param {Box} box @param {Matrix} m @returns {Box} */
export function mapBox(box, m) {
  const corners = [
    apply(m, { x: box.x, y: box.y }),
    apply(m, { x: box.x + box.width, y: box.y }),
    apply(m, { x: box.x + box.width, y: box.y + box.height }),
    apply(m, { x: box.x, y: box.y + box.height }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The box around a layer's content, in the layer's own coordinates (its parts, its child layers as they are drawn
 * inside it, an image layer's picture), or null if it is empty.
 * @param {Doc} doc @param {DocObject} layer
 * @returns {Box | null}
 */
export function contentBounds(doc, layer) {
  if (layer.type === 'image') return { x: 0, y: 0, width: Number(layer.width ?? 100), height: Number(layer.height ?? 100) };
  /** @type {Box[]} */
  const boxes = [];
  for (const child of childrenOf(doc, layer.id)) {
    if (isLayer(child)) {
      const box = contentBounds(doc, child);
      if (box) boxes.push(mapBox(box, layerMatrix(doc, child)));
    } else {
      const box = bounds([child]);
      if (box) boxes.push(box);
    }
  }
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}

/** The point a layer turns and scales around, in its own coordinates. @param {Doc} doc @param {DocObject} layer @returns {Point} */
export function pivotOf(doc, layer) {
  const origin = originOf(layer);
  if (origin) return origin;
  const box = contentBounds(doc, layer);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 };
}

/**
 * The matrix of a layer's own transform: from its coordinates to its parent's.
 * T(x, y) · T(pivot) · R(rotation) · S(scaleX, scaleY) · T(-pivot)
 * @param {Doc} doc @param {DocObject} layer @param {LayerTransform} [t] another transform than its own
 * @returns {Matrix}
 */
export function layerMatrix(doc, layer, t) {
  if (!t) {
    if (!isTransformed(layer)) return IDENTITY;
    t = transformOf(layer);
  }
  const p = pivotOf(doc, layer);
  return multiply(translate(t.x, t.y), around(p, multiply(rotate(t.rotation), scale(t.scaleX, t.scaleY))));
}

/**
 * From an object's own coordinates to the artboard's: for a part, its layer's coordinates (the vertices); for a
 * layer, its own coordinates (where its content is).
 * @param {Doc} doc @param {string | null} id
 * @returns {Matrix}
 */
export function worldOf(doc, id) {
  let m = IDENTITY;
  for (let o = id ? findObject(doc, id) : undefined; o; o = o.parent ? findObject(doc, o.parent) : undefined) {
    if (isLayer(o)) m = multiply(layerMatrix(doc, o), m);
  }
  return m;
}

/** From a layer's parent's coordinates to the artboard's (where its x, y are). @param {Doc} doc @param {DocObject} layer */
export const parentWorldOf = (doc, layer) => worldOf(doc, layer.parent);

/**
 * A matrix that acts in the artboard's coordinates, seen from inside a space whose matrix to the artboard is `w`.
 * @param {Matrix} m @param {Matrix} w @returns {Matrix}
 */
export const conjugate = (m, w) => multiply(invert(w), multiply(m, w));

/**
 * The transform a layer gets for a new matrix (its coordinates to its parent's), keeping its pivot. Skew cannot be
 * kept: the editor only asks for moves, turns and scales along the layer's own axes, which have none.
 * @param {Doc} doc @param {DocObject} layer @param {Matrix} m
 * @returns {LayerTransform}
 */
export function decompose(doc, layer, m) {
  const p = pivotOf(doc, layer);
  // m = T(x, y) · T(p) · R · S · T(-p): the linear part is R · S, and m(p) = p + (x, y).
  const sx = Math.hypot(m[0], m[1]);
  const rotation = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const sy = sx ? (m[0] * m[3] - m[1] * m[2]) / sx : Math.hypot(m[2], m[3]);
  const at = apply(m, p);
  /** @param {number} n @param {number} places */
  const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places || 0;
  return { x: round2(at.x - p.x), y: round2(at.y - p.y), rotation: round(rotation, 2), scaleX: round(sx, 4), scaleY: round(sy, 4) };
}

/**
 * The props that set a layer to a transform: only what differs from the defaults is stored, and a layer that had no
 * origin gets one where its pivot is now, so editing its content later does not move it.
 * @param {Doc} doc @param {DocObject} layer @param {LayerTransform} t
 * @returns {Record<string, number | null>}
 */
export function transformProps(doc, layer, t) {
  /** @type {Record<string, number | null>} */
  const props = { x: t.x, y: t.y, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY };
  if (!originOf(layer)) {
    const p = pivotOf(doc, layer);
    props.originX = round2(p.x);
    props.originY = round2(p.y);
  }
  return props;
}

/**
 * The origin of a layer moved to `to` (its own coordinates) without the layer moving on the artboard: its x, y
 * make up for the new pivot.
 * @param {Doc} doc @param {DocObject} layer @param {Point} to
 */
export function moveLayerOrigin(doc, layer, to) {
  const t = transformOf(layer);
  const p = pivotOf(doc, layer);
  const linear = multiply(rotate(t.rotation), scale(t.scaleX, t.scaleY));
  const d = { x: p.x - to.x, y: p.y - to.y };
  const turned = applyVector(linear, d);
  return { originX: round2(to.x), originY: round2(to.y), x: round2(t.x + d.x - turned.x), y: round2(t.y + d.y - turned.y) };
}

/** The SVG transform attribute of a layer, or '' when it has none. @param {Doc} doc @param {DocObject} layer */
export function svgTransform(doc, layer) {
  if (!isTransformed(layer)) return '';
  const m = layerMatrix(doc, layer);
  /** @param {number} n */
  const r = (n) => Math.round(n * 10000) / 10000;
  return `matrix(${m.map(r).join(' ')})`;
}

/**
 * Apply transform: a vector layer's transform goes into its parts' vertices (and their origins), and the layer is left
 * without one. It looks the same; the parts' coordinates change.
 * @param {Doc} doc @param {DocObject} layer
 * @returns {import('./operations.js').Operation[]}
 */
export function applyTransformOps(doc, layer) {
  if (layer.type !== 'vector') throw new Error(`Apply transform works on vector layers (${layer.id} is a ${layer.type})`);
  if (!isTransformed(layer)) return [];
  const m = layerMatrix(doc, layer);
  return [
    ...childrenOf(doc, layer.id).map((part) => ({ op: 'set', target: part.id, props: transformPart(part, m) })),
    { op: 'set', target: layer.id, props: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, ...transformOrigin(layer, m) } },
  ];
}
