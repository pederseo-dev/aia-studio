// The Layers panel, as in Moho: the layer on top of the list is drawn on top. Click selects, double click or F2
// renames, the eye hides, the padlock locks, and dragging reorders (on the middle of a group: into it).

import { childrenOf, findObject, idFromName } from '../core/document.js';
import { icon } from './icons.js';
import { chooseImages } from './images.js';
import { run, select, state, toggleSelect } from './state.js';
import { canContain, isPart, schema } from './schema.js';

/**
 * @typedef {import('../core/document.js').DocObject} DocObject
 * @typedef {import('../core/operations.js').Operation} Operation
 */

const tree = /** @type {HTMLUListElement} */ (document.getElementById('tree'));
/** Groups folded in Layers (per session). */
const folded = new Set();
/** @type {string | null} */
let dragged = null;

const taken = (/** @type {string} */ id) => !!state.document && (id === 'meta' || !!findObject(state.document, id));

/**
 * Where a new layer goes, as in Moho: above the selected layer, or inside it (on top) if it is a group; with a part
 * selected, next to its vector layer; at the top of the root with nothing selected.
 * @returns {{ parent: string | null, index?: number }}
 */
export function newLayerPlace() {
  const doc = state.document;
  let selected = doc && state.selected ? findObject(doc, state.selected) : undefined;
  if (!doc || !selected) return { parent: null };
  if (isPart(selected.type)) selected = findObject(doc, /** @type {string} */ (selected.parent));
  if (!selected) return { parent: null };
  if (selected.type === 'group') {
    folded.delete(selected.id);
    return { parent: selected.id };
  }
  return { parent: selected.parent, index: childrenOf(doc, selected.parent).indexOf(selected) + 1 };
}

/** @param {'vector' | 'group'} type */
export function addLayer(type) {
  if (!state.document) return;
  const id = idFromName(`${type === 'group' ? 'group' : 'layer'}_1`, taken);
  const { parent, index } = newLayerPlace();
  /** @type {Operation} */
  const create = { op: 'create', type, id };
  if (parent) create.parent = parent;
  if (index !== undefined) create.index = index;
  // Then its name is asked right away (optional), as for parts.
  run([create], { select: id, note: `New ${type} layer` }).then(() => state.selected === id && renameSelected());
}

export function deleteSelected() {
  const doc = state.document;
  const selected = doc && state.selected ? findObject(doc, state.selected) : undefined;
  if (!selected) return;
  const ids = state.selection;
  run(
    ids.map((id) => ({ op: 'delete', target: id })),
    { select: selected.parent, note: ids.length > 1 ? `Delete ${ids.length} parts` : `Delete ${selected.id}` },
  );
}

export function renameSelected() {
  const row = tree.querySelector(`[data-id="${CSS.escape(state.selected ?? '')}"] .name`);
  if (row) return startRename(/** @type {HTMLElement} */ (row));
  // A part is not in the list: its name is in the options bar.
  const field = /** @type {HTMLInputElement | null} */ (document.querySelector('.options input'));
  field?.focus();
  field?.select();
}

