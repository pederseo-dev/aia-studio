// Affine matrices [a, b, c, d, e, f], the same ones SVG uses in matrix(...).

import { findObject } from './document.js';
import { read } from './schema.js';

/** @typedef {import('./types.js').Matrix} Matrix @typedef {import('./types.js').Point} Point */

/** @type {Matrix} */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

/** @param {Matrix} m @param {Matrix} n @returns {Matrix} */
export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** @param {Matrix} m @returns {Matrix} */
export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!det) return IDENTITY;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Applies the matrix to the point (x, y). It can be called with the point spread: apply(m, ...[x, y]).
 * @param {Matrix} m @param {...number} point x, y @returns {Point}
 */
export function apply(m, ...point) {
  const [x, y] = point;
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** translate(x, y) · rotate(rotation) · scale(scaleX, scaleY) */
export function localMatrix(schema, obj) {
  const r = (read(schema, obj, 'rotation') * Math.PI) / 180;
  const sx = read(schema, obj, 'scaleX');
  const sy = read(schema, obj, 'scaleY');
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, s * sx, -s * sy, c * sy, read(schema, obj, 'x'), read(schema, obj, 'y')];
}

/** Matrix of the object in document coordinates (null = the root, identity). */
export function worldMatrix(doc, schema, id) {
  let m = IDENTITY;
  for (let o = findObject(doc, id); o; o = findObject(doc, o.parent)) m = multiply(localMatrix(schema, o), m);
  return m;
}
