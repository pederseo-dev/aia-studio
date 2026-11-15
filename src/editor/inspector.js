// Inspector generated from the schema: each property of the selected type (or of the document, if nothing is selected)
// gets its field according to its type. A new type in schema/ appears here without touching this file.
// With several objects selected it shows the properties they all have; what is changed applies to all, and the
// fields where the values differ are marked as mixed (they show the main object's value).

import { findObject, skeletonOf } from '../core/document.js';
import { read, readMeta, validateValue } from '../core/schema.js';
import { artboardOps } from '../core/artboard.js';
import { boneValues } from '../core/skeleton.js';
import { valueOrigin, effectiveValue } from '../core/styles.js';
import { openedClip, editingName, poseOps, activePose } from './editing.js';
import { execute, schema, state, setState, preview, select, subscribe } from './state.js';
import { replaceImage, imagesOnly, naturalSize, assetUrl } from './images.js';
import { sameTime } from '../core/curves.js';

const GROUP_ORDER = ['General', 'Image', 'Transform', 'Shape', 'Appearance', 'Gradient', 'Canvas', 'Time'];
// As in Rive, the pivot goes with the transform (in the schema it is a property of the shape).
const GROUP_OF = { originX: 'Transform', originY: 'Transform' };
// Visibility and lock live in Layers (eye and padlock), not repeated here.
const HIDDEN = new Set(['visible', 'locked']);
// Readable name of a property: strokeWidth → «Stroke width», repeat_min → «Repeat min»; a few by hand.
const NAMES = { src: 'File', fps: 'FPS', r: 'Radius' };
const humanize = (prop) =>
  NAMES[prop] ??
  prop
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ ([A-Z])(?=[a-z])/g, (_, c) => ` ${c.toLowerCase()}`);
// Collapsed sections, remembered by name.
const FOLDED_KEY = 'aia:inspector-folded';
const folded = new Set((() => {
  try {
    return JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]');
  } catch {
    return [];
  }
})());
const PAIRS = { x: 'y', scaleX: 'scaleY', width: 'height', originX: 'originY', x1: 'y1', x2: 'y2', cx: 'cy' };
// In a pair row, the row name goes in the label column and each half only carries its letter (as in Rive).
const PAIR_NAMES = { x: 'Position', scaleX: 'Scale', width: 'Size', originX: 'Pivot', x1: 'Start', x2: 'End', cx: 'Center' };
const PAIR_LETTERS = { x: 'X', y: 'Y', scaleX: 'X', scaleY: 'Y', width: 'W', height: 'H', originX: 'X', originY: 'Y', x1: 'X', y1: 'Y', x2: 'X', y2: 'Y', cx: 'X', cy: 'Y' };
const LABELS = { x: 'X', y: 'Y', scaleX: 'SX', scaleY: 'SY', width: 'W', height: 'H', originX: 'PX', originY: 'PY', x1: 'X1', y1: 'Y1', x2: 'X2', y2: 'Y2', cx: 'CX', cy: 'CY' };

