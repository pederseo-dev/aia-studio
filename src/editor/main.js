// Punto de entrada del editor: monta los paneles y conecta la barra, el teclado y los avisos en vivo.

import { buscar, hijos, subarbol } from '../core/documento.js';
import { aplicarOperaciones } from '../core/operaciones.js';
import { leer } from '../core/esquema.js';
import { montarArbol } from './arbol.js';
import { montarHistorial } from './historial.js';
import { FLECHA, ICONOS } from './iconos.js';
import { operacionesDeImportar } from './importar.js';
import { montarInspector } from './inspector.js';
import { montarLienzo } from './lienzo.js';
import { montarOpciones } from './opciones.js';
import { montarParametros } from './parametros.js';
import {
  abrir, agregarPestana, api, avisar, cargarDocumentos, cerrarPestana, deshacer, ejecutar, eliminarDocumento,
  enviarPendiente, esquema, estado, fijar, hayPendiente, idLibre, mantenerPosicion, padreParaNuevo,
  pestanasGuardadas, refrescarHistorial, rehacer, seleccionRaices, seleccionar, seleccionarVarios, suscribir,
} from './estado.js';

const $ = (s) => document.querySelector(s);
$('#deshacer').innerHTML = ICONOS.deshacer;
$('#rehacer').innerHTML = ICONOS.rehacer;
// Íconos fijos del HTML: data-icono los pone al principio del elemento y data-flecha es la flecha de un desplegable.
for (const el of document.querySelectorAll('[data-icono]')) el.insertAdjacentHTML('afterbegin', ICONOS[el.dataset.icono]);
for (const el of document.querySelectorAll('[data-flecha]')) el.innerHTML = FLECHA;

montarArbol($('#arbol'), $('#recursos'));
montarInspector($('#inspector'));
montarHistorial($('#entradas'), $('#deshacer'), $('#rehacer'));
const lienzo = montarLienzo($('#lienzo'));
montarOpciones($('#opciones'), { agrupar: () => agruparSeleccion(), switch: () => nuevoSwitch(), enlazar: () => enlazarSeleccion() });
montarParametros($('#parametros'), $('#nuevo-param'));

// ---------- Menús desplegables (menú principal, zoom, grupos de herramientas) ----------

function alternarMenu(menu, boton) {
  const abrirlo = menu.hidden;
  cerrarMenus();
  if (!abrirlo) return;
  menu.hidden = false;
  boton?.setAttribute('aria-expanded', 'true');
  // Posición fija junto al desplegable: así un panel con overflow (la jerarquía) no recorta el menú.
  const caja = (menu.closest('.desplegable') ?? boton).getBoundingClientRect();
  const ancho = menu.offsetWidth;
  const izquierda = menu.classList.contains('derecha') ? caja.right - ancho : caja.left;
  menu.style.left = `${Math.max(4, Math.min(izquierda, innerWidth - ancho - 4))}px`;
  menu.style.top = `${caja.bottom + 4}px`;
}
addEventListener('resize', cerrarMenus);

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
    if (!confirm(`Delete “${d?.name ?? estado.id}” and all its history? This can’t be undone.`)) return;
    try {
      await eliminarDocumento(estado.id);
      avisar(`Deleted “${d?.name ?? estado.id}”`);
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
      li.querySelector('.id').textContent = estado.pestanas.includes(d.id) ? `${d.id} · open` : d.id;
      li.querySelector('button').addEventListener('click', () => {
        $('#dialogo-abrir').close();
        abrir(d.id);
      });
      return li;
    }),
  );
  if (!estado.documentos.length) lista.innerHTML = '<li class="ayuda">No characters yet.</li>';
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
      pestana.innerHTML = '<span class="titulo"></span><button type="button" class="cerrar" title="Close tab (the document is not deleted)">×</button>';
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
    { id: 'seleccionar', nombre: 'Move', atajo: 'V' },
    { id: 'rotar', nombre: 'Rotate', atajo: 'T' },
    { id: 'escalar', nombre: 'Scale', atajo: 'S' },
  ],
  crear: [
    { id: 'path', nombre: 'Pen', atajo: 'P' },
    { id: 'rect', nombre: 'Rectangle', atajo: 'R' },
    { id: 'ellipse', nombre: 'Ellipse', atajo: 'E' },
  ],
  esqueleto: [{ id: 'hueso', nombre: 'Bone', atajo: 'B' }],
};
const ultimaDelGrupo = { transformar: 'seleccionar', crear: 'path', esqueleto: 'hueso' };
const ATAJOS = Object.fromEntries(Object.values(GRUPOS).flat().map((h) => [h.atajo.toLowerCase(), h.id]));

