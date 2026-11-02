// Punto de entrada del editor: monta los paneles y conecta la barra, el teclado y los avisos en vivo.

import { buscar, subarbol } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { montarArbol } from './arbol.js';
import { montarHistorial } from './historial.js';
import { operacionesDeImportar } from './importar.js';
import { montarInspector } from './inspector.js';
import { montarLienzo } from './lienzo.js';
import {
  abrir, api, avisar, cargarDocumentos, deshacer, ejecutar, enviarPendiente, esquema, estado, fijar, hayPendiente,
  idLibre, padreParaNuevo, refrescarHistorial, rehacer, seleccionar, suscribir,
} from './estado.js';

const $ = (s) => document.querySelector(s);

montarArbol($('#arbol'), $('#recursos'));
montarInspector($('#inspector'));
montarHistorial($('#entradas'), $('#deshacer'), $('#rehacer'));
const lienzo = montarLienzo($('#lienzo'));

// ---------- Barra ----------

suscribir((c) => {
  if ('documentos' in c || 'id' in c) {
    $('#documentos').replaceChildren(...estado.documentos.map((d) => new Option(d.name === d.id ? d.id : `${d.name} (${d.id})`, d.id, false, d.id === estado.id)));
  }
  if ('herramienta' in c) {
    for (const b of document.querySelectorAll('[data-herramienta]')) b.classList.toggle('activo', b.dataset.herramienta === estado.herramienta);
  }
  if ('seleccion' in c || 'doc' in c) $('#borrar').disabled = $('#duplicar').disabled = !estado.seleccion;
  // Si la selección desapareció (por ejemplo, la IA borró el objeto), se limpia.
  if ('doc' in c && estado.seleccion && !buscar(estado.doc, estado.seleccion)) seleccionar(null);
});

$('#documentos').addEventListener('change', (e) => abrir(e.target.value));
$('#herramientas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-herramienta]');
  if (b) fijar({ herramienta: b.dataset.herramienta });
});
$('#deshacer').addEventListener('click', deshacer);
$('#rehacer').addEventListener('click', rehacer);
$('#ajustar').addEventListener('click', () => lienzo.ajustar());
$('#borrar').addEventListener('click', borrarSeleccion);
$('#nuevo-grupo').addEventListener('click', nuevoGrupo);
$('#duplicar').addEventListener('click', duplicarSeleccion);
$('#nuevo').addEventListener('click', () => nuevoDocumento());
$('#copiar-documento').addEventListener('click', () => estado.id && nuevoDocumento(estado.id));
$('#nuevo-estilo').addEventListener('click', () => nuevoRecurso('style', 'style', { fill: '#c8c2d4', stroke: '#2b2135' }));
$('#nuevo-degradado').addEventListener('click', () => nuevoRecurso('linear_gradient', 'gradient'));
$('#importar').addEventListener('click', () => $('#archivo-svg').click());
$('#archivo-svg').addEventListener('change', async (e) => {
  const archivo = e.target.files[0];
  e.target.value = '';
  if (!archivo || !estado.doc) return;
  try {
    const nombre = archivo.name.replace(/\.svg$/i, '');
    const { ops, grupo } = operacionesDeImportar(await archivo.text(), { doc: estado.doc, padre: padreParaNuevo(), nombre });
    ejecutar(ops, `importar ${archivo.name} (${ops.length - 1} formas)`);
    seleccionar(grupo);
  } catch (err) {
    avisar(err.message, true);
  }
});

function nuevoRecurso(tipo, base, props) {
  if (!estado.doc) return;
  const id = idLibre(base);
  ejecutar([{ op: 'create', type: tipo, id, ...(props ? { props } : {}) }], `crear ${id}`);
  seleccionar(id);
}

/** Duplica la selección con sus hijos, un poco desplazada, y selecciona la copia. */
function duplicarSeleccion() {
  const obj = estado.seleccion && buscar(estado.doc, estado.seleccion);
  if (!obj) return;
  const ids = subarbol(estado.doc, obj.id);
  let sufijo = 'copy';
  for (let n = 2; ids.some((id) => buscar(estado.doc, `${id}_${sufijo}`)); n++) sufijo = `copy${n}`;
  const props = { x: leer(esquema, obj, 'x') + 20, y: leer(esquema, obj, 'y') + 20 };
  ejecutar([{ op: 'duplicate', target: obj.id, suffix: sufijo, props }], `duplicar ${obj.id}`);
  seleccionar(`${obj.id}_${sufijo}`);
}

function borrarSeleccion() {
  const id = estado.seleccion;
  if (!id) return;
  seleccionar(null);
  ejecutar([{ op: 'delete', target: id }], `borrar ${id}`);
}

