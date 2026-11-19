// The canvas: the artboard of the active document, drawn with the core's drawDocument, plus an overlay where the
// tools draw what they need (the selection frame and its handles, the pen's outline). While a tool drags, it shows
// a preview document instead of the saved one, and commits a single batch when the pointer is released.

import { childrenOf } from '../core/document.js';
import { drawDocument, partData } from '../core/draw.js';
import { syncShared } from '../core/points.js';
import { assetUrl } from './images.js';
import { state } from './state.js';
import { area, element, screen, svg, view } from './view.js';
import { placeView, showZoom } from './navigate.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/document.js').DocObject} DocObject
 * @typedef {import('../core/draw.js').SvgNode} SvgNode
 * @typedef {(overlay: SVGGElement, doc: Doc) => void} Painter
 * @typedef {(event: PointerEvent) => void} PointerHandler
 */

const empty = /** @type {HTMLElement} */ (document.getElementById('empty'));

/** @type {Painter[]} each tool adds what it draws on the overlay */
const painters = [];
/** @param {Painter} painter */
export const addPainter = (painter) => painters.push(painter);

/** @type {Doc | null} what a drag shows until it commits */
let preview = null;
/** @type {SVGGElement | null} */
let overlay = null;

/**
 * Shows a document other than the saved one (a drag in progress), or the saved one again with null. What is shared
 * stays together: a moved shared vertex drags the point it shares.
 * @param {Doc | null} doc
 */
export function showPreview(doc) {
  preview = doc && state.document ? syncShared(doc, state.document) : doc;
  render();
}

/** @param {SvgNode} node @returns {SVGElement} */
function toElement(node) {
  const el = element(node.tag, node.attrs);
  for (const child of node.children) el.append(toElement(child));
  return el;
}

export function render() {
  const doc = preview ?? state.document;
  empty.hidden = !!state.document;
  svg.style.display = doc ? '' : 'none';
  svg.dataset.tool = state.tool;
  showZoom(!!doc);
  if (!doc) return;
  const drawing = drawDocument(doc, { assetUrl });
  // Where the artboard sits: the document's kept view, or the artboard fitted (navigate.js).
  placeView(drawing);
  const box = area.getBoundingClientRect();
  svg.setAttribute('width', String(box.width));
  svg.setAttribute('height', String(box.height));

  const defs = element('defs');
  const checker = element('pattern', { id: 'checker', width: 16, height: 16, patternUnits: 'userSpaceOnUse' });
  checker.append(
    element('rect', { width: 16, height: 16, fill: '#ffffff' }),
    element('rect', { width: 8, height: 8, fill: '#d9d9d9' }),
    element('rect', { x: 8, y: 8, width: 8, height: 8, fill: '#d9d9d9' }),
  );
  defs.append(checker);
  const artboard = element('g', { transform: `translate(${view.x} ${view.y}) scale(${view.scale})` });
  const background = element('rect', {
    width: drawing.width,
    height: drawing.height,
    fill: drawing.background ?? 'url(#checker)',
    class: 'artboard',
  });
  const content = element('g', { class: 'content' });
  content.append(...drawing.nodes.map(toElement));
  if (GHOST_TOOLS.includes(state.tool)) {
    addGhosts(content, doc);
    addLineHits(content);
  }
  overlay = /** @type {SVGGElement} */ (element('g', { class: 'overlay' }));
  artboard.append(background, content, overlay);
  svg.replaceChildren(defs, artboard);
  paintOverlay();
}

const GHOST_TOOLS = ['select', 'move', 'scale', 'rotate'];
const GHOST_HIT = 8; // screen px, how near the outline of an open ghost a click picks it

/** Why a part draws nothing: hidden, or empty (neither fill nor stroke); '' if it draws. @param {DocObject} part */
export function ghostKind(part) {
  if (part.visible === false) return 'hidden';
  return part.fill === null && part.stroke === null ? 'empty' : '';
}

/** A ghost outline: a dashed line, and a transparent area (or a wide line, for an open one) to pick it. @param {DocObject} part @param {string} kind */
function ghost(part, kind) {
  const d = partData(part);
  const closed = part.closed !== false;
  const g = element('g', { 'data-id': part.id, class: `ghost ${kind}` });
  g.append(
    element('path', { d, class: 'ghost-hit', fill: closed ? 'transparent' : 'none', 'stroke-width': screen(GHOST_HIT) }),
    element('path', { d, class: 'ghost-line' }),
  );
  return g;
}

/** Puts the ghost outlines of every shown vector layer in their place among its parts. @param {Element} content @param {Doc} doc */
function addGhosts(content, doc) {
  for (const group of content.querySelectorAll('g[data-id]')) {
    const id = group.getAttribute('data-id') ?? '';
    const parts = childrenOf(doc, id);
    if (!parts.some(ghostKind)) continue;
    const drawn = new Map([...group.children].map((el) => [el.getAttribute('data-id'), el]));
    /** @type {Element[]} */
    const items = [];
    for (const part of parts) {
      const kind = ghostKind(part);
      const el = kind ? ghost(part, kind) : drawn.get(part.id);
      if (el) items.push(el);
    }
    group.replaceChildren(...items);
  }
}

const LINE_HIT = 10; // screen px, how wide the band around a line without fill is where a click picks it

/**
 * Lines without fill are picked by their stroke, which is thin; an invisible wider band right after each one (so in
 * its place among the parts) makes them easy to pick, even over a fill under them.
 * @param {Element} content
 */
function addLineHits(content) {
  for (const line of content.querySelectorAll('path[data-id][fill="none"][stroke]')) {
    const hit = element('path', { d: line.getAttribute('d') ?? '', 'data-id': line.getAttribute('data-id') ?? '', class: 'line-hit', fill: 'none', stroke: 'transparent', 'stroke-width': screen(LINE_HIT) });
    line.after(hit);
  }
}

/** Redraws only the overlay (the pen's rubber band follows the pointer without redrawing the drawing). */
export function paintOverlay() {
  const doc = preview ?? state.document;
  if (!overlay || !doc) return;
  overlay.replaceChildren();
  for (const paint of painters) paint(overlay, doc);
}

/** @type {Record<string, PointerHandler>} the pointerdown of each tool */
const tools = {};
/** @param {string} tool @param {PointerHandler} handler */
export const onToolDown = (tool, handler) => {
  tools[tool] = handler;
};

export function setupCanvas() {
  new ResizeObserver(() => render()).observe(area);
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !state.document) return;
    event.preventDefault();
    tools[state.tool]?.(event);
  });
}
