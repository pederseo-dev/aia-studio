// Estado del editor y acciones. Todo cambio al documento pasa por `ejecutar`, que usa el mismo motor de operaciones
// que la IA: se aplica al instante en pantalla y se guarda en el servidor con origen "user".

import { createSchema } from '../core/schema.js';
import { findObject, skeletonOf, subtree } from '../core/document.js';
import { applyOperations, compact, keptPosition } from '../core/operations.js';

const defs = import.meta.glob('../../schema/*.json', { eager: true, import: 'default' });
export const schema = createSchema(Object.values(defs));

export const state = {
  documents: [],
  tabs: [], // ids de los documentos abiertos, en orden
  id: null,
  doc: null,
  previewDoc: null, // documento con un cambio en curso (arrastre, scrub), todavía sin guardar
  selection: null, // el objeto principal: el último elegido, el que muestra el inspector
  selected: [], // todos los elegidos (incluye el principal)
  editing: null, // id del path cuyos puntos se están editando
  vertex: null, // índice del vértice seleccionado en la edición de puntos
  tool: 'seleccionar',
  mode: 'design', // 'design' (dibujo y rig), 'animate' (timeline de escena) o 'puppet' (controles y clips del muñeco)
  // Lo que se ve y se edita encima del montaje: una pose o un clip (animation, en `tiempo`). Lo que se cambia va a la
  // pose o, en un clip, a un keyframe en el tiempo del playhead (autokey). null = el montaje.
  pose: null,
  params: null, // valores de los params en la vista Parámetros (null = no se mezcla nada)
  time: 0, // playhead del clip abierto, en segundos
  playing: false,
  // ▶ Live (Puppet): el muñeco en marcha (src/editor/vivo.js). poseViva = lo que se ve en este cuadro; estadoVivo =
  // qué suena y con qué peso. Con Live encendido el documento no se edita.
  live: false,
  livePose: null,
  liveState: null,
  history: { entries: [], user: { deshacer: false, rehacer: false } },
};

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
export function setState(changes) {
  Object.assign(state, changes);
  for (const fn of listeners) fn(changes);
}
export const docVisible = () => state.previewDoc ?? state.doc;

// ---------- Servidor ----------

