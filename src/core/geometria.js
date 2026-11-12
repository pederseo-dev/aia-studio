// Matrices afines [a, b, c, d, e, f], las mismas que usa SVG en matrix(...).

import { buscar } from './documento.js';
import { leer } from './esquema.js';

/** @typedef {import('./tipos.js').Matriz} Matriz @typedef {import('./tipos.js').Punto} Punto */

/** @type {Matriz} */
export const IDENTIDAD = [1, 0, 0, 1, 0, 0];

/** @param {Matriz} m @param {Matriz} n @returns {Matriz} */
export function multiplicar(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** @param {Matriz} m @returns {Matriz} */
export function invertir([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!det) return IDENTIDAD;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** @param {Matriz} m @param {number} x @param {number} y @returns {Punto} */
export function aplicar(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** translate(x, y) · rotate(rotation) · scale(scaleX, scaleY) */
export function matrizLocal(esquema, obj) {
  const r = (leer(esquema, obj, 'rotation') * Math.PI) / 180;
  const sx = leer(esquema, obj, 'scaleX');
  const sy = leer(esquema, obj, 'scaleY');
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, s * sx, -s * sy, c * sy, leer(esquema, obj, 'x'), leer(esquema, obj, 'y')];
}

/** Matriz del objeto en coordenadas del documento (null = la raíz, identidad). */
export function matrizMundo(doc, esquema, id) {
  let m = IDENTIDAD;
  for (let o = buscar(doc, id); o; o = buscar(doc, o.parent)) m = multiplicar(matrizLocal(esquema, o), m);
  return m;
}
