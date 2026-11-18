// Moving around the canvas, as in Moho and every drawing app:
//   The wheel zooms around the pointer (Ctrl+wheel and a trackpad pinch too); Shift+wheel, or a sideways scroll,
//   moves the view sideways. Space+drag or a middle-button drag moves the view, whatever the tool.
//   Ctrl + / Ctrl − step the zoom around the middle, Ctrl+0 fits the artboard, Ctrl+1 is 100 %, Shift+2 zooms to
//   the selection (the picked points while editing them). The zoom shows in a corner of the canvas, with a menu.
// The view is not part of the document: each document's is kept in this browser, and a document seen for the first
// time (or after Ctrl+0) fits the artboard, following the window when it is resized.

import { state } from './state.js';
import { area, svg, view } from './view.js';
import { fitView, keepView, placeKept, stepScale, zoomAt } from './viewMath.js';

/** @typedef {import('./viewMath.js').KeptView} KeptView @typedef {import('./viewMath.js').View} View */

const MARGIN = 40; // screen px around the fitted artboard
const SELECTION_MARGIN = 80;
const KEY = 'aia.views';

/** @type {() => void} redraws the canvas (given by setupNavigation, so this module does not import canvas.js) */
let render = () => {};
/** @type {{ width: number, height: number }} the artboard's size at the last render */
let artboard = { width: 800, height: 600 };

/** @type {Record<string, KeptView>} each document's view; none = fit the artboard */
const kept = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
})();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {}
}

const screenSize = () => {
  const box = area.getBoundingClientRect();
  return { width: box.width, height: box.height };
};

/** Sets where the artboard sits for a drawing of this size (the canvas calls it on every render). @param {{ width: number, height: number }} drawing */
export function placeView(drawing) {
  const screen = screenSize();
  artboard = { width: drawing.width, height: drawing.height };
  const mine = state.active ? kept[state.active] : undefined;
  Object.assign(view, mine ? placeKept(mine, screen) : fitView(screen, { x: 0, y: 0, ...drawing }, MARGIN));
  label.textContent = `${Math.round(view.scale * 100)}%`;
}

/** Changes the view and keeps it. A zoom redraws everything (handles keep their size); a move only shifts the artboard. @param {View} next @param {boolean} redraw */
function setView(next, redraw = true) {
  if (!state.active) return;
  Object.assign(view, next);
  kept[state.active] = keepView(view, screenSize());
  save();
  if (redraw) render();
  else svg.querySelector(':scope > g')?.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
}

/** Zooms by steps around the middle of the canvas. @param {1 | -1} direction */
export function zoomStep(direction) {
  if (!state.document) return;
  const { width, height } = screenSize();
  setView(zoomAt(view, { x: width / 2, y: height / 2 }, stepScale(view.scale, direction)));
}

/**
 * Forgets a document's view (it was deleted, or a new one took its id), so it fits the artboard when it opens.
 * @param {string} id
 */
export function forgetView(id) {
  if (!(id in kept)) return;
  delete kept[id];
  save();
  if (id === state.active) render();
}

/** Ctrl+0: the artboard whole, following the window from then on. */
export function zoomFit() {
  if (!state.active) return;
  delete kept[state.active];
  save();
  render();
}

/** Ctrl+1: 100 %, around the middle. */
export function zoomActual() {
  if (!state.document) return;
  const { width, height } = screenSize();
  setView(zoomAt(view, { x: width / 2, y: height / 2 }, 1));
}

/**
 * Shift+2: the selection fills the canvas (the picked points while editing them); with nothing selected, the artboard.
 * A selection that draws nothing here (hidden) leaves the view as it is.
 */
export function zoomSelection() {
  if (!state.document) return;
  const points = state.editing && state.points.length > 0;
  if (!points && !state.selection.length) return zoomFit();
  const elements = points
    ? [...svg.querySelectorAll('.overlay .handle.point.picked')]
    : state.selection.flatMap((id) => [...svg.querySelectorAll(`.content [data-id="${CSS.escape(id)}"]`)]);
  // A point counts by its middle (where the vertex is), not by its square, whose size is in screen px.
  const boxes = elements
    .map((el) => el.getBoundingClientRect())
    .filter((b) => b.width || b.height)
    .map((b) => (points ? { left: (b.left + b.right) / 2, right: (b.left + b.right) / 2, top: (b.top + b.bottom) / 2, bottom: (b.top + b.bottom) / 2 } : b));
  if (!boxes.length) return;
  const origin = svg.getBoundingClientRect();
  const left = Math.min(...boxes.map((b) => b.left)) - origin.left;
  const top = Math.min(...boxes.map((b) => b.top)) - origin.top;
  const right = Math.max(...boxes.map((b) => b.right)) - origin.left;
  const bottom = Math.max(...boxes.map((b) => b.bottom)) - origin.top;
  // In document units, so pressing it again changes nothing: a point or a small selection gets at least a quarter of
  // the artboard around it, instead of the closest zoom.
  const room = Math.min(artboard.width, artboard.height) / 4;
  const width = Math.max((right - left) / view.scale, room);
  const height = Math.max((bottom - top) / view.scale, room);
  const cx = ((left + right) / 2 - view.x) / view.scale;
  const cy = ((top + bottom) / 2 - view.y) / view.scale;
  setView(fitView(screenSize(), { x: cx - width / 2, y: cy - height / 2, width, height }, SELECTION_MARGIN));
}

