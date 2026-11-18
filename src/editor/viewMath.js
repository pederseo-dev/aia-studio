// The canvas view without the DOM: where the artboard sits on the screen (document point (x, y) is at screen
// (view.x + x·scale, view.y + y·scale)), fitting a box in it, zooming around a point that stays still, the zoom
// steps, and the view as it is kept between sessions (the document point at the middle of the screen, so a resized
// window keeps what was in the middle).

/**
 * @typedef {{ x: number, y: number, scale: number }} View
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 * @typedef {{ width: number, height: number }} Size
 * @typedef {{ scale: number, cx: number, cy: number }} KeptView
 */

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 64;
/** The zoom levels Ctrl + / Ctrl − step through. */
export const STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

/** @param {number} scale */
export const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/**
 * The view that shows a box of the document whole and centered on a screen, with a margin around it (smaller on a
 * small screen: never more than a quarter of it on each side).
 * @param {Size} screen @param {Box} box in document units @param {number} margin in screen px
 * @returns {View}
 */
export function fitView(screen, box, margin) {
  const width = Math.max(box.width, 1e-6);
  const height = Math.max(box.height, 1e-6);
  const mx = Math.min(margin, screen.width / 4);
  const my = Math.min(margin, screen.height / 4);
  const scale = clampScale(Math.min((screen.width - mx * 2) / width, (screen.height - my * 2) / height));
  return {
    scale,
    x: (screen.width - width * scale) / 2 - box.x * scale,
    y: (screen.height - height * scale) / 2 - box.y * scale,
  };
}

/**
 * The view at another scale with the document point under `at` (a screen point) still under it.
 * @param {View} view @param {{ x: number, y: number }} at @param {number} scale
 * @returns {View}
 */
export function zoomAt(view, at, scale) {
  const next = clampScale(scale);
  const docX = (at.x - view.x) / view.scale;
  const docY = (at.y - view.y) / view.scale;
  return { scale: next, x: at.x - docX * next, y: at.y - docY * next };
}

/**
 * The next zoom step in or out from a scale (one that is between steps goes to the nearest one that way).
 * @param {number} scale @param {1 | -1} direction
 */
export function stepScale(scale, direction) {
  const next = direction > 0 ? STEPS.find((s) => s > scale * 1.001) : STEPS.findLast((s) => s < scale * 0.999);
  return next ?? (direction > 0 ? MAX_SCALE : MIN_SCALE);
}

/** The view as it is kept: its scale and the document point at the middle of the screen. @param {View} view @param {Size} screen @returns {KeptView} */
export const keepView = (view, screen) => ({
  scale: view.scale,
  cx: (screen.width / 2 - view.x) / view.scale,
  cy: (screen.height / 2 - view.y) / view.scale,
});

/** A kept view back on a screen of any size. @param {KeptView} kept @param {Size} screen @returns {View} */
export const placeKept = (kept, screen) => {
  const scale = clampScale(kept.scale);
  return { scale, x: screen.width / 2 - kept.cx * scale, y: screen.height / 2 - kept.cy * scale };
};
