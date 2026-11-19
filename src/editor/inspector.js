// The Inspector: the properties of what is selected, built from the schema (each row's tooltip is the property's
// `help`). With nothing selected it shows the document's own properties; with several parts, what they share (a
// value they do not agree on shows empty, and setting it sets it on all of them). Colors are swatches (their opacity
// is set in the swatch's popover), the stroke has its width on the same row, the origin is one row with X and Y, and a
// number from 0 to 1 (an opacity) is a slider. While a value is being changed (a color
// being picked, a number being typed) the canvas shows it live; it is saved as one batch when done.
// With a drawing tool active, a «New shapes» section sets the auto fill and auto stroke the tool gives new shapes.
// While editing points, a «Points» section flips the picked points horizontally or vertically; otherwise a Flip row
// flips the selected parts, or the selected layer, and an Order row raises or lowers them.

import { findObject } from '../core/document.js';
import { applyTransformOps, isTransformed } from '../core/transform.js';
import { showPreview } from './canvas.js';
import { colorSwatch } from './colorSwatch.js';
import { flipPoints } from './pointEdit.js';
import { orderSelected } from './layers.js';
import { flipSelection } from './selectTool.js';
import { drawStyle, isDrawTool, isLocked, run, setDrawStyle, state } from './state.js';
import { schema } from './schema.js';

/**
 * @typedef {import('../core/schema.js').PropertySpec} PropertySpec
 * @typedef {{ id: string, values: Record<string, unknown> }} Target
 */

const panel = /** @type {HTMLElement} */ (document.getElementById('inspector'));
const title = /** @type {HTMLElement} */ (document.getElementById('inspector-title'));

/** strokeWidth → "Stroke width". @param {string} key */
const labelOf = (key) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/ (\w)/g, (_, c) => ` ${c.toLowerCase()}`);

/** Properties shown inside another one's row instead of their own. */
const COMPANIONS = /** @type {Record<string, string>} */ ({ stroke: 'strokeWidth', originX: 'originY' });
/** A color's opacity, set in its swatch's popover. */
const OPACITY_OF = /** @type {Record<string, string>} */ ({ fill: 'fillOpacity', stroke: 'strokeOpacity' });
const SHOWN_WITH = new Set([...Object.values(COMPANIONS), ...Object.values(OPACITY_OF)]);

const MIXED = Symbol('mixed');

/** The shared value of a property across targets, or MIXED. @param {Target[]} targets @param {string} key @param {PropertySpec} spec */
function valueOf(targets, key, spec) {
  const values = targets.map((t) => (key in t.values ? t.values[key] : spec.default));
  const first = JSON.stringify(values[0]);
  return values.every((v) => JSON.stringify(v) === first) ? values[0] : MIXED;
}

/** Shows the change on the canvas without saving it. @param {Target[]} targets @param {Record<string, unknown>} props */
function preview(targets, props) {
  const doc = state.document;
  if (!doc) return;
  const ids = new Set(targets.map((t) => t.id));
  showPreview({
    ...doc,
    meta: ids.has('meta') ? { ...doc.meta, ...props } : doc.meta,
    objects: doc.objects.map((o) => (ids.has(o.id) ? { ...o, ...props } : o)),
  });
}

/** Saves the change on every target, as one batch. @param {Target[]} targets @param {Record<string, unknown>} props */
function save(targets, props) {
  const names = Object.keys(props).map(labelOf).join(', ');
  run(
    targets.map((t) => ({ op: 'set', target: t.id, props })),
    { note: `${names}${targets.length > 1 ? ` of ${targets.length} parts` : ''}` },
  ).finally(() => showPreview(null));
}

/**
 * A number field: typing previews, Enter or leaving saves. Nullable fields save null when emptied.
 * @param {PropertySpec} spec @param {unknown} value
 * @param {(n: number | null) => void} onInput @param {(n: number | null) => void} onChange
 * @param {string} [placeholder]
 */
function numberField(spec, value, onInput, onChange, placeholder = '') {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  if (spec.min !== undefined) input.min = String(spec.min);
  if (spec.max !== undefined) input.max = String(spec.max);
  const mixed = value === MIXED;
  input.value = mixed || value === null || value === undefined ? '' : String(value);
  input.placeholder = mixed ? 'mixed' : placeholder;
  /** @returns {number | null | undefined} undefined = not a value to use */
  const read = () => {
    if (input.value === '') return spec.nullable ? null : undefined;
    const n = Number(input.value);
    return Number.isFinite(n) && (spec.min === undefined || n >= spec.min) ? n : undefined;
  };
  input.addEventListener('input', () => {
    const n = read();
    if (n !== undefined) onInput(n);
  });
  input.addEventListener('change', () => {
    const n = read();
    if (n !== undefined) onChange(n);
    else showPreview(null);
  });
  return input;
}

