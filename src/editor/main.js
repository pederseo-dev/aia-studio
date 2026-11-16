// The editor's entry point: Design mode with the top bar (tools, the options of the selection), Layers, the canvas
// and the Document JSON panel.

import { placeIcons } from './icons.js';
import { actions, renderHeader, setupDropdowns, setupHeader } from './header.js';
import { deleteSelected, render as renderLayers, renameSelected, setupLayers } from './layers.js';
import { render as renderCanvas, setupCanvas } from './canvas.js';
import { cancelPen, setupDrawTools } from './drawTools.js';
import { nudgeSelection, setupSelectTool } from './selectTool.js';
import { deletePoints, nudgePoints, setupPointEdit, stopEditing } from './pointEdit.js';
import { copy, duplicate, paste } from './clipboard.js';
import { renderToolbar, setupToolbar } from './toolbar.js';
import { renderOptions } from './options.js';
import { renderInspector } from './inspector.js';
import { render as renderJson, setupJson } from './json.js';
import { followChanges, onChange, redo, restore, setTool, state, undo, walkParts } from './state.js';

placeIcons(document);
setupDropdowns();
setupHeader();
setupToolbar();
setupLayers();
setupCanvas();
setupDrawTools();
setupSelectTool();
setupPointEdit();
setupJson();

let lastTool = state.tool;
onChange(() => {
  if (state.tool !== lastTool) {
    lastTool = state.tool;
    if (state.tool !== 'pen') cancelPen();
  }
  renderHeader();
  renderToolbar();
  renderOptions();
  renderInspector();
  renderLayers();
  renderCanvas();
  renderJson();
});

/** @type {Record<string, typeof state.tool>} */
const TOOL_KEYS = { v: 'select', m: 'move', s: 'scale', t: 'rotate', p: 'pen', r: 'rect', e: 'ellipse' };
/** @type {Record<string, [number, number]>} */
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

document.addEventListener('keydown', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.closest?.('input, textarea, select, dialog')) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const arrow = ARROWS[event.key];
  if (ctrl && key === 'z') event.shiftKey ? redo() : undo();
  else if (ctrl && key === 'y') redo();
  else if (ctrl && key === 'd') duplicate();
  else if (ctrl && key === 'c') {
    if (!copy()) return;
  } else if (ctrl && key === 'v') {
    if (!paste()) return;
  } else if (event.altKey && key === 'w') actions.close();
  else if (event.key === 'Escape' && stopEditing()) {
    // point editing ended
  } else if (arrow && !ctrl) {
    const step = event.shiftKey ? 10 : 1;
    const done = state.editing ? nudgePoints(arrow[0] * step, arrow[1] * step) : nudgeSelection(arrow[0] * step, arrow[1] * step);
    if (!done) return;
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    if (state.editing) deletePoints();
    else deleteSelected();
  }
  else if (event.key === 'Tab' && !ctrl) {
    if (!walkParts(event.shiftKey)) return;
  } else if (event.key === 'F2') renameSelected();
  else if (!ctrl && !event.altKey && TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
  else return;
  event.preventDefault();
});

await restore();
followChanges();
