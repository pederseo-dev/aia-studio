// Curvas de interpolación de los keyframes. Cada keyframe lleva la suya y vale para el tramo que sale de él (como en
// Moho y Rive). Todas son cubic-bezier como las de CSS, para que pasen sin pérdida a CSS, Lottie y Rive; `step`
// mantiene el valor hasta el keyframe siguiente.

// Las fuertes (quad, cubic, expo, back) son las aproximaciones cubic-bezier clásicas (las de easings.net).
export const CURVAS_CON_NOMBRE = {
  linear: [0, 0, 1, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  'ease-in-quad': [0.11, 0, 0.5, 0],
  'ease-out-quad': [0.5, 1, 0.89, 1],
  'ease-in-out-quad': [0.45, 0, 0.55, 1],
  'ease-in-cubic': [0.32, 0, 0.67, 0],
  'ease-out-cubic': [0.33, 1, 0.68, 1],
  'ease-in-out-cubic': [0.65, 0, 0.35, 1],
  'ease-in-expo': [0.7, 0, 0.84, 0],
  'ease-out-expo': [0.16, 1, 0.3, 1],
  'ease-in-out-expo': [0.87, 0, 0.13, 1],
  'ease-in-back': [0.36, 0, 0.66, -0.56],
  'ease-out-back': [0.34, 1.56, 0.64, 1],
  'ease-in-out-back': [0.68, -0.6, 0.32, 1.6],
};
export const NOMBRES_DE_CURVA = [...Object.keys(CURVAS_CON_NOMBRE), 'step'];

/** Qué hace cada curva, para la guía de la IA (una línea por familia). */
export const DESCRIPCION_DE_CURVAS = [
  ['linear', 'velocidad pareja (por defecto)'],
  ['step', 'se mantiene y cambia de golpe en el keyframe siguiente'],
  ['ease-in, ease-out, ease-in-out', 'suaves: arranca despacio, frena al llegar o las dos cosas'],
  ['ease-in-quad, ease-out-quad, ease-in-out-quad', 'un poco más marcadas que las suaves'],
  ['ease-in-cubic, ease-out-cubic, ease-in-out-cubic', 'marcadas: un arranque o un frenado que se nota'],
  ['ease-in-expo, ease-out-expo, ease-in-out-expo', 'muy fuertes: casi quieto y después de golpe (ease-in-expo = «vuelve de golpe» al final), o un golpe que frena en seco (ease-out-expo)'],
  ['ease-in-back, ease-out-back, ease-in-out-back', 'se pasan: ease-in-back toma impulso hacia atrás antes de salir; ease-out-back se pasa del valor y vuelve (un rebote corto)'],
];

/**
 * Dos keyframes de una pista a menos de esto (en segundos) son el mismo momento: ponerlos reemplaza, quitar o mover
 * los elige juntos, y la validación no deja guardar dos tan cerca. Es menos que un cuadro a 120 fps.
 */
export const MISMO_TIEMPO = 1e-3;
export const mismoTiempo = (a, b) => Math.abs(a - b) < MISMO_TIEMPO;

/** Por qué una curva no sirve (null si sirve). `undefined` es linear. */
export function errorDeCurva(ease) {
  if (ease === undefined || NOMBRES_DE_CURVA.includes(ease)) return null;
  if (Array.isArray(ease)) {
    if (ease.length !== 4 || !ease.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'a cubic-bezier ease must be [x1, y1, x2, y2] with 4 numbers';
    if (ease[0] < 0 || ease[0] > 1 || ease[2] < 0 || ease[2] > 1) return 'in a cubic-bezier [x1, y1, x2, y2], x1 and x2 must be between 0 and 1 (like in CSS)';
    return null;
  }
  return `ease must be one of ${NOMBRES_DE_CURVA.join(', ')} or [x1, y1, x2, y2] (received ${JSON.stringify(ease)})`;
}

/**
 * Progreso con curva: `f` va de 0 a 1 en el tramo; devuelve cuánto del cambio ya ocurrió (puede salir de 0…1 con
 * una bezier que se pasa, como en CSS). `step` da 0 hasta el final del tramo.
 */
export function aplicarCurva(ease, f) {
  if (ease === 'step') return 0;
  const [x1, y1, x2, y2] = Array.isArray(ease) ? ease : (CURVAS_CON_NOMBRE[ease] ?? CURVAS_CON_NOMBRE.linear);
  if (x1 === y1 && x2 === y2) return f;
  return bezierY(y1, y2, resolverX(x1, x2, f));
}

// Cubic-bezier con extremos (0,0) y (1,1): B(s) = 3(1−s)²s·p1 + 3(1−s)s²·p2 + s³.
const bezier = (p1, p2, s) => ((1 - 3 * p2 + 3 * p1) * s + (3 * p2 - 6 * p1)) * s * s + 3 * p1 * s;
const derivada = (p1, p2, s) => 3 * (1 - 3 * p2 + 3 * p1) * s * s + 2 * (3 * p2 - 6 * p1) * s + 3 * p1;
const bezierY = (y1, y2, s) => bezier(y1, y2, s);

/** El parámetro s con B_x(s) = x: Newton-Raphson y, si no converge, bisección (el algoritmo clásico de CSS). */
function resolverX(x1, x2, x) {
  let s = x;
  for (let i = 0; i < 8; i++) {
    const error = bezier(x1, x2, s) - x;
    if (Math.abs(error) < 1e-7) return s;
    const d = derivada(x1, x2, s);
    if (Math.abs(d) < 1e-6) break;
    s -= error / d;
  }
  let [a, b] = [0, 1];
  s = x;
  for (let i = 0; i < 40; i++) {
    const v = bezier(x1, x2, s);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) a = s;
    else b = s;
    s = (a + b) / 2;
  }
  return s;
}
