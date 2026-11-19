// The editor's entry point: Design mode with the top bar (tools, the options of the selection), Layers, the canvas
// and the Document JSON panel.

import { placeIcons } from './icons.js';
import { actions, renderHeader, setupDropdowns, setupHeader } from './header.js';
import { deleteSelected, orderSelected, render as renderLayers, renameSelected, setupLayers } from './layers.js';
import { render as renderCanvas, setupCanvas } from './canvas.js';
import { cancelPen, setupDrawTools } from './drawTools.js';
import { clearMarks, createMarked, setupFillTool } from './fillTool.js';
import { nudgeSelection, setupSelectTool } from './selectTool.js';
import { deletePoints, nudgePoints, setupPointEdit, stopEditing } from './pointEdit.js';
import { copy, cut, duplicate, paste } from './clipboard.js';
import { renderToolbar, setupToolbar } from './toolbar.js';
import { renderOptions } from './options.js';
import { renderInspector } from './inspector.js';
import { render as renderJson, setupJson } from './json.js';
import { setupImageDrop } from './images.js';
import { setupNavigation, zoomActual, zoomFit, zoomSelection, zoomStep } from './navigate.js';
import { followChanges, onChange, redo, restore, setTool, state, undo, walkParts } from './state.js';

placeIcons(document);
setupDropdowns();
setupHeader();
setupToolbar();
setupLayers();
setupCanvas();
setupDrawTools();
setupFillTool();
setupSelectTool();
setupPointEdit();
setupJson();
setupImageDrop();
setupNavigation(renderCanvas);

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
const TOOL_KEYS = { v: 'select', m: 'move', s: 'scale', t: 'rotate', p: 'pen', r: 'rect', e: 'ellipse', f: 'fill' };
/** @type {Record<string, [number, number]>} */
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

document.addEventListener('keydown', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.closest?.('input, textarea, select, dialog')) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const arrow = ARROWS[event.key];
  // The view: Ctrl + / Ctrl − (by key or by place on the keyboard), Ctrl+0 fit, Ctrl+1 100 %, Shift+2 the selection.
  if (ctrl && (event.key === '+' || event.key === '=' || event.code === 'Equal' || event.code === 'NumpadAdd')) zoomStep(1);
  else if (ctrl && (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract')) zoomStep(-1);
  else if (ctrl && (event.code === 'Digit0' || event.code === 'Numpad0')) zoomFit();
  else if (ctrl && (event.code === 'Digit1' || event.code === 'Numpad1')) zoomActual();
  else if (!ctrl && event.shiftKey && event.code === 'Digit2') zoomSelection();
  else if (ctrl && key === 'z') event.shiftKey ? redo() : undo();
  else if (ctrl && key === 'y') redo();
  else if (ctrl && key === 'd') duplicate();
  else if (ctrl && key === 'c') {
    if (!copy()) return;
  } else if (ctrl && key === 'x') {
    if (!cut()) return;
  } else if (ctrl && key === 'v') {
    if (!paste()) return;
  } else if (event.altKey && key === 'w') actions.close();
  else if (event.key === 'Escape' && state.tool === 'fill' && clearMarks()) {
    // the marked gaps were cleared
  } else if (event.key === 'Enter' && state.tool === 'fill' && createMarked()) {
    // shapes were created in the marked gaps
  } else if (event.key === 'Escape' && stopEditing()) {
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
  else if ((event.key === 'PageUp' || event.key === 'PageDown') && !ctrl) {
    const up = event.key === 'PageUp';
    orderSelected(event.shiftKey ? (up ? 'top' : 'bottom') : up ? 'up' : 'down');
  }
  else if (!ctrl && !event.altKey && TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
  else return;
  event.preventDefault();
});

await restore();
followChanges();
