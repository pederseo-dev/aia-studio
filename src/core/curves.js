// Keyframe interpolation curves. Each keyframe carries its own and it applies to the span leaving it (like in
// Moho and Rive). All are cubic-bezier like CSS ones, so they carry over losslessly to CSS, Lottie and Rive; `step`
// holds the value until the next keyframe.

// The strong ones (quad, cubic, expo, back) are the classic cubic-bezier approximations (those of easings.net).
export const NAMED_CURVES = {
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
export const CURVE_NAMES = [...Object.keys(NAMED_CURVES), 'step'];

/** What each curve does, for the AI guide (one line per family). */
export const CURVE_DESCRIPTIONS = [
  ['linear', 'even speed (the default)'],
  ['step', 'holds, then jumps at the next keyframe'],
  ['ease-in, ease-out, ease-in-out', 'gentle: starts slowly, slows down on arrival, or both'],
  ['ease-in-quad, ease-out-quad, ease-in-out-quad', 'a bit stronger than the gentle ones'],
  ['ease-in-cubic, ease-out-cubic, ease-in-out-cubic', 'strong: a noticeable start or stop'],
  ['ease-in-expo, ease-out-expo, ease-in-out-expo', 'very strong: almost still, then all at once (ease-in-expo = "snaps back" at the end), or a burst that stops dead (ease-out-expo)'],
  ['ease-in-back, ease-out-back, ease-in-out-back', 'overshoot: ease-in-back winds up backwards before leaving; ease-out-back goes past the value and comes back (a short bounce)'],
];

/**
 * Two keyframes of a track closer than this (in seconds) are the same moment: setting one replaces, removing or
 * moving picks them together, and validation does not allow saving two this close. It is less than a frame at 120 fps.
 */
export const SAME_TIME = 1e-3;
export const sameTime = (a, b) => Math.abs(a - b) < SAME_TIME;

/** Why a curve is not valid (null if it is). `undefined` is linear. */
export function curveError(ease) {
  if (ease === undefined || CURVE_NAMES.includes(ease)) return null;
  if (Array.isArray(ease)) {
    if (ease.length !== 4 || !ease.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'a cubic-bezier ease must be [x1, y1, x2, y2] with 4 numbers';
    if (ease[0] < 0 || ease[0] > 1 || ease[2] < 0 || ease[2] > 1) return 'in a cubic-bezier [x1, y1, x2, y2], x1 and x2 must be between 0 and 1 (like in CSS)';
    return null;
  }
  return `ease must be one of ${CURVE_NAMES.join(', ')} or [x1, y1, x2, y2] (received ${JSON.stringify(ease)})`;
}

/**
 * Progress with a curve: `f` goes from 0 to 1 over the span; returns how much of the change has already happened
 * (it can leave 0…1 with an overshooting bezier, like in CSS). `step` gives 0 until the end of the span.
 */
export function applyCurve(ease, f) {
  if (ease === 'step') return 0;
  const [x1, y1, x2, y2] = Array.isArray(ease) ? ease : (NAMED_CURVES[ease] ?? NAMED_CURVES.linear);
  if (x1 === y1 && x2 === y2) return f;
  return bezierY(y1, y2, resolveX(x1, x2, f));
}

// Cubic-bezier with endpoints (0,0) and (1,1): B(s) = 3(1−s)²s·p1 + 3(1−s)s²·p2 + s³.
const bezier = (p1, p2, s) => ((1 - 3 * p2 + 3 * p1) * s + (3 * p2 - 6 * p1)) * s * s + 3 * p1 * s;
const derivative = (p1, p2, s) => 3 * (1 - 3 * p2 + 3 * p1) * s * s + 2 * (3 * p2 - 6 * p1) * s + 3 * p1;
const bezierY = (y1, y2, s) => bezier(y1, y2, s);

/** The parameter s with B_x(s) = x: Newton-Raphson and, if it does not converge, bisection (classic CSS algorithm). */
function resolveX(x1, x2, x) {
  let s = x;
  for (let i = 0; i < 8; i++) {
    const error = bezier(x1, x2, s) - x;
    if (Math.abs(error) < 1e-7) return s;
    const d = derivative(x1, x2, s);
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
