// Árbol de objetos: muestra la jerarquía con lo que está al frente arriba (como en Moho o Figma).
// Como en Moho, aquí solo hay capas: los huesos de un skeleton no son filas, se ven y se eligen en el lienzo.
// Arrastrar una fila cambia el orden o el padre; doble clic renombra; el ojo muestra u oculta.
// Ctrl + clic agrega o quita de la selección; Shift + clic selecciona el tramo de filas desde la anterior.

import { TYPE_ICON, ICONOS } from './icons.js';
import { findObject, children, subtree } from '../core/document.js';
import { read } from '../core/schema.js';
import { applyOperations } from '../core/operations.js';
import { toggleBinding, notifyLoose, boneToBind, releaseOnMove } from './bones.js';
import { chooseVariant, variantOf, variantsToShow } from './editing.js';
import { toggleSelection, execute, schema, state, keepPosition, selectionRoots, select, selectSeveral, subscribe } from './state.js';

const isResource = (o) => schema.types.get(o.type)?.resource;
const FROM_PUPPET = new Set(['pose', 'param', 'driver', 'animation']);

/** Árbol de objetos en `raiz` y lista de recursos (estilos, degradados) en `raizRecursos`. */
export function mountTree(root, resourcesRoot) {
  let dragged = null;
  // Grupos plegados, por documento (estado del editor: no va en el documento).
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
    else root.innerHTML = '<li class="vacio">Empty. Draw with the tools or ask the AI.</li>';
    // Cada modo muestra sus recursos: Design, estilos y degradados; Animate, además los clips de escena; Puppet, todo
    // (poses, params, drivers y clips).
    const visible = (o) => !FROM_PUPPET.has(o.type) || state.mode === 'puppet' || (state.mode === 'animate' && o.type === 'animation' && o.usage !== 'puppet');
    const resources = doc.objects.filter((o) => isResource(o) && visible(o)).map((o) => {
      const li = document.createElement('li');
      li.innerHTML = `<div class="fila${selectionClass(o.id)}" data-id="${o.id}" style="padding-left:8px"><span class="tipo" title="${o.type}">${TYPE_ICON[o.type] ?? '•'}</span><span class="nombre"></span></div>`;
      li.querySelector('.nombre').textContent = o.id;
      return li;
    });
    if (resources.length) resourcesRoot.replaceChildren(...resources);
    else resourcesRoot.innerHTML = '<li class="vacio">No styles or gradients.</li>';
    root.querySelector('.principal')?.scrollIntoView({ block: 'nearest' });
  }

  const selectionClass = (id) => (id === state.selection ? ' seleccionada principal' : state.selected.includes(id) ? ' seleccionada' : '');

  /** Filas de las capas hijas de `padre`, con lo del frente arriba. Los huesos no son capas: no salen. */
  const layers = (doc, parent) => children(doc, parent).filter((o) => !isResource(o) && o.type !== 'bone');

  function branch(doc, parent, level) {
    return layers(doc, parent)
      .reverse()
      .map((o) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'treeitem');
        const withEye = 'visible' in schema.types.get(o.type).properties;
        const visible = !withEye || read(schema, o, 'visible');
        const row = document.createElement('div');
        // En un switch, las variantes que no se ven quedan atenuadas (la seleccionada se muestra igual, para editarla).
        const parent = o.parent && findObject(doc, o.parent);
        const active = parent?.type === 'switch' ? variantOf(doc, parent) : null;
        const apagada = active != null && o.id !== active;
        const fromView = apagada && variantsToShow(doc)[parent.id] === o.id;
        row.className = `fila${selectionClass(o.id)}${visible ? '' : ' oculta'}${apagada ? ' apagada' : ''}`;
        if (apagada) row.title = fromView ? `Visible while selected; switch ${parent.id} shows ${active}` : `Hidden: switch ${parent.id} shows ${active}`;
        row.dataset.id = o.id;
        row.draggable = true;
        row.style.paddingLeft = `${4 + level * 14}px`;
        const hasChildren = layers(doc, o.id).length > 0;
        const folded = foldedOf().has(o.id);
        row.innerHTML = `<button type="button" class="plegar${hasChildren ? '' : ' vacio'}" title="${folded ? 'Expand' : 'Collapse'}" tabindex="-1">${folded ? '▸' : '▾'}</button>
          <span class="tipo" title="${o.type}">${TYPE_ICON[o.type] ?? '•'}</span><span class="nombre"></span>${o.bone ? `<span class="enlace">${ICONOS.hueso}</span>` : ''}
          ${o.type === 'switch' ? '<span class="desplegable variante-switch"><button type="button" class="variante" title="Variant shown (in a pose, saved to the pose)"></button><div class="menu" role="menu" hidden></div></span>' : ''}
          ${withEye ? `<button type="button" class="candado${o.locked ? ' puesto' : ''}" title="${o.locked ? 'Unlock: pick and edit it on the canvas again' : 'Lock: it can’t be picked or changed on the canvas'}">${o.locked ? ICONOS.candado : ICONOS.candadoAbierto}</button>` : ''}
          ${withEye ? `<button type="button" class="ojo${visible ? '' : ' oculto'}" title="${visible ? 'Hide' : 'Show'}">${visible ? '◉' : '○'}</button>` : ''}`;
        row.querySelector('.nombre').textContent = o.id;
        if (o.bone) (/** @type {HTMLElement} */ (row.querySelector('.enlace'))).title = `Follows bone ${o.bone}`;
        if (o.type === 'switch') row.querySelector('.variante').textContent = `▾ ${variantOf(doc, o) ?? 'empty'}`;
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
    const row = e.target.closest('.fila');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('.plegar')) {
      const set = foldedOf();
      set.has(id) ? set.delete(id) : set.add(id);
      return draw();
    }
    // Botón de variante de un switch: abre la lista de sus hijos (como el menú de un switch layer de Moho).
    const item = e.target.closest('[data-variante]');
    if (item) {
      item.closest('.menu').hidden = true;
      return chooseVariant(id, item.dataset.variante);
    }
    if (e.target.closest('.variante')) return openVariants(row, id);
    if (e.target.closest('.candado')) {
      const set = !!findObject(state.doc, id)?.locked;
      execute([set ? { op: 'unset', target: id, props: ['locked'] } : { op: 'set', target: id, props: { locked: true } }], `${set ? 'unlock' : 'lock'} ${id}`);
      return;
    }
    if (e.target.closest('.ojo')) {
      const visible = read(schema, findObject(state.doc, id), 'visible');
      execute([visible ? { op: 'set', target: id, props: { visible: false } } : { op: 'unset', target: id, props: ['visible'] }], `${visible ? 'hide' : 'show'} ${id}`);
      return;
    }
    // Bind Layer con un hueso elegido: la fila se pega a ese hueso (o se suelta) en vez de seleccionarse.
    const bone = boneToBind();
    if (bone) return toggleBinding(id, bone);
    if (e.ctrlKey || e.metaKey) return toggleSelection(id);
    if (e.shiftKey && state.selection) return selectSpan(row);
    select(id);
  }

  // Shift + clic: todas las filas visibles entre la del objeto principal y la clicada, en la misma lista.
  function selectSpan(row) {
    const list = row.closest('#arbol, #recursos') ?? root;
    const rows = [...list.querySelectorAll('.fila')].map((f) => f.dataset.id);
    const a = rows.indexOf(state.selection);
    const b = rows.indexOf(row.dataset.id);
    if (a < 0) return select(row.dataset.id);
    const span = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
    selectSeveral([...state.selected, ...span], row.dataset.id);
  }

  function openVariants(row, id) {
    const button = row.querySelector('.variante');
    const menu = row.querySelector('.variante-switch .menu');
    const active = variantOf(state.doc, findObject(state.doc, id));
    const variants = children(state.doc, id);
    menu.replaceChildren(
      ...(variants.length
        ? variants.map((h) => {
            const b = Object.assign(document.createElement('button'), { type: 'button', className: h.id === active ? 'marcado' : '', textContent: h.id });
            b.setAttribute('role', 'menuitemradio');
            b.dataset.variante = h.id;
            return b;
          })
        : [Object.assign(document.createElement('span'), { className: 'ayuda', textContent: 'Empty: drag drawings into it.' })]),
    );
    // Fijo en la pantalla: la lista de la jerarquía tiene su propio desplazamiento y lo cortaría.
    const r = button.getBoundingClientRect();
    Object.assign(menu.style, { position: 'fixed', top: `${r.bottom + 4}px`, left: `${r.left}px`, minWidth: '160px' });
    menu.hidden = !menu.hidden;
  }

  // Renombrar con doble clic.
  function rename(e) {
    const name = e.target.closest('.nombre');
    if (!name) return;
    const previous = name.closest('.fila').dataset.id;
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

  // ---------- Arrastrar para reordenar o reparentar ----------

  function zone(e, row) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const target = findObject(state.doc, row.dataset.id);
    if (schema.types.get(target.type).container && y > 0.25 && y < 0.75) return 'dentro';
    return y < 0.5 ? 'antes' : 'despues';
  }

  function cleanMarks() {
    root.querySelectorAll('.soltar-antes, .soltar-despues, .soltar-dentro').forEach((f) => f.classList.remove('soltar-antes', 'soltar-despues', 'soltar-dentro'));
  }

  // Lo que se arrastra: la selección entera si la fila es parte de ella, si no solo esa fila (los huesos elegidos en el
  // lienzo no se mueven por aquí: viven en su skeleton).
  const draggedIds = () => (state.selected.includes(dragged) ? selectionRoots().filter((id) => findObject(state.doc, id)?.type !== 'bone') : [dragged]);
  const containsA = (ids, target) => ids.some((id) => subtree(state.doc, id).includes(target));

  root.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.fila');
    dragged = row?.dataset.id ?? null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragged ?? '');
  });

  root.addEventListener('dragover', (e) => {
    const row = e.target.closest('.fila');
    if (!dragged || !row || containsA(draggedIds(), row.dataset.id)) return;
    e.preventDefault();
    cleanMarks();
    row.classList.add(`soltar-${zone(e, row)}`);
  });

  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) cleanMarks();
  });

  root.addEventListener('drop', (e) => {
    e.preventDefault();
    cleanMarks();
    const row = e.target.closest('.fila');
    if (!row || !dragged) return (dragged = null);
    const ids = draggedIds();
    const where = zone(e, row);
    dragged = null;
    if (!ids.length || containsA(ids, row.dataset.id)) return;
    const target = findObject(state.doc, row.dataset.id);
    const name = ids.length === 1 ? ids[0] : `${ids.length} objects`;
    // Se arma el lote paso a paso sobre una copia: cada índice depende de cómo quedó el anterior.
    let doc = state.doc;
    const ops = [];
    const loose = [];
    const step = (lote) => {
      doc = applyOperations(doc, lote, schema).doc;
      ops.push(...lote);
    };
    // Un move suelta antes los enlaces que dejarían de valer (dibujo que sale del skeleton de su hueso).
    const move = (id, parent, index) => {
      const release = releaseOnMove(doc, id, parent);
      loose.push(...release);
      step([...release, { op: 'move', target: id, parent: parent, ...(index !== undefined ? { index } : {}) }, ...keepPosition(doc, id, parent)]);
    };
    const finish = (nota) => {
      if (!ops.length) return;
      execute(ops, nota).then((ok) => ok && notifyLoose(loose));
    };
    if (where === 'dentro') {
      for (const id of ids) move(id, target.id);
      return finish(`move ${name} into ${target.id}`);
    }
    // En el panel, "arriba" es "delante": antes de la fila = un lugar más al frente que el destino.
    // Se insertan de a uno junto al destino, en el orden que conserva cómo estaban entre ellos.
    const parent = target.parent ?? null;
    for (const id of where === 'antes' ? [...ids].reverse() : ids) {
      const siblings = children(doc, parent).filter((o) => o.id !== id);
      const pos = siblings.findIndex((o) => o.id === target.id);
      move(id, parent, where === 'antes' ? pos + 1 : pos);
    }
    finish(`reorder ${name}`);
  });

  root.addEventListener('dragend', () => {
    dragged = null;
    cleanMarks();
  });
}
