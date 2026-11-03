// Punto de entrada del editor: monta los paneles y conecta la barra, el teclado y los avisos en vivo.

import { buscar, hijos, subarbol } from '../core/documento.js';
import { aplicarOperaciones } from '../core/operaciones.js';
import { leer } from '../core/esquema.js';
import { montarArbol } from './arbol.js';
import { montarHistorial } from './historial.js';
import { operacionesDeImportar } from './importar.js';
import { montarInspector } from './inspector.js';
import { montarLienzo } from './lienzo.js';
import {
  abrir, agregarPestana, api, avisar, cargarDocumentos, cerrarPestana, deshacer, ejecutar, eliminarDocumento,
  enviarPendiente, esquema, estado, fijar, hayPendiente, idLibre, mantenerPosicion, padreParaNuevo,
  pestanasGuardadas, refrescarHistorial, rehacer, seleccionRaices, seleccionar, seleccionarVarios, suscribir,
} from './estado.js';

const $ = (s) => document.querySelector(s);

montarArbol($('#arbol'), $('#recursos'));
montarInspector($('#inspector'));
montarHistorial($('#entradas'), $('#deshacer'), $('#rehacer'));
const lienzo = montarLienzo($('#lienzo'));

// ---------- Menús desplegables (menú principal, zoom, grupos de herramientas) ----------

function alternarMenu(menu, boton) {
  const abrirlo = menu.hidden;
  cerrarMenus();
  if (!abrirlo) return;
  menu.hidden = false;
  boton?.setAttribute('aria-expanded', 'true');
}

function cerrarMenus() {
  document.querySelectorAll('.menu').forEach((m) => (m.hidden = true));
  document.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.desplegable')) cerrarMenus();
});

// ---------- Menú principal ----------

const ACCIONES = {
  nuevo: () => nuevoDocumento(),
  abrir: mostrarAbrir,
  copiar: () => nuevoDocumento(estado.id),
  importar: () => $('#archivo-svg').click(),
  cerrar: () => cerrarPestana(estado.id),
  eliminar: async () => {
    const d = estado.documentos.find((x) => x.id === estado.id);
    if (!confirm(`¿Eliminar «${d?.name ?? estado.id}» y todo su historial? No se puede deshacer.`)) return;
    try {
      await eliminarDocumento(estado.id);
      avisar(`Se eliminó «${d?.name ?? estado.id}»`);
    } catch (err) {
      avisar(err.message, true);
    }
  },
  atajos: () => $('#dialogo-atajos').showModal(),
};

$('#menu-boton').addEventListener('click', () => alternarMenu($('#menu'), $('#menu-boton')));
$('#menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-accion]');
  if (!b || b.disabled) return;
  cerrarMenus();
  ACCIONES[b.dataset.accion]();
});
$('#nueva-pestana').addEventListener('click', () => nuevoDocumento());

function mostrarAbrir() {
  const lista = $('#lista-documentos');
  lista.replaceChildren(
    ...estado.documentos.map((d) => {
      const li = document.createElement('li');
      li.innerHTML = '<button type="button"><span class="nombre"></span><span class="id"></span></button>';
      li.querySelector('.nombre').textContent = d.name;
      li.querySelector('.id').textContent = estado.pestanas.includes(d.id) ? `${d.id} · abierto` : d.id;
      li.querySelector('button').addEventListener('click', () => {
        $('#dialogo-abrir').close();
        abrir(d.id);
      });
      return li;
    }),
  );
  if (!estado.documentos.length) lista.innerHTML = '<li class="ayuda">No hay personajes todavía.</li>';
  $('#dialogo-abrir').showModal();
}

// ---------- Pestañas ----------

function dibujarPestanas() {
  $('#pestanas').replaceChildren(
    ...estado.pestanas.map((id) => {
      const d = estado.documentos.find((x) => x.id === id);
      const pestana = document.createElement('div');
      pestana.className = `pestana${id === estado.id ? ' activa' : ''}`;
      pestana.setAttribute('role', 'tab');
      pestana.setAttribute('aria-selected', String(id === estado.id));
      pestana.title = id;
      pestana.innerHTML = '<span class="titulo"></span><button type="button" class="cerrar" title="Cerrar pestaña (el documento no se borra)">×</button>';
      pestana.querySelector('.titulo').textContent = d?.name ?? id;
      pestana.addEventListener('click', (e) => (e.target.closest('.cerrar') ? cerrarPestana(id) : id !== estado.id && abrir(id)));
      // Clic con la rueda también cierra, como en el navegador.
      pestana.addEventListener('auxclick', (e) => e.button === 1 && cerrarPestana(id));
      return pestana;
    }),
  );
}

// ---------- Grupos de herramientas ----------

