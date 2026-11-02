// Estado del editor y acciones. Todo cambio al documento pasa por `ejecutar`, que usa el mismo motor de operaciones
// que la IA: se aplica al instante en pantalla y se guarda en el servidor con origen "user".

import { crearEsquema } from '../core/esquema.js';
import { buscar } from '../core/documento.js';
import { aplicarOperaciones, compactar } from '../core/operaciones.js';

const defs = import.meta.glob('../../schema/*.json', { eager: true, import: 'default' });
export const esquema = crearEsquema(Object.values(defs));

export const estado = {
  documentos: [],
  pestanas: [], // ids de los documentos abiertos, en orden
  id: null,
  doc: null,
  previa: null, // documento con un cambio en curso (arrastre, scrub), todavía sin guardar
  seleccion: null,
  edicion: null, // id del path cuyos puntos se están editando
  vertice: null, // índice del vértice seleccionado en la edición de puntos
  herramienta: 'seleccionar',
  historial: { entradas: [], user: { deshacer: false, rehacer: false } },
};

const oyentes = new Set();
export const suscribir = (fn) => oyentes.add(fn);
export function fijar(cambios) {
  Object.assign(estado, cambios);
  for (const fn of oyentes) fn(cambios);
}
export const docVisible = () => estado.previa ?? estado.doc;

// ---------- Servidor ----------

async function pedir(ruta, cuerpo) {
  // keepalive: un lote agrupado que se envía al cerrar la pestaña igual llega.
  const opciones = cuerpo === undefined ? undefined : { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) };
  const res = await fetch(`/api/documentos${ruta}`, opciones);
  const datos = await res.json();
  if (!res.ok) throw new Error(datos.error);
  return datos;
}

