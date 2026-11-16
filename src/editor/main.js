// Editor entry point: mounts the panels and wires up the bar, the keyboard and the live notices.

import { askText } from './ask.js';
import { findObject, skeletonOf, children, subtree, locked } from '../core/document.js';
import { applyOperations } from '../core/operations.js';
import { read, readMeta } from '../core/schema.js';
import { artboardOps } from '../core/artboard.js';
import { mountTree } from './layers.js';
import { notifyLoose, bindByProximity, reasonNotToBind, releaseOnMove } from './bones.js';
import { mountHistory } from './history.js';
import { ARROW, ICONS } from './icons.js';
import { importOperations } from './importSvg.js';
import { addImages, imagesOnly } from './images.js';
import { mountInspector } from './inspector.js';
import { mountCanvas } from './canvas.js';
import { createFromPicked, isShapeTool, shapeToolLayer } from './shapeTools.js';
import { isSelectShape, restackShape } from './selectShape.js';
import { mountOptions } from './toolOptions.js';
import { mountParameters } from './parameters.js';
import { changeMode, mountClips, mountModes, mountTimeline } from './timeline.js';
import { mountBanner, mountPoses } from './poses.js';
import { resetParams } from './live.js';
import { onServer } from './serverEvents.js';
import { mountConnectAi, showConnectAi } from './connectAi.js';
import {
  open, addTab, api, notify, deletedHere, loadDocuments, closeTab, undo, execute, deleteDocument,
  sendPending, schema, state, setState, hasPending, freeId, keepPosition, parentForNew, pickable,
  savedTabs, refreshHistory, redo, selectionRoots, select, selectSeveral, subscribe,
} from './state.js';

const $ = (s) => document.querySelector(s);
// Fixed icons of the HTML: data-icon puts them at the start of the element and data-arrow is a dropdown's arrow.
for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-icon]'))) el.insertAdjacentHTML('afterbegin', ICONS[el.dataset.icon]);
for (const el of document.querySelectorAll('[data-arrow]')) el.innerHTML = ARROW;

mountTree($('#tree'), $('#resources'));
mountInspector($('#inspector'));
mountHistory($('#entries'));
const canvas = mountCanvas($('#canvas'));
mountOptions($('#options'), { projectSettings: () => showSettings(), group: () => groupSelection(), switch: () => newSwitch(), skeleton: () => newSkeleton(), bind: () => bindSelection(), bindAll: bindByProximity });
mountParameters($('#parameters'), $('#new-param'), $('#delete-param'));
mountModes($('#modes'));
mountClips($('#clips'), $('#list-clips'), $('#new-clip'), $('#live'), $('#show-manifest'), $('#delete-clip'));
mountPoses($('#section-poses'), $('#list-poses'), $('#new-pose'), $('#delete-pose'));
$('#reset-params').addEventListener('click', resetParams);
mountBanner($('#banner'));

// Clips, Parameters and Poses (Puppet) collapse with the title arrow; the user's choice is remembered.
for (const section of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-foldable]'))) {
  const key = `aia:folded:${section.dataset.foldable}`;
  const button = section.querySelector('.fold-section');
  const fold = (folded) => {
    section.classList.toggle('folded', folded);
    button.setAttribute('aria-expanded', String(!folded));
  };
  button.addEventListener('click', () => {
    const folded = !section.classList.contains('folded');
    try {
      localStorage.setItem(key, folded ? '1' : '0');
    } catch {}
    fold(folded);
  });
  try {
    fold(localStorage.getItem(key) === '1');
  } catch {}
}
mountTimeline($('#timeline'));

// At the bottom, the timeline takes the whole panel (Design has none). Params belong to the puppet: the Parameters
// panel, on the right, is only in Puppet. An Animate scene does not animate params; it keys the values themselves.
function drawParameters() {
  $('#parameters-section').hidden = state.mode !== 'puppet';
}
subscribe((c) => {
  if ('mode' in c || 'doc' in c) drawParameters();
  // When opening another document, the mode stays: in Animate its first scene is opened.
  if ('id' in c && state.doc && state.mode !== 'design') changeMode(state.mode);
});
drawParameters();

