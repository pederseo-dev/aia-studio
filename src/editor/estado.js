// Estado del editor y acciones. Todo cambio al documento pasa por `ejecutar`, que usa el mismo motor de operaciones
// que la IA: se aplica al instante en pantalla y se guarda en el servidor con origen "user".

import { crearEsquema } from '../core/esquema.js';
import { buscar } from '../core/documento.js';
import { aplicarOperaciones } from '../core/operaciones.js';

const defs = import.meta.glob('../../schema/*.json', { eager: true, import: 'default' });
export const esquema = crearEsquema(Object.values(defs));

export const estado = {
  documentos: [],
  id: null,
  doc: null,
  previa: null, // documento con un cambio en curso (arrastre, scrub), todavía sin guardar
  seleccion: null,
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
  const opciones = cuerpo === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) };
  const res = await fetch(`/api/documentos${ruta}`, opciones);
  const datos = await res.json();
  if (!res.ok) throw new Error(datos.error);
  return datos;
}

export const api = {
  listar: () => pedir(''),
  crear: (id, meta) => pedir('', { id, meta }),
  leer: (id) => pedir(`/${id}`),
  historial: (id) => pedir(`/${id}/historial`),
  operar: (id, ops, nota) => pedir(`/${id}/ops`, { ops, nota }),
  deshacer: (id) => pedir(`/${id}/deshacer`, {}),
  rehacer: (id) => pedir(`/${id}/rehacer`, {}),
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

export async function abrir(id) {
  const doc = await api.leer(id);
  history.replaceState(null, '', `?doc=${encodeURIComponent(id)}`);
  fijar({ id, doc, previa: null, seleccion: null });
  await refrescarHistorial();
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

export function ejecutar(ops, nota) {
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
  const id = estado.id;
  fila = fila.then(async () => {
    try {
      const { doc } = await api.operar(id, ops, nota);
      if (estado.id === id) fijar({ doc });
    } catch (e) {
      avisar(e.message, true);
      if (estado.id === id) fijar({ doc: await api.leer(id) });
    }
    await refrescarHistorial();
    return true;
  });
  return fila;
}

async function revertir(tipo) {
  if (!estado.id) return;
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
