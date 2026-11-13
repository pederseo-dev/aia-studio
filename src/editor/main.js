// Punto de entrada del editor: monta los paneles y conecta la barra, el teclado y los avisos en vivo.

import { findObject, skeletonOf, children, subtree } from '../core/document.js';
import { applyOperations } from '../core/operations.js';
import { read, readMeta } from '../core/schema.js';
import { artboardOps } from '../core/artboard.js';
import { mountTree } from './layers.js';
import { notifyLoose, bindByProximity, reasonNotToBind, releaseOnMove } from './bones.js';
import { mountHistory } from './history.js';
import { FLECHA, ICONOS } from './icons.js';
import { importOperations } from './importSvg.js';
import { addImages, imagesOnly } from './images.js';
import { mountInspector } from './inspector.js';
import { mountCanvas } from './canvas.js';
import { mountOptions } from './toolOptions.js';
import { mountParameters } from './parameters.js';
import { changeMode, mountClips, mountModes, mountTimeline } from './timeline.js';
import { mountBanner, mountPoses } from './poses.js';
import { resetParams } from './live.js';
import {
  open, addTab, api, notify, deletedHere, loadDocuments, closeTab, undo, execute, deleteDocument,
  sendPending, schema, state, setState, hasPending, freeId, keepPosition, parentForNew,
  savedTabs, refreshHistory, redo, selectionRoots, select, selectSeveral, subscribe,
} from './state.js';

const $ = (s) => document.querySelector(s);
// Íconos fijos del HTML: data-icono los pone al principio del elemento y data-flecha es la flecha de un desplegable.
for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-icono]'))) el.insertAdjacentHTML('afterbegin', ICONOS[el.dataset.icono]);
for (const el of document.querySelectorAll('[data-flecha]')) el.innerHTML = FLECHA;

mountTree($('#arbol'), $('#recursos'));
mountInspector($('#inspector'));
mountHistory($('#entradas'));
const canvas = mountCanvas($('#lienzo'));
mountOptions($('#opciones'), { projectSettings: () => showSettings(), group: () => groupSelection(), switch: () => newSwitch(), esqueleto: () => newSkeleton(), bind: () => bindSelection(), bindAll: bindByProximity });
mountParameters($('#parametros'), $('#nuevo-param'), $('#borrar-param'));
mountModes($('#modos'));
mountClips($('#clips'), $('#lista-clips'), $('#nuevo-clip'), $('#live'), $('#ver-manifiesto'), $('#borrar-clip'));
mountPoses($('#seccion-poses'), $('#lista-poses'), $('#nueva-pose'), $('#borrar-pose'));
$('#reset-params').addEventListener('click', resetParams);
mountBanner($('#cartel'));

