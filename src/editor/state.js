// The editor's state: the open tabs, the active document and what is selected. Panels read it and listen for
// changes; every change to a document goes through `run` (a batch of operations on the server), `undo` or `redo`.

import { api } from './api.js';
import { findObject } from '../core/document.js';
import { applyOps } from '../core/operations.js';
import { resolveDoc, settleOps } from '../core/points.js';
import { schema } from './schema.js';

/**
 * @typedef {import('../core/document.js').Doc} Doc
 * @typedef {import('../core/operations.js').Operation} Operation
 * @typedef {{ id: string, name: string }} Tab
 * @typedef {'select' | 'move' | 'scale' | 'rotate' | 'pen' | 'rect' | 'ellipse'} Tool
 */

const TABS_KEY = 'aia.tabs';

export const state = {
  /** @type {Tab[]} */
  tabs: [],
  /** @type {string | null} */
  active: null,
  /** @type {Doc | null} the active document as the editor sees it: shared points resolved (see core/points.js) */
  document: null,
  /** @type {Doc | null} the active document exactly as it is saved */
  saved: null,
  canUndo: false,
  canRedo: false,
  /** @type {string | null} the main selected object: a layer or a part (the last one picked) */
  selected: null,
  /** @type {string[]} everything selected: one layer, or one or more parts; `selected` is the last one */
  selection: [],
  /** @type {Tool} the canvas tool */
  tool: 'select',
  /** @type {string | null} the vector layer whose points are being edited (a second click on a picked part) */
  editing: null,
  /** @type {string[]} the picked points while editing, as "part:index" (rect_1:2 is the third vertex of rect_1) */
  points: [],
  /** @type {string} the last message for the person (an error or what happened) */
  notice: '',
};

/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {() => void} listener */
export function onChange(listener) {
  listeners.add(listener);
}

function changed() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: state.tabs, active: state.active }));
  } catch {}
  for (const listener of listeners) listener();
}

/** @param {string} text */
export function notify(text) {
  state.notice = text;
  changed();
}

/** @param {import('./api.js').DocumentState} result */
function take(result) {
  state.saved = result.document;
  state.document = resolveDoc(result.document);
  state.canUndo = result.canUndo;
  state.canRedo = result.canRedo;
  setSelection(state.selection.filter((id) => findObject(result.document, id)));
  const tab = state.tabs.find((t) => t.id === state.active);
  if (tab) tab.name = String(result.document.meta.name ?? tab.id);
}

/** @param {() => Promise<void>} task */
async function guarded(task) {
  try {
    state.notice = '';
    await task();
  } catch (e) {
    state.notice = e.message;
  }
  changed();
}

/** @type {number} batches of this editor on their way to the server */
let sending = 0;

/**
 * Live: when the open document changes on disk from elsewhere (the AI, with aia), loads it again. A change of this
 * editor's own comes back too; it is the same document, so nothing moves.
 */
export function followChanges() {
  if (typeof EventSource === 'undefined') return;
  const events = new EventSource('/api/events');
  events.addEventListener('document', async (event) => {
    const { id } = JSON.parse(/** @type {MessageEvent} */ (event).data);
    if (id !== state.active || sending) return;
    try {
      const result = await api.get(id);
      if (id !== state.active || sending) return;
      if (JSON.stringify(result.document) === JSON.stringify(state.saved) && result.canUndo === state.canUndo) return;
      take(result);
      changed();
    } catch {}
  });
  events.addEventListener('deleted', (event) => {
    const { id } = JSON.parse(/** @type {MessageEvent} */ (event).data);
    if (state.tabs.some((t) => t.id === id)) {
      close(id);
      notify(`${id} was deleted`);
    }
  });
}

/** Reopens the tabs of the last session (the ones whose documents still exist). */
export async function restore() {
  let saved = { tabs: [], active: null };
  try {
    saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? '') ?? saved;
  } catch {}
  const existing = new Set((await api.list().catch(() => [])).map((d) => d.id));
  state.tabs = (saved.tabs ?? []).filter((t) => existing.has(t.id));
  const active = state.tabs.find((t) => t.id === saved.active) ?? state.tabs[0];
  if (active) await open(active.id);
  else changed();
}

/** @param {string} id */
export function open(id) {
  return guarded(async () => {
    const result = await api.get(id);
    if (!state.tabs.some((t) => t.id === id)) state.tabs.push({ id, name: String(result.document.meta.name ?? id) });
    state.active = id;
    setSelection([]);
    take(result);
  });
}

