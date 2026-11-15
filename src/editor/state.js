// Editor state and actions. Every change to the document goes through `execute`, which uses the same operation engine
// as the AI: it is applied instantly on screen and saved on the server with origin "user".

import { createSchema } from '../core/schema.js';
import { findObject, skeletonOf, subtree } from '../core/document.js';
import { applyOperations, compact, keptPosition } from '../core/operations.js';

const defs = import.meta.glob('../../schema/*.json', { eager: true, import: 'default' });
export const schema = createSchema(Object.values(defs));

export const state = {
  documents: [],
  tabs: [], // ids of the open documents, in order
  id: null,
  doc: null,
  previewDoc: null, // document with a change in progress (drag, scrub), not saved yet
  selection: null, // the main object: the last picked, the one the inspector shows
  selected: [], // all the picked ones (includes the main one)
  editing: null, // id of the path whose points are being edited
  // Bind Points (as in Moho): the layer whose points are bound (the last vector layer or path picked; it stays while
  // a bone is picked) and the keys of its points picked to bind.
  bindTarget: null,
  bindPicked: [],
  vertex: null, // index of the selected vertex in point editing
  // Auto-weld (as in Moho): dropping an end point of an open path on its other end closes it. On by default; the
  // choice is remembered.
  autoWeld: readFlag('aia:auto-weld', true),
  tool: 'select',
  mode: 'design', // 'design' (drawing and rig), 'animate' (scene timeline) or 'puppet' (puppet controls and clips)
  // What is seen and edited on top of the setup: a pose or a clip (animation, at `time`). What is changed goes to the
  // pose or, in a clip, to a keyframe at the playhead time (autokey). null = the setup.
  pose: null,
  params: null, // param values in the Parameters view (null = nothing is blended)
  time: 0, // playhead of the open clip, in seconds
  playing: false,
  // ▶ Live (Puppet): the puppet running (src/editor/live.js). livePose = what is seen in this frame; liveState =
  // what is playing and with what weight. With Live on the document is not edited.
  live: false,
  livePose: null,
  liveState: null,
  history: { entries: [], user: { undo: false, redo: false } },
};

/** A remembered on/off editor preference (localStorage can fail: then the default). */
function readFlag(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : saved === '1';
  } catch {
    return fallback;
  }
}
export function setAutoWeld(value) {
  try {
    localStorage.setItem('aia:auto-weld', value ? '1' : '0');
  } catch {}
  setState({ autoWeld: value });
}

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
export function setState(changes) {
  Object.assign(state, changes);
  for (const fn of listeners) fn(changes);
}
export const docVisible = () => state.previewDoc ?? state.doc;

// ---------- Server ----------