function dibujarGrupos() {
  for (const [grupo, herramientas] of Object.entries(GRUPOS)) {
    const caja = document.querySelector(`[data-grupo="${grupo}"]`);
    const activa = herramientas.find((h) => h.id === estado.herramienta);
    if (activa) ultimaDelGrupo[grupo] = activa.id;
    const visible = herramientas.find((h) => h.id === ultimaDelGrupo[grupo]);
    caja.classList.toggle('activo', !!activa);
    caja.innerHTML = `<button type="button" class="principal" title="${visible.nombre} (${visible.atajo})" aria-label="${visible.nombre}">${ICONOS[visible.id]}</button><button type="button" class="elegir" aria-haspopup="menu" title="More tools">${FLECHA}</button><div class="menu" role="menu" hidden></div>`;
    const menu = caja.querySelector('.menu');
    for (const h of herramientas) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = h.id === estado.herramienta ? 'marcado' : '';
      b.innerHTML = `<span class="con-icono">${ICONOS[h.id]}${h.nombre}</span><kbd>${h.atajo}</kbd>`;
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
// Grupo y switch comparten botón, como la pluma y las formas: el principal crea el último tipo elegido.
const CONTENEDORES = {
  group: { titulo: 'New group (G) · with several selected, groups them (Ctrl+G)', crear: () => (estado.seleccionados.length > 1 ? agruparSeleccion() : nuevoGrupo()) },
  switch: { titulo: 'New switch (Shift+G): shows one child at a time · with something selected, wraps it as variants', crear: () => nuevoSwitch() },
};
let ultimoContenedor = 'group';
function fijarContenedor(tipo) {
  ultimoContenedor = tipo;
  Object.assign($('#nuevo-grupo'), { innerHTML: ICONOS[tipo], title: CONTENEDORES[tipo].titulo });
}
fijarContenedor('group');
$('#nuevo-grupo').addEventListener('click', () => CONTENEDORES[ultimoContenedor].crear());
$('#crear-grupo .elegir').addEventListener('click', (e) => alternarMenu($('#crear-grupo .menu'), e.currentTarget));
$('#crear-grupo .menu').addEventListener('click', (e) => {
  const tipo = e.target.closest('[data-tipo]')?.dataset.tipo;
  if (!tipo) return;
  cerrarMenus();
  fijarContenedor(tipo);
  CONTENEDORES[tipo].crear();
});
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
    ejecutar(ops, `import ${archivo.name} (${ops.length - 1} shapes)`);
    seleccionar(grupo);
  } catch (err) {
    avisar(err.message, true);
  }
});

function nuevoRecurso(tipo, base, props) {
  if (!estado.doc) return;
  const id = idLibre(base);
  ejecutar([{ op: 'create', type: tipo, id, ...(props ? { props } : {}) }], `create ${id}`);
  seleccionar(id);
}

const nombreDe = (ids) => (ids.length === 1 ? ids[0] : `${ids.length} objects`);

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
  ejecutar(ops, `duplicate ${nombreDe(raices)}`);
  seleccionarVarios(raices.map((id) => `${id}_${sufijo}`));
}

function borrarSeleccion() {
  const raices = seleccionRaices();
  if (!raices.length) return;
  seleccionar(null);
  ejecutar(raices.map((id) => ({ op: 'delete', target: id })), `delete ${nombreDe(raices)}`);
}