/**
 * A number from 0 to 1 (an opacity) as a slider and a field in percent: dragging previews, letting go saves.
 * @param {unknown} value @param {(n: number) => void} onInput @param {(n: number) => void} onChange
 * @returns {HTMLInputElement[]}
 */
function unitSlider(value, onInput, onChange) {
  const mixed = value === MIXED;
  const start = mixed ? '' : String(Math.round((typeof value === 'number' ? value : 1) * 100));
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'slider';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = start || '100';
  const percent = document.createElement('input');
  percent.type = 'number';
  percent.min = '0';
  percent.max = '100';
  percent.step = '1';
  percent.value = start;
  percent.placeholder = mixed ? 'mixed' : '%';
  percent.title = 'Percent: 0 is invisible, 100 is solid';
  /** @param {string} text @returns {number | undefined} */
  const read = (text) => {
    const n = Number(text);
    return text === '' || !Number.isFinite(n) ? undefined : Math.min(100, Math.max(0, n)) / 100;
  };
  slider.addEventListener('input', () => {
    percent.value = slider.value;
    onInput(Number(slider.value) / 100);
  });
  slider.addEventListener('change', () => onChange(Number(slider.value) / 100));
  percent.addEventListener('input', () => {
    const n = read(percent.value);
    if (n === undefined) return;
    slider.value = String(Math.round(n * 100));
    onInput(n);
  });
  percent.addEventListener('change', () => {
    const n = read(percent.value);
    if (n !== undefined) onChange(n);
    else showPreview(null);
  });
  return [slider, percent];
}

/**
 * @param {string} label @param {string} help @param {...HTMLElement} controls
 */
function row(label, help, ...controls) {
  const line = document.createElement('div');
  line.className = 'prop';
  line.title = help;
  const name = document.createElement('span');
  name.className = 'prop-name';
  name.textContent = label;
  const box = document.createElement('div');
  box.className = 'controls';
  box.append(...controls);
  line.append(name, box);
  return line;
}