/** @type {boolean} Space is held: a drag moves the view */
let space = false;

/** Moves the view with the pointer until it is released. @param {PointerEvent} down */
function panDrag(down) {
  svg.setPointerCapture(down.pointerId);
  svg.classList.add('panning');
  let last = { x: down.clientX, y: down.clientY };
  const move = (/** @type {PointerEvent} */ e) => {
    setView({ ...view, x: view.x + e.clientX - last.x, y: view.y + e.clientY - last.y }, false);
    last = { x: e.clientX, y: e.clientY };
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.removeEventListener('pointercancel', up);
    svg.classList.remove('panning');
    render();
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
}

/** Whether a key goes to a field (typing a space there must not move the view). @param {EventTarget | null} target */
const typing = (target) => !!(/** @type {HTMLElement} */ (target)?.closest?.('input, textarea, select, [contenteditable], dialog'));

const label = document.createElement('button');
const control = document.createElement('div');

/** The zoom control shows only with a document open. @param {boolean} on */
export const showZoom = (on) => {
  control.hidden = !on;
};

/** @param {() => void} redraw the canvas's render */
export function setupNavigation(redraw) {
  render = redraw;
  // The zoom in a corner of the canvas, with a menu.
  control.className = 'dropdown zoom-control';
  label.type = 'button';
  label.title = 'Zoom (the wheel zooms around the pointer; Space+drag or the middle button moves the view)';
  label.setAttribute('aria-haspopup', 'menu');
  const menu = document.createElement('div');
  menu.className = 'menu up right';
  menu.hidden = true;
  /** @type {[string, string, () => void][]} */
  const items = [
    ['Zoom in', 'Ctrl +', () => zoomStep(1)],
    ['Zoom out', 'Ctrl −', () => zoomStep(-1)],
    ['Fit the artboard', 'Ctrl+0', zoomFit],
    ['100%', 'Ctrl+1', zoomActual],
    ['Zoom to the selection', 'Shift+2', zoomSelection],
  ];
  for (const [text, keys, act] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span>${text}</span><kbd>${keys}</kbd>`;
    b.addEventListener('click', act);
    menu.append(b);
  }
  control.append(label, menu);
  area.append(control);

  area.addEventListener(
    'wheel',
    (event) => {
      if (!state.document) return;
      event.preventDefault();
      // Not while a drag is going on (a marquee, a moved point): the overlay it draws on would be redrawn under it.
      if (event.buttons) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? screenSize().height : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (!event.ctrlKey && (event.shiftKey || Math.abs(dx) > Math.abs(dy))) {
        setView({ ...view, x: view.x - (event.shiftKey ? dy || dx : dx) }, false);
        return;
      }
      const box = svg.getBoundingClientRect();
      const at = { x: event.clientX - box.left, y: event.clientY - box.top };
      // A mouse notch (about 100) zooms about 20 %; a pinch sends many small steps.
      const factor = Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.0035);
      setView(zoomAt(view, at, view.scale * factor));
    },
    { passive: false },
  );

  // Before the tools: a middle-button drag, or a drag with Space held, moves the view.
  svg.addEventListener(
    'pointerdown',
    (event) => {
      if (!state.document || !(event.button === 1 || (event.button === 0 && space))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      panDrag(event);
    },
    { capture: true },
  );
  // No auto-scroll circle with the middle button.
  area.addEventListener('mousedown', (event) => event.button === 1 && event.preventDefault());

  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || typing(event.target)) return;
    event.preventDefault();
    if (space) return;
    space = true;
    svg.classList.add('pan-ready');
  });
  const release = () => {
    space = false;
    svg.classList.remove('pan-ready');
  };
  document.addEventListener('keyup', (event) => event.code === 'Space' && release());
  window.addEventListener('blur', release);
}
