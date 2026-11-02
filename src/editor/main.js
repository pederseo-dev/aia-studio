// Editor: muestra el personaje, permite moverlo con sus params y retocar el montaje a mano.
// Cada retoque es un lote de operaciones, igual que los que envía la IA por MCP.

import { Avatar } from '../runtime/avatar.js';
import { aplicarOperaciones } from '../core/operaciones.js';
import { valoresIniciales } from '../core/pose.js';

const $ = (selector) => document.querySelector(selector);
const NS = 'http://www.w3.org/2000/svg';
const PROPIEDADES_HUESO = [
  { prop: 'x', paso: 1, defecto: 0 },
  { prop: 'y', paso: 1, defecto: 0 },
  { prop: 'rotation', paso: 1, defecto: 0 },
  { prop: 'scaleX', paso: 0.01, defecto: 1 },
  { prop: 'scaleY', paso: 0.01, defecto: 1 },
];

const estado = {
  id: null,
  doc: null,
  avatar: null,
  hueso: null,
  deshacer: [],
};

// ---------- Comunicación con el servidor local ----------

async function api(ruta, opciones) {
  const res = await fetch(`/api/personajes${ruta}`, opciones);
  const datos = await res.json();
  if (!res.ok) throw new Error(datos.error);
  return datos;
}

function avisar(texto, esError = false) {
  const aviso = $('#aviso');
  aviso.textContent = texto;
  aviso.style.color = esError ? '#ff7a7a' : '';
  clearTimeout(avisar.temporizador);
  avisar.temporizador = setTimeout(() => (aviso.textContent = ''), 4000);
}

