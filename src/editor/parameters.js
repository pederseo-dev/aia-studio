// Parameters panel (on the right, only in Puppet: params belong to the puppet): one control per param (slider,
// checkbox or list) and the poses it blends with their weight. Moving a control
// switches to the Parameters view: the canvas shows the blend of poses the drivers give. The controls' values
// belong to the editor (they are not saved); what is saved are the params, the drivers and the poses.

import { isScene } from '../core/animation.js';
import { findObject } from '../core/document.js';
import { read } from '../core/schema.js';
import { driverWeight, paramValues } from '../core/blend.js';
import { notify, execute, schema, state, setState, freeId, select, subscribe } from './state.js';
import { openedClip, poseOps, activePose } from './editing.js';
import { putParamLive } from './live.js';

export function mountParameters(root, newButton, deleteButton) {
  // 🗑 deletes the selected param (in Parameters or Assets) with its drivers: without a param, a driver moves nothing.
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
  // A grabbed slider: until it is released, the panel is not rebuilt (only weights and values), even if the document
  // changes (the autokey of an open clip) or the view.
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
    // While a control is dragged, the panel is not rebuilt (the drag would be cut): only the weights are updated.
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
    // Only Puppet has params (in a scene there are no param values to show).
    if (!doc || state.mode !== 'puppet') return root.replaceChildren();
    const params = doc.objects.filter((o) => o.type === 'param');
    if (!params.length) {
      root.innerHTML = '<p class="help">No parameters. A parameter (happiness, head turn, mouth…) drives one or more poses through drivers: create one with + above and connect it to a pose with its own +.</p>';
      return;
    }
    const values = seenValues(doc);
    root.replaceChildren(...params.map((p) => row(doc, p, values[p.id])));
  }

  /**
   * Changing a control: switches to the Parameters view with the new value. With a clip open, instead, the value
   * becomes a keyframe of the param at the playhead time (autokey).
   */
  const move = (id, v) => {
    // With Live on, the control is the app's value: it goes to the runtime and is not saved.
    if (state.live) return putParamLive(id, v);
    const clip = openedClip();
    // `pose` is only named if one must be closed: otherwise the change is only to params and the panel is not rebuilt.
    if (!clip) return setState({ ...(state.pose ? { pose: null } : {}), params: { ...(state.params ?? {}), [id]: v } });
    execute(poseOps(state.doc, clip.id, id, { value: v }), `${clip.id}: ${id} at ${+state.time.toFixed(3)} s`, { group: `clip:${clip.id}.${id}.${state.time}` });
  };
  /** Values the controls show: those of the open clip at the playhead or those of the Parameters view. */
  const seenValues = (doc) => (openedClip(doc) && !isScene(schema, openedClip(doc)) ? activePose(doc).params : paramValues(doc, schema, state.params ?? {}));

  /**
   * One row per param, in three lines: the name and the value; the control at full width (slider or list); and the
   * poses it blends with their weight now, with «＋» to connect another.
   */
  function row(doc, param, value) {
    const kind = read(schema, param, 'kind');
    const div = document.createElement('div');
    div.className = `param${param.id === state.selection ? ' selected' : ''}`;
    div.dataset.param = param.id;
    const head = document.createElement('div');
    head.className = 'head-param';
    const name = Object.assign(document.createElement('button'), { type: 'button', className: 'name', textContent: param.id });
    const description = read(schema, param, 'description');
    name.title = `${description ? `${description}\n` : ''}Select the parameter (kind, range, options and description in the inspector)`;
    name.addEventListener('click', () => select(param.id));
    head.append(name);
    if (kind === 'boolean') {
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value >= 0.5, title: 'On / off' });
      check.addEventListener('change', () => move(param.id, check.checked ? 1 : 0));
      head.append(check);
    } else if (kind === 'number') head.append(Object.assign(document.createElement('span'), { className: 'value', textContent: +value.toFixed(2) }));
    div.append(head);
    if (kind !== 'boolean') div.append(control(param, value, kind));

    // The poses it blends (through its drivers) and with what weight now; «＋» connects another.
    const drivers = doc.objects.filter((o) => o.type === 'driver' && o.param === param.id);
    const list = document.createElement('div');
    list.className = 'drivers';
    for (const d of drivers) {
      const chip = Object.assign(document.createElement('button'), { type: 'button', className: `driver${d.id === state.selection ? ' selected' : ''}` });
      chip.dataset.driver = d.id;
      chip.title = `Driver ${d.id}: ${span(d)}. Click to edit it in the inspector.`;
      chip.addEventListener('click', () => select(d.id));
      list.append(chip);
    }
    const poses = doc.objects.filter((o) => o.type === 'pose');
    const connect = document.createElement('select');
    connect.className = 'connect';
    connect.title = poses.length ? 'Blend one more pose with this parameter (creates a driver)' : 'There are no poses yet: create one under Poses';
    connect.append(new Option('＋', ''), ...poses.map((p) => new Option(p.id, p.id)));
    connect.disabled = !poses.length || state.live;
    connect.addEventListener('change', () => {
      if (!connect.value) return;
      const id = freeId(`${param.id}_to_${connect.value}`.slice(0, 40));
      // With an enum, the pose goes with the option that is chosen now.
      const props = { param: param.id, pose: connect.value, ...(kind === 'enum' ? { equals: value } : {}) };
      execute([{ op: 'create', type: 'driver', id, props }], `connect ${param.id} → ${connect.value}`);
      select(id);
    });
    if (!drivers.length) list.append(Object.assign(document.createElement('span'), { className: 'no-poses', textContent: 'blends no pose yet' }));
    list.append(connect);
    div.append(list);
    weights(doc, div, value);
    return div;
  }

  /** The text and the weight bar of each pose in a row, and the value's number. */
  function weights(doc, row, value) {
    for (const chip of row.querySelectorAll('[data-driver]')) {
      const d = findObject(doc, chip.dataset.driver);
      const weight = d?.pose && findObject(doc, d.pose) ? driverWeight(doc, schema, d, value) : 0;
      chip.textContent = `${d?.pose ?? '(no pose)'}${d?.equals != null ? ` = ${d.equals}` : ''} ${Math.round(weight * 100)}%`;
      chip.style.setProperty('--weight', `${Math.round(weight * 100)}%`);
      chip.classList.toggle('active', weight > 0);
    }
    const number = row.querySelector('.value');
    if (number && typeof value === 'number') number.textContent = +value.toFixed(2);
  }

  function control(param, value, kind) {
    if (kind === 'enum') {
      const select = document.createElement('select');
      select.className = 'options-param';
      for (const o of read(schema, param, 'options')) select.append(new Option(o, o, false, o === value));
      if (!select.options.length) select.append(new Option('(no options)', ''));
      select.addEventListener('change', () => move(param.id, select.value));
      return select;
    }
    const [min, max] = [read(schema, param, 'min'), read(schema, param, 'max')];
    const range = Object.assign(document.createElement('input'), { type: 'range', className: 'slider', min, max, step: (max - min) / 100 || 0.01, value: value });
    range.title = `${min} … ${max} (double-click: back to ${read(schema, param, 'default')})`;
    // While dragging, the panel is not rebuilt (the drag would be cut): only the weights are updated.
    range.addEventListener('pointerdown', () => (dragging = true));
    range.addEventListener('input', () => move(param.id, Number(range.value)));
    // Double click: back to the initial value.
    range.addEventListener('dblclick', () => move(param.id, read(schema, param, 'default')));
    return range;
  }

  function span(d) {
    if (d.equals != null) return `full pose when "${d.equals}"`;
    const v = (k) => read(schema, d, k);
    return `${v('inMin')}…${v('inMax')} → weight ${v('outMin')}…${v('outMax')}`;
  }
}