/** @param {HTMLElement} label */
function startRename(label) {
  const id = /** @type {HTMLElement} */ (label.closest('[data-id]')).dataset.id;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = id;
  let done = false;
  const finish = (/** @type {boolean} */ save) => {
    if (done) return;
    done = true;
    const typed = input.value.trim();
    input.replaceWith(label);
    if (!save || !typed || typed === id) return;
    const next = idFromName(typed, (candidate) => candidate !== id && taken(candidate));
    run([{ op: 'rename', target: id, id: next }], { select: next, note: `Rename ${id}` });
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  label.replaceWith(input);
  input.focus();
  input.select();
}

/**
 * Where a drop on a row puts the dragged layer: above it, below it, or inside it (groups only).
 * @param {DragEvent} event @param {HTMLElement} row
 * @returns {'above' | 'below' | 'inside'}
 */
function dropPlace(event, row) {
  const box = row.getBoundingClientRect();
  const y = (event.clientY - box.top) / box.height;
  const moving = dragged && state.document ? findObject(state.document, dragged) : undefined;
  if (moving && canContain(row.dataset.type ?? '', moving.type)) return y < 0.25 ? 'above' : y > 0.75 ? 'below' : 'inside';
  return y < 0.5 ? 'above' : 'below';
}

/** @param {string} target @param {'above' | 'below' | 'inside'} place @returns {Operation | null} */
function moveFor(target, place) {
  const doc = state.document;
  const moving = dragged && doc ? findObject(doc, dragged) : undefined;
  const over = doc ? findObject(doc, target) : undefined;
  if (!doc || !moving || !over || moving === over) return null;
  if (place === 'inside') return { op: 'move', target: moving.id, parent: over.id };
  // The list shows the top layer first, so «above» a row is one index higher among its siblings.
  const siblings = childrenOf(doc, over.parent).filter((o) => o !== moving);
  const index = siblings.indexOf(over) + (place === 'above' ? 1 : 0);
  return { op: 'move', target: moving.id, parent: over.parent, index };
}

/** @param {DocObject} object @param {number} depth */
function row(object, depth) {
  const item = document.createElement('li');
  item.setAttribute('role', 'treeitem');
  const line = document.createElement('div');
  line.className = `row${rowState(object.id)}${object.visible === false ? ' hidden-layer' : ''}`;
  line.dataset.id = object.id;
  line.dataset.type = object.type;
  line.draggable = true;
  line.style.paddingLeft = `${6 + depth * 14}px`;

  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'fold';
  // Only layers show here; a layer's parts are picked on the canvas and named in the options bar.
  const children = childrenOf(/** @type {import('../core/document.js').Doc} */ (state.document), object.id).filter((o) => !isPart(o.type));
  const container = schema.get(object.type)?.childTypes.some((type) => !isPart(type)) ?? false;
  if (container) {
    fold.innerHTML = icon('chevron');
    fold.classList.toggle('open', !folded.has(object.id));
    fold.title = folded.has(object.id) ? 'Expand' : 'Collapse';
    fold.addEventListener('click', (event) => {
      event.stopPropagation();
      if (folded.has(object.id)) folded.delete(object.id);
      else folded.add(object.id);
      render();
    });
  } else fold.disabled = true;

  const kind = document.createElement('span');
  kind.className = 'kind';
  // Layers lists only layers (a part is named in the options bar).
  kind.title = { group: 'Group layer', vector: 'Vector layer', image: 'Image layer' }[object.type] ?? object.type;
  kind.innerHTML = icon(/** @type {any} */ (object.type in { group: 1, vector: 1, image: 1 } ? object.type : 'vector'));

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = object.id;
  name.addEventListener('dblclick', () => startRename(name));

  const toggle = (/** @type {'visible' | 'locked'} */ prop, /** @type {boolean} */ on, /** @type {string} */ title) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `toggle${on ? ' on' : ''}`;
    button.title = title;
    button.setAttribute('aria-pressed', String(on));
    button.innerHTML = icon(prop === 'visible' ? (on ? 'eye' : 'eyeOff') : on ? 'lock' : 'openLock');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      run([{ op: 'set', target: object.id, props: { [prop]: !on } }]);
    });
    return button;
  };
  const visible = object.visible !== false;
  const locked = object.locked === true;

  line.append(fold, kind, name);
  line.append(toggle('locked', locked, locked ? 'Unlock' : 'Lock on the canvas'), toggle('visible', visible, visible ? 'Hide' : 'Show'));
  line.addEventListener('click', (event) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey) toggleSelect(object.id);
    else if (state.selection.length !== 1 || object.id !== state.selected) select(object.id);
  });

  line.addEventListener('dragstart', (event) => {
    dragged = object.id;
    event.dataTransfer?.setData('text/plain', object.id);
  });
  line.addEventListener('dragend', () => {
    dragged = null;
    clearDropMarks();
  });
  line.addEventListener('dragover', (event) => {
    if (!dragged || dragged === object.id) return;
    event.preventDefault();
    clearDropMarks();
    line.classList.add(`drop-${dropPlace(event, line)}`);
  });
  line.addEventListener('drop', (event) => {
    event.preventDefault();
    const operation = moveFor(object.id, dropPlace(event, line));
    const moved = dragged;
    clearDropMarks();
    if (operation) run([operation], { select: moved, note: `Move ${moved}` });
  });

  item.append(line);
  if (container && !folded.has(object.id) && children.length) {
    const list = document.createElement('ul');
    list.setAttribute('role', 'group');
    list.append(...[...children].reverse().map((child) => row(child, depth + 1)));
    item.append(list);
  }
  return item;
}

function clearDropMarks() {
  for (const el of tree.querySelectorAll('.drop-above, .drop-below, .drop-inside')) {
    el.classList.remove('drop-above', 'drop-below', 'drop-inside');
  }
}

/** The layers that hold the selected parts (highlighted softly, since parts are not listed). */
function partLayers() {
  const doc = state.document;
  if (!doc) return [];
  return state.selection
    .map((id) => findObject(doc, id))
    .filter((o) => o && isPart(o.type))
    .map((o) => /** @type {string} */ (o?.parent));
}

/** @param {string} id */
const rowState = (id) => (state.selection.includes(id) ? ' selected' : partLayers().includes(id) ? ' holds-selection' : '');

/** What the list was last built from: when only the selection changes, the rows stay (so a double click works). */
let builtFrom = '';

export function render() {
  const doc = state.document;
  const layerButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#layer-new, #layer-delete'));
  layerButtons[0].disabled = !doc;
  layerButtons[1].disabled = !state.selected;
  const key = doc ? JSON.stringify([state.active, doc.objects, [...folded]]) : '';
  if (key === builtFrom && tree.querySelector('.row')) {
    for (const line of tree.querySelectorAll('.row')) {
      const id = /** @type {HTMLElement} */ (line).dataset.id ?? '';
      line.classList.toggle('selected', state.selection.includes(id));
      line.classList.toggle('holds-selection', partLayers().includes(id));
    }
    return;
  }
  builtFrom = key;
  if (!doc) return tree.replaceChildren();
  const top = [...childrenOf(doc, null)].reverse();
  if (top.length === 0) {
    tree.innerHTML = '<li class="empty">No layers yet. Add one with the folder button above, or draw on the canvas with a tool.</li>';
    return;
  }
  tree.replaceChildren(...top.map((object) => row(object, 0)));
}

export function setupLayers() {
  for (const item of document.querySelectorAll('#layer-menu [data-type]')) {
    const type = item.getAttribute('data-type');
    item.addEventListener('click', () => (type === 'image' ? chooseImages() : addLayer(/** @type {'vector' | 'group'} */ (type))));
  }
  document.getElementById('layer-delete')?.addEventListener('click', deleteSelected);
  // A click on the empty part of the panel clears the selection, so a new layer goes to the root.
  tree.addEventListener('click', (event) => {
    if (event.target === tree) select(null);
  });
}