const GRUPOS = {
  transformar: [
    { id: 'seleccionar', icono: '↖', nombre: 'Mover', atajo: 'V' },
    { id: 'rotar', icono: '⟳', nombre: 'Rotar', atajo: 'T' },
    { id: 'escalar', icono: '⤡', nombre: 'Escalar', atajo: 'S' },
  ],
  crear: [
    { id: 'path', icono: '✒', nombre: 'Pluma', atajo: 'P' },
    { id: 'rect', icono: '▭', nombre: 'Rectángulo', atajo: 'R' },
    { id: 'ellipse', icono: '◯', nombre: 'Elipse', atajo: 'E' },
  ],
};
const ultimaDelGrupo = { transformar: 'seleccionar', crear: 'path' };
const ATAJOS = Object.fromEntries(Object.values(GRUPOS).flat().map((h) => [h.atajo.toLowerCase(), h.id]));

function dibujarGrupos() {
  for (const [grupo, herramientas] of Object.entries(GRUPOS)) {
    const caja = document.querySelector(`[data-grupo="${grupo}"]`);
    const activa = herramientas.find((h) => h.id === estado.herramienta);
    if (activa) ultimaDelGrupo[grupo] = activa.id;
    const visible = herramientas.find((h) => h.id === ultimaDelGrupo[grupo]);
    caja.classList.toggle('activo', !!activa);
    caja.innerHTML = `<button type="button" class="principal" title="${visible.nombre} (${visible.atajo})">${visible.icono} ${visible.nombre}</button><button type="button" class="elegir" aria-haspopup="menu" title="Más herramientas">▾</button><div class="menu" role="menu" hidden></div>`;
    const menu = caja.querySelector('.menu');
    for (const h of herramientas) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = h.id === estado.herramienta ? 'marcado' : '';
      b.innerHTML = `<span>${h.icono} ${h.nombre}</span><kbd>${h.atajo}</kbd>`;
      b.addEventListener('click', () => {
        cerrarMenus();
        fijar({ herramienta: h.id });
      });
      menu.append(b);
    }
    caja.querySelector('.principal').addEventListener('click', () => fijar({ herramienta: visible.id }));
    caja.querySelector('.elegir').addEventListener('click', (e) => alternarMenu(menu, e.currentTarget));
  }
}

// ---------- Zoom ----------

$('#zoom').addEventListener('click', () => alternarMenu($('#menu-zoom'), $('#zoom')));
$('#menu-zoom').addEventListener('click', (e) => {
  const b = e.target.closest('[data-zoom]');
  if (!b) return;
  cerrarMenus();
  if (b.dataset.zoom === 'ajustar') lienzo.ajustar();
  else lienzo.fijarZoom(Number(b.dataset.zoom));
});

// ---------- Estado de la barra ----------

suscribir((c) => {
  if ('pestanas' in c || 'id' in c || 'documentos' in c) dibujarPestanas();
  if ('herramienta' in c) dibujarGrupos();
  if ('id' in c) {
    for (const b of document.querySelectorAll('[data-requiere-doc]')) b.disabled = !estado.id;
    $('#lienzo .sin-documento')?.toggleAttribute('hidden', !!estado.id);
  }
  if ('seleccion' in c || 'doc' in c) $('#borrar').disabled = $('#duplicar').disabled = !estado.seleccionados.length;
  // Si algo de la selección desapareció (por ejemplo, la IA borró el objeto), se quita.
  if ('doc' in c && estado.doc && estado.seleccionados.some((id) => !buscar(estado.doc, id))) {
    const quedan = estado.seleccionados.filter((id) => buscar(estado.doc, id));
    seleccionarVarios(quedan, buscar(estado.doc, estado.seleccion ?? '') ? estado.seleccion : (quedan.at(-1) ?? null));
  }
});

$('#deshacer').addEventListener('click', deshacer);
$('#rehacer').addEventListener('click', rehacer);
$('#borrar').addEventListener('click', borrarSeleccion);
$('#nuevo-grupo').addEventListener('click', () => (estado.seleccionados.length > 1 ? agruparSeleccion() : nuevoGrupo()));
$('#duplicar').addEventListener('click', duplicarSeleccion);
$('#nuevo-estilo').addEventListener('click', () => nuevoRecurso('style', 'style', { fill: '#c8c2d4', stroke: '#2b2135' }));
$('#nuevo-degradado').addEventListener('click', () => nuevoRecurso('linear_gradient', 'gradient'));
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

const nombreDe = (ids) => (ids.length === 1 ? ids[0] : `${ids.length} objetos`);

/** Duplica la selección con sus hijos, un poco desplazada, y selecciona las copias. */
function duplicarSeleccion() {
  const raices = seleccionRaices();
  if (!raices.length) return;
  const ids = raices.flatMap((id) => subarbol(estado.doc, id));
  let sufijo = 'copy';
  for (let n = 2; ids.some((id) => buscar(estado.doc, `${id}_${sufijo}`)); n++) sufijo = `copy${n}`;
  const ops = raices.map((id) => {
    const obj = buscar(estado.doc, id);
    return { op: 'duplicate', target: id, suffix: sufijo, props: { x: leer(esquema, obj, 'x') + 20, y: leer(esquema, obj, 'y') + 20 } };
  });
  ejecutar(ops, `duplicar ${nombreDe(raices)}`);
  seleccionarVarios(raices.map((id) => `${id}_${sufijo}`));
}

