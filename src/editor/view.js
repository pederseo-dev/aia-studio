// What the canvas tools share: the SVG element, where the artboard sits on the screen, turning pointer positions into
// document coordinates, building SVG elements and following a drag.

export const NS = 'http://www.w3.org/2000/svg';
export const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.getElementById('canvas')));
export const area = /** @type {HTMLElement} */ (document.getElementById('canvas-area'));

/** Where the artboard sits on the screen: document point (x, y) is at screen (view.x + x·scale, view.y + y·scale). */
export const view = { x: 0, y: 0, scale: 1 };

/**
 * @typedef {{ x: number, y: number }} Point
 */

/** @param {string} tag @param {Record<string, string | number>} [attributes] */
export function element(tag, attributes = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, String(value));
  return el;
}

/** A pointer position in the artboard's coordinates. @param {{ clientX: number, clientY: number }} event @returns {Point} */
export function toDoc(event) {
  const box = svg.getBoundingClientRect();
  return { x: (event.clientX - box.left - view.x) / view.scale, y: (event.clientY - box.top - view.y) / view.scale };
}

/** A length of `px` screen pixels in document units (handle sizes, hit distances). @param {number} px */
export const screen = (px) => px / view.scale;

/**
 * Follows the pointer from a pointerdown until it is released.
 * @param {PointerEvent} down
 * @param {(p: Point, e: PointerEvent) => void} move
 * @param {(p: Point, e: PointerEvent) => void} up
 */
export function drag(down, move, up) {
  svg.setPointerCapture(down.pointerId);
  const onMove = (/** @type {PointerEvent} */ e) => move(toDoc(e), e);
  const onUp = (/** @type {PointerEvent} */ e) => {
    svg.removeEventListener('pointermove', onMove);
    svg.removeEventListener('pointerup', onUp);
    svg.removeEventListener('pointercancel', onUp);
    up(toDoc(e), e);
  };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
}