async function request(filePath, body) {
  // keepalive: un lote agrupado que se envía al cerrar la pestaña igual llega.
  const options = body === undefined ? undefined : { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(`/api/documentos${filePath}`, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export const api = {
  list: () => request(''),
  crear: (id, meta, copyFrom) => request('', { id, meta, copyFrom }),
  read: (id) => request(`/${id}`),
  history: (id) => request(`/${id}/historial`),
  applyOps: (id, ops, nota) => request(`/${id}/ops`, { ops, nota }),
  deshacer: (id) => request(`/${id}/deshacer`, {}),
  rehacer: (id) => request(`/${id}/rehacer`, {}),
  eliminar: async (id) => {
    const res = await fetch(`/api/documentos/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
  },
};

// ---------- Avisos ----------

let timer;
export function notify(text, isError = false) {
  const notice = /** @type {HTMLElement} */ (document.querySelector('#aviso'));
  notice.textContent = text;
  notice.title = text;
  notice.classList.toggle('error', isError);
  clearTimeout(timer);
  timer = setTimeout(() => (notice.textContent = ''), isError ? 8000 : 4000);
}

// ---------- Acciones ----------

export async function loadDocuments() {
  setState({ documents: await api.list() });
}

// ---------- Pestañas ----------

const TABS_KEY = 'aia-studio.pestanas';

/** Pestañas recordadas de la última vez (solo las que siguen existiendo). Es una comodidad: si falla, no pasa nada. */
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
    // sin almacenamiento: las pestañas no se recuerdan
  }
}

/** Agrega una pestaña sin cambiar a ella (por ejemplo, cuando la IA crea un documento). */
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

/** Cierra la pestaña (el documento sigue en disco) y pasa a la vecina, si hay. */
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
  setState({ id: null, doc: null, previewDoc: null, selection: null, selected: [], editing: null, vertex: null, pose: null, params: null, time: 0, playing: false, history: { entries: [], user: { deshacer: false, rehacer: false } } });
}

/** Documentos que se están borrando desde este editor (para no avisar de un borrado que pidió el propio usuario). */
export const deletedHere = new Set();

/** Borra el documento del disco (con su historial) y cierra su pestaña. */
export async function deleteDocument(id) {
  deletedHere.add(id);
  setTimeout(() => deletedHere.delete(id), 5000);
  await closeTab(id);
  await api.eliminar(id);
  await loadDocuments();
}

export async function refreshHistory() {
  if (state.id) setState({ history: await api.history(state.id) });
}

/** Muestra un cambio sin guardarlo (null lo descarta). Si el cambio no es válido, simplemente no se muestra. */
export function preview(ops) {
  if (!ops) return state.previewDoc && setState({ previewDoc: null });
  if (state.live) return;
  try {
    setState({ previewDoc: applyOperations(state.doc, ops, schema).doc });
  } catch {
    // valor intermedio inválido mientras se escribe: se ignora
  }
}

// Los lotes se envían en orden, uno detrás de otro.
/** @type {Promise<any>} */
let row = Promise.resolve();

// Cambios seguidos sobre lo mismo (flechas, flechitas de un campo numérico) se juntan en un solo lote:
// una sola entrada en el historial y un solo paso de deshacer.
const GROUP_WAIT = 800;
let pending = null;

export const hasPending = () => pending !== null || underway > 0;

/** Envía ya el lote agrupado que esté esperando. */
export function sendPending() {
  if (!pending) return row;
  const { id, ops, nota, timer } = pending;
  clearTimeout(timer);
  pending = null;
  return send(id, ops, nota);
}

/**
 * Aplica un lote al instante en pantalla y lo guarda. Con `agrupar` (una clave como "flechas:head"), los lotes
 * seguidos con la misma clave se juntan hasta que pasa un momento sin cambios.
 */
/** @param {any[]} ops @param {string} [nota] @param {{ group?: string }} [options] */
export function execute(ops, nota, { group } = {}) {
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
  if (!group) return send(state.id, ops, nota);
  if (pending) {
    clearTimeout(pending.timer);
    pending.ops = compact([...pending.ops, ...ops]);
  } else {
    pending = { key: group, id: state.id, ops: compact(ops), nota };
  }
  pending.timer = setTimeout(sendPending, GROUP_WAIT);
  return Promise.resolve(true);
}

let underway = 0;

function send(id, ops, nota) {
  underway++;
  row = row.then(async () => {
    try {
      const { doc } = await api.applyOps(id, ops, nota);
      // Si quedan lotes por llegar al servidor, la pantalla ya va por delante: no se pisa con un estado viejo.
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

async function revert(tipo) {
  if (!state.id) return;
  await sendPending();
  try {
    const { doc } = await api[tipo](state.id);
    setState({ doc, previewDoc: null });
  } catch (e) {
    notify(e.message, true);
  }
  await refreshHistory();
}
export const deshacer = () => revert('deshacer');
export const rehacer = () => revert('rehacer');

export function select(id) {
  if (id !== state.selection || state.selected.length !== (id ? 1 : 0)) setState({ selection: id, selected: id ? [id] : [] });
}

/** Selección de varios objetos; el principal es el último, salvo que se indique otro. */
export function selectSeveral(ids, main = ids.at(-1) ?? null) {
  const unique = [...new Set(ids)];
  if (main && !unique.includes(main)) unique.push(main);
  setState({ selection: main, selected: unique });
}

/** Agrega o quita un objeto de la selección (Ctrl/Shift + clic). */
export function toggleSelection(id) {
  if (!state.selected.includes(id)) return selectSeveral([...state.selected, id], id);
  const rest = state.selected.filter((s) => s !== id);
  selectSeveral(rest, state.selection === id ? (rest.at(-1) ?? null) : state.selection);
}

/**
 * Los objetos seleccionados sobre los que actúan mover, rotar, borrar y duplicar: sin los que ya están dentro de otro
 * seleccionado (moverlos dos veces los desplazaría el doble) y en el orden del documento.
 */
export function selectionRoots() {
  const ids = new Set(state.selected.filter((id) => findObject(state.doc, id)));
  const inside = new Set();
  for (const id of ids) for (const d of subtree(state.doc, id)) if (d !== id) inside.add(d);
  return state.doc.objects.filter((o) => ids.has(o.id) && !inside.has(o.id)).map((o) => o.id);
}

/** Un id libre a partir de una base: rect_1, rect_2... */
export function freeId(base) {
  for (let n = 1; ; n++) if (!findObject(state.doc, `${base}_${n}`)) return `${base}_${n}`;
}

/**
 * Dónde se crea algo nuevo: dentro del contenedor seleccionado o, si no hay uno, en la raíz. Con un hueso
 * seleccionado, en su skeleton (el dibujo no va dentro de los huesos).
 */
export function parentForNew() {
  const sel = state.selection && findObject(state.doc, state.selection);
  if (sel?.type === 'bone') return skeletonOf(state.doc, sel.id);
  return sel && schema.types.get(sel.type).container ? sel.id : null;
}

/** Al cambiar de padre, el x/y que deja al objeto en el mismo lugar de la pantalla (sobre el `doc` indicado). */
export function keepPosition(doc, id, newParent) {
  const obj = findObject(doc, id);
  if ((obj.parent ?? null) === newParent) return [];
  return [{ op: 'set', target: id, props: keptPosition(doc, schema, obj, newParent) }];
}
