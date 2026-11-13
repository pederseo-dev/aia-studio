// Inspector generado desde el esquema: cada propiedad del tipo seleccionado (o del documento, si no hay selección)
// tiene su campo según su tipo. Un tipo nuevo en schema/ aparece aquí sin tocar este archivo.
// Con varios objetos seleccionados muestra las propiedades que tienen todos; lo que se cambia se aplica a todos, y los
// campos donde los valores difieren se marcan como mixtos (muestran el valor del objeto principal).

import { findObject, skeletonOf } from '../core/document.js';
import { read, readMeta, validateValue } from '../core/schema.js';
import { artboardOps } from '../core/artboard.js';
import { boneValues } from '../core/skeleton.js';
import { valueOrigin, effectiveValue } from '../core/styles.js';
import { openedClip, editingName, poseOps, activePose } from './editing.js';
import { execute, schema, state, setState, preview, select, subscribe } from './state.js';
import { replaceImage, imagesOnly, naturalSize, assetUrl } from './images.js';

const GROUP_ORDER = ['General', 'Imagen', 'Forma', 'Transformación', 'Apariencia', 'Degradado', 'Lienzo', 'Tiempo'];
// Nombres de grupo del esquema, como se muestran (el esquema sigue en español).
const GROUP_NAMES = { General: 'General', Imagen: 'Image', Forma: 'Shape', Transformación: 'Transform', Apariencia: 'Appearance', Degradado: 'Gradient', Lienzo: 'Canvas', Tiempo: 'Time', Driver: 'Driver', Esqueleto: 'Skeleton', Hueso: 'Bone', Límites: 'Limits', Parámetro: 'Parameter', Pose: 'Pose', Switch: 'Switch', Tramo: 'Range', Otros: 'Other' };
const PAIRS = { x: 'y', scaleX: 'scaleY', width: 'height', originX: 'originY', x1: 'y1', x2: 'y2', cx: 'cy' };
// En una fila de par, el nombre de la fila va en la columna de etiquetas y cada mitad lleva solo su letra (como Rive).
const PAIR_NAMES = { x: 'Position', scaleX: 'Scale', width: 'Size', originX: 'Pivot', x1: 'Start', x2: 'End', cx: 'Center' };
const PAIR_LETTERS = { x: 'X', y: 'Y', scaleX: 'X', scaleY: 'Y', width: 'W', height: 'H', originX: 'X', originY: 'Y', x1: 'X', y1: 'Y', x2: 'X', y2: 'Y', cx: 'X', cy: 'Y' };
const LABELS = { x: 'X', y: 'Y', scaleX: 'SX', scaleY: 'SY', width: 'W', height: 'H', originX: 'PX', originY: 'PY', x1: 'X1', y1: 'Y1', x2: 'X2', y2: 'Y2', cx: 'CX', cy: 'CY' };

