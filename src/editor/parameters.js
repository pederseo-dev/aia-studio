// Panel de parámetros (a la derecha, solo en Puppet: los params son del muñeco): un control por param (deslizador,
// casilla o lista) y las poses que mezcla con su peso. Mover un control
// pasa a la vista Parámetros: el lienzo muestra la mezcla de poses que dan los drivers. Los valores de los controles
// son del editor (no se guardan); lo que se guarda son los params, los drivers y las poses.

import { isScene } from '../core/animation.js';
import { findObject } from '../core/document.js';
import { read } from '../core/schema.js';
import { driverWeight, paramValues } from '../core/blend.js';
import { notify, execute, schema, state, setState, freeId, select, subscribe } from './state.js';
import { openedClip, poseOps, activePose } from './editing.js';
import { putParamLive } from './live.js';

export function mountParameters(root, newButton, deleteButton) {
  // 🗑 borra el param seleccionado (en Parameters o en Assets) con sus drivers: sin param, un driver no mueve nada.
  const chosen = () => (state.doc && findObject(state.doc, state.selection)?.type === 'param' ? state.selection : null);
  deleteButton.addEventListener('click', () => {
    const id = chosen();
    if (!id) return;
    const drivers = state.doc.objects.filter((o) => o.type === 'driver' && o.param === id).map((o) => ({ op: 'delete', target: o.id }));
    execute([...drivers, { op: 'delete', target: id }], `delete param ${id}`);
    select(null);
  });
  subscribe((c) => {
    if ('doc' in c || 'selection' in c || 'live' in c) deleteButton.disabled = !chosen() || state.live;
  });
  // Un deslizador agarrado: hasta soltarlo, el panel no se rehace (solo pesos y valores), aunque cambie el documento
  // (el autokey de un clip abierto) o la vista.
  let dragging = false;
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    draw();
  });
  subscribe((c) => {
    if (dragging && ('doc' in c || 'params' in c || 'pose' in c || 'time' in c)) return updateWeights();
    if ('doc' in c || 'selection' in c || 'id' in c || 'pose' in c || 'mode' in c || 'live' in c) return draw();
    if ('time' in c && openedClip()) return root.contains(document.activeElement) ? updateWeights() : draw();
    // Mientras se arrastra un control, no se rehace el panel (se cortaría el arrastre): solo se actualizan los pesos.
    if ('params' in c) root.contains(document.activeElement) ? updateWeights() : draw();
  });

  function updateWeights() {
    const doc = state.doc;
    const values = seenValues(doc);
    for (const f of root.querySelectorAll('.param[data-param]')) weights(doc, f, values[f.dataset.param]);
  }

  newButton.addEventListener('click', () => {
    if (!state.doc) return;
    const base = prompt('Parameter name (e.g. happiness, head_turn, mouth):', '')?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base) return;
    const id = /^[a-z]/.test(base) ? base : `param_${base}`;
    if (findObject(state.doc, id)) return notify(`"${id}" already exists`, true);
    execute([{ op: 'create', type: 'param', id }], `create param ${id}`);
    select(id);
  });

  function draw() {
    const doc = state.doc;
    newButton.disabled = !doc || state.live;
    // Solo Puppet tiene params (en una escena no hay valores de params que mostrar).
    if (!doc || state.mode !== 'puppet') return root.replaceChildren();
    const params = doc.objects.filter((o) => o.type === 'param');
    if (!params.length) {
      root.innerHTML = '<p class="ayuda">No parameters. A parameter (happiness, head turn, mouth…) drives one or more poses through drivers: create one with + above and connect it to a pose with its own +.</p>';
      return;
    }
    const values = seenValues(doc);
    root.replaceChildren(...params.map((p) => row(doc, p, values[p.id])));
  }

  /**
   * Cambiar un control: pasa a la vista Parámetros con el valor nuevo. Con un clip abierto, en cambio, el valor queda
   * como keyframe del param en el tiempo del playhead (autokey).
   */
  const move = (id, v) => {
    // Con Live encendido, el control es el valor de la app: va al runtime y no se guarda.
    if (state.live) return putParamLive(id, v);
    const clip = openedClip();
    // Solo se nombra `pose` si hay que cerrar una: si no, el cambio es solo de params y el panel no se rehace.
    if (!clip) return setState({ ...(state.pose ? { pose: null } : {}), params: { ...(state.params ?? {}), [id]: v } });
    execute(poseOps(state.doc, clip.id, id, { value: v }), `${clip.id}: ${id} at ${+state.time.toFixed(3)} s`, { group: `clip:${clip.id}.${id}.${state.time}` });
  };
  /** Valores que muestran los controles: los del clip abierto en el playhead o los de la vista Parámetros. */
  const seenValues = (doc) => (openedClip(doc) && !isScene(schema, openedClip(doc)) ? activePose(doc).params : paramValues(doc, schema, state.params ?? {}));

  /**
   * Una fila por param, en tres líneas: el nombre y el valor; el control a todo el ancho (deslizador o lista); y las
   * poses que mezcla con su peso ahora, con «＋» para conectar otra.
   */
  function row(doc, param, value) {
    const kind = read(schema, param, 'kind');
    const div = document.createElement('div');
    div.className = `param${param.id === state.selection ? ' seleccionado' : ''}`;
    div.dataset.param = param.id;
    const head = document.createElement('div');
    head.className = 'cabeza-param';
    const name = Object.assign(document.createElement('button'), { type: 'button', className: 'nombre', textContent: param.id });
    const description = read(schema, param, 'description');
    name.title = `${description ? `${description}\n` : ''}Select the parameter (kind, range, options and description in the inspector)`;
    name.addEventListener('click', () => select(param.id));
    head.append(name);
    if (kind === 'boolean') {
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value >= 0.5, title: 'On / off' });
      check.addEventListener('change', () => move(param.id, check.checked ? 1 : 0));
      head.append(check);
    } else if (kind === 'number') head.append(Object.assign(document.createElement('span'), { className: 'valor', textContent: +value.toFixed(2) }));
    div.append(head);
    if (kind !== 'boolean') div.append(control(param, value, kind));

    // Las poses que mezcla (por sus drivers) y con qué peso ahora; «＋» conecta otra.
    const drivers = doc.objects.filter((o) => o.type === 'driver' && o.param === param.id);
    const list = document.createElement('div');
    list.className = 'drivers';
    for (const d of drivers) {
      const chip = Object.assign(document.createElement('button'), { type: 'button', className: `driver${d.id === state.selection ? ' seleccionado' : ''}` });
      chip.dataset.driver = d.id;
      chip.title = `Driver ${d.id}: ${span(d)}. Click to edit it in the inspector.`;
      chip.addEventListener('click', () => select(d.id));
      list.append(chip);
    }
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const connect = document.createElement('select');
    connect.className = 'conectar';
    connect.title = poses.length ? 'Blend one more pose with this parameter (creates a driver)' : 'There are no poses yet: create one under Poses';
    connect.append(new Option('＋', ''), ...poses.map((p) => new Option(p.id, p.id)));
    connect.disabled = !poses.length || state.live;
    connect.addEventListener('change', () => {
      if (!connect.value) return;
      const id = freeId(`${param.id}_to_${connect.value}`.slice(0, 40));
      // Con un enum, la pose va con la opción que está elegida ahora.
      const props = { param: param.id, pose: connect.value, ...(kind === 'enum' ? { equals: value } : {}) };
      execute([{ op: 'create', type: 'driver', id, props }], `connect ${param.id} → ${connect.value}`);
      select(id);
    });
    if (!drivers.length) list.append(Object.assign(document.createElement('span'), { className: 'sin-poses', textContent: 'blends no pose yet' }));
    list.append(connect);
    div.append(list);
    weights(doc, div, value);
    return div;
  }

  /** El texto y la barra de peso de cada pose de una fila, y el número del valor. */
  function weights(doc, row, value) {
    for (const chip of row.querySelectorAll('[data-driver]')) {
      const d = findObject(doc, chip.dataset.driver);
      const weight = d?.pose && findObject(doc, d.pose) ? driverWeight(doc, schema, d, value) : 0;
      chip.textContent = `${d?.pose ?? '(no pose)'}${d?.equals != null ? ` = ${d.equals}` : ''} ${Math.round(weight * 100)}%`;
      chip.style.setProperty('--peso', `${Math.round(weight * 100)}%`);
      chip.classList.toggle('activo', weight > 0);
    }
    const number = row.querySelector('.valor');
    if (number && typeof value === 'number') number.textContent = +value.toFixed(2);
  }

  function control(param, value, kind) {
    if (kind === 'enum') {
      const select = document.createElement('select');
      select.className = 'opciones-param';
      for (const o of read(schema, param, 'options')) select.append(new Option(o, o, false, o === value));
      if (!select.options.length) select.append(new Option('(no options)', ''));
      select.addEventListener('change', () => move(param.id, select.value));
      return select;
    }
    const [min, max] = [read(schema, param, 'min'), read(schema, param, 'max')];
    const range = Object.assign(document.createElement('input'), { type: 'range', className: 'deslizador', min, max, step: (max - min) / 100 || 0.01, value: value });
    range.title = `${min} … ${max} (double-click: back to ${read(schema, param, 'default')})`;
    // Mientras se arrastra, el panel no se rehace (se cortaría el arrastre): solo se actualizan los pesos.
    range.addEventListener('pointerdown', () => (dragging = true));
    range.addEventListener('input', () => move(param.id, Number(range.value)));
    // Doble clic: vuelve al valor inicial.
    range.addEventListener('dblclick', () => move(param.id, read(schema, param, 'default')));
    return range;
  }

  function span(d) {
    if (d.equals != null) return `full pose when "${d.equals}"`;
    const v = (k) => read(schema, d, k);
    return `${v('inMin')}…${v('inMax')} → weight ${v('outMin')}…${v('outMax')}`;
  }
}