async function request(filePath, body) {
  // keepalive: a grouped batch that is sent when the tab is closed still arrives.
  const options = body === undefined ? undefined : { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`/api/documents${filePath}`, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export const api = {
  list: () => request(''),
  create: (id, meta, copyFrom) => request('', { id, meta, copyFrom }),
  read: (id) => request(`/${id}`),
  history: (id) => request(`/${id}/history`),
  applyOps: (id, ops, note) => request(`/${id}/ops`, { ops, note }),
  undo: (id) => request(`/${id}/undo`, {}),
  redo: (id) => request(`/${id}/redo`, {}),
  delete: async (id) => {
    const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
  },
};

// ---------- Notices ----------

let timer;
export function notify(text, isError = false) {
  const notice = /** @type {HTMLElement} */ (document.querySelector('#notice'));
  notice.textContent = text;
  notice.title = text;
  notice.classList.toggle('error', isError);
  clearTimeout(timer);
  timer = setTimeout(() => (notice.textContent = ''), isError ? 8000 : 4000);
}

// ---------- Actions ----------

export async function loadDocuments() {
  setState({ documents: await api.list() });
}

// ---------- Remembered preferences (localStorage) ----------

// ---------- Tabs ----------

const TABS_KEY = 'aia-studio.tabs';

/** Tabs remembered from last time (only those that still exist). It is a convenience: if it fails, nothing happens. */
export function savedTabs() {
  try {
    const ids = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return ids.filter((id) => state.documents.some((d) => d.id === id));
  } catch {
    return [];
  }
}

function setTabs(tabs) {
  setState({ tabs });
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    // no storage: the tabs are not remembered
  }
}

/** Adds a tab without switching to it (for example, when the AI creates a document). */
export function addTab(id) {
  if (!state.tabs.includes(id)) setTabs([...state.tabs, id]);
}

export async function open(id) {
  await sendPending();
  const doc = await api.read(id);
  addTab(id);
  history.replaceState(null, '', `?doc=${encodeURIComponent(id)}`);
  setState({ id, doc, previewDoc: null, selection: null, selected: [], editing: null, vertex: null, pose: null, params: null, time: 0, playing: false });
  await refreshHistory();
}

/** Closes the tab (the document stays on disk) and moves to the neighboring one, if any. */
export async function closeTab(id) {
  const i = state.tabs.indexOf(id);
  if (i < 0) return;
  const tabs = state.tabs.filter((p) => p !== id);
  setTabs(tabs);
  if (id !== state.id) return;
  const neighbor = tabs[Math.min(i, tabs.length - 1)];
  if (neighbor) return open(neighbor);
  await sendPending();
  history.replaceState(null, '', location.pathname);
  setState({ id: null, doc: null, previewDoc: null, selection: null, selected: [], editing: null, vertex: null, pose: null, params: null, time: 0, playing: false, history: { entries: [], user: { undo: false, redo: false } } });
}

/** Documents being deleted from this editor (so as not to warn about a deletion the user asked for). */
export const deletedHere = new Set();

/** Deletes the document from disk (with its history) and closes its tab. */
export async function deleteDocument(id) {
  deletedHere.add(id);
  setTimeout(() => deletedHere.delete(id), 5000);
  await closeTab(id);
  await api.delete(id);
  await loadDocuments();
}

export async function refreshHistory() {
  if (state.id) setState({ history: await api.history(state.id) });
}

/** Shows a change without saving it (null discards it). If the change is not valid, it is simply not shown. */
export function preview(ops) {
  if (!ops) return state.previewDoc && setState({ previewDoc: null });
  if (state.live) return;
  try {
    setState({ previewDoc: applyOperations(state.doc, ops, schema).doc });
  } catch {
    // invalid intermediate value while typing: it is ignored
  }
}

// Batches are sent in order, one after the other.
/** @type {Promise<any>} */
let row = Promise.resolve();

// Consecutive changes to the same thing (arrows, arrows of a number field) are merged into a single batch:
// a single entry in the history and a single undo step.
const GROUP_WAIT = 800;
let pending = null;

export const hasPending = () => pending !== null || underway > 0;

/** Sends right away the grouped batch that is waiting. */
export function sendPending() {
  if (!pending) return row;
  const { id, ops, note, timer } = pending;
  clearTimeout(timer);
  pending = null;
  return send(id, ops, note);
}

/**
 * Applies a batch instantly on screen and saves it. With `group` (a key like "arrows:head"), consecutive batches
 * with the same key are merged until a moment passes without changes.
 */
/** @param {any[]} ops @param {string} [note] @param {{ group?: string }} [options] */
export function execute(ops, note, { group } = {}) {
  if (state.live) {
    notify('Live is on: turn it off (■ Live) to edit the document.', true);
    return Promise.resolve(false);
  }
  let result;
  try {
    result = applyOperations(state.doc, ops, schema);
  } catch (e) {
    notify(e.message, true);
    setState({ previewDoc: null });
    return Promise.resolve(false);
  }
  setState({ doc: result.doc, previewDoc: null });
  if (result.warnings.length) notify(result.warnings.join(' · '));

  if (pending && (pending.key !== group || pending.id !== state.id)) sendPending();
  if (!group) return send(state.id, ops, note);
  if (pending) {
    clearTimeout(pending.timer);
    pending.ops = compact([...pending.ops, ...ops]);
  } else {
    pending = { key: group, id: state.id, ops: compact(ops), note };
  }
  pending.timer = setTimeout(sendPending, GROUP_WAIT);
  return Promise.resolve(true);
}

let underway = 0;

function send(id, ops, note) {
  underway++;
  row = row.then(async () => {
    try {
      const { doc } = await api.applyOps(id, ops, note);
      // With batches still on their way to the server, the screen is ahead: it is not overwritten with an old state.
      if (state.id === id && !pending && underway === 1) setState({ doc });
    } catch (e) {
      notify(e.message, true);
      if (state.id === id) setState({ doc: await api.read(id) });
    } finally {
      underway--;
    }
    await refreshHistory();
    return true;
  });
  return row;
}

async function revert(kind) {
  if (!state.id) return;
  await sendPending();
  try {
    const { doc } = await api[kind](state.id);
    setState({ doc, previewDoc: null });
  } catch (e) {
    notify(e.message, true);
  }
  await refreshHistory();
}
export const undo = () => revert('undo');
export const redo = () => revert('redo');

export function select(id) {
  if (id !== state.selection || state.selected.length !== (id ? 1 : 0)) setState({ selection: id, selected: id ? [id] : [] });
}

/** Selection of several objects; the main one is the last, unless another is given. */
export function selectSeveral(ids, main = ids.at(-1) ?? null) {
  const unique = [...new Set(ids)];
  if (main && !unique.includes(main)) unique.push(main);
  setState({ selection: main, selected: unique });
}

/** Adds or removes an object from the selection (Ctrl/Shift + click). */
export function toggleSelection(id) {
  if (!state.selected.includes(id)) return selectSeveral([...state.selected, id], id);
  const rest = state.selected.filter((s) => s !== id);
  selectSeveral(rest, state.selection === id ? (rest.at(-1) ?? null) : state.selection);
}

/**
 * The selected objects that move, rotate, delete and duplicate act on: without those already inside another
 * selected one (moving them twice would offset them double) and in document order.
 */
export function selectionRoots() {
  const ids = new Set(state.selected.filter((id) => findObject(state.doc, id)));
  const inside = new Set();
  for (const id of ids) for (const d of subtree(state.doc, id)) if (d !== id) inside.add(d);
  return state.doc.objects.filter((o) => ids.has(o.id) && !inside.has(o.id)).map((o) => o.id);
}

/** A free id from a base: rect_1, rect_2... */
export function freeId(base) {
  for (let n = 1; ; n++) if (!findObject(state.doc, `${base}_${n}`)) return `${base}_${n}`;
}

/**
 * Where something new is created: inside the selected container or, if there is none, at the root. With a bone
 * selected, in its skeleton (the drawing does not go inside the bones). A vector layer only holds shapes: with one
 * selected (or one of its shapes), the new layer goes next to it.
 */
export function parentForNew() {
  let sel = state.selection && findObject(state.doc, state.selection);
  if (sel?.type === 'bone') return skeletonOf(state.doc, sel.id);
  if (sel?.type === 'shape') sel = findObject(state.doc, sel.parent);
  if (sel?.type === 'vector') return sel.parent ?? null;
  return sel && schema.types.get(sel.type).container ? sel.id : null;
}

/** The vector layer the drawing tools draw into: the selected one, or the one of the selected shape (null if none). */
export function drawingLayer() {
  const sel = state.selection && findObject(state.doc, state.selection);
  if (sel?.type === 'vector') return sel.id;
  if (sel?.type === 'shape') return sel.parent;
  return null;
}

/** What a click on the canvas picks: a shape picks its vector layer (with the layer picked, a click or a double click picks the shape). */
export function pickable(id) {
  const obj = id && findObject(state.doc, id);
  return obj?.type === 'shape' ? obj.parent : id;
}

/** When changing parent, the x/y that leaves the object in the same place on screen (on the given `doc`). */
export function keepPosition(doc, id, newParent) {
  const obj = findObject(doc, id);
  if ((obj.parent ?? null) === newParent) return [];
  return [{ op: 'set', target: id, props: keptPosition(doc, schema, obj, newParent) }];
}