function nuevoGrupo(tipo = 'group') {
  if (!estado.doc) return;
  const id = idLibre(tipo);
  ejecutar([{ op: 'create', type: tipo, id, parent: padreParaNuevo() }], `create ${id}`);
  seleccionar(id);
}

/**
 * Switch (Shift+G): mete la selección en un switch nuevo (cada objeto es una variante; se ve el primero) o, sin
 * selección, crea uno vacío. Después se le agregan variantes arrastrándolas adentro o dibujando con él seleccionado.
 */
function nuevoSwitch() {
  const dibujo = seleccionRaices().filter((id) => !esquema.tipos.get(buscar(estado.doc, id).type).resource);
  return dibujo.length ? agruparSeleccion('switch') : nuevoGrupo('switch');
}

/**
 * Mete la selección en un grupo nuevo (Ctrl+G). Si todos tienen el mismo padre, el grupo queda ahí, en el lugar del
 * que estaba más al frente; si no, va a la raíz. Los objetos no se mueven de lugar en pantalla.
 */
function agruparSeleccion(tipo = 'group') {
  const raices = seleccionRaices().filter((id) => !esquema.tipos.get(buscar(estado.doc, id).type).resource);
  if (!raices.length) return;
  const padres = new Set(raices.map((id) => buscar(estado.doc, id).parent ?? null));
  const padre = padres.size === 1 ? [...padres][0] : null;
  const hermanos = hijos(estado.doc, padre);
  const frente = Math.max(...raices.map((id) => hermanos.findIndex((o) => o.id === id)));
  const grupo = idLibre(tipo);
  const ops = [{ op: 'create', type: tipo, id: grupo, parent: padre, ...(frente >= 0 ? { index: frente + 1 } : {}) }];
  let doc = aplicarOperaciones(estado.doc, ops, esquema).doc;
  for (const id of raices) {
    const lote = [{ op: 'move', target: id, parent: grupo }, ...mantenerPosicion(doc, id, grupo)];
    doc = aplicarOperaciones(doc, lote, esquema).doc;
    ops.push(...lote);
  }
  ejecutar(ops, `${tipo === 'switch' ? 'switch with' : 'group'} ${nombreDe(raices)} into ${grupo}`);
  seleccionar(grupo);
}

/**
 * Ctrl+B: pega los objetos seleccionados al hueso seleccionado (el principal, o el único hueso de la selección).
 * Sin ningún hueso en la selección, los suelta. Como en Moho, enlazar no mueve nada: el dibujo sigue al hueso al posar.
 */
function enlazarSeleccion() {
  const ids = estado.seleccionados.filter((id) => buscar(estado.doc, id));
  const huesos = ids.filter((id) => buscar(estado.doc, id).type === 'bone');
  const hueso = huesos.includes(estado.seleccion) ? estado.seleccion : huesos.length === 1 ? huesos[0] : null;
  if (huesos.length > 1 && !hueso) return avisar('To bind, leave only one bone in the selection', true);
  const objetos = ids.filter((id) => 'bone' in esquema.tipos.get(buscar(estado.doc, id).type).properties);
  if (!objetos.length) return avisar(hueso ? 'Also select the artwork to bind to the bone' : 'Select artwork and a bone (Ctrl + click)', true);
  const ops = objetos.map((id) => (hueso ? { op: 'set', target: id, props: { bone: hueso } } : { op: 'unset', target: id, props: ['bone'] }));
  ejecutar(ops, hueso ? `bind ${nombreDe(objetos)} to ${hueso}` : `unbind ${nombreDe(objetos)}`);
  avisar(hueso ? `${nombreDe(objetos)} follow${objetos.length > 1 ? '' : 's'} ${hueso}` : `${nombreDe(objetos)} no longer follow${objetos.length > 1 ? '' : 's'} any bone`);
}

// ---------- Montaje y poses ----------

const NUEVA_POSE = '__nueva';
const PARAMETROS = '__params';