function nuevoGrupo() {
  if (!estado.doc) return;
  const id = idLibre('group');
  ejecutar([{ op: 'create', type: 'group', id, parent: padreParaNuevo() }], `crear ${id}`);
  seleccionar(id);
}

/** Crea un documento vacío o, con `copiarDe`, una copia del documento indicado. */
async function nuevoDocumento(copiarDe) {
  const actual = copiarDe && estado.documentos.find((d) => d.id === copiarDe);
  const nombre = prompt(copiarDe ? 'Nombre de la copia:' : 'Nombre del personaje nuevo:', actual ? `${actual.name} (copia)` : '')?.trim();
  if (!nombre) return;
  const base = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const raiz = /^[a-z]/.test(base) ? base : `doc_${base || 'nuevo'}`;
  const ids = new Set(estado.documentos.map((d) => d.id));
  let id = raiz;
  for (let n = 2; ids.has(id); n++) id = `${raiz}_${n}`;
  try {
    await api.crear(id, { name: nombre }, copiarDe);
    await cargarDocumentos();
    await abrir(id);
  } catch (e) {
    avisar(e.message, true);
  }
}

// ---------- Teclado ----------

const ATAJOS = { v: 'seleccionar', r: 'rect', e: 'ellipse', p: 'path' };
const salirDeEdicion = () => fijar({ edicion: null, vertice: null });

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const tecla = e.key.toLowerCase();
  if (mod && tecla === 'z') {
    e.preventDefault();
    return e.shiftKey ? rehacer() : deshacer();
  }
  if (mod && tecla === 'y') {
    e.preventDefault();
    return rehacer();
  }
  if (mod && tecla === 'd') {
    e.preventDefault();
    return duplicarSeleccion();
  }
  if (mod) return;
  if (ATAJOS[tecla]) return fijar({ herramienta: ATAJOS[tecla] });
  if (tecla === 'g') return nuevoGrupo();
  if (tecla === 'f') return lienzo.ajustar();

  // Pluma: Enter o Escape terminan el trazo abierto.
  if (estado.herramienta === 'path' && lienzo.pluma.activa() && (e.key === 'Enter' || e.key === 'Escape')) return lienzo.pluma.terminar(false);
  // Enter entra o sale de la edición de puntos de un path.
  if (e.key === 'Enter') {
    if (estado.edicion) return salirDeEdicion();
    const sel = estado.seleccion && buscar(estado.doc, estado.seleccion);
    if (sel?.type === 'path') return lienzo.editarPuntos(sel.id);
  }
  if (e.key === 'Escape') {
    if (estado.edicion) return salirDeEdicion();
    return estado.herramienta !== 'seleccionar' ? fijar({ herramienta: 'seleccionar' }) : seleccionar(null);
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (estado.edicion) return lienzo.puntos.borrarVertice();
    return borrarSeleccion();
  }

  // Flechas: mover la selección 1 px (Shift: 10 px).
  const flechas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const obj = estado.seleccion && buscar(estado.doc, estado.seleccion);
  if (flechas[e.key] && obj) {
    e.preventDefault();
    const [dx, dy] = flechas[e.key].map((d) => d * (e.shiftKey ? 10 : 1));
    ejecutar([{ op: 'set', target: obj.id, props: { x: leer(esquema, obj, 'x') + dx, y: leer(esquema, obj, 'y') + dy } }], `mover ${obj.id}`, { agrupar: `flechas:${obj.id}` });
  }
});

window.addEventListener('pagehide', enviarPendiente);

// ---------- Cambios desde fuera (la IA por MCP, u otro proceso) ----------

import.meta.hot?.on('aia:documento', async ({ id }) => {
  if (!estado.documentos.some((d) => d.id === id)) await cargarDocumentos();
  if (id !== estado.id || hayPendiente()) return;
  const doc = await api.leer(id);
  if (JSON.stringify(doc) !== JSON.stringify(estado.doc)) {
    fijar({ doc, previa: null });
    avisar('El documento cambió desde fuera (IA)');
  }
});

import.meta.hot?.on('aia:historial', ({ id }) => id === estado.id && refrescarHistorial());

// ---------- Inicio ----------

fijar({ herramienta: 'seleccionar' });
await cargarDocumentos();
const pedido = new URLSearchParams(location.search).get('doc');
const inicial = estado.documentos.find((d) => d.id === pedido)?.id ?? estado.documentos[0]?.id;
if (inicial) await abrir(inicial);
else avisar('No hay documentos todavía: crea uno con «Nuevo» o pídeselo a la IA.');
