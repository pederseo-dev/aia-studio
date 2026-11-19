// Elements and shapes (part 4 of docs/rebuild.md). A part drawn with its own points (Pen, Rectangle, Ellipse) is an
// **element**, with its own fill and stroke. What Create Shape makes on top of an element's lines is a **shape**: two
// parts that follow those lines, `<line>_fill` (only the fill) and `<line>_stroke` (only the stroke), numbered as a
// pair (`head_fill_2` with `head_stroke_2`). These rules are the one place that knows how a shape's parts are named,
// which element a shape belongs to and what moves with it; the gap search (fill.js), the rename cascade
// (operations.js), the Inspector and `aia` use them.

import { findObject } from './document.js';
import { holesOf, verticesOf } from './geometry.js';
import { followedLines, followsOthers } from './points.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {'fill' | 'stroke'} ShapeKind
 * @typedef {{ key: string, fill?: DocObject, stroke?: DocObject }} Shape one shape on an element: its fill part
 *   and its stroke part (either may be missing); key: the name they share (head, head_2)
 */

const SHAPE_NAME = /^(.+)_(fill|stroke)(_[0-9]+)?$/;

/**
 * The name of a shape's part: head_fill, head_stroke_2.
 * @param {string} base @param {ShapeKind} kind @param {string} [suffix] '' or _2, _3…
 */
export const shapePartName = (base, kind, suffix = '') => `${base}_${kind}${suffix}`;

/**
 * What a part's name says about it, when it is named as a shape's part: the name it is after, fill or stroke, and its
 * number ('' or _2…). Null for any other name.
 * @param {string} id @returns {{ base: string, kind: ShapeKind, suffix: string } | null}
 */
export function shapePartOf(id) {
  const match = SHAPE_NAME.exec(id);
  return match ? { base: match[1], kind: /** @type {ShapeKind} */ (match[2]), suffix: match[3] ?? '' } : null;
}

/**
 * The first free number for a new shape named after `base`, for its fill and its stroke alike ('' or _2…).
 * @param {(id: string) => boolean} taken @param {string} base
 */
export function freeShapeSuffix(taken, base) {
  let suffix = '';
  for (let n = 2; taken(shapePartName(base, 'fill', suffix)) || taken(shapePartName(base, 'stroke', suffix)); n++) suffix = `_${n}`;
  return suffix;
}

/**
 * The element a part belongs to: the part itself when it is drawn with its own points, or, for a shape's part (it
 * follows lines), the line it is named after, else the first line it follows.
 * @param {Doc} doc @param {DocObject} part
 */
export function elementOf(doc, part) {
  if (!followsOthers(part)) return part;
  const lines = followedLines(part);
  const named = shapePartOf(part.id)?.base;
  const id = named && lines.has(named) ? named : [...lines][0];
  return findObject(doc, id) ?? part;
}

/**
 * The shapes on an element: the parts of its layer that follow it, paired by name (head_fill_2 with
 * head_stroke_2); a part named otherwise is a shape of its own (its fill, its stroke, or both).
 * @param {Doc} doc @param {DocObject} element
 * @returns {Shape[]}
 */
export function shapesOf(doc, element) {
  /** @type {Map<string, Shape>} */
  const shapes = new Map();
  for (const o of doc.objects) {
    if (o.parent !== element.parent || o.type !== 'path' || !followedLines(o).has(element.id)) continue;
    const name = shapePartOf(o.id);
    const key = name ? `${name.base}${name.suffix}` : o.id;
    const shape = shapes.get(key) ?? { key };
    if (name) shape[name.kind] = o;
    else Object.assign(shape, { ...(o.fill !== null ? { fill: o } : {}), ...(o.stroke !== null ? { stroke: o } : {}) });
    shapes.set(key, shape);
  }
  return [...shapes.values()];
}

/**
 * What moves when parts are moved, turned or scaled: a shape is drawn from the lines it follows, so moving it moves
 * those lines whole (moving its shared points alone would pull only those points of the lines). The shape's part
 * itself moves too only when it has points of its own.
 * @param {Doc} doc @param {DocObject[]} parts
 * @returns {DocObject[]}
 */
export function partsToMove(doc, parts) {
  /** @type {Map<string, DocObject>} */
  const moving = new Map();
  for (const part of parts) {
    if (!followsOthers(part)) {
      moving.set(part.id, part);
      continue;
    }
    for (const id of followedLines(part)) {
      const line = findObject(doc, id);
      if (line) moving.set(line.id, line);
    }
    if ([...verticesOf(part), ...holesOf(part).flat()].some((v) => !v.ref)) moving.set(part.id, part);
  }
  return [...moving.values()];
}