// Collapsible History: in Animate and Puppet it starts collapsed to leave room for the inspector and animation panels.
// The user's choice is remembered per mode.
const historyKey = () => `aia:folded-history:${state.mode}`;
function foldedHistory() {
  try {
    const saved = localStorage.getItem(historyKey());
    if (saved !== null) return saved === '1';
  } catch {}
  return state.mode !== 'design';
}
function foldHistory(folded) {
  document.body.classList.toggle('folded-history', folded);
  $('#fold-history').setAttribute('aria-expanded', String(!folded));
}
$('#fold-history').addEventListener('click', () => {
  const folded = !document.body.classList.contains('folded-history');
  try {
    localStorage.setItem(historyKey(), folded ? '1' : '0');
  } catch {}
  foldHistory(folded);
});
subscribe((c) => 'mode' in c && foldHistory(foldedHistory()));
foldHistory(foldedHistory());

// Collapsible Layers (open by default), like Assets; the user's choice is remembered.
function foldLayers(folded) {
  document.body.classList.toggle('folded-layers', folded);
  $('#fold-layers').setAttribute('aria-expanded', String(!folded));
}
$('#fold-layers').addEventListener('click', () => {
  const folded = !document.body.classList.contains('folded-layers');
  try {
    localStorage.setItem('aia:folded-layers', folded ? '1' : '0');
  } catch {}
  foldLayers(folded);
});
try {
  foldLayers(localStorage.getItem('aia:folded-layers') === '1');
} catch {}

// Collapsible Assets (open by default); the user's choice is remembered.
function foldResources(folded) {
  document.body.classList.toggle('folded-resources', folded);
  $('#fold-resources').setAttribute('aria-expanded', String(!folded));
}
$('#fold-resources').addEventListener('click', () => {
  const folded = !document.body.classList.contains('folded-resources');
  try {
    localStorage.setItem('aia:folded-resources', folded ? '1' : '0');
  } catch {}
  foldResources(folded);
});
try {
  foldResources(localStorage.getItem('aia:folded-resources') === '1');
} catch {}

// ---------- Dropdown menus (main menu, zoom, tool groups) ----------

function toggleMenu(menu, button) {
  const openIt = menu.hidden;
  closeMenus();
  if (!openIt) return;
  menu.hidden = false;
  button?.setAttribute('aria-expanded', 'true');
  // Fixed position next to the dropdown: that way a panel with overflow (the hierarchy) does not clip the menu.
  const box = (menu.closest('.dropdown') ?? button).getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = menu.classList.contains('right') ? box.right - width : box.left;
  menu.style.left = `${Math.max(4, Math.min(left, innerWidth - width - 4))}px`;
  menu.style.top = `${box.bottom + 4}px`;
}
addEventListener('resize', closeMenus);

function closeMenus() {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.menu')).forEach((m) => (m.hidden = true));
  document.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

document.addEventListener('pointerdown', (e) => {
  if (!(/** @type {Element} */ (e.target)).closest('.dropdown')) closeMenus();
});

// ---------- Main menu ----------

const ACTIONS = {
  new: () => newDocument(),
  open: showOpen,
  copy: () => newDocument(state.id),
  import: () => $('#svg-file').click(),
  close: () => closeTab(state.id),
  delete: async () => {
    const d = state.documents.find((x) => x.id === state.id);
    if (!confirm(`Delete “${d?.name ?? state.id}” and all its history? This can’t be undone.`)) return;
    try {
      await deleteDocument(state.id);
      notify(`Deleted “${d?.name ?? state.id}”`);
    } catch (err) {
      notify(err.message, true);
    }
  },
  shortcuts: () => $('#shortcuts-dialog').showModal(),
  ai: () => showConnectAi(),
  settings: () => showSettings(),
};

// ---------- Project Settings (like Moho's File → Project Settings) ----------

/** Dialog with the document properties. The size changes with the drawing centered, same as the Artboard tool. */
function showSettings() {
  if (!state.doc) return;
  const f = $('#form-settings').elements;
  const meta = (p) => readMeta(schema, state.doc, p);
  f.name.value = meta('name');
  f.width.value = meta('width');
  f.height.value = meta('height');
  f.fps.value = meta('fps');
  const background = meta('background');
  f.transparent.checked = background == null;
  f.background.value = background ?? schema.meta.properties.background.default;
  f.background.disabled = background == null;
  $('#settings-dialog').showModal();
}
$('#form-settings').elements.transparent.addEventListener('change', (e) => ($('#form-settings').elements.background.disabled = e.target.checked));
$('#form-settings [data-close]').addEventListener('click', () => $('#settings-dialog').close());
$('#form-settings').addEventListener('submit', () => {
  const f = $('#form-settings').elements;
  const doc = state.doc;
  if (!doc) return;
  const meta = (p) => readMeta(schema, doc, p);
  const width = Math.round(Number(f.width.value));
  const height = Math.round(Number(f.height.value));
  const ops = width !== meta('width') || height !== meta('height') ? artboardOps(doc, schema, width, height) : [];
  const props = {};
  const name = f.name.value.trim();
  if (name && name !== meta('name')) props.name = name;
  const background = f.transparent.checked ? null : f.background.value;
  if (background !== meta('background')) props.background = background;
  if (Number(f.fps.value) !== meta('fps')) props.fps = Number(f.fps.value);
  if (Object.keys(props).length) ops.push({ op: 'set', target: 'meta', props });
  if (ops.length) execute(ops, 'project settings');
});

$('#menu-button').addEventListener('click', () => toggleMenu($('#menu'), $('#menu-button')));
$('#menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b || b.disabled) return;
  closeMenus();
  ACTIONS[b.dataset.action]();
});
$('#tab-new').addEventListener('click', () => newDocument());