export function mountInspector(root) {
  subscribe((c) => {
    // El tiempo cambia los valores de un clip; mientras se reproduce no se rehace (sería en cada cuadro).
    if ('doc' in c || 'selection' in c || 'editing' in c || 'pose' in c || ('time' in c && !state.playing) || ('playing' in c && !state.playing)) draw();
  });

  function draw() {
    const doc = state.doc;
    if (!doc) return root.replaceChildren();
    const inFocus = root.contains(document.activeElement) ? (/** @type {HTMLElement} */ (document.activeElement.closest('[data-prop]')))?.dataset.prop : null;

    const obj = state.selection ? findObject(doc, state.selection) : null;
    const tipo = obj ? schema.types.get(obj.type) : schema.meta;
    const target = obj ? obj.id : 'meta';
    const data = obj ?? doc.meta;
    const others = obj ? state.selected.map((id) => findObject(doc, id)).filter((o) => o && o.id !== obj.id) : [];
    // Con varios: solo lo que tienen todos (y que se puede editar en bloque).
    const common = ([prop, p]) => !others.length || (!['vertices', 'stops'].includes(p.type) && others.every((o) => schema.types.get(o.type).properties[prop]?.type === p.type));
    // Lo de Live es de los clips de Puppet (una escena no se dispara), y la espera del auto, solo con auto repeat.
    const fromLive = ([prop, p]) =>
      obj?.type !== 'animation' || others.length || p.group !== 'Live' || (read(schema, obj, 'usage') === 'puppet' && (!prop.startsWith('repeat_') || read(schema, obj, 'auto') === 'repeat'));
    const properties = Object.entries(tipo.properties).filter(common).filter(fromLive);
    context = { others };

    root.replaceChildren(others.length ? severalTitle(obj, others) : obj ? title(obj, tipo) : Object.assign(document.createElement('h2'), { textContent: 'Artboard' }));
    if (others.length && !properties.length) root.append(Object.assign(document.createElement('p'), { className: 'ayuda', textContent: 'No properties in common.' }));
    const pose = activePose();
    if (pose && obj && !others.length && !tipo.resource) poseSection(obj, tipo, pose);

    const groups = Map.groupBy(properties, ([, p]) => p.group ?? 'Otros');
    const names = [...groups.keys()].sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));
    for (const name of names) {
      root.append(Object.assign(document.createElement('h3'), { textContent: GROUP_NAMES[name] ?? name }));
      const props = groups.get(name);
      const inPair = new Set();
      for (const [prop, p] of props) {
        if (inPair.has(prop)) continue;
        // Pares (x/y, ancho/alto, escala) en una sola fila, como en Rive.
        const pair = PAIRS[prop] && props.find(([q]) => q === PAIRS[prop]);
        if (pair) {
          inPair.add(pair[0]);
          const row = document.createElement('div');
          row.className = 'par';
          const name = Object.assign(document.createElement('span'), { className: 'nombre-par', textContent: PAIR_NAMES[prop] ?? prop });
          row.append(name, field(target, data, prop, p, PAIR_LETTERS[prop]), field(target, data, pair[0], pair[1], PAIR_LETTERS[pair[0]]));
          root.append(row);
        } else {
          root.append(field(target, data, prop, p));
        }
      }
    }

    if (inFocus) root.querySelector(`[data-prop="${inFocus}"] input, [data-prop="${inFocus}"] select`)?.focus();
  }

  /**
   * Con una pose activa, lo animable del objeto en esa pose: lo que la pose fija se ve normal y lo demás (que sigue
   * como en el montaje), atenuado. Cambiar un campo lo agrega a la pose; ↺ lo quita.
   */
  function poseSection(obj, tipo, pose) {
    const animatable = Object.entries(tipo.properties).filter(([, p]) => p.animatable);
    if (!animatable.length) return;
    const clip = openedClip();
    const title = clip ? `Clip “${clip.id}” at ${+state.time.toFixed(3)} s` : `Pose “${pose.id}”`;
    root.append(Object.assign(document.createElement('h3'), { className: 'en-pose', textContent: title }));
    // En un clip, «fijado» es lo que tiene pista; el valor es el que se ve en el tiempo del playhead.
    const fixed = clip ? Object.fromEntries(Object.keys(clip.tracks?.[obj.id] ?? {}).map((k) => [k, pose.values?.[obj.id]?.[k]])) : (pose.values?.[obj.id] ?? {});
    const fromBone = obj.type === 'bone' ? boneValues(schema, obj, pose) : null;
    const value = (k) => (fromBone ? fromBone[k] : (pose.values?.[obj.id]?.[k] ?? effectiveValue(schema, state.doc, obj, k)));
    const inPair = new Set();
    for (const [k, p] of animatable) {
      if (inPair.has(k)) continue;
      const pair = PAIRS[k] && animatable.find(([q]) => q === PAIRS[k]);
      if (pair) {
        inPair.add(pair[0]);
        const row = document.createElement('div');
        row.className = 'par';
        row.append(poseField(obj, pose, k, p, value(k), k in fixed), poseField(obj, pose, pair[0], pair[1], value(pair[0]), pair[0] in fixed));
        root.append(row);
      } else {
        root.append(poseField(obj, pose, k, p, value(k), k in fixed));
      }
    }
    const help = clip ? 'Changing a value keys it at the playhead (autokey); ↺ removes that keyframe. Below is the setup (the rest pose).' : 'Below is the setup (the rest pose).';
    root.append(Object.assign(document.createElement('p'), { className: 'ayuda', textContent: help }));
  }

  function poseField(obj, pose, k, p, value, fixed) {
    const div = document.createElement('div');
    div.className = `campo${fixed ? '' : ' por-defecto'}`;
    div.dataset.prop = `pose.${k}`;
    const label = Object.assign(document.createElement('label'), { textContent: LABELS[k] ?? k });
    const inClip = !!openedClip();
    label.title = inClip ? `${k} in the clip${fixed ? '' : ' (no track yet: uses the setup value)'}` : `${k} in the pose${fixed ? '' : ' (not set by the pose: uses the setup value)'}`;
    const change = (v) => poseOps(state.doc, pose.id, obj.id, { [k]: v });
    const commit = (v) => {
      if (Object.is(v, value) && fixed) return preview(null);
      execute(change(v), `${editingName(pose.id)}: ${obj.id}.${k}`, { group: `pose:${pose.id}.${obj.id}.${k}` });
    };
    const control = CONTROLS[p.type]({ p, value, preview: (v) => preview(change(v)), commit, div, label, target: obj.id });
    const reset = Object.assign(document.createElement('button'), { type: 'button', className: 'restablecer', textContent: '↺', title: inClip ? 'Remove the keyframe at the playhead' : 'Remove from pose (back to setup)' });
    reset.addEventListener('click', () => execute(poseOps(state.doc, pose.id, obj.id, { [k]: undefined }), `${editingName(pose.id)}: ${obj.id}.${k} ${inClip ? 'key removed' : 'from setup'}`));
    div.append(label, control, reset);
    return div;
  }

  // Lo que el campo necesita saber de una selección múltiple (se arma en cada dibujo).
  let context = { others: [] };

  function severalTitle(obj, others) {
    const div = document.createElement('div');
    div.className = 'titulo-varios';
    const names = [obj, ...others].map((o) => o.id);
    div.innerHTML = `<h2>${names.length} objects</h2><p class="ayuda"></p>`;
    div.querySelector('p').textContent = names.join(', ');
    div.title = `Primary: ${obj.id}. Changes apply to all.`;
    return div;
  }

  function title(obj, tipo) {
    const div = document.createElement('div');
    div.className = 'campo';
    div.dataset.prop = '__id';
    div.innerHTML = `<label title="${tipo.help.replace(/"/g, '&quot;')}">${tipo.name}</label><input type="text" aria-label="Id"><span></span>`;
    const input = div.querySelector('input');
    input.value = obj.id;
    input.addEventListener('change', async () => {
      const created = input.value.trim();
      if (!created || created === obj.id) return (input.value = obj.id);
      const previous = obj.id;
      await execute([{ op: 'rename', target: previous, id: created }], `rename ${previous} → ${created}`);
      if (findObject(state.doc, created)) select(created);
    });
    return div;
  }

  function field(target, data, prop, p, labelText) {
    const isObject = target !== 'meta';
    const origen = isObject ? valueOrigin(state.doc, data, prop) : data[prop] !== undefined ? 'propio' : 'defecto';
    const value = isObject ? effectiveValue(schema, state.doc, data, prop) : (data[prop] ?? p.default);
    const { others } = context;
    const targets = [target, ...others.map((o) => o.id)];
    const mixed = others.some((o) => JSON.stringify(effectiveValue(schema, state.doc, o, prop)) !== JSON.stringify(value));
    const div = document.createElement('div');
    div.className = `campo${origen === 'defecto' ? ' por-defecto' : origen === 'estilo' ? ' por-defecto por-estilo' : ''}${mixed ? ' mixto' : ''}`;
    div.dataset.prop = prop;
    const label = document.createElement('label');
    label.textContent = labelText ?? prop;
    const whence = origen === 'estilo' ? `\nFrom style "${data.style}".` : '';
    label.title = `${prop}: ${p.help ?? ''}${p.default !== undefined ? `\nDefault: ${JSON.stringify(p.default)}` : ''}${whence}${mixed ? `\nMixed values: showing ${target}.` : ''}`;
    const reset = Object.assign(document.createElement('button'), { type: 'button', className: 'restablecer', textContent: '↺', title: 'Reset to default' });
    const name = others.length ? `${targets.length} objects` : target;

    // El tamaño del lienzo cambia con el dibujo centrado, como la herramienta Artboard y Project Settings.
    const size = target === 'meta' && (prop === 'width' || prop === 'height');
    const change = (v) =>
      size
        ? artboardOps(state.doc, schema, prop === 'width' ? v : readMeta(schema, state.doc, 'width'), prop === 'height' ? v : readMeta(schema, state.doc, 'height'))
        : targets.map((t) => ({ op: 'set', target: t, props: { [prop]: v } }));
    reset.addEventListener('click', () => execute(size ? change(p.default) : targets.map((t) => ({ op: 'unset', target: t, props: [prop] })), `${name}.${prop} reset`));
    // Varios cambios seguidos de la misma propiedad (flechitas del campo, escribir y corregir) son un solo paso.
    const commit = (v) => {
      if (Object.is(v, value) && !mixed) return preview(null);
      execute(change(v), `${name}.${prop}`, { group: `${targets.join()}.${prop}` });
    };
    const control = CONTROLS[p.type]({ p, value, preview: (v) => preview(change(v)), commit, div, label, target });
    div.append(label, control, reset);
    return div;
  }
}

