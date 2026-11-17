// The Inspector: the properties of what is selected, built from the schema (each row's tooltip is the property's
// `help`). With nothing selected it shows the document's own properties; with several parts, what they share (a
// value they do not agree on shows empty, and setting it sets it on all of them). Colors are swatches, the stroke
// has its width on the same row, and the origin is one row with X and Y. While a value is being changed (a color
// being picked, a number being typed) the canvas shows it live; it is saved as one batch when done.
// With a drawing tool active, a «New shapes» section sets the auto fill and auto stroke the tool gives new shapes.
// While editing points, a «Points» section flips the picked points horizontally or vertically.

import { findObject } from '../core/document.js';
import { applyTransformOps, isTransformed } from '../core/transform.js';
import { showPreview } from './canvas.js';
import { colorSwatch } from './colorSwatch.js';
import { flipPoints } from './pointEdit.js';
import { drawStyle, isDrawTool, run, setDrawStyle, state } from './state.js';
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
const SHOWN_WITH = new Set(Object.values(COMPANIONS));

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
    const swatch = colorSwatch({
      value: mixed ? undefined : /** @type {string | null} */ (value),
      nullable: spec.nullable,
      mixed,
      onInput: live,
      onChange: change,
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
  if (spec.type === 'number') return row(labelOf(key), spec.help, numberField(spec, value, live, change));
  if (spec.type === 'vertices') {
    const span = document.createElement('span');
    span.className = 'faint';
    span.textContent = mixed ? 'mixed' : `${Array.isArray(value) ? value.length : 0} points (edit them on the canvas)`;
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

/** @param {Target[]} targets */
const typeOf = (targets) => (targets[0].id === 'meta' ? 'meta' : String(targets[0].values.type));

/** The «New shapes» section: the auto fill and auto stroke of the drawing tools. */
function newShapesSection() {
  const section = document.createElement('div');
  section.className = 'new-shapes';
  const heading = document.createElement('h3');
  heading.textContent = 'New shapes';
  const fill = colorSwatch({
    value: drawStyle.fill,
    nullable: true,
    title: 'Auto fill: the fill new shapes get (None: no fill)',
    onChange: (color) => setDrawStyle({ fill: color }),
  });
  const stroke = colorSwatch({
    value: drawStyle.stroke,
    nullable: true,
    title: 'Auto stroke: the stroke new shapes get (None: no stroke)',
    onChange: (color) => setDrawStyle({ stroke: color }),
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
      for (const [name, property] of Object.entries(spec.properties)) {
        if (!SHOWN_WITH.has(name)) parts.push(propertyRow(name, property, targets));
      }
      const only = objects.length === 1 ? objects[0] : null;
      if (only?.type === 'vector' && isTransformed(only)) parts.push(applyTransformRow(only));
    }
  }
  panel.replaceChildren(...parts);
}