/** @param {string} id */
export async function close(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  state.tabs.splice(i, 1);
  if (state.active !== id) return changed();
  const next = state.tabs[Math.min(i, state.tabs.length - 1)];
  state.active = null;
  state.document = null;
  state.saved = null;
  setSelection([]);
  if (next) await open(next.id);
  else changed();
}

/** @param {Record<string, unknown>} meta */
export function createDocument(meta) {
  return guarded(async () => {
    const { id, ...result } = await api.create(meta);
    state.tabs.push({ id, name: String(result.document.meta.name ?? id) });
    state.active = id;
    setSelection([]);
    take(result);
  });
}

/** @param {string} id */
export async function deleteDocument(id) {
  try {
    await api.remove(id);
  } catch (e) {
    return notify(e.message);
  }
  await close(id);
}

/** Applies a batch without checking shared points (to look at its result before it is settled). @param {Doc} doc @param {Operation[]} ops */
const applyLoose = (doc, ops) => applyOps(schema, doc, ops, { checkPoints: false }).document;

/**
 * Applies a batch to the active document. The tools write it against `state.document` (shared vertices with x, y);
 * it is settled for the saved document first: a moved shared vertex moves the point it shares, and shared vertices
 * whose point is gone keep their place.
 * @param {Operation[]} ops
 * @param {{ note?: string, select?: string | string[] | null }} [options] select: what to select after it applies
 */
export function run(ops, { note, select } = {}) {
  const id = state.active;
  if (!id) return Promise.resolve();
  return guarded(async () => {
    sending++;
    const result = await api.ops(id, state.saved ? settleOps(state.saved, ops, applyLoose) : ops, note).finally(() => sending--);
    take(result);
    if (select !== undefined) setSelection(Array.isArray(select) ? select : select ? [select] : []);
  });
}

export const undo = () => state.active && state.canUndo && guarded(async () => take(await api.undo(state.active)));
export const redo = () => state.active && state.canRedo && guarded(async () => take(await api.redo(state.active)));

/** @param {string[]} ids */
function setSelection(ids) {
  state.selection = [...new Set(ids)];
  state.selected = state.selection.at(-1) ?? null;
  // Point editing lasts while what is selected is one part of the edited layer.
  const doc = state.document;
  const inLayer = state.selection.length === 1 && !!doc && findObject(doc, state.selection[0])?.parent === state.editing;
  if (state.editing && !inLayer) {
    state.editing = null;
    state.points = [];
  }
}

/**
 * Enters point editing of a part's vector layer, with that part as the main one; null leaves it.
 * @param {string | null} part
 */
export function editPoints(part) {
  const doc = state.document;
  const object = part && doc ? findObject(doc, part) : undefined;
  state.editing = object?.parent ?? null;
  state.points = [];
  if (object) setSelection([object.id]);
  changed();
}

/**
 * Picks points while editing; `main` becomes the selected part (its name shows in the options bar).
 * @param {string[]} keys "part:index" @param {string} [main]
 */
export function pickPoints(keys, main) {
  state.points = [...new Set(keys)];
  if (main) setSelection([main]);
  changed();
}

/** @param {string | null} id */
export function select(id) {
  setSelection(id ? [id] : []);
  changed();
}

/** @param {string[]} ids */
export function selectMany(ids) {
  setSelection(ids);
  changed();
}

/**
 * Shift+click: adds a part to the selection or takes it out. Only parts gather; a layer is always selected alone.
 * @param {string} id
 */
export function toggleSelect(id) {
  const doc = state.document;
  const isPartId = (/** @type {string} */ x) => {
    const object = doc ? findObject(doc, x) : undefined;
    const parent = object?.parent && doc ? findObject(doc, object.parent) : undefined;
    return parent?.type === 'vector';
  };
  if (!isPartId(id)) return select(id);
  const parts = state.selection.filter(isPartId);
  setSelection(parts.includes(id) ? parts.filter((x) => x !== id) : [...parts, id]);
  changed();
}

/** @param {Tool} tool */
export function setTool(tool) {
  state.tool = tool;
  if (!['select', 'move', 'scale', 'rotate'].includes(tool)) {
    state.editing = null;
    state.points = [];
  }
  changed();
}

