// The tool selector: one button per group showing the group's current tool (a click picks it), and a small arrow
// that opens the group's menu with all its tools and their keys.

import { icon } from './icons.js';
import { setTool, state } from './state.js';

/** @typedef {import('./state.js').Tool} Tool */

/** @type {Record<Tool, { name: string, key: string, icon: Parameters<typeof icon>[0], help: string }>} */
export const TOOLS = {
  select: { name: 'Select', key: 'V', icon: 'select', help: 'Pick, move, scale and rotate parts; Shift+click or a marquee for several; click a picked part again to edit its points' },
  move: { name: 'Move', key: 'M', icon: 'move', help: 'Drag anywhere to move the picked parts (Shift: straight; Alt: a copy)' },
  scale: { name: 'Scale', key: 'S', icon: 'scale', help: 'Drag anywhere to scale the picked parts from their center, or drag a handle' },
  rotate: { name: 'Rotate', key: 'T', icon: 'rotate', help: 'Drag anywhere to rotate the picked parts around their center (Shift: 15° steps)' },
  pen: { name: 'Pen', key: 'P', icon: 'pen', help: 'Click for corners, drag for curves; the first point closes, Enter ends a line, Esc cancels' },
  rect: { name: 'Rectangle', key: 'R', icon: 'rect', help: 'Drag on the canvas for a rectangular path; Shift for a square' },
  ellipse: { name: 'Ellipse', key: 'E', icon: 'ellipse', help: 'Drag on the canvas for an elliptical path; Shift for a circle' },
  shape: { name: 'Create Shape', key: 'F', icon: 'bean', help: 'Pick the points around a shape (click, a box, or a click inside a gap; Shift adds or takes out, also dragging over points); a checkerboard shows when they close it, and Create shape (Enter) makes it. A click on a ring welds two crossing lines there. Esc clears the picks' },
};

/** @type {{ id: string, name: string, tools: Tool[] }[]} */
const GROUPS = [
  { id: 'transform', name: 'Transform', tools: ['select', 'move', 'scale', 'rotate'] },
  { id: 'draw', name: 'Draw', tools: ['pen', 'rect', 'ellipse'] },
  { id: 'shape', name: 'Create Shape', tools: ['shape'] },
];

/** @type {Record<string, Tool>} the tool each group shows (the last one used in it) */
const current = Object.fromEntries(GROUPS.map((g) => [g.id, g.tools[0]]));

const bar = /** @type {HTMLElement} */ (document.getElementById('tools'));

/** @param {Tool} tool */
const tip = (tool) => `${TOOLS[tool].name} (${TOOLS[tool].key}): ${TOOLS[tool].help}`;

export function setupToolbar() {
  for (const group of GROUPS) {
    const wrap = document.createElement('div');
    wrap.className = 'tools-group dropdown';
    wrap.dataset.group = group.id;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'icon main';
    main.addEventListener('click', () => setTool(current[group.id]));
    wrap.append(main);
    if (group.tools.length > 1) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'more';
      more.title = `${group.name} tools`;
      more.setAttribute('aria-label', `${group.name} tools`);
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.innerHTML = '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.setAttribute('role', 'menu');
      menu.hidden = true;
      for (const tool of group.tools) {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.title = TOOLS[tool].help;
        item.innerHTML = `<span class="with-icon">${icon(TOOLS[tool].icon)}${TOOLS[tool].name}</span><kbd>${TOOLS[tool].key}</kbd>`;
        item.addEventListener('click', () => setTool(tool));
        menu.append(item);
      }
      wrap.append(more, menu);
    }
    bar.append(wrap);
  }
  renderToolbar();
}

export function renderToolbar() {
  for (const group of GROUPS) {
    if (group.tools.includes(/** @type {Tool} */ (state.tool))) current[group.id] = /** @type {Tool} */ (state.tool);
    const wrap = /** @type {HTMLElement} */ (bar.querySelector(`[data-group="${group.id}"]`));
    const main = /** @type {HTMLButtonElement} */ (wrap.querySelector('.main'));
    const tool = current[group.id];
    main.innerHTML = icon(TOOLS[tool].icon);
    main.title = tip(tool);
    main.setAttribute('aria-label', TOOLS[tool].name);
    wrap.classList.toggle('active', group.tools.includes(/** @type {Tool} */ (state.tool)));
    for (const item of wrap.querySelectorAll('[role="menuitem"]')) {
      item.classList.toggle('current', item.textContent?.startsWith(TOOLS[state.tool].name) ?? false);
    }
  }
}