/** The control(s) of one property of the targets. @param {string} key @param {PropertySpec} spec @param {Target[]} targets */
function propertyRow(key, spec, targets) {
  const value = valueOf(targets, key, spec);
  const mixed = value === MIXED;
  const change = (/** @type {unknown} */ v) => save(targets, { [key]: v });
  const live = (/** @type {unknown} */ v) => preview(targets, { [key]: v });

  if (spec.type === 'color') {
    const opacityKey = OPACITY_OF[key];
    const opacitySpec = opacityKey ? schema.get(typeOf(targets))?.properties[opacityKey] : undefined;
    const opacity = opacitySpec ? valueOf(targets, /** @type {string} */ (opacityKey), opacitySpec) : undefined;
    /** The color and, when the popover set one, its opacity. @param {string | null} color @param {number | undefined} alpha */
    const props = (color, alpha) => ({ [key]: color, ...(opacityKey && alpha !== undefined ? { [opacityKey]: alpha } : {}) });
    const swatch = colorSwatch({
      kind: key === 'fill' || key === 'stroke' ? key : undefined,
      value: mixed ? undefined : /** @type {string | null} */ (value),
      nullable: spec.nullable,
      mixed,
      opacity: opacitySpec ? (opacity === MIXED ? null : /** @type {number} */ (opacity)) : undefined,
      onInput: (color, alpha) => preview(targets, props(color, alpha)),
      onChange: (color, alpha) => save(targets, props(color, alpha)),
      onCancel: () => showPreview(null),
    });
    const companion = COMPANIONS[key];
    if (!companion) return row(labelOf(key), spec.help, swatch);
    const other = /** @type {PropertySpec} */ (schema.get(typeOf(targets))?.properties[companion]);
    const width = numberField(other, valueOf(targets, companion, other), (n) => preview(targets, { [companion]: n }), (n) => save(targets, { [companion]: n }));
    width.classList.add('width');
    width.title = other.help;
    return row(labelOf(key), `${spec.help} ${other.help}`, swatch, width);
  }

  if (key === 'originX') {
    const ySpec = /** @type {PropertySpec} */ (schema.get(typeOf(targets))?.properties.originY);
    const yValue = valueOf(targets, 'originY', ySpec);
    const x = numberField(spec, value, (n) => live(n), (n) => save(targets, n === null ? { originX: null, originY: null } : { originX: n, originY: yValue === MIXED || yValue === null ? n : yValue }), 'center');
    const y = numberField(ySpec, yValue, (n) => preview(targets, { originY: n }), (n) => save(targets, n === null ? { originX: null, originY: null } : { originX: value === MIXED || value === null ? n : value, originY: n }), 'center');
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'small';
    reset.textContent = 'Center';
    reset.title = 'Back to the center of its box';
    reset.disabled = value === null && yValue === null;
    reset.addEventListener('click', () => save(targets, { originX: null, originY: null }));
    return row('Origin', spec.help, x, y, reset);
  }

  if (spec.type === 'boolean') {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = value === true;
    box.indeterminate = mixed;
    box.addEventListener('change', () => change(box.checked));
    return row(labelOf(key), spec.help, box);
  }
  if (spec.type === 'number' && spec.min === 0 && spec.max === 1) return row(labelOf(key), spec.help, ...unitSlider(value, live, change));
  if (spec.type === 'number') return row(labelOf(key), spec.help, numberField(spec, value, live, change));
  if (spec.type === 'vertices') {
    const span = document.createElement('span');
    span.className = 'faint';
    span.textContent = mixed ? 'mixed' : `${Array.isArray(value) ? value.length : 0} points (edit them on the canvas)`;
    return row(labelOf(key), spec.help, span);
  }
  if (spec.type === 'holes') {
    const span = document.createElement('span');
    span.className = 'faint';
    const count = Array.isArray(value) ? value.length : 0;
    span.textContent = mixed ? 'mixed' : count ? `${count} (they follow the shapes inside)` : 'None';
    return row(labelOf(key), spec.help, span);
  }
  if (spec.type === 'pointGroups') {
    const span = document.createElement('span');
    span.className = 'faint';
    const names = value && typeof value === 'object' ? Object.keys(value) : [];
    span.textContent = mixed ? 'mixed' : names.length ? `${names.join(', ')} (edit them while editing points)` : 'None (make them while editing points)';
    return row(labelOf(key), spec.help, span);
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.value = mixed ? '' : String(value ?? '');
  input.placeholder = mixed ? 'mixed' : '';
  input.addEventListener('change', () => change(input.value));
  return row(labelOf(key), spec.help, input);
}

/** Apply transform: the layer's transform goes into its parts' vertices. @param {import('../core/document.js').DocObject} layer */
function applyTransformRow(layer) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'small apply-transform';
  button.textContent = 'Apply transform';
  button.title = 'Put this layer’s move, turn and scale into its parts’ vertices, and leave the layer without a transform (it looks the same)';
  button.addEventListener('click', () => {
    const doc = state.document;
    if (doc) run(applyTransformOps(doc, layer), { select: layer.id, note: `Apply the transform of ${layer.id}` });
  });
  const row = document.createElement('div');
  row.className = 'prop';
  row.append(document.createElement('span'), button);
  return row;
}

/** The «Points» section while editing points: what applies to the picked points. */
function pointsSection() {
  const section = document.createElement('div');
  section.className = 'points-section';
  const heading = document.createElement('h3');
  heading.textContent = 'Points';
  const picked = state.points.length > 0;
  /** @param {string} text @param {string} help @param {boolean} horizontal */
  const flip = (text, help, horizontal) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small';
    button.textContent = text;
    button.title = picked ? help : `${help} (pick some points first)`;
    button.disabled = !picked;
    button.addEventListener('click', () => flipPoints(horizontal));
    return button;
  };
  section.append(
    heading,
    row(
      'Flip',
      'Mirror the picked points and their curve handles across the middle of their box.',
      flip('Horizontal', 'Flip the picked points horizontally (left ↔ right)', true),
      flip('Vertical', 'Flip the picked points vertically (top ↔ bottom)', false),
    ),
  );
  return section;
}

/** Flip of the selected parts or layer. @param {boolean} enabled */
function flipRow(enabled) {
  /** @param {string} text @param {string} help @param {boolean} horizontal */
  const flip = (text, help, horizontal) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small';
    button.textContent = text;
    button.title = enabled ? help : `${help} (unlock it first)`;
    button.disabled = !enabled;
    button.addEventListener('click', () => flipSelection(horizontal));
    return button;
  };
  return row(
    'Flip',
    'Mirror what is selected across the middle of its box.',
    flip('Horizontal', 'Flip horizontally (left ↔ right)', true),
    flip('Vertical', 'Flip vertically (top ↔ bottom)', false),
  );
}

