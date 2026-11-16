// The document: its properties (`meta`) and a flat list of objects, each with a stable text id that is also its name
// (`head`, `left_eye`) and the id of its `parent` (null at the root). The list is always kept in tree order: each
// object right after its parent, siblings in drawing order (the last one is drawn on top). Only values that differ
// from the schema's default are stored, so the JSON says what was chosen and nothing else.

/**
 * @typedef {{ id: string, type: string, parent: string | null, [property: string]: unknown }} DocObject
 * @typedef {{ aia: number, meta: Record<string, unknown>, objects: DocObject[] }} Doc
 */

export const FORMAT_VERSION = 1;

/** Ids: lowercase letters, digits and _, starting with a letter. */
export const ID = /^[a-z][a-z0-9_]*$/;

/**
 * @param {Record<string, unknown>} [meta]
 * @returns {Doc}
 */
export function newDocument(meta = {}) {
  return { aia: FORMAT_VERSION, meta: { ...meta }, objects: [] };
}

/** @param {Doc} doc @param {string} id */
export const findObject = (doc, id) => doc.objects.find((o) => o.id === id);

/**
 * Children of a parent (null = the root), in drawing order.
 * @param {Doc} doc @param {string | null} parent
 */
export const childrenOf = (doc, parent) => doc.objects.filter((o) => o.parent === parent);

/**
 * The object and everything under it, in tree order.
 * @param {Doc} doc @param {string} id
 * @returns {DocObject[]}
 */
export function subtree(doc, id) {
  const object = findObject(doc, id);
  if (!object) return [];
  return [object, ...childrenOf(doc, id).flatMap((child) => subtree(doc, child.id))];
}

/**
 * The list in tree order (each object right after its parent).
 * @param {Doc} doc
 * @returns {DocObject[]}
 */
export function treeOrder(doc) {
  /** @param {string | null} parent @returns {DocObject[]} */
  const walk = (parent) => childrenOf(doc, parent).flatMap((o) => [o, ...walk(o.id)]);
  return walk(null);
}

/**
 * A free id from a name typed by a person: "Left Eye" → "left_eye", "2nd" → "l_2nd"; taken ids get _2, _3…
 * @param {string} text
 * @param {(id: string) => boolean} taken
 */
export function idFromName(text, taken) {
  let base = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = 'layer';
  if (!/^[a-z]/.test(base)) base = `l_${base}`;
  if (!taken(base)) return base;
  const stem = base.replace(/_\d+$/, '');
  for (let n = 2; ; n++) if (!taken(`${stem}_${n}`)) return `${stem}_${n}`;
}
