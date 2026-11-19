// The options bar, as in Moho: what is selected, its name (editable) and buttons for what can be done with it right
// now, instead of instructions. A name is the id the document and the AI use, so what is typed becomes an id
// ("Left Eye" → left_eye).

import { findObject, idFromName } from '../core/document.js';
import { icon } from './icons.js';
import {
  canFollow,
  canUnweld,
  followPicked,
  editGroup,
  pickGroup,
  pickedAreCorners,
  pickedFollows,
  pickedPoint,
  pointGroups,
  renamePickedPoint,
  stopEditing,
  toggleCornersPicked,
  unweldPicked,
} from './pointEdit.js';
import { addPoint, autoWeld, drawStyle, editPoints, isDrawTool, penOptions, run, setDrawStyle, state, toggleAddPoint, toggleAutoWeld, toggleSharpCorners } from './state.js';
import { colorSwatch } from './colorSwatch.js';
import { isPart } from './schema.js';

const KINDS = /** @type {Record<string, string>} */ ({
  vector: 'Vector layer',
  group: 'Group layer',
  image: 'Image layer',
  path: 'Shape',
});

const bar = /** @type {HTMLElement} */ (document.getElementById('options'));
const kind = document.createElement('span');
kind.className = 'kind';
const label = document.createElement('label');
label.className = 'name-field';
label.textContent = 'Name';
const input = document.createElement('input');
input.type = 'text';
input.spellcheck = false;
input.setAttribute('aria-label', 'Name of the selection');
label.append(input);
const actions = document.createElement('div');
actions.className = 'actions';
// With a drawing tool: the auto fill and auto stroke new shapes get, as in Moho's tool options.
const style = document.createElement('div');
style.className = 'draw-style';
bar.append(style, kind, label, actions);

/** @type {string} what the style controls were last built from */
let styleFrom = '';

function renderStyle() {
  const key = isDrawTool(state.tool) ? JSON.stringify({ ...drawStyle, pen: state.tool === 'pen', weld: autoWeld.on, sharp: penOptions.sharp }) : '';
  if (key === styleFrom) return;
  styleFrom = key;
  style.replaceChildren();
  style.hidden = !key;
  if (!key) return;
  const width = document.createElement('input');
  width.type = 'number';
  width.min = '0';
  width.step = 'any';
  width.value = String(drawStyle.strokeWidth);
  width.title = 'Stroke width of new shapes';
  width.addEventListener('change', () => {
    const n = Number(width.value);
    if (width.value !== '' && n >= 0) setDrawStyle({ strokeWidth: n });
  });
  const fillLabel = document.createElement('span');
  fillLabel.textContent = 'Auto fill';
  const strokeLabel = document.createElement('span');
  strokeLabel.textContent = 'Auto stroke';
  style.append(
    fillLabel,
    colorSwatch({ kind: 'fill', value: drawStyle.fill, opacity: drawStyle.fillOpacity, nullable: true, title: 'The fill new shapes get (None: no fill)', onChange: (c, a) => setDrawStyle({ fill: c, ...(a === undefined ? {} : { fillOpacity: a }) }) }),
    strokeLabel,
    colorSwatch({ kind: 'stroke', value: drawStyle.stroke, opacity: drawStyle.strokeOpacity, nullable: true, title: 'The stroke new shapes get (None: no stroke)', onChange: (c, a) => setDrawStyle({ stroke: c, ...(a === undefined ? {} : { strokeOpacity: a }) }) }),
    width,
  );
  if (state.tool === 'pen') {
    style.append(
      toggle('corner', 'Sharp corners', 'New points are corners instead of smooth curves (Alt while drawing does the other)', penOptions.sharp, toggleSharpCorners),
      toggle('weld', 'Auto weld', 'A point pressed or released on a point or a line of the layer is welded there (a green ring shows where)', autoWeld.on, toggleAutoWeld),
    );
  }
}

/**
 * @param {Parameters<typeof icon>[0]} name @param {string} text @param {string} title @param {() => void} onClick
 * @param {{ disabled?: boolean, main?: boolean }} [options]
 */