function showOpen() {
  const list = $('#documents-list');
  list.replaceChildren(
    ...state.documents.map((d) => {
      const li = document.createElement('li');
      li.innerHTML = '<button type="button"><span class="name"></span><span class="id"></span></button>';
      li.querySelector('.name').textContent = d.name;
      li.querySelector('.id').textContent = state.tabs.includes(d.id) ? `${d.id} · open` : d.id;
      li.querySelector('button').addEventListener('click', () => {
        $('#dialog-open').close();
        open(d.id);
      });
      return li;
    }),
  );
  if (!state.documents.length) list.innerHTML = '<li class="help">No files yet.</li>';
  $('#dialog-open').showModal();
}

// ---------- Tabs ----------

function drawTabs() {
  $('#tabs').replaceChildren(
    ...state.tabs.map((id) => {
      const d = state.documents.find((x) => x.id === id);
      const tab = document.createElement('div');
      tab.className = `tab${id === state.id ? ' active' : ''}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(id === state.id));
      tab.title = id;
      tab.innerHTML = '<span class="title"></span><button type="button" class="close" title="Close tab (the document is not deleted)">×</button>';
      tab.querySelector('.title').textContent = d?.name ?? id;
      tab.addEventListener('click', (e) => ((/** @type {Element} */ (e.target)).closest('.close') ? closeTab(id) : id !== state.id && open(id)));
      // Middle-click also closes, as in the browser.
      tab.addEventListener('auxclick', (e) => e.button === 1 && closeTab(id));
      return tab;
    }),
  );
}

// ---------- Tool groups ----------

const GROUPS = {
  transform: [
    { id: 'select', name: 'Move', shortcut: 'V' },
    { id: 'rotate', name: 'Rotate', shortcut: 'T' },
    { id: 'scale', name: 'Scale', shortcut: 'S' },
  ],
  canvas: [{ id: 'artboard', name: 'Artboard', shortcut: 'A' }],
  create: [
    { id: 'path', name: 'Pen', shortcut: 'P' },
    { id: 'rect', name: 'Rectangle', shortcut: 'R' },
    { id: 'ellipse', name: 'Ellipse', shortcut: 'E' },
  ],
  paint: [
    { id: 'selectShape', name: 'Select Shape', shortcut: 'Q' },
    { id: 'fill', name: 'Fill', shortcut: 'U' },
    { id: 'stroke', name: 'Stroke' },
    { id: 'both', name: 'Both' },
  ],
  skeleton: [
    { id: 'bone', name: 'Add Bone', shortcut: 'B', icon: 'addBone' },
    { id: 'manipulate', name: 'Manipulate Bones', shortcut: 'M' },
    { id: 'reparent', name: 'Reparent Bone', icon: 'reparent' },
    { id: 'bindLayer', name: 'Bind Layer', shortcut: 'L' },
    { id: 'bindPoints', name: 'Bind Points' },
  ],
};
const lastInGroup = { transform: 'select', canvas: 'artboard', create: 'path', paint: 'fill', skeleton: 'bone' };
const SHORTCUTS = Object.fromEntries(Object.values(GROUPS).flat().filter((h) => h.shortcut).map((h) => [h.shortcut.toLowerCase(), h.id]));

function drawGroups() {
  for (const [group, tools] of Object.entries(GROUPS)) {
    const box = document.querySelector(`[data-group="${group}"]`);
    const active = tools.find((h) => h.id === state.tool);
    if (active) lastInGroup[group] = active.id;
    const visible = tools.find((h) => h.id === lastInGroup[group]);
    box.classList.toggle('active', !!active);
    box.innerHTML = `<button type="button" class="main" title="${visible.name}${visible.shortcut ? ` (${visible.shortcut})` : ''}" aria-label="${visible.name}">${ICONS[visible.icon ?? visible.id]}</button>${tools.length > 1 ? `<button type="button" class="choose" aria-haspopup="menu" title="More tools">${ARROW}</button><div class="menu" role="menu" hidden></div>` : ''}`;
    box.querySelector('.main').addEventListener('click', () => setState({ tool: visible.id }));
    // A lone tool (Artboard) has no menu.
    if (tools.length === 1) continue;
    const menu = box.querySelector('.menu');
    for (const h of tools) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = h.id === state.tool ? 'marked' : '';
      b.innerHTML = `<span class="with-icon">${ICONS[h.icon ?? h.id]}${h.name}</span>${h.shortcut ? `<kbd>${h.shortcut}</kbd>` : ''}`;
      b.addEventListener('click', () => {
        closeMenus();
        setState({ tool: h.id });
      });
      menu.append(b);
    }
    box.querySelector('.choose').addEventListener('click', (e) => toggleMenu(menu, e.currentTarget));
  }
}

// ---------- Zoom ----------

$('#zoom').addEventListener('click', () => toggleMenu($('#menu-zoom'), $('#zoom')));
$('#menu-zoom').addEventListener('click', (e) => {
  const b = e.target.closest('[data-zoom]');
  if (!b) return;
  closeMenus();
  if (b.dataset.zoom === 'adjust') canvas.adjust();
  else canvas.setZoom(Number(b.dataset.zoom));
});

// ---------- Bar state ----------

subscribe((c) => {
  if ('tabs' in c || 'id' in c || 'documents' in c) drawTabs();
  if ('tool' in c) drawGroups();
  // With Artboard, what is picked is the canvas: the inspector shows its properties.
  if ('tool' in c && state.tool === 'artboard' && state.selected.length) select(null);
  if ('id' in c) {
    for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-requires-doc]'))) b.disabled = !state.id;
    $('#canvas .no-document')?.toggleAttribute('hidden', !!state.id);
  }
  if ('selection' in c || 'doc' in c) $('#delete').disabled = $('#duplicate').disabled = !state.selected.length;
  if ('selection' in c || 'doc' in c) $('#delete-resource').disabled = !selectedResources().length;
  // If something in the selection disappeared (for example, the AI deleted the object), it is removed.
  if ('doc' in c && state.doc && state.selected.some((id) => !findObject(state.doc, id))) {
    const remain = state.selected.filter((id) => findObject(state.doc, id));
    selectSeveral(remain, findObject(state.doc, state.selection ?? '') ? state.selection : (remain.at(-1) ?? null));
  }
});

$('#delete').addEventListener('click', deleteSelection);
$('#delete-resource').addEventListener('click', deleteResources);
// Vector, group, switch, skeleton and image: a single button (folder with +) that opens the menu to choose what to create.
const CONTAINERS = {
  vector: () => newVector(),
  group: () => (state.selected.length > 1 ? groupSelection() : newGroup()),
  switch: () => newSwitch(),
  skeleton: () => newSkeleton(),
  image: () => $('#image-file').click(),
};
$('#group-new').addEventListener('click', (e) => toggleMenu($('#create-group .menu'), e.currentTarget));
$('#create-group .menu').addEventListener('click', (e) => {
  const kind = e.target.closest('[data-type]')?.dataset.type;
  if (!kind) return;
  closeMenus();
  CONTAINERS[kind]();
});
$('#duplicate').addEventListener('click', duplicateSelection);
$('#style-new').addEventListener('click', () => newResource('style', 'style', { fill: '#c8c2d4', stroke: '#2b2135' }));
$('#gradient-new').addEventListener('click', () => newResource('linear_gradient', 'gradient'));
$('#image-file').addEventListener('change', (e) => {
  const files = imagesOnly(e.target.files);
  e.target.value = '';
  addImages(files);
});
// Ctrl+V, unless typing in a field: an image from the system clipboard is added as a layer; what Ctrl+C copied in
// the editor is pasted (see pasteCopied).
document.addEventListener('paste', (e) => {
  if (!state.doc || (/** @type {Element} */ (e.target)).closest?.('input, textarea, [contenteditable]')) return;
  const files = imagesOnly(e.clipboardData?.files);
  if (files.length) {
    e.preventDefault();
    return addImages(files);
  }
  // The system clipboard still holds the mark Ctrl+C wrote (or nothing readable): paste what was copied here.
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (copied && (!text || text === copied.mark)) {
    e.preventDefault();
    pasteCopied();
  }
});

/**
 * Ctrl+C: what is copied (the selection, in this document). The system clipboard gets a mark, so a later image
 * copied elsewhere wins on Ctrl+V.
 * @type {{ doc: string, ids: string[], mark: string } | null}
 */
let copied = null;
function copySelection() {
  const ids = selectionRoots().filter((id) => !schema.types.get(findObject(state.doc, id).type).resource);
  if (!ids.length) return;
  copied = { doc: state.id, ids, mark: `aia-studio:copy:${Date.now()}` };
  navigator.clipboard?.writeText(copied.mark).catch(() => {});
  notify(`Copied ${nameOf(ids)}`);
}

/**
 * Ctrl+V: pastes copies of what was copied. A shape goes into the picked vector layer (or the layer of the picked
 * shape) and keeps its place on screen, with its own points; with no layer picked, into its own layer. Anything else
 * is pasted next to its original. The copies are selected.
 */
function pasteCopied() {
  if (copied.doc !== state.id) return notify('Paste works inside the same document: copy it in this one.', true);
  const ids = copied.ids.filter((id) => findObject(state.doc, id));
  if (!ids.length) return notify('What was copied no longer exists.', true);
  const sel = state.selection && findObject(state.doc, state.selection);
  const layer = sel?.type === 'vector' ? sel.id : sel?.type === 'shape' ? sel.parent : null;
  const all = ids.flatMap((id) => subtree(state.doc, id));
  let suffix = 'copy';
  for (let n = 2; all.some((id) => findObject(state.doc, `${id}_${suffix}`)); n++) suffix = `copy${n}`;
  const ops = ids.map((id) => {
    const obj = findObject(state.doc, id);
    return obj.type === 'shape' && layer ? { op: 'duplicate', target: id, suffix, parent: layer } : { op: 'duplicate', target: id, suffix };
  });
  execute(ops, `paste ${nameOf(ids)}${layer && ids.some((id) => findObject(state.doc, id).type === 'shape') ? ` into ${layer}` : ''}`);
  selectSeveral(ids.map((id) => `${id}_${suffix}`).filter((id) => findObject(state.doc, id)));
}
$('#svg-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.doc) return;
  try {
    const name = file.name.replace(/\.svg$/i, '');
    const { ops, group } = importOperations(await file.text(), { doc: state.doc, parent: parentForNew(), name });
    execute(ops, `import ${file.name} (${ops.length - 1} shapes)`);
    select(group);
  } catch (err) {
    notify(err.message, true);
  }
});

function newResource(kind, base, props) {
  if (!state.doc) return;
  const id = freeId(base);
  execute([{ op: 'create', type: kind, id, ...(props ? { props } : {}) }], `create ${id}`);
  select(id);
}

const nameOf = (ids) => (ids.length === 1 ? ids[0] : `${ids.length} objects`);

/** Duplicates the selection with its children, slightly offset, and selects the copies. */
function duplicateSelection() {
  const roots = selectionRoots();
  if (!roots.length) return;
  const ids = roots.flatMap((id) => subtree(state.doc, id));
  let suffix = 'copy';
  for (let n = 2; ids.some((id) => findObject(state.doc, `${id}_${suffix}`)); n++) suffix = `copy${n}`;
  const ops = roots.map((id) => {
    const obj = findObject(state.doc, id);
    // A shape has no position of its own (it is drawn by its layer's points): its copy stays on top of it.
    if (!('x' in schema.types.get(obj.type).properties)) return { op: 'duplicate', target: id, suffix: suffix };
    return { op: 'duplicate', target: id, suffix: suffix, props: { x: read(schema, obj, 'x') + 20, y: read(schema, obj, 'y') + 20 } };
  });
  execute(ops, `duplicate ${nameOf(roots)}`);
  selectSeveral(roots.map((id) => `${id}_${suffix}`));
}

/** The assets (styles, gradients) in the selection. */
const selectedResources = () => (state.doc ? state.selected.filter((id) => schema.types.get(findObject(state.doc, id)?.type)?.resource) : []);

/** Assets delete button: deletes only the selected assets (the core cleans up their references). */
function deleteResources() {
  const ids = selectedResources();
  if (!ids.length) return;
  selectSeveral(state.selected.filter((id) => !ids.includes(id)));
  execute(ids.map((id) => ({ op: 'delete', target: id })), `delete ${nameOf(ids)}`);
}

function deleteSelection() {
  const roots = selectionRoots();
  if (!roots.length) return;
  select(null);
  execute(roots.map((id) => ({ op: 'delete', target: id })), `delete ${nameOf(roots)}`);
}

function newGroup(kind = 'group') {
  if (!state.doc) return;
  const id = freeId(kind);
  execute([{ op: 'create', type: kind, id, parent: parentForNew() }], `create ${id}`);
  select(id);
}

/** Vector layer: an empty one, next to the selection (or inside the selected group). The drawing tools draw into it. */
function newVector() {
  if (!state.doc) return;
  const id = freeId('layer');
  execute([{ op: 'create', type: 'vector', id, parent: parentForNew() }], `create ${id}`);
  select(id);
  notify('Vector layer: draw in it with the Pen (P), Rectangle (R) or Ellipse (E); every shape stays in this layer');
}

/**
 * Switch (Shift+G): puts the selection in a new switch (each object is a variant; the first one is seen) or, with no
 * selection, creates an empty one. Later variants are added by dragging them inside or drawing with it selected.
 */
function newSwitch() {
  const drawing = selectionRoots().filter((id) => !schema.types.get(findObject(state.doc, id).type).resource);
  return drawing.length ? groupSelection('switch') : newGroup('switch');
}

/**
 * Skeleton (K): the bone layer. With drawing selected it puts it inside (it stays still until bound); with no
 * selection it creates an empty one. Later bones are drawn on it with the Bone tool.
 */
function newSkeleton() {
  if (!state.doc) return;
  const drawing = selectionRoots().filter((id) => !schema.types.get(findObject(state.doc, id).type).resource && findObject(state.doc, id).type !== 'bone');
  if (drawing.length) groupSelection('skeleton');
  else newGroup('skeleton');
  notify('Skeleton: draw its bones with Add Bone (B), then bind the drawing inside it (Ctrl+B or “Bind all by proximity”)');
}

/**
 * Puts the selection in a new group (Ctrl+G). If they all have the same parent, the group stays there, in the place
 * of the one furthest in front; otherwise, it goes to the root. The objects do not move on screen.
 */
function groupSelection(kind = 'group') {
  // Bones are not grouped: they live in their skeleton. A shape cannot leave its vector layer: its layer is wrapped.
  const roots = [...new Set(selectionRoots().map(pickable))].filter((id) => !schema.types.get(findObject(state.doc, id).type).resource && findObject(state.doc, id).type !== 'bone');
  if (!roots.length) return;
  const parents = new Set(roots.map((id) => findObject(state.doc, id).parent ?? null));
  const parent = parents.size === 1 ? [...parents][0] : null;
  const siblings = children(state.doc, parent);
  const front = Math.max(...roots.map((id) => siblings.findIndex((o) => o.id === id)));
  const group = freeId(kind);
  /** @type {any[]} */
  const ops = [{ op: 'create', type: kind, id: group, parent: parent, ...(front >= 0 ? { index: front + 1 } : {}) }];
  let doc = applyOperations(state.doc, ops, schema).doc;
  const loose = [];
  for (const id of roots) {
    // What goes into a new skeleton can no longer follow the bones of the outer one: it is released first.
    const release = releaseOnMove(doc, id, group);
    loose.push(...release);
    const batch = [...release, { op: 'move', target: id, parent: group }, ...keepPosition(doc, id, group)];
    doc = applyOperations(doc, batch, schema).doc;
    ops.push(...batch);
  }
  const verb = { switch: 'switch with', skeleton: 'skeleton with' }[kind] ?? 'group';
  execute(ops, `${verb} ${nameOf(roots)} into ${group}`).then((ok) => ok && notifyLoose(loose));
  select(group);
}

/**
 * Ctrl+B: attaches the selected objects to the selected bone (the main one, or the only bone in the selection).
 * With no bone selected, it releases them. As in Moho, binding moves nothing: the drawing follows the bone when posing.
 */
function bindSelection() {
  const ids = state.selected.filter((id) => findObject(state.doc, id));
  const bones = ids.filter((id) => findObject(state.doc, id).type === 'bone');
  const bone = bones.includes(state.selection) ? state.selection : bones.length === 1 ? bones[0] : null;
  if (bones.length > 1 && !bone) return notify('To bind, leave only one bone in the selection', true);
  let objects = ids.filter((id) => 'bone' in schema.types.get(findObject(state.doc, id).type).properties);
  if (!objects.length) return notify(bone ? 'Also select the artwork to bind to the bone' : 'Select artwork and a bone (Ctrl + click)', true);
  // Only what is in the bone's skeleton is bound.
  if (bone) {
    const foreign = objects.filter((id) => reasonNotToBind(state.doc, id, bone));
    objects = objects.filter((id) => !foreign.includes(id));
    if (foreign.length && !objects.length) return notify(reasonNotToBind(state.doc, foreign[0], bone), true);
    if (foreign.length) notify(`${nameOf(foreign)} skipped: not in skeleton ${skeletonOf(state.doc, bone)}`, true);
  }
  const ops = objects.map((id) => (bone ? { op: 'set', target: id, props: { bone: bone } } : { op: 'unset', target: id, props: ['bone'] }));
  execute(ops, bone ? `bind ${nameOf(objects)} to ${bone}` : `unbind ${nameOf(objects)}`);
  notify(bone ? `${nameOf(objects)} follow${objects.length > 1 ? '' : 's'} ${bone}` : `${nameOf(objects)} no longer follow${objects.length > 1 ? '' : 's'} any bone`);
}

// ---------- Setup and poses ----------

// Poses are opened from their list in Puppet (poses.js); before there was a «View» dropdown at the top.
subscribe((c) => {
  // If the open pose or clip disappeared (undo, the AI deleted it), it goes back to the params view or the setup.
  if (('doc' in c || 'pose' in c || 'id' in c) && state.pose && !['pose', 'animation'].includes(findObject(state.doc ?? { objects: [] }, state.pose)?.type)) {
    setState({ pose: null, ...(state.mode === 'puppet' ? { params: state.params ?? {} } : {}) });
  }
});

/** Creates an empty document or, with `copyFrom`, a copy of the given document. */
async function newDocument(copyFrom) {
  const current = copyFrom && state.documents.find((d) => d.id === copyFrom);
  const name = (await askText(copyFrom ? 'Name of the copy:' : 'New file name:', current ? `${current.name} (copy)` : ''))?.trim();
  if (!name) return;
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const root = /^[a-z]/.test(base) ? base : `doc_${base || 'new'}`;
  const ids = new Set(state.documents.map((d) => d.id));
  let id = root;
  for (let n = 2; ids.has(id); n++) id = `${root}_${n}`;
  try {
    await api.create(id, { name: name }, copyFrom);
    await loadDocuments();
    await open(id);
  } catch (e) {
    notify(e.message, true);
  }
}

// ---------- Keyboard ----------

const exitEditing = () => setState({ editing: null, vertex: null });

window.addEventListener('keydown', (e) => {
  if ((/** @type {Element} */ (e.target)).closest?.('input, select, textarea, dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === 'Escape' && document.querySelector('.menu:not([hidden])')) return closeMenus();
  if (e.altKey && key === 'w') {
    e.preventDefault();
    return state.id && closeTab(state.id);
  }
  if (!state.doc) return;
  if (mod && key === 'z') {
    e.preventDefault();
    return e.shiftKey ? redo() : undo();
  }
  if (mod && key === 'y') {
    e.preventDefault();
    return redo();
  }
  if (mod && key === 'd') {
    e.preventDefault();
    return duplicateSelection();
  }
  // Ctrl+V itself is handled by the paste event (it also brings images from the system clipboard).
  if (mod && key === 'c' && !window.getSelection()?.toString()) return copySelection();
  if (mod && key === 'g') {
    e.preventDefault();
    return groupSelection();
  }
  if (mod && key === 'b') {
    e.preventDefault();
    return bindSelection();
  }
  if (mod && key === 'a') {
    e.preventDefault();
    // Fill, Stroke and Both: every point of the picked layer (as Moho's Select All in point tools).
    if (isShapeTool() && shapeToolLayer()) return setState({ shapePicked: Object.keys(read(schema, shapeToolLayer(), 'points') ?? {}) });
    // Everything at the root (without the assets).
    return selectSeveral(children(state.doc, null).filter((o) => !schema.types.get(o.type).resource && !o.locked).map((o) => o.id));
  }
  if (mod) return;
  if (SHORTCUTS[key]) return setState({ tool: SHORTCUTS[key] });
  if (key === 'g') return e.shiftKey ? newSwitch() : newGroup();
  if (key === 'k') return newSkeleton();
  if (key === 'f') return canvas.adjust();
  if (key === '1') return canvas.setZoom(1);

  // Pen: Enter or Escape finish the open stroke.
  if (state.tool === 'path' && canvas.pen.active() && (e.key === 'Enter' || e.key === 'Escape')) return canvas.pen.finish(false);
  // Fill, Stroke and Both: Enter (or Space) creates the shape over the picked points.
  if (e.key === 'Enter' && isShapeTool() && state.shapePicked.length) return createFromPicked();
  // Enter enters or leaves point editing of a path.
  if (e.key === 'Enter') {
    if (state.editing) return exitEditing();
    const sel = state.selection && findObject(state.doc, state.selection);
    if (sel?.type === 'path') return canvas.editPoints(sel.id);
  }
  if (e.key === 'Escape') {
    if (state.editing) return exitEditing();
    if (state.tool !== 'select') return setState({ tool: 'select' });
    // A picked shape goes back to its vector layer.
    const picked = state.selection && findObject(state.doc, state.selection);
    return select(picked?.type === 'shape' ? picked.parent : null);
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.editing) return canvas.points.deleteVertex();
    return deleteSelection();
  }

  // Select Shape (as in Moho): ↑ ↓ raise or lower the picked shape in its layer.
  if (isSelectShape() && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    return restackShape(e.key === 'ArrowUp' ? 1 : -1);
  }
  // Arrows: move the selection 1 px (Shift: 10 px).
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  // Locked layers (picked from Layers) are not moved: the lock protects them on the canvas and from the keyboard.
  const roots = selectionRoots().filter((id) => !locked(state.doc, id));
  // In a pose, the arrows do not move the setup (a picked shape's points do move, inside the pose).
  if (arrows[e.key] && roots.length && (!state.pose || canvas.shapePoints.active())) {
    e.preventDefault();
    const [dx, dy] = arrows[e.key].map((d) => d * (e.shiftKey ? 10 : 1));
    // A picked shape: its points move (it has no position of its own).
    if (canvas.shapePoints.nudge(dx, dy)) return;
    const ops = roots.map((id) => {
      const obj = findObject(state.doc, id);
      return { op: 'set', target: id, props: { x: read(schema, obj, 'x') + dx, y: read(schema, obj, 'y') + dy } };
    });
    execute(ops, `move ${nameOf(roots)}`, { group: `arrows:${roots.join()}` });
  }
});

window.addEventListener('pagehide', sendPending);

// ---------- Changes from outside (the AI through MCP, or another process) ----------

onServer('document', async ({ id }) => {
  // A new document (for example, created by the AI) opens in a tab without taking you away from the current one.
  if (!state.documents.some((d) => d.id === id)) {
    await loadDocuments();
    addTab(id);
    if (!state.id) return open(id);
    notify(`Created “${state.documents.find((d) => d.id === id)?.name ?? id}” in a new tab`);
    return;
  }
  if (id !== state.id || hasPending()) return;
  const doc = await api.read(id);
  if (JSON.stringify(doc) !== JSON.stringify(state.doc)) {
    setState({ doc, previewDoc: null });
    notify('The document was changed externally (AI)');
  }
});

// A document deleted outside the editor (the AI with delete_document, or another process): its tab is closed.
onServer('deleted', async ({ id }) => {
  const name = state.documents.find((d) => d.id === id)?.name ?? id;
  const known = state.documents.some((d) => d.id === id) || state.tabs.includes(id);
  if (!known || deletedHere.has(id)) return;
  await closeTab(id);
  await loadDocuments();
  notify(`“${name}” was deleted outside the editor (by the AI or another program)`);
});

onServer('history', ({ id }) => id === state.id && refreshHistory());

// ---------- Startup ----------

mountConnectAi();

setState({ tool: 'select', id: null });
await loadDocuments();
const requested = new URLSearchParams(location.search).get('doc');
const remembered = savedTabs();
for (const id of remembered) addTab(id);
const initial = state.documents.find((d) => d.id === requested)?.id ?? remembered[0];
if (initial) await open(initial);