// Clips, Parameters y Poses (Puppet) se pliegan con la flecha del título; se recuerda lo que elija el usuario.
for (const section of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-plegable]'))) {
  const key = `aia:plegado:${section.dataset.plegable}`;
  const button = section.querySelector('.plegar-seccion');
  const fold = (folded) => {
    section.classList.toggle('plegada', folded);
    button.setAttribute('aria-expanded', String(!folded));
  };
  button.addEventListener('click', () => {
    const folded = !section.classList.contains('plegada');
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

// Abajo, la timeline ocupa todo el panel (Design no tiene). Los params son del muñeco: el panel Parameters, a la
// derecha, está solo en Puppet. Una escena de Animate no anima params; keya los valores mismos.
function drawParameters() {
  $('#seccion-parametros').hidden = state.mode !== 'puppet';
}
subscribe((c) => {
  if ('mode' in c || 'doc' in c) drawParameters();
  // Al abrir otro documento, el modo sigue: en Animate se abre su primera escena.
  if ('id' in c && state.doc && state.mode !== 'design') changeMode(state.mode);
});
drawParameters();

// History plegable: en Animate y Puppet arranca plegado para dejarle lugar al inspector y a los paneles de animación.
// Lo que elija el usuario se recuerda por modo.
const historyKey = () => `aia:historial-plegado:${state.mode}`;
function foldedHistory() {
  try {
    const saved = localStorage.getItem(historyKey());
    if (saved !== null) return saved === '1';
  } catch {}
  return state.mode !== 'design';
}
function foldHistory(folded) {
  document.body.classList.toggle('historial-plegado', folded);
  $('#plegar-historial').setAttribute('aria-expanded', String(!folded));
}
$('#plegar-historial').addEventListener('click', () => {
  const folded = !document.body.classList.contains('historial-plegado');
  try {
    localStorage.setItem(historyKey(), folded ? '1' : '0');
  } catch {}
  foldHistory(folded);
});
subscribe((c) => 'mode' in c && foldHistory(foldedHistory()));
foldHistory(foldedHistory());

// Layers plegable (abierto por defecto), como Assets; se recuerda lo que elija el usuario.
function foldLayers(folded) {
  document.body.classList.toggle('capas-plegado', folded);
  $('#plegar-capas').setAttribute('aria-expanded', String(!folded));
}
$('#plegar-capas').addEventListener('click', () => {
  const folded = !document.body.classList.contains('capas-plegado');
  try {
    localStorage.setItem('aia:capas-plegado', folded ? '1' : '0');
  } catch {}
  foldLayers(folded);
});
try {
  foldLayers(localStorage.getItem('aia:capas-plegado') === '1');
} catch {}

// Assets plegable (abierto por defecto); se recuerda lo que elija el usuario.
function foldResources(folded) {
  document.body.classList.toggle('recursos-plegado', folded);
  $('#plegar-recursos').setAttribute('aria-expanded', String(!folded));
}
$('#plegar-recursos').addEventListener('click', () => {
  const folded = !document.body.classList.contains('recursos-plegado');
  try {
    localStorage.setItem('aia:recursos-plegado', folded ? '1' : '0');
  } catch {}
  foldResources(folded);
});
try {
  foldResources(localStorage.getItem('aia:recursos-plegado') === '1');
} catch {}

// ---------- Menús desplegables (menú principal, zoom, grupos de herramientas) ----------

function toggleMenu(menu, button) {
  const openIt = menu.hidden;
  closeMenus();
  if (!openIt) return;
  menu.hidden = false;
  button?.setAttribute('aria-expanded', 'true');
  // Posición fija junto al desplegable: así un panel con overflow (la jerarquía) no recorta el menú.
  const box = (menu.closest('.desplegable') ?? button).getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = menu.classList.contains('derecha') ? box.right - width : box.left;
  menu.style.left = `${Math.max(4, Math.min(left, innerWidth - width - 4))}px`;
  menu.style.top = `${box.bottom + 4}px`;
}
addEventListener('resize', closeMenus);

function closeMenus() {
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.menu')).forEach((m) => (m.hidden = true));
  document.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

document.addEventListener('pointerdown', (e) => {
  if (!(/** @type {Element} */ (e.target)).closest('.desplegable')) closeMenus();
});

// ---------- Menú principal ----------

const ACTIONS = {
  nuevo: () => newDocument(),
  abrir: showOpen,
  copiar: () => newDocument(state.id),
  importar: () => $('#archivo-svg').click(),
  cerrar: () => closeTab(state.id),
  eliminar: async () => {
    const d = state.documents.find((x) => x.id === state.id);
    if (!confirm(`Delete “${d?.name ?? state.id}” and all its history? This can’t be undone.`)) return;
    try {
      await deleteDocument(state.id);
      notify(`Deleted “${d?.name ?? state.id}”`);
    } catch (err) {
      notify(err.message, true);
    }
  },
  atajos: () => $('#dialogo-atajos').showModal(),
  ajustes: () => showSettings(),
};

// ---------- Project Settings (como File → Project Settings de Moho) ----------

/** Diálogo con las propiedades del documento. El tamaño cambia con el dibujo centrado, igual que la herramienta Artboard. */
function showSettings() {
  if (!state.doc) return;
  const f = $('#form-ajustes').elements;
  const meta = (p) => readMeta(schema, state.doc, p);
  f.name.value = meta('name');
  f.width.value = meta('width');
  f.height.value = meta('height');
  f.fps.value = meta('fps');
  const background = meta('background');
  f.transparente.checked = background == null;
  f.background.value = background ?? schema.meta.properties.background.default;
  f.background.disabled = background == null;
  $('#dialogo-ajustes').showModal();
}
$('#form-ajustes').elements.transparente.addEventListener('change', (e) => ($('#form-ajustes').elements.background.disabled = e.target.checked));
$('#form-ajustes [data-cerrar]').addEventListener('click', () => $('#dialogo-ajustes').close());
$('#form-ajustes').addEventListener('submit', () => {
  const f = $('#form-ajustes').elements;
  const doc = state.doc;
  if (!doc) return;
  const meta = (p) => readMeta(schema, doc, p);
  const width = Math.round(Number(f.width.value));
  const height = Math.round(Number(f.height.value));
  const ops = width !== meta('width') || height !== meta('height') ? artboardOps(doc, schema, width, height) : [];
  const props = {};
  const name = f.name.value.trim();
  if (name && name !== meta('name')) props.name = name;
  const background = f.transparente.checked ? null : f.background.value;
  if (background !== meta('background')) props.background = background;
  if (Number(f.fps.value) !== meta('fps')) props.fps = Number(f.fps.value);
  if (Object.keys(props).length) ops.push({ op: 'set', target: 'meta', props });
  if (ops.length) execute(ops, 'project settings');
});

$('#menu-boton').addEventListener('click', () => toggleMenu($('#menu'), $('#menu-boton')));
$('#menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-accion]');
  if (!b || b.disabled) return;
  closeMenus();
  ACTIONS[b.dataset.accion]();
});
$('#nueva-pestana').addEventListener('click', () => newDocument());

function showOpen() {
  const list = $('#lista-documentos');
  list.replaceChildren(
    ...state.documents.map((d) => {
      const li = document.createElement('li');
      li.innerHTML = '<button type="button"><span class="nombre"></span><span class="id"></span></button>';
      li.querySelector('.nombre').textContent = d.name;
      li.querySelector('.id').textContent = state.tabs.includes(d.id) ? `${d.id} · open` : d.id;
      li.querySelector('button').addEventListener('click', () => {
        $('#dialogo-abrir').close();
        open(d.id);
      });
      return li;
    }),
  );
  if (!state.documents.length) list.innerHTML = '<li class="ayuda">No files yet.</li>';
  $('#dialogo-abrir').showModal();
}

// ---------- Pestañas ----------

function drawTabs() {
  $('#pestanas').replaceChildren(
    ...state.tabs.map((id) => {
      const d = state.documents.find((x) => x.id === id);
      const tab = document.createElement('div');
      tab.className = `pestana${id === state.id ? ' activa' : ''}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(id === state.id));
      tab.title = id;
      tab.innerHTML = '<span class="titulo"></span><button type="button" class="cerrar" title="Close tab (the document is not deleted)">×</button>';
      tab.querySelector('.titulo').textContent = d?.name ?? id;
      tab.addEventListener('click', (e) => ((/** @type {Element} */ (e.target)).closest('.cerrar') ? closeTab(id) : id !== state.id && open(id)));
      // Clic con la rueda también cierra, como en el navegador.
      tab.addEventListener('auxclick', (e) => e.button === 1 && closeTab(id));
      return tab;
    }),
  );
}

// ---------- Grupos de herramientas ----------

const GROUPS = {
  transformar: [
    { id: 'seleccionar', name: 'Move', shortcut: 'V' },
    { id: 'rotar', name: 'Rotate', shortcut: 'T' },
    { id: 'escalar', name: 'Scale', shortcut: 'S' },
  ],
  lienzo: [{ id: 'artboard', name: 'Artboard', shortcut: 'A' }],
  crear: [
    { id: 'path', name: 'Pen', shortcut: 'P' },
    { id: 'rect', name: 'Rectangle', shortcut: 'R' },
    { id: 'ellipse', name: 'Ellipse', shortcut: 'E' },
  ],
  esqueleto: [
    { id: 'hueso', name: 'Add Bone', shortcut: 'B', icon: 'agregarHueso' },
    { id: 'manipular', name: 'Manipulate Bones', shortcut: 'M' },
    { id: 'reparentar', name: 'Reparent Bone', icon: 'reparentar' },
    { id: 'enlazarCapa', name: 'Bind Layer', shortcut: 'L' },
    { id: 'enlazarPuntos', name: 'Bind Points' },
  ],
};
const lastInGroup = { transformar: 'seleccionar', lienzo: 'artboard', crear: 'path', esqueleto: 'hueso' };
const SHORTCUTS = Object.fromEntries(Object.values(GROUPS).flat().filter((h) => h.shortcut).map((h) => [h.shortcut.toLowerCase(), h.id]));

function drawGroups() {
  for (const [group, tools] of Object.entries(GROUPS)) {
    const box = document.querySelector(`[data-grupo="${group}"]`);
    const active = tools.find((h) => h.id === state.tool);
    if (active) lastInGroup[group] = active.id;
    const visible = tools.find((h) => h.id === lastInGroup[group]);
    box.classList.toggle('activo', !!active);
    box.innerHTML = `<button type="button" class="principal" title="${visible.name}${visible.shortcut ? ` (${visible.shortcut})` : ''}" aria-label="${visible.name}">${ICONOS[visible.icon ?? visible.id]}</button>${tools.length > 1 ? `<button type="button" class="elegir" aria-haspopup="menu" title="More tools">${FLECHA}</button><div class="menu" role="menu" hidden></div>` : ''}`;
    box.querySelector('.principal').addEventListener('click', () => setState({ tool: visible.id }));
    // Una herramienta sola (Artboard) no lleva menú.
    if (tools.length === 1) continue;
    const menu = box.querySelector('.menu');
    for (const h of tools) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = h.id === state.tool ? 'marcado' : '';
      b.innerHTML = `<span class="con-icono">${ICONOS[h.icon ?? h.id]}${h.name}</span>${h.shortcut ? `<kbd>${h.shortcut}</kbd>` : ''}`;
      b.addEventListener('click', () => {
        closeMenus();
        setState({ tool: h.id });
      });
      menu.append(b);
    }
    box.querySelector('.elegir').addEventListener('click', (e) => toggleMenu(menu, e.currentTarget));
  }
}

// ---------- Zoom ----------

$('#zoom').addEventListener('click', () => toggleMenu($('#menu-zoom'), $('#zoom')));
$('#menu-zoom').addEventListener('click', (e) => {
  const b = e.target.closest('[data-zoom]');
  if (!b) return;
  closeMenus();
  if (b.dataset.zoom === 'ajustar') canvas.adjust();
  else canvas.setZoom(Number(b.dataset.zoom));
});

// ---------- Estado de la barra ----------

subscribe((c) => {
  if ('tabs' in c || 'id' in c || 'documents' in c) drawTabs();
  if ('tool' in c) drawGroups();
  // Con Artboard, lo elegido es el lienzo: el inspector muestra sus propiedades.
  if ('tool' in c && state.tool === 'artboard' && state.selected.length) select(null);
  if ('id' in c) {
    for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-requiere-doc]'))) b.disabled = !state.id;
    $('#lienzo .sin-documento')?.toggleAttribute('hidden', !!state.id);
  }
  if ('selection' in c || 'doc' in c) $('#borrar').disabled = $('#duplicar').disabled = !state.selected.length;
  if ('selection' in c || 'doc' in c) $('#borrar-recurso').disabled = !selectedResources().length;
  // Si algo de la selección desapareció (por ejemplo, la IA borró el objeto), se quita.
  if ('doc' in c && state.doc && state.selected.some((id) => !findObject(state.doc, id))) {
    const remain = state.selected.filter((id) => findObject(state.doc, id));
    selectSeveral(remain, findObject(state.doc, state.selection ?? '') ? state.selection : (remain.at(-1) ?? null));
  }
});

$('#borrar').addEventListener('click', deleteSelection);
$('#borrar-recurso').addEventListener('click', deleteResources);
// Grupo, switch y skeleton: un solo botón (carpeta con +) que abre el menú para elegir qué crear.
const CONTAINERS = {
  group: () => (state.selected.length > 1 ? groupSelection() : newGroup()),
  switch: () => newSwitch(),
  skeleton: () => newSkeleton(),
  image: () => $('#archivo-imagen').click(),
};
$('#nuevo-grupo').addEventListener('click', (e) => toggleMenu($('#crear-grupo .menu'), e.currentTarget));
$('#crear-grupo .menu').addEventListener('click', (e) => {
  const kind = e.target.closest('[data-tipo]')?.dataset.tipo;
  if (!kind) return;
  closeMenus();
  CONTAINERS[kind]();
});
$('#duplicar').addEventListener('click', duplicateSelection);
$('#nuevo-estilo').addEventListener('click', () => newResource('style', 'style', { fill: '#c8c2d4', stroke: '#2b2135' }));
$('#nuevo-degradado').addEventListener('click', () => newResource('linear_gradient', 'gradient'));
$('#archivo-imagen').addEventListener('change', (e) => {
  const files = imagesOnly(e.target.files);
  e.target.value = '';
  addImages(files);
});
// Pegar una imagen (Ctrl+V) la agrega como capa, salvo que se esté escribiendo en un campo.
document.addEventListener('paste', (e) => {
  const files = imagesOnly(e.clipboardData?.files);
  if (!files.length || !state.doc || (/** @type {Element} */ (e.target)).closest?.('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  addImages(files);
});
$('#archivo-svg').addEventListener('change', async (e) => {
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

/** Duplica la selección con sus hijos, un poco desplazada, y selecciona las copias. */
function duplicateSelection() {
  const roots = selectionRoots();
  if (!roots.length) return;
  const ids = roots.flatMap((id) => subtree(state.doc, id));
  let suffix = 'copy';
  for (let n = 2; ids.some((id) => findObject(state.doc, `${id}_${suffix}`)); n++) suffix = `copy${n}`;
  const ops = roots.map((id) => {
    const obj = findObject(state.doc, id);
    return { op: 'duplicate', target: id, suffix: suffix, props: { x: read(schema, obj, 'x') + 20, y: read(schema, obj, 'y') + 20 } };
  });
  execute(ops, `duplicate ${nameOf(roots)}`);
  selectSeveral(roots.map((id) => `${id}_${suffix}`));
}

/** Los recursos (estilos, degradados) de la selección. */
const selectedResources = () => (state.doc ? state.selected.filter((id) => schema.types.get(findObject(state.doc, id)?.type)?.resource) : []);

/** Botón de borrar de Assets: borra solo los recursos seleccionados (el núcleo limpia sus referencias). */
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

/**
 * Switch (Shift+G): mete la selección en un switch nuevo (cada objeto es una variante; se ve el primero) o, sin
 * selección, crea uno vacío. Después se le agregan variantes arrastrándolas adentro o dibujando con él seleccionado.
 */
function newSwitch() {
  const drawing = selectionRoots().filter((id) => !schema.types.get(findObject(state.doc, id).type).resource);
  return drawing.length ? groupSelection('switch') : newGroup('switch');
}

/**
 * Skeleton (K): la capa de huesos. Con dibujo seleccionado lo mete adentro (queda quieto hasta enlazarlo); sin
 * selección crea uno vacío. Después se le dibujan huesos con la herramienta Bone.
 */
function newSkeleton() {
  if (!state.doc) return;
  const drawing = selectionRoots().filter((id) => !schema.types.get(findObject(state.doc, id).type).resource && findObject(state.doc, id).type !== 'bone');
  if (drawing.length) groupSelection('skeleton');
  else newGroup('skeleton');
  notify('Skeleton: draw its bones with Add Bone (B), then bind the drawing inside it (Ctrl+B or “Bind all by proximity”)');
}

/**
 * Mete la selección en un grupo nuevo (Ctrl+G). Si todos tienen el mismo padre, el grupo queda ahí, en el lugar del
 * que estaba más al frente; si no, va a la raíz. Los objetos no se mueven de lugar en pantalla.
 */
function groupSelection(kind = 'group') {
  // Los huesos no se agrupan: viven en su skeleton.
  const roots = selectionRoots().filter((id) => !schema.types.get(findObject(state.doc, id).type).resource && findObject(state.doc, id).type !== 'bone');
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
    // Lo que entra a un skeleton nuevo deja de poder seguir a los huesos del de afuera: se suelta antes.
    const release = releaseOnMove(doc, id, group);
    loose.push(...release);
    const lote = [...release, { op: 'move', target: id, parent: group }, ...keepPosition(doc, id, group)];
    doc = applyOperations(doc, lote, schema).doc;
    ops.push(...lote);
  }
  const verb = { switch: 'switch with', skeleton: 'skeleton with' }[kind] ?? 'group';
  execute(ops, `${verb} ${nameOf(roots)} into ${group}`).then((ok) => ok && notifyLoose(loose));
  select(group);
}

/**
 * Ctrl+B: pega los objetos seleccionados al hueso seleccionado (el principal, o el único hueso de la selección).
 * Sin ningún hueso en la selección, los suelta. Como en Moho, enlazar no mueve nada: el dibujo sigue al hueso al posar.
 */
function bindSelection() {
  const ids = state.selected.filter((id) => findObject(state.doc, id));
  const bones = ids.filter((id) => findObject(state.doc, id).type === 'bone');
  const bone = bones.includes(state.selection) ? state.selection : bones.length === 1 ? bones[0] : null;
  if (bones.length > 1 && !bone) return notify('To bind, leave only one bone in the selection', true);
  let objects = ids.filter((id) => 'bone' in schema.types.get(findObject(state.doc, id).type).properties);
  if (!objects.length) return notify(bone ? 'Also select the artwork to bind to the bone' : 'Select artwork and a bone (Ctrl + click)', true);
  // Solo se enlaza lo que está en el skeleton del hueso.
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

// ---------- Montaje y poses ----------

// Las poses se abren desde su lista en Puppet (poses.js); antes había un desplegable «View» arriba.
subscribe((c) => {
  // Si la pose o el clip abierto desapareció (deshacer, la IA lo borró), se vuelve a la vista de params o al montaje.
  if (('doc' in c || 'pose' in c || 'id' in c) && state.pose && !['pose', 'animation'].includes(findObject(state.doc ?? { objects: [] }, state.pose)?.type)) {
    setState({ pose: null, ...(state.mode === 'puppet' ? { params: state.params ?? {} } : {}) });
  }
});

/** Crea un documento vacío o, con `copiarDe`, una copia del documento indicado. */
async function newDocument(copyFrom) {
  const current = copyFrom && state.documents.find((d) => d.id === copyFrom);
  const name = prompt(copyFrom ? 'Name of the copy:' : 'New file name:', current ? `${current.name} (copy)` : '')?.trim();
  if (!name) return;
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const root = /^[a-z]/.test(base) ? base : `doc_${base || 'nuevo'}`;
  const ids = new Set(state.documents.map((d) => d.id));
  let id = root;
  for (let n = 2; ids.has(id); n++) id = `${root}_${n}`;
  try {
    await api.crear(id, { name: name }, copyFrom);
    await loadDocuments();
    await open(id);
  } catch (e) {
    notify(e.message, true);
  }
}

// ---------- Teclado ----------

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
  if (mod && key === 'g') {
    e.preventDefault();
    return groupSelection();
  }
  if (mod && key === 'b') {
    e.preventDefault();
    return bindSelection();
  }
  if (mod && key === 'a') {
    // Todo lo que está en la raíz (sin los recursos).
    e.preventDefault();
    return selectSeveral(children(state.doc, null).filter((o) => !schema.types.get(o.type).resource && !o.locked).map((o) => o.id));
  }
  if (mod) return;
  if (SHORTCUTS[key]) return setState({ tool: SHORTCUTS[key] });
  if (key === 'g') return e.shiftKey ? newSwitch() : newGroup();
  if (key === 'k') return newSkeleton();
  if (key === 'f') return canvas.adjust();
  if (key === '1') return canvas.setZoom(1);

  // Pluma: Enter o Escape terminan el trazo abierto.
  if (state.tool === 'path' && canvas.pen.active() && (e.key === 'Enter' || e.key === 'Escape')) return canvas.pen.finish(false);
  // Enter entra o sale de la edición de puntos de un path.
  if (e.key === 'Enter') {
    if (state.editing) return exitEditing();
    const sel = state.selection && findObject(state.doc, state.selection);
    if (sel?.type === 'path') return canvas.editPoints(sel.id);
  }
  if (e.key === 'Escape') {
    if (state.editing) return exitEditing();
    return state.tool !== 'seleccionar' ? setState({ tool: 'seleccionar' }) : select(null);
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.editing) return canvas.points.deleteVertex();
    return deleteSelection();
  }

  // Flechas: mover la selección 1 px (Shift: 10 px).
  const flechas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const roots = selectionRoots();
  // En una pose, las flechas no mueven el montaje.
  if (flechas[e.key] && roots.length && !state.pose) {
    e.preventDefault();
    const [dx, dy] = flechas[e.key].map((d) => d * (e.shiftKey ? 10 : 1));
    const ops = roots.map((id) => {
      const obj = findObject(state.doc, id);
      return { op: 'set', target: id, props: { x: read(schema, obj, 'x') + dx, y: read(schema, obj, 'y') + dy } };
    });
    execute(ops, `move ${nameOf(roots)}`, { group: `flechas:${roots.join()}` });
  }
});

window.addEventListener('pagehide', sendPending);

// ---------- Cambios desde fuera (la IA por MCP, u otro proceso) ----------

import.meta.hot?.on('aia:document', async ({ id }) => {
  // Un documento nuevo (por ejemplo, creado por la IA) se abre en una pestaña sin quitarte de la actual.
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

// Un documento borrado fuera del editor (la IA con delete_document, u otro proceso): se cierra su pestaña.
import.meta.hot?.on('aia:deleted', async ({ id }) => {
  const name = state.documents.find((d) => d.id === id)?.name ?? id;
  const known = state.documents.some((d) => d.id === id) || state.tabs.includes(id);
  if (!known || deletedHere.has(id)) return;
  await closeTab(id);
  await loadDocuments();
  notify(`“${name}” was deleted outside the editor (by the AI or another program)`);
});

import.meta.hot?.on('aia:history', ({ id }) => id === state.id && refreshHistory());

// ---------- Inicio ----------

setState({ tool: 'seleccionar', id: null });
await loadDocuments();
const requested = new URLSearchParams(location.search).get('doc');
const remembered = savedTabs();
for (const id of remembered) addTab(id);
const initial = state.documents.find((d) => d.id === requested)?.id ?? remembered[0];
if (initial) await open(initial);
