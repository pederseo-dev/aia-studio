// Drawing order inside a layer (Moho's Raise / Lower shape), for the editor (Page Up / Page Down) and `aia order`.
// Among siblings, a higher index draws over a lower one. Several objects move together and keep their order among
// themselves; ones already at the top (or bottom) stay, and the others close up under (or over) them.

import { childrenOf, findObject } from './document.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {'up' | 'down' | 'top' | 'bottom'} OrderMove
 */

export const ORDER_MOVES = /** @type {const} */ (['up', 'down', 'top', 'bottom']);

/**
 * The `move` ops that raise or lower objects among their siblings: one place (`up`, `down`) or all the way (`top`,
 * `bottom`). Objects with different parents move each among their own siblings. No ops when nothing would change.
 * @param {Doc} doc
 * @param {string[]} ids
 * @param {OrderMove} how
 * @returns {Operation[]}
 */
export function orderOps(doc, ids, how) {
  if (!ORDER_MOVES.includes(how)) throw new Error(`"${how}" is not an order move (${ORDER_MOVES.join(', ')})`);
  /** @type {Map<string | null, Set<string>>} */
  const byParent = new Map();
  for (const id of ids) {
    const object = findObject(doc, id);
    if (!object) throw new Error(`there is no object "${id}"`);
    const parent = object.parent ?? null;
    if (!byParent.has(parent)) byParent.set(parent, new Set());
    /** @type {Set<string>} */ (byParent.get(parent)).add(id);
  }
  /** @type {Operation[]} */
  const ops = [];
  for (const [parent, picked] of byParent) {
    const now = childrenOf(doc, parent).map((o) => o.id);
    const next = reorder(now, picked, how);
    if (next.every((id, i) => id === now[i])) continue;
    ops.push(...movesTo(now, next, picked, parent));
  }
  return ops;
}

/**
 * The new order of a list of siblings (bottom first).
 * @param {string[]} list @param {Set<string>} picked @param {OrderMove} how
 */
function reorder(list, picked, how) {
  const others = list.filter((id) => !picked.has(id));
  const moving = list.filter((id) => picked.has(id));
  if (how === 'top') return [...others, ...moving];
  if (how === 'bottom') return [...moving, ...others];
  const next = [...list];
  // One place: each picked object swaps with the unpicked neighbor on that side, the ones nearest that end first,
  // so a run of picked objects moves as one and stops at the end.
  const up = how === 'up';
  for (let k = 0; k < next.length; k++) {
    const i = up ? next.length - 1 - k : k;
    const j = up ? i + 1 : i - 1;
    if (picked.has(next[i]) && j >= 0 && j < next.length && !picked.has(next[j])) [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

/**
 * The `move` ops that turn `now` into `next`, moving only the picked objects. Taken from the top down, each one goes
 * right under the object that is over it in `next` (or to the top), which is already in its final place.
 * @param {string[]} now @param {string[]} next @param {Set<string>} picked @param {string | null} parent
 * @returns {Operation[]}
 */
function movesTo(now, next, picked, parent) {
  const list = [...now];
  /** @type {Operation[]} */
  const ops = [];
  for (let k = next.length - 1; k >= 0; k--) {
    const id = next[k];
    if (!picked.has(id)) continue;
    list.splice(list.indexOf(id), 1);
    const over = next[k + 1];
    const index = over === undefined ? list.length : list.indexOf(over);
    list.splice(index, 0, id);
    ops.push({ op: 'move', target: id, parent, index });
  }
  return ops;
}
