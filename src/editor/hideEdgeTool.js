// The Hide Edge tool (H), as Moho's Hide Edge (step 3 of part 4 in docs/rebuild.md): the stretch of a stroke under
// the pointer lights up (of the topmost element or shape stroke there, in a shown and unlocked layer; with Alt, of the
// one under it, as a shape's stroke under its line); a click hides it, without touching the fill, and a click on a
// hidden one shows it again. Hidden stretches show as a faint dashed
// line while the tool is on, so they can be found. The stretches and the batch come from the core (core/edges.js),
// the same as `aia edge`.

import { findObject } from '../core/document.js';
import { DEFAULTS, pathData } from '../core/draw.js';
import { edgeOps, hiddenStretches, isHidden as isHiddenStretch, stretchNear, stretchVertices } from '../core/edges.js';
import { addPainter, onToolDown, paintOverlay } from './canvas.js';
import { fromLayer, layerScreen, toLayer } from './pointEdit.js';
import { isHidden, isLocked, notify, run, state } from './state.js';
import { element, svg, toDoc } from './view.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/document.js').DocObject} DocObject
 * @typedef {import('../core/geometry.js').Point} Point
 * @typedef {import('../core/geometry.js').Vertex} Vertex
 * @typedef {import('../core/edges.js').Stretch} Stretch
 */

const HIT = 6; // screen px around a stroke (besides half its width)

/** @type {Stretch | null} the stretch under the pointer */
let hover = null;

/** The parts whose stroke the tool works on, the topmost first: shown, unlocked, with a stroke. @param {Doc} doc */
function strokedParts(doc) {
  return doc.objects
    .filter((o) => o.type === 'path' && o.stroke !== null && !isHidden(o.id) && !isLocked(o.id))
    .reverse();
}

/**
 * The stretch of a stroke under a place of the artboard, or null: of the topmost part there, or with `under` of the
 * next one down (the topmost again when there is no other).
 * @param {Doc} doc @param {Point} p @param {boolean} [under]
 * @returns {Stretch | null}
 */
function stretchAt(doc, p, under = false) {
  /** @type {Stretch[]} */
  const hits = [];
  for (const part of strokedParts(doc)) {
    const layer = String(part.parent);
    const reach = layerScreen(layer, HIT) + Number(part.strokeWidth ?? DEFAULTS.strokeWidth) / 2;
    const hit = stretchNear(part, toLayer(layer, p), reach);
    if (hit) hits.push({ part: hit.part, hole: hit.hole, index: hit.index });
    if (hits.length === (under ? 2 : 1)) break;
  }
  return hits[hits.length - 1] ?? null;
}

/** A stretch on the artboard as path data (its curve, through its layer's transform). @param {DocObject} part @param {Stretch} stretch */
function stretchPath(part, stretch) {
  const layer = String(part.parent);
  const [a, b] = stretchVertices(part, stretch);
  if (!a || !b) return '';
  /** A vertex and its handle toward the stretch, on the artboard. @param {Vertex} v @param {'in' | 'out'} side @returns {Vertex} */
  const onArtboard = (v, side) => {
    const p = fromLayer(layer, v);
    const handle = v[side];
    if (!handle) return p;
    const q = fromLayer(layer, { x: v.x + handle.x, y: v.y + handle.y });
    return { ...p, [side]: { x: q.x - p.x, y: q.y - p.y } };
  };
  return pathData([onArtboard(a, 'out'), onArtboard(b, 'in')], false);
}

/** @param {PointerEvent} event */
function edgeDown(event) {
  const doc = state.document;
  if (!doc) return;
  const stretch = stretchAt(doc, toDoc(event), event.altKey);
  if (!stretch) return;
  const hide = !isHiddenStretch(doc, stretch);
  try {
    const { ops, edge } = edgeOps(doc, stretch, hide);
    run(ops, { note: `${hide ? 'Hide' : 'Show'} the edge ${edge[0]} – ${edge[1]} of ${stretch.part}` });
  } catch (e) {
    notify(e.message);
  }
}

/** @param {SVGGElement} overlay @param {Doc} doc */
function paint(overlay, doc) {
  for (const part of strokedParts(doc)) {
    for (const stretch of hiddenStretches(part)) overlay.append(element('path', { d: stretchPath(part, stretch), class: 'edge-hidden' }));
  }
  const part = hover ? findObject(doc, hover.part) : undefined;
  if (part && hover) {
    const hidden = isHiddenStretch(doc, hover);
    overlay.append(element('path', { d: stretchPath(part, hover), class: `edge-hover${hidden ? ' hidden' : ''}` }));
  }
}

/** @param {Stretch | null} a @param {Stretch | null} b */
const same = (a, b) => (a && b ? a.part === b.part && a.hole === b.hole && a.index === b.index : a === b);

export function setupHideEdgeTool() {
  onToolDown('edge', edgeDown);
  svg.addEventListener('pointermove', (event) => {
    const doc = state.document;
    if (state.tool !== 'edge' || event.buttons || !doc) return;
    const next = stretchAt(doc, toDoc(event), event.altKey);
    if (same(next, hover)) return;
    hover = next;
    paintOverlay();
  });
  svg.addEventListener('pointerleave', () => {
    if (!hover) return;
    hover = null;
    paintOverlay();
  });
  addPainter((overlay, doc) => {
    if (state.tool !== 'edge') {
      hover = null;
      return;
    }
    // A stretch that is gone (the drawing changed) is no longer lit.
    const part = hover ? findObject(doc, hover.part) : undefined;
    if (hover && (!part || !stretchVertices(part, hover).length)) hover = null;
    paint(overlay, doc);
  });
}