export function mountInspector(root) {
  subscribe((c) => {
    // Time changes the values of a clip; while playing it is not rebuilt (it would be on every frame).
    if ('doc' in c || 'selection' in c || 'editing' in c || 'pose' in c || ('time' in c && !state.playing) || ('playing' in c && !state.playing)) draw();
  });

  function draw() {
    const doc = state.doc;
    if (!doc) return root.replaceChildren();
    const inFocus = root.contains(document.activeElement) ? (/** @type {HTMLElement} */ (document.activeElement.closest('[data-prop]')))?.dataset.prop : null;

    const obj = state.selection ? findObject(doc, state.selection) : null;
    const kind = obj ? schema.types.get(obj.type) : schema.meta;
    const target = obj ? obj.id : 'meta';
    const data = obj ?? doc.meta;
    const others = obj ? state.selected.map((id) => findObject(doc, id)).filter((o) => o && o.id !== obj.id) : [];
    // With several: only what they all have (and that can be edited in bulk).
    const common = ([prop, p]) => !others.length || (!['vertices', 'points', 'curves', 'stops'].includes(p.type) && others.every((o) => schema.types.get(o.type).properties[prop]?.type === p.type));
    // The Live settings belong to Puppet clips (a scene is not triggered), and the auto wait, only with auto repeat.
    const fromLive = ([prop, p]) =>
      obj?.type !== 'animation' || others.length || p.group !== 'Live' || (read(schema, obj, 'usage') === 'puppet' && (!prop.startsWith('repeat_') || read(schema, obj, 'auto') === 'repeat'));
    const properties = Object.entries(kind.properties).filter(common).filter(fromLive).filter(([prop]) => !(obj && HIDDEN.has(prop)));
    // In a pose or a clip (Animate, Puppet) the same sections show the values there, as in Rive: each animatable
    // property gets its key diamond and what is changed goes to the pose or is keyed at the playhead; the rest is
    // setup only (edited in Design).
    const pose = activePose();
    context = { others, posing: pose && obj && !kind.resource ? posingInfo(obj, pose, !others.length) : null };

    root.replaceChildren(others.length ? severalTitle(obj, others) : obj ? title(obj, kind) : Object.assign(document.createElement('h2'), { textContent: 'Artboard' }));
    if (others.length && !properties.length) root.append(Object.assign(document.createElement('p'), { className: 'help', textContent: 'No properties in common.' }));
    if (context.posing) posingBanner(context.posing);

    const groups = Map.groupBy(properties, ([prop, p]) => GROUP_OF[prop] ?? p.group ?? 'Other');
    const names = [...groups.keys()].sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99));
    for (const name of names) {
      // Collapsible section title, as in Rive (▾ open, ▸ collapsed).
      const closed = folded.has(name);
      const heading = Object.assign(document.createElement('h3'), { className: `section${closed ? ' folded' : ''}`, textContent: name, title: closed ? 'Expand' : 'Collapse' });
      heading.addEventListener('click', () => {
        if (folded.has(name)) folded.delete(name);
        else folded.add(name);
        try {
          localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
        } catch {}
        draw();
      });
      root.append(heading);
      if (closed) continue;
      const props = groups.get(name);
      const inPair = new Set();
      for (const [prop, p] of props) {
        if (inPair.has(prop)) continue;
        // Fill and stroke: one row each (none / solid / gradient), as in Rive.
        if (prop === 'fillGradient' && props.some(([q]) => q === 'fill') && !context.posing) continue;
        if ((prop === 'fill' || prop === 'stroke') && p.type === 'color' && !context.posing) {
          root.append(paintRow(target, data, prop, p, prop === 'fill' ? props.find(([q]) => q === 'fillGradient') : null));
          continue;
        }
        // Pairs (x/y, width/height, scale) in a single row, as in Rive.
        const pair = PAIRS[prop] && props.find(([q]) => q === PAIRS[prop]);
        if (pair) {
          inPair.add(pair[0]);
          const row = document.createElement('div');
          row.className = 'pair';
          const name = Object.assign(document.createElement('span'), { className: 'name-pair', textContent: PAIR_NAMES[prop] ?? prop });
          row.append(name, field(target, data, prop, p, PAIR_LETTERS[prop]), field(target, data, pair[0], pair[1], PAIR_LETTERS[pair[0]]));
          root.append(row);
          if (prop === 'scaleX' && obj && obj.type !== 'bone') root.append(flipRow(target, data));
        } else {
          root.append(field(target, data, prop, p, humanize(prop)));
        }
      }
    }

    if (inFocus) root.querySelector(`[data-prop="${inFocus}"] input, [data-prop="${inFocus}"] select`)?.focus();
  }

  /**
   * What the object looks like in the pose or clip: `fixed` = what the pose sets (in a clip, what has a track) and
   * `value(k)` = the value seen (at the playhead time, in a clip).
   */
  function posingInfo(obj, pose, single) {
    const clip = openedClip();
    const fixed = clip ? Object.fromEntries(Object.keys(clip.tracks?.[obj.id] ?? {}).map((k) => [k, pose.values?.[obj.id]?.[k]])) : (pose.values?.[obj.id] ?? {});
    const fromBone = obj.type === 'bone' ? boneValues(schema, obj, pose) : null;
    const value = (k) => (fromBone ? fromBone[k] : (pose.values?.[obj.id]?.[k] ?? effectiveValue(schema, state.doc, obj, k)));
    return { obj, pose, clip, fixed, value, single };
  }

  function posingBanner({ pose, clip, single }) {
    root.append(Object.assign(document.createElement('h3'), { className: 'in-pose', textContent: clip ? `Clip “${clip.id}” at ${+state.time.toFixed(3)} s` : `Pose “${pose.id}”` }));
    const help = !single
      ? 'Select a single object to animate its values.'
      : clip
        ? 'Changing a value keys it at the playhead (autokey); ◇ keys it as it is, ◆ removes that keyframe. Dimmed fields are setup only (Design).'
        : 'Changing a value sets it in the pose; ◇ sets it as it is, ◆ takes it out (back to setup). Dimmed fields are setup only (Design).';
    root.append(Object.assign(document.createElement('p'), { className: 'help', textContent: help }));
  }

  function poseField(obj, pose, k, p, value, fixed, labelText) {
    const div = document.createElement('div');
    div.className = `field${fixed ? '' : ' default'}`;
    div.dataset.prop = k;
    const label = Object.assign(document.createElement('label'), { textContent: labelText ?? LABELS[k] ?? humanize(k) });
    const inClip = !!openedClip();
    label.title = inClip ? `${k} in the clip${fixed ? '' : ' (no track yet: uses the setup value)'}` : `${k} in the pose${fixed ? '' : ' (not set by the pose: uses the setup value)'}`;
    const change = (v) => poseOps(state.doc, pose.id, obj.id, { [k]: v });
    const commit = (v) => {
      if (Object.is(v, value) && fixed) return preview(null);
      execute(change(v), `${editingName(pose.id)}: ${obj.id}.${k}`, { group: `pose:${pose.id}.${obj.id}.${k}` });
    };
    const control = CONTROLS[p.type]({ p, value, preview: (v) => preview(change(v)), commit, div, label, target: obj.id });
    // Key diamond, as in Rive: ◆ = a keyframe at the playhead (or set by the pose), click removes it; ◇ = none here,
    // click keys the current value as it is (a hold, without having to change it).
    const keys = inClip ? (openedClip().tracks?.[obj.id]?.[k] ?? []) : [];
    const on = inClip ? keys.some((c) => sameTime(c.t, state.time)) : fixed;
    const key = Object.assign(document.createElement('button'), {
      type: 'button',
      className: `reset key-toggle${on ? ' on' : keys.length ? ' animated' : ''}`,
      textContent: on ? '◆' : '◇',
      title: inClip
        ? on ? 'Remove the keyframe at the playhead' : `Key ${k} at the playhead with its current value${keys.length ? '' : ' (adds its track to the timeline)'}`
        : on ? 'Remove from pose (back to setup)' : `Set ${k} in the pose with its current value`,
    });
    key.addEventListener('click', () =>
      on
        ? execute(poseOps(state.doc, pose.id, obj.id, { [k]: undefined }), `${editingName(pose.id)}: ${obj.id}.${k} ${inClip ? 'key removed' : 'from setup'}`)
        : execute(change(value), `${editingName(pose.id)}: key ${obj.id}.${k}`),
    );
    div.append(label, control, key);
    return div;
  }

  // What the field needs to know about a multiple selection (built on every draw).
  let context = { others: [] };

  /**
   * Flip H / V: inverts the scale (around the pivot). In the setup, of all the selected objects; in a pose or clip, of
   * the object there (it goes to the pose or is keyed at the playhead).
   */
  function flipRow(target, data) {
    const row = document.createElement('div');
    row.className = 'pair flip';
    const { posing } = context;
    const targets = [target, ...context.others.map((o) => o.id)];
    const flip = (prop) => {
      const which = `flip ${prop === 'scaleX' ? 'horizontal' : 'vertical'}`;
      if (posing) return execute(poseOps(state.doc, posing.pose.id, target, { [prop]: -posing.value(prop) }), `${editingName(posing.pose.id)}: ${which} ${target}`);
      const ops = targets.map((t) => ({ op: 'set', target: t, props: { [prop]: -effectiveValue(schema, state.doc, findObject(state.doc, t), prop) } }));
      execute(ops, `${which} ${targets.length > 1 ? `${targets.length} objects` : target}`);
    };
    const button = (text, title, prop) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, title, disabled: !!posing && !posing.single });
      b.addEventListener('click', () => flip(prop));
      return b;
    };
    row.append(
      Object.assign(document.createElement('span'), { className: 'name-pair', textContent: 'Flip' }),
      button('Horizontal', 'Mirror left ↔ right around the pivot (inverts Scale X)', 'scaleX'),
      button('Vertical', 'Mirror top ↕ bottom around the pivot (inverts Scale Y)', 'scaleY'),
    );
    return row;
  }

  /**
   * Fill or stroke in one row, as in Rive: the kind (None, Solid and, for the fill, Gradient) and next to it the color
   * or the gradient.
   */
  function paintRow(target, data, prop, p, gradientEntry) {
    const [gradientProp, gp] = gradientEntry ?? [];
    const { others } = context;
    const targets = [target, ...others.map((o) => o.id)];
    const name = others.length ? `${targets.length} objects` : target;
    const color = effectiveValue(schema, state.doc, data, prop);
    const gradient = gradientProp ? effectiveValue(schema, state.doc, data, gradientProp) : null;
    const kind = gradient ? 'gradient' : color == null ? 'none' : 'solid';
    const origin = valueOrigin(state.doc, data, prop);
    const own = origin !== 'default' || (gradientProp && valueOrigin(state.doc, data, gradientProp) !== 'default');
    const mixed = others.some((o) => effectiveValue(schema, state.doc, o, prop) !== color || (gradientProp && effectiveValue(schema, state.doc, o, gradientProp) !== gradient));
    const div = document.createElement('div');
    div.className = `field paint${own ? '' : ' default'}${origin === 'style' ? ' by-style' : ''}${mixed ? ' mixed' : ''}`;
    div.dataset.prop = prop;
    const label = Object.assign(document.createElement('label'), { textContent: humanize(prop) });
    label.title = `${prop}${gradientProp ? ` / ${gradientProp}` : ''}: ${p.help ?? ''}${origin === 'style' ? `\nFrom style "${data.style}".` : ''}${mixed ? `\nMixed values: showing ${target}.` : ''}`;
    const set = (props) => execute(targets.map((t) => ({ op: 'set', target: t, props })), `${name}.${prop}`, { group: `${targets.join()}.${prop}` });

    const box = document.createElement('div');
    box.className = 'color';
    const select = document.createElement('select');
    select.title = gradientProp ? 'None, a solid color or a gradient' : 'None or a solid color';
    const gradients = gradientProp ? state.doc.objects.filter((o) => !gp.refTypes || gp.refTypes.includes(o.type)) : [];
    select.append(new Option('None', 'none'), new Option('Solid', 'solid'));
    if (gradientProp) {
      const option = new Option(gradients.length ? 'Gradient' : 'Gradient (none yet)', 'gradient');
      option.disabled = !gradients.length;
      select.append(option);
    }
    select.value = kind;
    select.addEventListener('change', () => {
      const props = select.value === 'none' ? { [prop]: null } : select.value === 'solid' ? { [prop]: color ?? p.default ?? '#888888' } : { [gradientProp]: gradients[0].id };
      if (gradientProp && select.value !== 'gradient') props[gradientProp] = null;
      set(props);
    });
    box.append(select);
    if (kind === 'solid') {
      const swatch = CONTROLS.color({ p: { ...p, nullable: false }, value: color, preview: (v) => preview(targets.map((t) => ({ op: 'set', target: t, props: { [prop]: v } }))), commit: (v) => set({ [prop]: v }) });
      box.append(...swatch.children);
    } else if (kind === 'gradient') {
      const which = document.createElement('select');
      for (const g of gradients) which.append(new Option(g.id, g.id, false, g.id === gradient));
      which.addEventListener('change', () => set({ [gradientProp]: which.value }));
      box.append(which);
    }
    div.append(label, box, document.createElement('span'));
    return div;
  }

  function severalTitle(obj, others) {
    const div = document.createElement('div');
    div.className = 'several-title';
    const names = [obj, ...others].map((o) => o.id);
    div.innerHTML = `<h2>${names.length} objects</h2><p class="help"></p>`;
    div.querySelector('p').textContent = names.join(', ');
    div.title = `Primary: ${obj.id}. Changes apply to all.`;
    return div;
  }

  function title(obj, kind) {
    const div = document.createElement('div');
    div.className = 'field';
    div.dataset.prop = '__id';
    div.innerHTML = `<label title="${kind.help.replace(/"/g, '&quot;')}">${kind.name}</label><input type="text" aria-label="Id"><span></span>`;
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
    const { posing } = context;
    // In a pose or clip, an animatable property of the (single) object is edited there, with its key diamond.
    if (posing?.single && p.animatable) return poseField(posing.obj, posing.pose, prop, p, posing.value(prop), prop in posing.fixed, labelText);
    const isObject = target !== 'meta';
    const origin = isObject ? valueOrigin(state.doc, data, prop) : data[prop] !== undefined ? 'own' : 'default';
    const value = isObject ? effectiveValue(schema, state.doc, data, prop) : (data[prop] ?? p.default);
    const { others } = context;
    const targets = [target, ...others.map((o) => o.id)];
    const mixed = others.some((o) => JSON.stringify(effectiveValue(schema, state.doc, o, prop)) !== JSON.stringify(value));
    const div = document.createElement('div');
    div.className = `field${origin === 'default' ? ' default' : origin === 'style' ? ' default by-style' : ''}${mixed ? ' mixed' : ''}`;
    div.dataset.prop = prop;
    const label = document.createElement('label');
    label.textContent = labelText ?? prop;
    const whence = origin === 'style' ? `\nFrom style "${data.style}".` : '';
    label.title = `${prop}: ${p.help ?? ''}${p.default !== undefined ? `\nDefault: ${JSON.stringify(p.default)}` : ''}${whence}${mixed ? `\nMixed values: showing ${target}.` : ''}`;
    const name = others.length ? `${targets.length} objects` : target;

    // The canvas size changes with the drawing centered, like the Artboard tool and Project Settings.
    const size = target === 'meta' && (prop === 'width' || prop === 'height');
    const change = (v) =>
      size
        ? artboardOps(state.doc, schema, prop === 'width' ? v : readMeta(schema, state.doc, 'width'), prop === 'height' ? v : readMeta(schema, state.doc, 'height'))
        : targets.map((t) => ({ op: 'set', target: t, props: { [prop]: v } }));
    // Several changes in a row to the same property (field arrows, typing and correcting) are a single step.
    const commit = (v) => {
      if (Object.is(v, value) && !mixed) return preview(null);
      execute(change(v), `${name}.${prop}`, { group: `${targets.join()}.${prop}` });
    };
    const control = CONTROLS[p.type]({ p, value, preview: (v) => preview(change(v)), commit, div, label, target });
    // The third column stays (where the key diamond goes in a pose or clip), so the rows line up.
    div.append(label, control, document.createElement('span'));
    // In a pose or clip what is not animated there is setup only: shown dimmed, edited in Design.
    if (posing) {
      div.classList.add('setup-only');
      div.title = posing.single ? 'Setup only: edit it in Design' : 'Select a single object to animate its values';
      for (const el of div.querySelectorAll('input, select, button')) /** @type {HTMLInputElement} */ (el).disabled = true;
    }
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
      div.classList.toggle('invalid', !!error);
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
        div.classList.remove('invalid');
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

    // Dragging over the name changes the value: Shift = fine, Alt = coarse.
    label.classList.add('draggable');
    label.addEventListener('pointerdown', (e) => {
      if (input.disabled) return;
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
    // Empty in a property that allows null = null (for example, the initial option of an enum param).
    input.addEventListener('change', () => commit(input.value === '' && p.nullable ? null : input.value));
    return input;
  },

  // List of texts (the options of an enum param): typed separated by commas.
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

  // Vertices are edited on the canvas; here they are only summarized and editing is entered.
  vertices({ value, target }) {
    const box = document.createElement('div');
    box.className = 'color vertices';
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: state.editing === target ? 'Done' : 'Edit points' });
    button.title = 'Or double-click the path, or press Enter';
    button.addEventListener('click', () => setState(state.editing === target ? { editing: null, vertex: null } : { editing: target, selection: target, selected: [target], vertex: null, tool: 'select' }));
    const summary = document.createElement('span');
    const curved = value.filter((v) => (v.mode ?? 'straight') !== 'straight').length;
    summary.textContent = `${value.length} points${curved ? `, ${curved} curved` : ''}`;
    box.append(summary, button);
    return box;
  },

  // The mesh of a vector layer: only summarized here (it is edited on the canvas).
  points({ value, target }) {
    const summary = document.createElement('span');
    const bound = Object.values(value ?? {}).filter((pt) => pt.bone).length;
    const n = Object.keys(value ?? {}).length;
    // In a pose or clip the value lists only the points moved there (the rest are the setup's).
    const layer = target && findObject(state.doc, target);
    const all = layer ? Object.keys(read(schema, layer, 'points') ?? {}).length : n;
    const moved = state.pose && value !== layer?.points;
    summary.textContent = moved ? `${n} of ${all} point${all === 1 ? '' : 's'} moved here` : `${n} point${n === 1 ? '' : 's'}${bound ? `, ${bound} bound to bones` : ''}`;
    return summary;
  },

  curves({ value }) {
    const summary = document.createElement('span');
    const closed = Object.values(value ?? {}).filter((c) => c.closed).length;
    const n = Object.keys(value ?? {}).length;
    summary.textContent = `${n} curve${n === 1 ? '' : 's'}${closed ? `, ${closed} closed` : ''}`;
    return summary;
  },

  // A pose is edited on the canvas: here it is summarized and activated.
  pose({ value, target }) {
    const box = document.createElement('div');
    box.className = 'summary-pose';
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

  // The tracks of a clip are edited in the timeline: here they are only summarized.
  tracks({ value }) {
    const list = document.createElement('ul');
    list.className = 'summary-pose';
    for (const [id, fields] of Object.entries(value ?? {})) {
      const li = document.createElement('li');
      li.textContent = `${id}: ${Object.entries(fields).map(([k, keys]) => `${k} (${keys.length} keys)`).join(', ')}`;
      list.append(li);
    }
    if (!list.children.length) list.innerHTML = '<li>No keyframes yet.</li>';
    return list;
  },

  // Stops of a gradient: color, offset and remove; plus a button to add.
  stops({ value, commit }) {
    const list = document.createElement('div');
    list.className = 'stops-list';
    const change = (i, changes) => commit(value.map((s, j) => (j === i ? { ...s, ...changes } : s)).sort((a, b) => a.offset - b.offset));
    value.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'stop';
      const color = Object.assign(document.createElement('input'), { type: 'color', value: s.color.length === 4 ? '#' + [...s.color.slice(1)].map((d) => d + d).join('') : s.color.slice(0, 7) });
      color.addEventListener('change', () => change(i, { color: color.value }));
      const offset = Object.assign(document.createElement('input'), { type: 'number', min: 0, max: 1, step: 0.05, value: s.offset, title: 'Position, 0 to 1' });
      offset.addEventListener('change', () => change(i, { offset: Math.min(1, Math.max(0, Number(offset.value) || 0)) }));
      const opacity = Object.assign(document.createElement('input'), { type: 'number', min: 0, max: 1, step: 0.1, value: s.opacity ?? 1, title: 'Opacity' });
      opacity.addEventListener('change', () => change(i, { opacity: Math.min(1, Math.max(0, Number(opacity.value))) }));
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'reset', textContent: '×', title: 'Remove stop' });
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

  // The file of an image layer: thumbnail, name, replace it with another and return to its natural size.
  asset({ value, target }) {
    const box = document.createElement('div');
    box.className = 'field-asset';
    const thumbnail = Object.assign(document.createElement('img'), { src: assetUrl(value), alt: '' });
    thumbnail.addEventListener('error', () => box.classList.add('missing'), { once: true });
    const name = Object.assign(document.createElement('span'), { className: 'name-asset', textContent: value, title: `${value} (missing from the document's assets if crossed out)` });
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
    buttons.className = 'buttons-asset';
    buttons.append(change, natural);
    box.append(thumbnail, name, buttons, file);
    return box;
  },

  ref({ p, value, commit, target }) {
    const select = document.createElement('select');
    if (p.nullable) select.append(new Option('(none)', ''));
    for (const o of state.doc.objects) {
      // refScope "children": only the children (the active child of a switch); "skeleton": the bones of its skeleton.
      const inReach = p.refScope === 'children' ? o.parent === target : p.refScope === 'skeleton' ? skeletonOf(state.doc, o.id) === skeletonOf(state.doc, target) : o.id !== target;
      if (inReach && (!p.refTypes || p.refTypes.includes(o.type))) select.append(new Option(o.id, o.id, false, o.id === value));
    }
    select.addEventListener('change', () => commit(select.value || null));
    return select;
  },
};
