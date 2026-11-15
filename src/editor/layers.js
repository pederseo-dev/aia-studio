// Object tree: shows the hierarchy with what is in front at the top (as in Moho or Figma).
// As in Moho, there are only layers here: the bones of a skeleton are not rows, they are seen and picked on the canvas.
// Dragging a row changes the order or the parent; double click renames; the eye shows or hides.
// Ctrl + click adds or removes from the selection; Shift + click selects the span of rows from the previous one.

import { TYPE_ICON, ICONS } from './icons.js';
import { findObject, children, subtree } from '../core/document.js';
import { read } from '../core/schema.js';
import { applyOperations } from '../core/operations.js';
import { toggleBinding, notifyLoose, boneToBind, releaseOnMove } from './bones.js';
import { chooseVariant, variantOf, variantsToShow } from './editing.js';
import { toggleSelection, execute, schema, state, keepPosition, selectionRoots, select, selectSeveral, subscribe } from './state.js';

const isResource = (o) => schema.types.get(o.type)?.resource;
const FROM_PUPPET = new Set(['pose', 'param', 'driver', 'animation']);

/** Object tree in `root` and asset list (styles, gradients) in `resourcesRoot`. */
export function mountTree(root, resourcesRoot) {
  let dragged = null;
  // Collapsed groups, per document (editor state: it does not go in the document).
  const folded = new Map();
  const foldedOf = () => folded.get(state.id) ?? folded.set(state.id, new Set()).get(state.id);

  subscribe((c) => {
    if ('doc' in c || 'selection' in c || 'mode' in c) draw();
  });

  function draw() {
    const doc = state.doc;
    if (!doc) return root.replaceChildren(), resourcesRoot.replaceChildren();
    const objects = branch(doc, null, 0);
    if (objects.length) root.replaceChildren(...objects);
    else root.innerHTML = '<li class="empty">Empty. Draw with the tools or ask the AI.</li>';
    // Each mode shows its assets: Design, styles and gradients; Animate, also the scene clips; Puppet, everything
    // (poses, params, drivers and clips).
    const visible = (o) => !FROM_PUPPET.has(o.type) || state.mode === 'puppet' || (state.mode === 'animate' && o.type === 'animation' && o.usage !== 'puppet');
    const resources = doc.objects.filter((o) => isResource(o) && visible(o)).map((o) => {
      const li = document.createElement('li');
      li.innerHTML = `<div class="row${selectionClass(o.id)}" data-id="${o.id}" style="padding-left:8px"><span class="type" title="${o.type}">${TYPE_ICON[o.type] ?? '•'}</span><span class="name"></span></div>`;
      li.querySelector('.name').textContent = o.id;
      return li;
    });
    if (resources.length) resourcesRoot.replaceChildren(...resources);
    else resourcesRoot.innerHTML = '<li class="empty">No styles or gradients.</li>';
    root.querySelector('.main')?.scrollIntoView({ block: 'nearest' });
  }

  const selectionClass = (id) => (id === state.selection ? ' selected main' : state.selected.includes(id) ? ' selected' : '');

  /**
   * Rows of the child layers of `parent`, with the front ones at the top. Bones are not layers: they do not appear.
   * Neither are the shapes of a vector layer, as in Moho: they are picked on the canvas.
   */
  const layers = (doc, parent) => children(doc, parent).filter((o) => !isResource(o) && o.type !== 'bone' && o.type !== 'shape');

  function branch(doc, parent, level) {
    return layers(doc, parent)
      .reverse()
      .map((o) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'treeitem');
        const withEye = 'visible' in schema.types.get(o.type).properties;
        const visible = !withEye || read(schema, o, 'visible');
        const row = document.createElement('div');
        // In a switch, the variants that are not seen are dimmed (the selected one is shown anyway, to edit it).
        const parent = o.parent && findObject(doc, o.parent);
        const active = parent?.type === 'switch' ? variantOf(doc, parent) : null;
        const switchedOff = active != null && o.id !== active;
        const fromView = switchedOff && variantsToShow(doc)[parent.id] === o.id;
        row.className = `row${selectionClass(o.id)}${visible ? '' : ' concealed'}${switchedOff ? ' off' : ''}`;
        if (switchedOff) row.title = fromView ? `Visible while selected; switch ${parent.id} shows ${active}` : `Hidden: switch ${parent.id} shows ${active}`;
        row.dataset.id = o.id;
        row.draggable = true;
        row.style.paddingLeft = `${4 + level * 14}px`;
        const hasChildren = layers(doc, o.id).length > 0;
        const folded = foldedOf().has(o.id);
        row.innerHTML = `<button type="button" class="fold${hasChildren ? '' : ' empty'}" title="${folded ? 'Expand' : 'Collapse'}" tabindex="-1">${folded ? '▸' : '▾'}</button>
          <span class="type" title="${o.type}">${TYPE_ICON[o.type] ?? '•'}</span><span class="name"></span>${o.bone ? `<span class="binding">${ICONS.bone}</span>` : ''}
          ${o.type === 'switch' ? '<span class="dropdown variant-switch"><button type="button" class="variant" title="Variant shown (in a pose, saved to the pose)"></button><div class="menu" role="menu" hidden></div></span>' : ''}
          ${withEye ? `<button type="button" class="lock${o.locked ? ' set' : ''}" title="${o.locked ? 'Unlock: pick and edit it on the canvas again' : 'Lock: it can’t be picked or changed on the canvas'}">${o.locked ? ICONS.lock : ICONS.openLock}</button>` : ''}
          ${withEye ? `<button type="button" class="eye${visible ? '' : ' concealed'}" title="${visible ? 'Hide' : 'Show'}">${visible ? '◉' : '○'}</button>` : ''}`;
        row.querySelector('.name').textContent = o.id;
        if (o.bone) (/** @type {HTMLElement} */ (row.querySelector('.binding'))).title = `Follows bone ${o.bone}`;
        if (o.type === 'switch') row.querySelector('.variant').textContent = `▾ ${variantOf(doc, o) ?? 'empty'}`;
        li.append(row);
        const subbranch = folded ? [] : branch(doc, o.id, level + 1);
        if (subbranch.length) {
          const ul = document.createElement('ul');
          ul.setAttribute('role', 'group');
          ul.append(...subbranch);
          li.append(ul);
        }
        return li;
      });
  }

  for (const list of [root, resourcesRoot]) {
    list.addEventListener('click', onClick);
    list.addEventListener('dblclick', rename);
  }

  function onClick(e) {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.fold')) {
      const set = foldedOf();
      set.has(id) ? set.delete(id) : set.add(id);
      return draw();
    }
    // Variant button of a switch: opens the list of its children (like the menu of a Moho switch layer).
    const item = e.target.closest('[data-variant]');
    if (item) {
      item.closest('.menu').hidden = true;
      return chooseVariant(id, item.dataset.variant);
    }
    if (e.target.closest('.variant')) return openVariants(row, id);
    if (e.target.closest('.lock')) {
      const set = !!findObject(state.doc, id)?.locked;
      execute([set ? { op: 'unset', target: id, props: ['locked'] } : { op: 'set', target: id, props: { locked: true } }], `${set ? 'unlock' : 'lock'} ${id}`);
      return;
    }
    if (e.target.closest('.eye')) {
      const visible = read(schema, findObject(state.doc, id), 'visible');
      execute([visible ? { op: 'set', target: id, props: { visible: false } } : { op: 'unset', target: id, props: ['visible'] }], `${visible ? 'hide' : 'show'} ${id}`);
      return;
    }
    // Bind Layer with a picked bone: the row is attached to that bone (or released) instead of being selected.
    const bone = boneToBind();
    if (bone) return toggleBinding(id, bone);
    if (e.ctrlKey || e.metaKey) return toggleSelection(id);
    if (e.shiftKey && state.selection) return selectSpan(row);
    select(id);
  }

  // Shift + click: all the visible rows between the main object's and the clicked one, in the same list.
  function selectSpan(row) {
    const list = row.closest('#tree, #resources') ?? root;
    const rows = [...list.querySelectorAll('.row')].map((f) => f.dataset.id);
    const a = rows.indexOf(state.selection);
    const b = rows.indexOf(row.dataset.id);
    if (a < 0) return select(row.dataset.id);
    const span = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
    selectSeveral([...state.selected, ...span], row.dataset.id);
  }

  function openVariants(row, id) {
    const button = row.querySelector('.variant');
    const menu = row.querySelector('.variant-switch .menu');
    const active = variantOf(state.doc, findObject(state.doc, id));
    const variants = children(state.doc, id);
    menu.replaceChildren(
      ...(variants.length
        ? variants.map((h) => {
            const b = Object.assign(document.createElement('button'), { type: 'button', className: h.id === active ? 'marked' : '', textContent: h.id });
            b.setAttribute('role', 'menuitemradio');
            b.dataset.variant = h.id;
            return b;
          })
        : [Object.assign(document.createElement('span'), { className: 'help', textContent: 'Empty: drag drawings into it.' })]),
    );
    // Fixed on the screen: the hierarchy list has its own scroll and would clip it.
    const r = button.getBoundingClientRect();
    Object.assign(menu.style, { position: 'fixed', top: `${r.bottom + 4}px`, left: `${r.left}px`, minWidth: '160px' });
    menu.hidden = !menu.hidden;
  }

  // Rename with double click.
  function rename(e) {
    const name = e.target.closest('.name');
    if (!name) return;
    const previous = name.closest('.row').dataset.id;
    const input = document.createElement('input');
    input.value = previous;
    name.replaceChildren(input);
    input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      const created = input.value.trim();
      if (save && created && created !== previous) {
        execute([{ op: 'rename', target: previous, id: created }], `rename ${previous} → ${created}`);
        if (state.selection === previous && findObject(state.doc, created)) selectSeveral(state.selected.map((s) => (s === previous ? created : s)), created);
      } else {
        name.textContent = previous;
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
      ev.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ---------- Drag to reorder or reparent ----------

  function zone(e, row) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const target = findObject(state.doc, row.dataset.id);
    if (schema.types.get(target.type).container && y > 0.25 && y < 0.75) return 'inside';
    return y < 0.5 ? 'before' : 'after';
  }

  function cleanMarks() {
    root.querySelectorAll('.release-before, .release-after, .release-inside').forEach((f) => f.classList.remove('release-before', 'release-after', 'release-inside'));
  }

  // What is dragged: the whole selection if the row is part of it, otherwise only that row (bones picked on the
  // canvas are not moved from here: they live in their skeleton).
  const draggedIds = () => (state.selected.includes(dragged) ? selectionRoots().filter((id) => findObject(state.doc, id)?.type !== 'bone') : [dragged]);
  const containsA = (ids, target) => ids.some((id) => subtree(state.doc, id).includes(target));

  root.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row');
    dragged = row?.dataset.id ?? null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged ?? '');
  });

  root.addEventListener('dragover', (e) => {
    const row = e.target.closest('.row');
    if (!dragged || !row || containsA(draggedIds(), row.dataset.id)) return;
    e.preventDefault();
    cleanMarks();
    row.classList.add(`release-${zone(e, row)}`);
  });

  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) cleanMarks();
  });

  root.addEventListener('drop', (e) => {
    e.preventDefault();
    cleanMarks();
    const row = e.target.closest('.row');
    if (!row || !dragged) return (dragged = null);
    const ids = draggedIds();
    const where = zone(e, row);
    dragged = null;
    if (!ids.length || containsA(ids, row.dataset.id)) return;
    const target = findObject(state.doc, row.dataset.id);
    const name = ids.length === 1 ? ids[0] : `${ids.length} objects`;
    // The batch is built step by step on a copy: each index depends on how the previous one left things.
    let doc = state.doc;
    const ops = [];
    const loose = [];
    const step = (batch) => {
      doc = applyOperations(doc, batch, schema).doc;
      ops.push(...batch);
    };
    // A move first releases the bindings that would stop being valid (drawing that leaves the skeleton of its bone).
    const move = (id, parent, index) => {
      const release = releaseOnMove(doc, id, parent);
      loose.push(...release);
      step([...release, { op: 'move', target: id, parent: parent, ...(index !== undefined ? { index } : {}) }, ...keepPosition(doc, id, parent)]);
    };
    const finish = (note) => {
      if (!ops.length) return;
      execute(ops, note).then((ok) => ok && notifyLoose(loose));
    };
    if (where === 'inside') {
      for (const id of ids) move(id, target.id);
      return finish(`move ${name} into ${target.id}`);
    }
    // In the panel, "up" is "front": before the row = one place further front than the target.
    // They are inserted one at a time next to the target, in the order that keeps how they were among themselves.
    const parent = target.parent ?? null;
    for (const id of where === 'before' ? [...ids].reverse() : ids) {
      const siblings = children(doc, parent).filter((o) => o.id !== id);
      const pos = siblings.findIndex((o) => o.id === target.id);
      move(id, parent, where === 'before' ? pos + 1 : pos);
    }
    finish(`reorder ${name}`);
  });

  root.addEventListener('dragend', () => {
    dragged = null;
    cleanMarks();
  });
}