/** Aplica un lote localmente (para que el cambio se vea al instante) y lo guarda en disco. */
async function enviar(ops, { registrarDeshacer = true, nota } = {}) {
  try {
    const { doc, inversas } = aplicarOperaciones(estado.doc, ops);
    if (registrarDeshacer) estado.deshacer.push(inversas);
    mostrarDocumento(doc);
    await api(`/${estado.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops, nota }) });
    cargarHistorial();
  } catch (e) {
    avisar(e.message, true);
    abrir(estado.id); // vuelve a la versión del disco
  }
}

// ---------- Carga ----------

async function cargarLista(seleccion) {
  const ids = await api('');
  $('#personajes').innerHTML = ids.map((id) => `<option>${id}</option>`).join('');
  const id = seleccion ?? new URLSearchParams(location.search).get('p') ?? ids[0];
  if (id) {
    $('#personajes').value = id;
    await abrir(id);
  }
}

async function abrir(id) {
  if (id !== estado.id) {
    estado.id = id;
    estado.hueso = null;
    estado.deshacer = [];
    history.replaceState(null, '', `?p=${id}`);
  }
  mostrarDocumento(await api(`/${id}`));
  cargarHistorial();
}

function mostrarDocumento(doc) {
  const cambioDeParams = JSON.stringify(doc.rig.params) !== JSON.stringify(estado.doc?.rig.params);
  estado.doc = doc;
  if (!doc.rig.bones.some((b) => b.id === estado.hueso)) estado.hueso = null;
  if (estado.avatar) estado.avatar.cargar(doc);
  else estado.avatar = new Avatar($('#escenario'), doc, { alActualizar: dibujarHuesos });
  if (cambioDeParams) dibujarParams();
  dibujarArbol();
  dibujarPropiedades();
}

// ---------- Params ----------

function dibujarParams() {
  const contenedor = $('#params');
  contenedor.innerHTML = '';
  for (const p of estado.doc.rig.params) {
    const div = document.createElement('div');
    div.className = 'param';
    div.title = p.description ?? '';
    div.innerHTML = `
      <div class="fila"><label for="param-${p.id}">${p.id}</label><span class="valor"></span></div>
      <input id="param-${p.id}" type="range" min="${p.range[0]}" max="${p.range[1]}" step="0.01">`;
    const input = div.querySelector('input');
    const valor = div.querySelector('.valor');
    input.value = estado.avatar.get(p.id);
    valor.textContent = (+input.value).toFixed(2);
    input.addEventListener('input', () => {
      estado.avatar.set(p.id, +input.value);
      valor.textContent = (+input.value).toFixed(2);
    });
    contenedor.append(div);
  }
}

function fijarParam(id, valor) {
  estado.avatar.set(id, valor);
  const input = document.getElementById(`param-${id}`);
  if (!input) return;
  input.value = valor;
  input.closest('.param').querySelector('.valor').textContent = valor.toFixed(2);
}

$('#reiniciar-params').addEventListener('click', () => {
  for (const [id, valor] of Object.entries(valoresIniciales(estado.doc))) fijarParam(id, valor);
});

// ---------- Árbol de huesos y propiedades ----------

function dibujarArbol() {
  const hijos = Map.groupBy(estado.doc.rig.bones, (b) => b.parent ?? null);
  const rama = (padre) =>
    (hijos.get(padre) ?? [])
      .map((b) => `<li><button type="button" data-hueso="${b.id}" class="${b.id === estado.hueso ? 'seleccionado' : ''}">${b.id}</button>${hijos.has(b.id) ? `<ul>${rama(b.id)}</ul>` : ''}</li>`)
      .join('');
  $('#huesos').innerHTML = rama(null);
}

$('#huesos').addEventListener('click', (e) => {
  const boton = e.target.closest('[data-hueso]');
  if (boton) seleccionar(boton.dataset.hueso);
});

function seleccionar(id) {
  estado.hueso = id;
  dibujarArbol();
  dibujarPropiedades();
  dibujarHuesos(estado.avatar);
}

function dibujarPropiedades() {
  const seccion = $('#propiedades');
  const hueso = estado.doc.rig.bones.find((b) => b.id === estado.hueso);
  seccion.hidden = !hueso;
  if (!hueso) return;
  $('#titulo-propiedades').textContent = `Hueso: ${hueso.id}`;
  const campos = $('#campos');
  campos.innerHTML = '';
  for (const { prop, paso, defecto } of PROPIEDADES_HUESO) {
    const fila = document.createElement('div');
    fila.className = 'campo';
    fila.innerHTML = `<label for="campo-${prop}">${prop}</label><input id="campo-${prop}" type="number" step="${paso}">`;
    const input = fila.querySelector('input');
    const label = fila.querySelector('label');
    const ruta = `rig.bones.${hueso.id}.${prop}`;
    const original = hueso[prop] ?? defecto;
    input.value = original;

    // Vista previa mientras se edita; el cambio se guarda al soltar o confirmar.
    const previsualizar = () => {
      const valor = +input.value;
      if (Number.isFinite(valor)) estado.avatar.cargar(aplicarOperaciones(estado.doc, [{ op: 'set', path: ruta, value: valor }]).doc);
    };
    const confirmar = () => {
      const valor = +input.value;
      if (Number.isFinite(valor) && valor !== original) enviar([{ op: 'set', path: ruta, value: valor }], { nota: `${hueso.id}.${prop}` });
    };
    input.addEventListener('input', previsualizar);
    input.addEventListener('change', confirmar);

    // Arrastrar sobre el nombre cambia el valor (Shift = más fino).
    label.addEventListener('pointerdown', (e) => {
      const inicioX = e.clientX;
      const inicio = +input.value;
      label.setPointerCapture(e.pointerId);
      const mover = (ev) => {
        const factor = ev.shiftKey ? 0.1 : 1;
        input.value = +(inicio + (ev.clientX - inicioX) * paso * factor).toFixed(paso < 1 ? 3 : 1);
        previsualizar();
      };
      const soltar = () => {
        label.removeEventListener('pointermove', mover);
        label.removeEventListener('pointerup', soltar);
        confirmar();
      };
      label.addEventListener('pointermove', mover);
      label.addEventListener('pointerup', soltar);
    });
    campos.append(fila);
  }
}

// Clic en el dibujo: selecciona el hueso al que está pegada esa parte.
$('#escenario').addEventListener('click', (e) => {
  const circulo = e.target.closest('[data-hueso-overlay]');
  if (circulo) return seleccionar(circulo.dataset.huesoOverlay);
  const el = e.target.closest('[data-part], [data-slot]');
  if (!el) return;
  const id = el.dataset.part ?? el.dataset.slot;
  const dibujable = [...estado.doc.rig.parts, ...estado.doc.rig.slots].find((d) => d.id === id);
  if (dibujable) seleccionar(dibujable.bone);
});

// ---------- Superposición de huesos ----------

function dibujarHuesos(avatar) {
  avatar.svg.querySelector('.huesos-overlay')?.remove();
  if (!$('#ver-huesos').checked) return;
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'huesos-overlay');
  const punto = (id) => avatar.mundo[id].slice(4);
  for (const b of avatar.doc.rig.bones) {
    if (b.parent == null) continue;
    const [x1, y1] = punto(b.parent);
    const [x2, y2] = punto(b.id);
    const linea = document.createElementNS(NS, 'line');
    Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => linea.setAttribute(k, v));
    g.append(linea);
  }
  for (const b of avatar.doc.rig.bones) {
    const [cx, cy] = punto(b.id);
    const c = document.createElementNS(NS, 'circle');
    Object.entries({ cx, cy, r: 4 }).forEach(([k, v]) => c.setAttribute(k, v));
    c.dataset.huesoOverlay = b.id;
    if (b.id === estado.hueso) c.setAttribute('class', 'seleccionado');
    c.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: b.id }));
    g.append(c);
  }
  avatar.svg.append(g);
}

$('#ver-huesos').addEventListener('change', () => dibujarHuesos(estado.avatar));

// ---------- Historial ----------

async function cargarHistorial() {
  const entradas = await api(`/${estado.id}/historial`);
  $('#historial').innerHTML = entradas
    .reverse()
    .slice(0, 12)
    .map((h) => {
      const hora = new Date(h.fecha).toLocaleTimeString();
      const quien = h.origen === 'ai' ? 'IA' : 'Tú';
      return `<li class="${h.origen}"><b>${quien}</b> ${hora} · ${h.nota ?? `${h.ops.length} cambios`}</li>`;
    })
    .join('');
}

// ---------- Comportamientos (código de la app, no del personaje) ----------

function parpadear() {
  if ($('#auto-parpadeo').checked && estado.avatar && 'blink' in estado.avatar.valores) {
    fijarParam('blink', 1);
    setTimeout(() => fijarParam('blink', 0), 120);
  }
  setTimeout(parpadear, 2000 + Math.random() * 3000);
}
setTimeout(parpadear, 1500);

setInterval(() => {
  if (!$('#simular-habla').checked || !estado.avatar || !('mouth_open' in estado.avatar.valores)) return;
  fijarParam('mouth_open', Math.random() < 0.25 ? 0 : 0.2 + Math.random() * 0.8);
}, 110);
$('#simular-habla').addEventListener('change', (e) => {
  if (!e.target.checked && estado.avatar) fijarParam('mouth_open', 0);
});

// ---------- Deshacer y cambios desde fuera ----------

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.target.matches('input[type=number]')) {
    const inversas = estado.deshacer.pop();
    if (inversas) enviar(inversas, { registrarDeshacer: false, nota: 'deshacer' });
    e.preventDefault();
  }
});

$('#personajes').addEventListener('change', (e) => abrir(e.target.value));

// Cuando la IA (u otro proceso) modifica un personaje en disco, el editor se actualiza solo.
import.meta.hot?.on('aia:personaje', async ({ id }) => {
  const conocidos = [...$('#personajes').options].map((o) => o.value);
  if (!conocidos.includes(id)) await cargarLista(estado.id);
  if (id !== estado.id) return;
  const doc = await api(`/${id}`);
  if (JSON.stringify(doc) === JSON.stringify(estado.doc)) return; // es nuestro propio guardado
  mostrarDocumento(doc);
  cargarHistorial();
  avisar('El personaje cambió desde fuera (IA o archivo)');
});

cargarLista();