export const api = {
  listar: () => pedir(''),
  crear: (id, meta, copiarDe) => pedir('', { id, meta, copiarDe }),
  leer: (id) => pedir(`/${id}`),
  historial: (id) => pedir(`/${id}/historial`),
  operar: (id, ops, nota) => pedir(`/${id}/ops`, { ops, nota }),
  deshacer: (id) => pedir(`/${id}/deshacer`, {}),
  rehacer: (id) => pedir(`/${id}/rehacer`, {}),
  eliminar: async (id) => {
    const res = await fetch(`/api/documentos/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
  },
};

// ---------- Avisos ----------

let temporizador;
export function avisar(texto, esError = false) {
  const aviso = document.querySelector('#aviso');
  aviso.textContent = texto;
  aviso.title = texto;
  aviso.classList.toggle('error', esError);
  clearTimeout(temporizador);
  temporizador = setTimeout(() => (aviso.textContent = ''), esError ? 8000 : 4000);
}

// ---------- Acciones ----------

export async function cargarDocumentos() {
  fijar({ documentos: await api.listar() });
}

// ---------- Pestañas ----------

const CLAVE_PESTANAS = 'aia-studio.pestanas';

/** Pestañas recordadas de la última vez (solo las que siguen existiendo). Es una comodidad: si falla, no pasa nada. */
export function pestanasGuardadas() {
  try {
    const ids = JSON.parse(localStorage.getItem(CLAVE_PESTANAS) ?? '[]');
    return ids.filter((id) => estado.documentos.some((d) => d.id === id));
  } catch {
    return [];
  }
}

function fijarPestanas(pestanas) {
  fijar({ pestanas });
  try {
    localStorage.setItem(CLAVE_PESTANAS, JSON.stringify(pestanas));
  } catch {
    // sin almacenamiento: las pestañas no se recuerdan
  }
}

/** Agrega una pestaña sin cambiar a ella (por ejemplo, cuando la IA crea un documento). */
export function agregarPestana(id) {
  if (!estado.pestanas.includes(id)) fijarPestanas([...estado.pestanas, id]);
}

export async function abrir(id) {
  await enviarPendiente();
  const doc = await api.leer(id);
  agregarPestana(id);
  history.replaceState(null, '', `?doc=${encodeURIComponent(id)}`);
  fijar({ id, doc, previa: null, seleccion: null, edicion: null, vertice: null });
  await refrescarHistorial();
}

/** Cierra la pestaña (el documento sigue en disco) y pasa a la vecina, si hay. */
export async function cerrarPestana(id) {
  const i = estado.pestanas.indexOf(id);
  if (i < 0) return;
  const pestanas = estado.pestanas.filter((p) => p !== id);
  fijarPestanas(pestanas);
  if (id !== estado.id) return;
  const vecina = pestanas[Math.min(i, pestanas.length - 1)];
  if (vecina) return abrir(vecina);
  await enviarPendiente();
  history.replaceState(null, '', location.pathname);
  fijar({ id: null, doc: null, previa: null, seleccion: null, edicion: null, vertice: null, historial: { entradas: [], user: { deshacer: false, rehacer: false } } });
}

/** Borra el documento del disco (con su historial) y cierra su pestaña. */
export async function eliminarDocumento(id) {
  await cerrarPestana(id);
  await api.eliminar(id);
  await cargarDocumentos();
}

export async function refrescarHistorial() {
  if (estado.id) fijar({ historial: await api.historial(estado.id) });
}

/** Muestra un cambio sin guardarlo (null lo descarta). Si el cambio no es válido, simplemente no se muestra. */
export function previsualizar(ops) {
  if (!ops) return estado.previa && fijar({ previa: null });
  try {
    fijar({ previa: aplicarOperaciones(estado.doc, ops, esquema).doc });
  } catch {
    // valor intermedio inválido mientras se escribe: se ignora
  }
}

// Los lotes se envían en orden, uno detrás de otro.
let fila = Promise.resolve();

// Cambios seguidos sobre lo mismo (flechas, flechitas de un campo numérico) se juntan en un solo lote:
// una sola entrada en el historial y un solo paso de deshacer.
const ESPERA_AGRUPADO = 800;
let pendiente = null;

export const hayPendiente = () => pendiente !== null || enCamino > 0;

/** Envía ya el lote agrupado que esté esperando. */
export function enviarPendiente() {
  if (!pendiente) return fila;
  const { id, ops, nota, temporizador } = pendiente;
  clearTimeout(temporizador);
  pendiente = null;
  return enviar(id, ops, nota);
}

/**
 * Aplica un lote al instante en pantalla y lo guarda. Con `agrupar` (una clave como "flechas:head"), los lotes
 * seguidos con la misma clave se juntan hasta que pasa un momento sin cambios.
 */
export function ejecutar(ops, nota, { agrupar } = {}) {
  let resultado;
  try {
    resultado = aplicarOperaciones(estado.doc, ops, esquema);
  } catch (e) {
    avisar(e.message, true);
    fijar({ previa: null });
    return Promise.resolve(false);
  }
  fijar({ doc: resultado.doc, previa: null });
  if (resultado.avisos.length) avisar(resultado.avisos.join(' · '));

  if (pendiente && (pendiente.clave !== agrupar || pendiente.id !== estado.id)) enviarPendiente();
  if (!agrupar) return enviar(estado.id, ops, nota);
  if (pendiente) {
    clearTimeout(pendiente.temporizador);
    pendiente.ops = compactar([...pendiente.ops, ...ops]);
  } else {
    pendiente = { clave: agrupar, id: estado.id, ops: compactar(ops), nota };
  }
  pendiente.temporizador = setTimeout(enviarPendiente, ESPERA_AGRUPADO);
  return Promise.resolve(true);
}

let enCamino = 0;

function enviar(id, ops, nota) {
  enCamino++;
  fila = fila.then(async () => {
    try {
      const { doc } = await api.operar(id, ops, nota);
      // Si quedan lotes por llegar al servidor, la pantalla ya va por delante: no se pisa con un estado viejo.
      if (estado.id === id && !pendiente && enCamino === 1) fijar({ doc });
    } catch (e) {
      avisar(e.message, true);
      if (estado.id === id) fijar({ doc: await api.leer(id) });
    } finally {
      enCamino--;
    }
    await refrescarHistorial();
    return true;
  });
  return fila;
}

async function revertir(tipo) {
  if (!estado.id) return;
  await enviarPendiente();
  try {
    const { doc } = await api[tipo](estado.id);
    fijar({ doc, previa: null });
  } catch (e) {
    avisar(e.message, true);
  }
  await refrescarHistorial();
}
export const deshacer = () => revertir('deshacer');
export const rehacer = () => revertir('rehacer');

export function seleccionar(id) {
  if (id !== estado.seleccion) fijar({ seleccion: id });
}

/** Un id libre a partir de una base: rect_1, rect_2... */
export function idLibre(base) {
  for (let n = 1; ; n++) if (!buscar(estado.doc, `${base}_${n}`)) return `${base}_${n}`;
}

/** Dónde se crea algo nuevo: dentro del grupo seleccionado o, si no hay un grupo seleccionado, en la raíz. */
export function padreParaNuevo() {
  const sel = estado.seleccion && buscar(estado.doc, estado.seleccion);
  return sel && esquema.tipos.get(sel.type).container ? sel.id : null;
}
