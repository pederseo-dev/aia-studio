// The Document JSON panel: the active document exactly as it is saved in document.json, with the lines that changed
// in the last step marked for a moment.

import { state } from './state.js';

const pre = /** @type {HTMLPreElement} */ (document.getElementById('json'));
/** @type {string | null} */
let shownId = null;
/** @type {string[]} */
let previous = [];

/** @param {string} text */
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Colors a line of JSON: keys, strings, numbers and literals. @param {string} line */
function highlight(line) {
  return escape(line).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b(true|false|null)\b/g,
    (match, string, colon, number, literal) => {
      if (string) return colon ? `<span class="j-key">${string}</span>${colon}` : `<span class="j-string">${string}</span>`;
      if (number) return `<span class="j-number">${number}</span>`;
      return `<span class="j-literal">${literal}</span>`;
    },
  );
}

export function render() {
  const doc = state.saved;
  if (!doc) {
    pre.textContent = '';
    shownId = null;
    previous = [];
    return;
  }
  const lines = JSON.stringify(doc, null, 2).split('\n');
  // Lines that were not there before (by content), only when it is the same document as last time.
  const before = new Map();
  if (shownId === state.active) for (const line of previous) before.set(line, (before.get(line) ?? 0) + 1);
  pre.innerHTML = lines
    .map((line) => {
      const count = before.get(line) ?? 0;
      const isNew = shownId === state.active && count === 0;
      if (count) before.set(line, count - 1);
      return `<span class="line${isNew ? ' changed' : ''}">${highlight(line)}</span>`;
    })
    .join('\n');
  shownId = state.active;
  previous = lines;
}

export function setupJson() {
  document.getElementById('json-copy')?.addEventListener('click', () => {
    if (state.saved) navigator.clipboard?.writeText(JSON.stringify(state.saved, null, 2));
  });
}