/**
 * The vector layer the drawing tools draw into: the selected one, or the one of the selected part.
 * @returns {import('../core/document.js').DocObject | undefined}
 */
export function activeVector() {
  const doc = state.document;
  const selected = doc && state.selected ? findObject(doc, state.selected) : undefined;
  if (!doc || !selected) return undefined;
  if (selected.type === 'vector') return selected;
  const parent = selected.parent ? findObject(doc, selected.parent) : undefined;
  return parent?.type === 'vector' ? parent : undefined;
}

/** Whether an object or one of its ancestors is hidden. @param {string} id */
export function isHidden(id) {
  const doc = state.document;
  for (let object = doc ? findObject(doc, id) : undefined; object; object = object.parent ? findObject(doc, object.parent) : undefined) {
    if (object.visible === false) return true;
  }
  return false;
}

/**
 * Whether a part can be reached with the Transform tools and in point editing: its layer and the layers above it
 * are shown. A hidden part of a shown layer is drawn as a ghost outline, so it can still be picked and edited.
 * @param {string} id
 */
export function inShownLayer(id) {
  const parent = state.document && findObject(state.document, id)?.parent;
  return !parent || !isHidden(parent);
}

/**
 * Tab / Shift+Tab: picks the next or previous part of the active layer (hidden ones too), wrapping around.
 * @param {boolean} back
 */
export function walkParts(back) {
  const doc = state.document;
  const layer = activeVector();
  if (!doc || !layer || isLocked(layer.id)) return false;
  const parts = doc.objects.filter((o) => o.parent === layer.id);
  if (!parts.length) return false;
  const at = parts.findIndex((p) => p.id === state.selected);
  const next = at < 0 ? (back ? parts[parts.length - 1] : parts[0]) : parts[(at + (back ? -1 : 1) + parts.length) % parts.length];
  if (state.editing) pickPoints(state.points, next.id);
  else select(next.id);
  return true;
}

/** Whether an object or one of its ancestors is locked. @param {string} id */
export function isLocked(id) {
  const doc = state.document;
  for (let object = doc ? findObject(doc, id) : undefined; object; object = object.parent ? findObject(doc, object.parent) : undefined) {
    if (object.locked === true) return true;
  }
  return false;
}

/** The selected parts (not layers), in drawing order. @returns {import('../core/document.js').DocObject[]} */
export function selectedParts() {
  const doc = state.document;
  if (!doc) return [];
  return doc.objects.filter((o) => {
    if (!state.selection.includes(o.id) || !o.parent) return false;
    return findObject(doc, o.parent)?.type === 'vector';
  });
}

const STYLE_KEY = 'aia.style';

/**
 * The style new shapes get from the drawing tools (Moho's auto fill and auto stroke): null turns it off. An open
 * line never gets a fill. Kept per person in this browser.
 * @type {{ fill: string | null, stroke: string | null, strokeWidth: number }}
 */
export const drawStyle = (() => {
  const fallback = { fill: '#c8c2d4', stroke: '#2b2926', strokeWidth: 2 };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(STYLE_KEY) ?? '{}') };
  } catch {
    return fallback;
  }
})();

/** @param {Partial<typeof drawStyle>} changes */
export function setDrawStyle(changes) {
  Object.assign(drawStyle, changes);
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(drawStyle));
  } catch {}
  changed();
}

/** Whether the tool draws new shapes. @param {Tool} tool */
export const isDrawTool = (tool) => tool === 'pen' || tool === 'rect' || tool === 'ellipse';

/** Auto weld (point editing): an open end dropped on another open end welds them. Kept per person in this browser. */
export const autoWeld = { on: (() => { try { return localStorage.getItem('aia.autoWeld') !== 'off'; } catch { return true; } })() };

/** The Pen's Sharp corners: new points are corners instead of smooth curves. Kept per person in this browser. */
export const penOptions = { sharp: (() => { try { return localStorage.getItem('aia.penSharp') === 'on'; } catch { return false; } })() };

export function toggleSharpCorners() {
  penOptions.sharp = !penOptions.sharp;
  try {
    localStorage.setItem('aia.penSharp', penOptions.sharp ? 'on' : 'off');
  } catch {}
  changed();
}

export function toggleAutoWeld() {
  autoWeld.on = !autoWeld.on;
  try {
    localStorage.setItem('aia.autoWeld', autoWeld.on ? 'on' : 'off');
  } catch {}
  changed();
}