function button(name, text, title, onClick, { disabled = false, main = false } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `action${main ? ' main' : ''}`;
  b.title = title;
  b.disabled = disabled;
  b.innerHTML = `${icon(name)}<span>${text}</span>`;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * A switch: its icon and name, lit while it is on.
 * @param {Parameters<typeof icon>[0]} name @param {string} text @param {string} title @param {boolean} on @param {() => void} onClick
 */
function toggle(name, text, title, on, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `action toggle${on ? ' on' : ''}`;
  b.title = title;
  b.setAttribute('aria-pressed', String(on));
  b.innerHTML = `${icon(name)}<span>${text}</span>`;
  b.addEventListener('click', onClick);
  return b;
}

/** @type {string | null} the id the field is showing */
let showing = null;

function commit() {
  const doc = state.document;
  const id = showing;
  const typed = input.value.trim();
  if (!doc || !id || !typed || typed === id) {
    input.value = id ?? '';
    return;
  }
  const next = idFromName(typed, (x) => x !== id && (x === 'meta' || !!findObject(doc, x)));
  run([{ op: 'rename', target: id, id: next }], { select: next, note: `Rename ${id}` });
}

input.addEventListener('keydown', (event) => {
  // Enter leaves the field, and leaving it with a new name renames (the change event).
  if (event.key === 'Enter') input.blur();
  else if (event.key === 'Escape') {
    input.value = showing ?? '';
    input.blur();
  }
});
input.addEventListener('change', commit);

export function renderOptions() {
  renderStyle();
  const doc = state.document;
  const selection = doc ? state.selection.map((id) => findObject(doc, id)).filter((o) => !!o) : [];
  actions.replaceChildren();
  if (selection.length !== 1) {
    showing = null;
    label.hidden = true;
    kind.textContent = selection.length > 1 ? `${selection.length} parts` : '';
    return;
  }
  const [object] = selection;
  const part = isPart(object.type);
  kind.textContent = `${KINDS[object.type] ?? object.type}${part ? ` in ${object.parent}` : ''}`;
  label.hidden = false;
  if (document.activeElement !== input || showing !== object.id) input.value = object.id;
  showing = object.id;
  if (!part) return;
  if (state.editing !== object.parent) {
    actions.append(button('points', 'Edit points', 'Edit the points of every shape in this layer (or click the shape again)', () => editPoints(object.id)));
    return;
  }
  const picked = state.points.length;
  const corners = pickedAreCorners();
  actions.append(
    pointField(),
    button(corners ? 'curve' : 'corner', corners ? 'Curve' : 'Corner', 'Make the picked points smooth curves, or corners (Alt+click a point does it for one)', toggleCornersPicked, { disabled: !picked }),
    button('unweld', 'Unweld', 'The picked points stop sharing: each one keeps its place as a point of its own', unweldPicked, { disabled: !canUnweld() }),
    toggle('addPoint', 'Add point', 'On: a click on a line adds a point there without changing its shape. Off: a click on a line or inside a shape picks all its points (Shift: adds them)', addPoint.on, toggleAddPoint),
    toggle('weld', 'Auto weld', 'Drop a point on a point or a line of another part to weld them; drop an open end on the other end of its line to close it (Alt: two open ends become one line)', autoWeld.on, toggleAutoWeld),
    followButton(),
    groupsMenu(),
    button('check', 'Done', 'Stop editing points (Esc)', () => stopEditing(), { main: true }),
  );
}

/** The Follow button: the stretch between two picked welded points follows the curve of a part through both. */
function followButton() {
  const follows = pickedFollows();
  const b = button(
    'curve',
    follows ? 'Unfollow' : 'Follow',
    follows
      ? 'The stretch between the picked points stops following the other part (Alt+click: follow it the other way round)'
      : 'The stretch between the two picked points follows the curve of the line welded to both (Alt+click: the long way round)',
    () => {},
    { disabled: !canFollow() },
  );
  b.addEventListener('click', (event) => followPicked(event.altKey));
  return b;
}

/** What is picked while editing points: how many, or the one point with its name (editable). */
function pointField() {
  const picked = state.points.length;
  const point = pickedPoint();
  const wrap = document.createElement('span');
  wrap.className = 'count';
  if (!point) {
    wrap.textContent = picked ? `${picked} points` : 'No points picked';
    return wrap;
  }
  if (point.vertex.ref) {
    wrap.textContent = `Point: shares ${point.vertex.ref}`;
    return wrap;
  }
  const label = document.createElement('label');
  label.className = 'name-field point-name';
  label.textContent = 'Point';
  const field = document.createElement('input');
  field.type = 'text';
  field.spellcheck = false;
  field.placeholder = 'no name';
  field.value = point.vertex.name ?? '';
  field.title = `Name of the point, to refer to it as ${point.part.id}.name (shared points and groups need one)`;
  field.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') field.blur();
    else if (event.key === 'Escape') {
      field.value = point.vertex.name ?? '';
      field.blur();
    }
  });
  field.addEventListener('change', () => renamePickedPoint(field.value));
  label.append(field);
  return label;
}

/** The Groups menu while editing points: pick the points of a group, and make or change groups with the picked points. */
function groupsMenu() {
  const groups = pointGroups();
  const picked = state.points.length > 0;
  const wrap = document.createElement('div');
  wrap.className = 'dropdown';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'action';
  open.setAttribute('aria-haspopup', 'menu');
  open.title = 'Point groups of this layer';
  open.innerHTML = `${icon('points')}<span>Groups</span>`;
  const menu = document.createElement('div');
  menu.className = 'menu groups-menu';
  menu.hidden = true;
  for (const [name, members] of Object.entries(groups)) {
    const row = document.createElement('div');
    row.className = 'group-row';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'group-pick';
    pick.title = `Pick the points of ${name}: ${members.join(', ') || 'none'}`;
    pick.innerHTML = `<span>${name}</span><span class="faint">${members.length}</span>`;
    pick.addEventListener('click', () => pickGroup(name));
    /** @param {string} text @param {string} title @param {'add' | 'remove' | 'delete'} action @param {boolean} disabled */
    const small = (text, title, action, disabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'group-edit';
      b.textContent = text;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', () => editGroup(action, name));
      return b;
    };
    row.append(
      pick,
      small('+', `Add the picked points to ${name}`, 'add', !picked),
      small('−', `Take the picked points out of ${name}`, 'remove', !picked),
      small('×', `Delete the group ${name} (its points stay)`, 'delete', false),
    );
    menu.append(row);
  }
  if (Object.keys(groups).length) menu.append(document.createElement('hr'));
  const create = document.createElement('input');
  create.type = 'text';
  create.spellcheck = false;
  create.placeholder = picked ? 'New group of the picked points' : 'Pick points to make a group';
  create.disabled = !picked;
  create.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && create.value.trim()) editGroup('new', create.value.trim());
  });
  menu.append(create);
  wrap.append(open, menu);
  return wrap;
}