const CONTROLS = {
  number({ p, value, preview: see, commit, div, label }) {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = p.step ?? 1;
    if (p.min != null) input.min = p.min;
    if (p.max != null) input.max = p.max;
    input.value = value;
    const readInput = () => {
      const v = input.value === '' ? NaN : Number(input.value);
      const error = validateValue(p, v);
      div.classList.toggle('invalido', !!error);
      input.title = error ?? '';
      return error ? null : v;
    };
    input.addEventListener('input', () => {
      const v = readInput();
      if (v != null) see(v);
    });
    input.addEventListener('change', () => {
      const v = readInput();
      if (v == null) {
        input.value = value;
        div.classList.remove('invalido');
        return preview(null);
      }
      commit(v);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = value;
        preview(null);
        input.blur();
      }
    });

    // Arrastrar sobre el nombre cambia el valor: Shift = fino, Alt = grueso.
    label.classList.add('arrastrable');
    label.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      label.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const step = p.step ?? 1;
      let current = value;
      const move = (ev) => {
        const factor = ev.shiftKey ? 0.1 : ev.altKey ? 10 : 1;
        let v = value + Math.round((ev.clientX - x0) * factor) * step;
        if (p.min != null) v = Math.max(p.min, v);
        if (p.max != null) v = Math.min(p.max, v);
        if (p.integer) v = Math.round(v);
        current = +v.toFixed(4);
        input.value = current;
        see(current);
      };
      const release = () => {
        label.removeEventListener('pointermove', move);
        label.removeEventListener('pointerup', release);
        commit(current);
      };
      label.addEventListener('pointermove', move);
      label.addEventListener('pointerup', release);
    });
    return input;
  },

  color({ p, value, preview: see, commit }) {
    const box = document.createElement('div');
    box.className = 'color';
    const selector = Object.assign(document.createElement('input'), { type: 'color' });
    const text = Object.assign(document.createElement('input'), { type: 'text', spellcheck: false });
    const toSixDigits = (c) => (c.length === 4 ? '#' + [...c.slice(1)].map((d) => d + d).join('') : c.slice(0, 7));
    selector.value = value ? toSixDigits(value) : '#000000';
    selector.disabled = value == null;
    text.value = value ?? '';
    text.placeholder = 'none';
    selector.addEventListener('input', () => see(selector.value));
    selector.addEventListener('change', () => commit(selector.value));
    text.addEventListener('change', () => {
      const v = text.value.trim() === '' && p.nullable ? null : text.value.trim();
      if (validateValue(p, v)) {
        text.value = value ?? '';
        return;
      }
      commit(v);
    });
    box.append(selector, text);
    if (p.nullable) {
      const none = document.createElement('label');
      const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value == null, title: 'No color' });
      check.addEventListener('change', () => commit(check.checked ? null : (p.default ?? '#888888')));
      none.append(check, ' none');
      box.append(none);
    }
    return box;
  },

  boolean({ value, commit }) {
    const check = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value });
    check.addEventListener('change', () => commit(check.checked));
    const wrapper = document.createElement('div');
    wrapper.append(check);
    return wrapper;
  },

  string({ p, value, commit }) {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: value ?? '', placeholder: p.nullable ? 'none' : '' });
    // Vacío en una propiedad que admite null = null (por ejemplo, la opción inicial de un param enum).
    input.addEventListener('change', () => commit(input.value === '' && p.nullable ? null : input.value));
    return input;
  },

  // Lista de textos (las opciones de un param enum): se escribe separada por comas.
  strings({ value, commit }) {
    const input = Object.assign(document.createElement('input'), { type: 'text', value: value.join(', '), placeholder: 'rest, a, e, o, m' });
    input.title = 'Comma-separated';
    input.addEventListener('change', () => commit(input.value.split(',').map((t) => t.trim()).filter(Boolean)));
    return input;
  },

  enum({ p, value, commit }) {
    const select = document.createElement('select');
    for (const v of p.values) select.append(new Option(v, v, false, v === value));
    select.addEventListener('change', () => commit(select.value));
    return select;
  },

  // Los vértices se editan en el lienzo; aquí solo se resume y se entra a editarlos.
  vertices({ value, target }) {
    const box = document.createElement('div');
    box.className = 'color vertices';
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: state.editing === target ? 'Done' : 'Edit points' });
    button.title = 'Or double-click the path, or press Enter';
    button.addEventListener('click', () => setState(state.editing === target ? { editing: null, vertex: null } : { editing: target, selection: target, selected: [target], vertex: null, tool: 'seleccionar' }));
    const summary = document.createElement('span');
    const curved = value.filter((v) => (v.mode ?? 'straight') !== 'straight').length;
    summary.textContent = `${value.length} points${curved ? `, ${curved} curved` : ''}`;
    box.append(summary, button);
    return box;
  },

  // Una pose se edita en el lienzo: aquí se resume y se activa.
  pose({ value, target }) {
    const box = document.createElement('div');
    box.className = 'resumen-pose';
    const list = document.createElement('ul');
    for (const [bone, fields] of Object.entries(value)) {
      const li = document.createElement('li');
      li.textContent = `${bone}: ${Object.entries(fields).map(([k, v]) => `${k} ${v}`).join(', ')}`;
      list.append(li);
    }
    if (!list.children.length) list.innerHTML = '<li>Doesn’t move any bones yet.</li>';
    const active = state.pose === target;
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: active ? 'Back to setup' : 'View and edit on canvas' });
    button.addEventListener('click', () => setState({ pose: active ? null : target }));
    box.append(list, button);
    return box;
  },

  // Las pistas de un clip se editan en la timeline: aquí solo se resumen.
  tracks({ value }) {
    const list = document.createElement('ul');
    list.className = 'resumen-pose';
    for (const [id, fields] of Object.entries(value ?? {})) {
      const li = document.createElement('li');
      li.textContent = `${id}: ${Object.entries(fields).map(([k, keys]) => `${k} (${keys.length} keys)`).join(', ')}`;
      list.append(li);
    }
    if (!list.children.length) list.innerHTML = '<li>No keyframes yet.</li>';
    return list;
  },

  // Paradas de un degradado: color, offset y quitar; más un botón para agregar.
  stops({ value, commit }) {
    const list = document.createElement('div');
    list.className = 'lista-paradas';
    const change = (i, changes) => commit(value.map((s, j) => (j === i ? { ...s, ...changes } : s)).sort((a, b) => a.offset - b.offset));
    value.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'parada';
      const color = Object.assign(document.createElement('input'), { type: 'color', value: s.color.length === 4 ? '#' + [...s.color.slice(1)].map((d) => d + d).join('') : s.color.slice(0, 7) });
      color.addEventListener('change', () => change(i, { color: color.value }));
      const offset = Object.assign(document.createElement('input'), { type: 'number', min: 0, max: 1, step: 0.05, value: s.offset, title: 'Position, 0 to 1' });
      offset.addEventListener('change', () => change(i, { offset: Math.min(1, Math.max(0, Number(offset.value) || 0)) }));
      const opacity = Object.assign(document.createElement('input'), { type: 'number', min: 0, max: 1, step: 0.1, value: s.opacity ?? 1, title: 'Opacity' });
      opacity.addEventListener('change', () => change(i, { opacity: Math.min(1, Math.max(0, Number(opacity.value))) }));
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'restablecer', textContent: '×', title: 'Remove stop' });
      remove.style.visibility = value.length > 1 ? 'visible' : 'hidden';
      remove.addEventListener('click', () => commit(value.filter((_, j) => j !== i)));
      row.append(color, offset, opacity, remove);
      list.append(row);
    });
    const add = Object.assign(document.createElement('button'), { type: 'button', textContent: '+ Stop' });
    add.addEventListener('click', () => commit([...value, { offset: 1, color: value.at(-1)?.color ?? '#ffffff' }].sort((a, b) => a.offset - b.offset)));
    list.append(add);
    return list;
  },

  // El archivo de una capa image: miniatura, nombre, cambiarlo por otro y volver a su tamaño natural.
  asset({ value, target }) {
    const box = document.createElement('div');
    box.className = 'campo-asset';
    const thumbnail = Object.assign(document.createElement('img'), { src: assetUrl(value), alt: '' });
    thumbnail.addEventListener('error', () => box.classList.add('falta'), { once: true });
    const name = Object.assign(document.createElement('span'), { className: 'nombre-asset', textContent: value, title: `${value} (missing from the document's assets if crossed out)` });
    const file = Object.assign(document.createElement('input'), { type: 'file', hidden: true, accept: 'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg' });
    file.addEventListener('change', () => {
      const [chosen] = imagesOnly(file.files);
      if (chosen) replaceImage(target, chosen);
    });
    const change = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Replace…', title: 'Use another image file (keeps the width)' });
    change.addEventListener('click', () => file.click());
    const natural = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Original size', title: 'Set width and height to the file’s own size' });
    natural.addEventListener('click', () => naturalSize(target));
    const buttons = document.createElement('div');
    buttons.className = 'botones-asset';
    buttons.append(change, natural);
    box.append(thumbnail, name, buttons, file);
    return box;
  },

  ref({ p, value, commit, target }) {
    const select = document.createElement('select');
    if (p.nullable) select.append(new Option('(none)', ''));
    for (const o of state.doc.objects) {
      // refScope "children": solo los hijos (el hijo activo de un switch); "skeleton": los huesos de su skeleton.
      const inReach = p.refScope === 'children' ? o.parent === target : p.refScope === 'skeleton' ? skeletonOf(state.doc, o.id) === skeletonOf(state.doc, target) : o.id !== target;
      if (inReach && (!p.refTypes || p.refTypes.includes(o.type))) select.append(new Option(o.id, o.id, false, o.id === value));
    }
    select.addEventListener('change', () => commit(select.value || null));
    return select;
  },
};