function dibujarPoses() {
  const select = $('#pose');
  const objetos = estado.doc?.objects ?? [];
  const poses = objetos.filter((o) => o.type === 'pose');
  const conParams = objetos.some((o) => o.type === 'param');
  select.replaceChildren(
    new Option('Setup', ''),
    ...(conParams ? [new Option('Parameters (blend)', PARAMETROS)] : []),
    ...poses.map((p) => new Option(`Pose: ${p.id}`, p.id)),
    new Option('＋ New pose…', NUEVA_POSE),
  );
  select.value = estado.pose ?? (estado.params && conParams ? PARAMETROS : '');
  $('#modo').classList.toggle('en-pose', !!estado.pose);
  $('#modo').classList.toggle('en-params', !estado.pose && !!estado.params);
}

$('#pose').addEventListener('change', (e) => {
  const valor = e.target.value;
  if (valor === PARAMETROS) return fijar({ pose: null, params: estado.params ?? {} });
  // Montaje deja de mezclar; una pose se ve sola (los valores de los params quedan para cuando se vuelva).
  if (valor !== NUEVA_POSE) return fijar(valor ? { pose: valor } : { pose: null, params: null });
  const base = prompt('Pose name (e.g. wave, look_up):', '')?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) return dibujarPoses();
  const id = /^[a-z]/.test(base) ? base : `pose_${base}`;
  if (buscar(estado.doc, id)) {
    avisar(`"${id}" already exists`, true);
    return dibujarPoses();
  }
  ejecutar([{ op: 'create', type: 'pose', id }], `create pose ${id}`);
  fijar({ pose: id });
});

suscribir((c) => {
  if ('doc' in c || 'pose' in c || 'params' in c || 'id' in c) {
    // Si la pose activa desapareció (deshacer, la IA la borró), se vuelve al montaje.
    if (estado.pose && buscar(estado.doc ?? { objects: [] }, estado.pose)?.type !== 'pose') return fijar({ pose: null });
    dibujarPoses();
  }
});

/** Crea un documento vacío o, con `copiarDe`, una copia del documento indicado. */
async function nuevoDocumento(copiarDe) {
  const actual = copiarDe && estado.documentos.find((d) => d.id === copiarDe);
  const nombre = prompt(copiarDe ? 'Name of the copy:' : 'New character name:', actual ? `${actual.name} (copy)` : '')?.trim();
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
  if (mod && tecla === 'b') {
    e.preventDefault();
    return enlazarSeleccion();
  }
  if (mod && tecla === 'a') {
    // Todo lo que está en la raíz (sin los recursos).
    e.preventDefault();
    return seleccionarVarios(hijos(estado.doc, null).filter((o) => !esquema.tipos.get(o.type).resource).map((o) => o.id));
  }
  if (mod) return;
  if (ATAJOS[tecla]) return fijar({ herramienta: ATAJOS[tecla] });
  if (tecla === 'g') return e.shiftKey ? nuevoSwitch() : nuevoGrupo();
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
    if (estado.enlazando) return fijar({ enlazando: null });
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
  // En una pose, las flechas no mueven el montaje.
  if (flechas[e.key] && raices.length && !estado.pose) {
    e.preventDefault();
    const [dx, dy] = flechas[e.key].map((d) => d * (e.shiftKey ? 10 : 1));
    const ops = raices.map((id) => {
      const obj = buscar(estado.doc, id);
      return { op: 'set', target: id, props: { x: leer(esquema, obj, 'x') + dx, y: leer(esquema, obj, 'y') + dy } };
    });
    ejecutar(ops, `move ${nombreDe(raices)}`, { agrupar: `flechas:${raices.join()}` });
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
    avisar(`Created “${estado.documentos.find((d) => d.id === id)?.name ?? id}” in a new tab`);
    return;
  }
  if (id !== estado.id || hayPendiente()) return;
  const doc = await api.leer(id);
  if (JSON.stringify(doc) !== JSON.stringify(estado.doc)) {
    fijar({ doc, previa: null });
    avisar('The document was changed externally (AI)');
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