function borrarSeleccion() {
  const raices = seleccionRaices();
  if (!raices.length) return;
  seleccionar(null);
  ejecutar(raices.map((id) => ({ op: 'delete', target: id })), `borrar ${nombreDe(raices)}`);
}

function nuevoGrupo() {
  if (!estado.doc) return;
  const id = idLibre('group');
  ejecutar([{ op: 'create', type: 'group', id, parent: padreParaNuevo() }], `crear ${id}`);
  seleccionar(id);
}

/**
 * Mete la selección en un grupo nuevo (Ctrl+G). Si todos tienen el mismo padre, el grupo queda ahí, en el lugar del
 * que estaba más al frente; si no, va a la raíz. Los objetos no se mueven de lugar en pantalla.
 */
function agruparSeleccion() {
  const raices = seleccionRaices().filter((id) => !esquema.tipos.get(buscar(estado.doc, id).type).resource);
  if (!raices.length) return;
  const padres = new Set(raices.map((id) => buscar(estado.doc, id).parent ?? null));
  const padre = padres.size === 1 ? [...padres][0] : null;
  const hermanos = hijos(estado.doc, padre);
  const frente = Math.max(...raices.map((id) => hermanos.findIndex((o) => o.id === id)));
  const grupo = idLibre('group');
  const ops = [{ op: 'create', type: 'group', id: grupo, parent: padre, ...(frente >= 0 ? { index: frente + 1 } : {}) }];
  let doc = aplicarOperaciones(estado.doc, ops, esquema).doc;
  for (const id of raices) {
    const lote = [{ op: 'move', target: id, parent: grupo }, ...mantenerPosicion(doc, id, grupo)];
    doc = aplicarOperaciones(doc, lote, esquema).doc;
    ops.push(...lote);
  }
  ejecutar(ops, `agrupar ${nombreDe(raices)} en ${grupo}`);
  seleccionar(grupo);
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

const salirDeEdicion = () => fijar({ edicion: null, vertice: null });

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea, dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  const tecla = e.key.toLowerCase();
  if (e.key === 'Escape' && document.querySelector('.menu:not([hidden])')) return cerrarMenus();
  if (e.altKey && tecla === 'w') {
    e.preventDefault();
    return estado.id && cerrarPestana(estado.id);
  }
  if (!estado.doc) return;
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
  if (mod && tecla === 'g') {
    e.preventDefault();
    return agruparSeleccion();
  }
  if (mod && tecla === 'a') {
    // Todo lo que está en la raíz (sin los recursos).
    e.preventDefault();
    return seleccionarVarios(hijos(estado.doc, null).filter((o) => !esquema.tipos.get(o.type).resource).map((o) => o.id));
  }
  if (mod) return;
  if (ATAJOS[tecla]) return fijar({ herramienta: ATAJOS[tecla] });
  if (tecla === 'g') return nuevoGrupo();
  if (tecla === 'f') return lienzo.ajustar();
  if (tecla === '1') return lienzo.fijarZoom(1);

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
  const raices = seleccionRaices();
  if (flechas[e.key] && raices.length) {
    e.preventDefault();
    const [dx, dy] = flechas[e.key].map((d) => d * (e.shiftKey ? 10 : 1));
    const ops = raices.map((id) => {
      const obj = buscar(estado.doc, id);
      return { op: 'set', target: id, props: { x: leer(esquema, obj, 'x') + dx, y: leer(esquema, obj, 'y') + dy } };
    });
    ejecutar(ops, `mover ${nombreDe(raices)}`, { agrupar: `flechas:${raices.join()}` });
  }
});

window.addEventListener('pagehide', enviarPendiente);

// ---------- Cambios desde fuera (la IA por MCP, u otro proceso) ----------

import.meta.hot?.on('aia:documento', async ({ id }) => {
  // Un documento nuevo (por ejemplo, creado por la IA) se abre en una pestaña sin quitarte de la actual.
  if (!estado.documentos.some((d) => d.id === id)) {
    await cargarDocumentos();
    agregarPestana(id);
    if (!estado.id) return abrir(id);
    avisar(`Se creó «${estado.documentos.find((d) => d.id === id)?.name ?? id}» en una pestaña nueva`);
    return;
  }
  if (id !== estado.id || hayPendiente()) return;
  const doc = await api.leer(id);
  if (JSON.stringify(doc) !== JSON.stringify(estado.doc)) {
    fijar({ doc, previa: null });
    avisar('El documento cambió desde fuera (IA)');
  }
});

import.meta.hot?.on('aia:historial', ({ id }) => id === estado.id && refrescarHistorial());

// ---------- Inicio ----------

fijar({ herramienta: 'seleccionar', id: null });
await cargarDocumentos();
const pedido = new URLSearchParams(location.search).get('doc');
const recordadas = pestanasGuardadas();
for (const id of recordadas) agregarPestana(id);
const inicial = estado.documentos.find((d) => d.id === pedido)?.id ?? recordadas[0];
if (inicial) await abrir(inicial);
