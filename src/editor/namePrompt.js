// The small box that asks for a name right after something is drawn, as a reminder to name things: names are how the
// document and the AI refer to them. It is optional: Enter names it, Esc or a click elsewhere keeps the given name.

import { findObject, idFromName } from '../core/document.js';
import { run, state } from './state.js';
import { area } from './view.js';

const box = document.createElement('div');
box.className = 'name-prompt';
box.hidden = true;
const input = document.createElement('input');
input.type = 'text';
input.spellcheck = false;
input.setAttribute('aria-label', 'Name of the new part');
const help = document.createElement('span');
help.className = 'help';
help.textContent = 'Give it a name, then Enter (Esc: later)';
box.append(input, help);
area.append(box);

/** @type {string | null} the part being named */
let naming = null;

function close() {
  naming = null;
  box.hidden = true;
  // Give the keys back to the editor (tool shortcuts), not to a hidden field.
  if (document.activeElement === input) input.blur();
}

function commit() {
  const doc = state.document;
  const id = naming;
  close();
  const typed = input.value.trim();
  if (!doc || !id || !typed || typed === id || !findObject(doc, id)) return;
  const next = idFromName(typed, (x) => x !== id && (x === 'meta' || !!findObject(doc, x)));
  run([{ op: 'rename', target: id, id: next }], { select: next, note: `Name ${next}` });
}

input.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.key === 'Enter') commit();
  else if (event.key === 'Escape') close();
});
input.addEventListener('blur', () => naming && close());

/**
 * Opens the box next to the part on the canvas, with its given name selected.
 * @param {string} id
 */
export function askName(id) {
  const shape = area.querySelector(`.content [data-id="${CSS.escape(id)}"]`);
  const at = shape?.getBoundingClientRect();
  const frame = area.getBoundingClientRect();
  naming = id;
  input.value = id;
  box.hidden = false;
  const left = at ? at.left - frame.left : 20;
  const top = at ? at.bottom - frame.top + 8 : 20;
  box.style.left = `${Math.max(8, Math.min(left, frame.width - box.offsetWidth - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(top, frame.height - box.offsetHeight - 8))}px`;
  input.focus();
  input.select();
}