/** Raise and lower the selected parts or layers among their siblings. @param {boolean} enabled */
function orderRow(enabled) {
  /** @param {string} text @param {string} help @param {import('../core/order.js').OrderMove} how */
  const move = (text, help, how) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small';
    button.textContent = text;
    button.title = enabled ? help : `${help} (unlock it first)`;
    button.disabled = !enabled;
    button.addEventListener('click', () => orderSelected(how));
    return button;
  };
  return row(
    'Order',
    'What is higher in the order is drawn over what is below it, among the parts of a layer (or the layers of a group).',
    move('Bottom', 'Lower to the bottom (Shift+Page Down)', 'bottom'),
    move('Lower', 'Lower one place (Page Down)', 'down'),
    move('Raise', 'Raise one place (Page Up)', 'up'),
    move('Top', 'Raise to the top (Shift+Page Up)', 'top'),
  );
}

/** @param {Target[]} targets */
const typeOf = (targets) => (targets[0].id === 'meta' ? 'meta' : String(targets[0].values.type));

/** The «New shapes» section: the auto fill and auto stroke of the drawing tools. */
function newShapesSection() {
  const section = document.createElement('div');
  section.className = 'new-shapes';
  const heading = document.createElement('h3');
  heading.textContent = 'New shapes';
  const fill = colorSwatch({
    kind: 'fill',
    value: drawStyle.fill,
    opacity: drawStyle.fillOpacity,
    nullable: true,
    title: 'Auto fill: the fill new shapes get (None: no fill)',
    onChange: (c, a) => setDrawStyle({ fill: c, ...(a === undefined ? {} : { fillOpacity: a }) }),
  });
  const stroke = colorSwatch({
    kind: 'stroke',
    value: drawStyle.stroke,
    opacity: drawStyle.strokeOpacity,
    nullable: true,
    title: 'Auto stroke: the stroke new shapes get (None: no stroke)',
    onChange: (c, a) => setDrawStyle({ stroke: c, ...(a === undefined ? {} : { strokeOpacity: a }) }),
  });
  const widthSpec = /** @type {PropertySpec} */ (schema.get('part')?.properties.strokeWidth);
  const width = numberField(widthSpec, drawStyle.strokeWidth, () => {}, (n) => n !== null && setDrawStyle({ strokeWidth: n }));
  width.classList.add('width');
  section.append(
    heading,
    row('Auto fill', 'The fill new shapes get. An open line never gets a fill.', fill),
    row('Auto stroke', 'The stroke new shapes get, and its width.', stroke, width),
  );
  return section;
}

/** What the panel was last built from, so typing in it is not interrupted by unrelated changes. */
let builtFrom = '';

export function renderInspector() {
  const doc = state.document;
  if (!doc) {
    builtFrom = '';
    title.textContent = '';
    panel.innerHTML = '';
    return;
  }
  const objects = state.selection.map((id) => findObject(doc, id)).filter((o) => !!o);
  const drawing = isDrawTool(state.tool);
  /** @type {Target[]} */
  let targets = [];
  let heading = '';
  if (!objects.length) {
    targets = [{ id: 'meta', values: doc.meta }];
    heading = 'Document';
  } else if (objects.every((o) => o.type === objects[0].type)) {
    targets = objects.map((o) => ({ id: o.id, values: o }));
    heading = objects.length > 1 ? `${objects.length} parts` : objects[0].id;
  } else heading = `${objects.length} selected`;
  const key = JSON.stringify([state.active, targets, drawing && drawStyle, state.editing, state.points.length > 0]);
  if (key === builtFrom) return;
  builtFrom = key;
  title.textContent = heading;
  /** @type {HTMLElement[]} */
  const parts = [];
  if (drawing) parts.push(newShapesSection());
  if (state.editing) parts.push(pointsSection());
  if (!targets.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Different kinds of things are selected.';
    parts.push(p);
  } else {
    const spec = schema.get(typeOf(targets));
    if (spec) {
      const help = document.createElement('p');
      help.className = 'type-help';
      help.textContent = spec.help;
      parts.push(help);
      const flippable = objects.length > 0 && !state.editing && objects.every((o) => o.type !== 'meta');
      if (flippable) {
        const unlocked = objects.every((o) => !isLocked(o.id));
        parts.push(flipRow(unlocked), orderRow(unlocked));
      }
      for (const [name, property] of Object.entries(spec.properties)) {
        if (!SHOWN_WITH.has(name)) parts.push(propertyRow(name, property, targets));
      }
      const only = objects.length === 1 ? objects[0] : null;
      if (only?.type === 'vector' && isTransformed(only)) parts.push(applyTransformRow(only));
    }
  }
  panel.replaceChildren(...parts);
}
