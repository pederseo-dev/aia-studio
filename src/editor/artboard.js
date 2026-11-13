// Artboard tool: handles on the canvas edge to resize it by dragging. As in Moho, the drawing stays anchored to the
// center: the canvas grows or shrinks equally on each side (see core/artboard.js), so the center of the frame does
// not move on screen (the canvas corrects the camera) and the size comes from the dragged point.

import { readMeta } from '../core/schema.js';
import { artboardOps } from '../core/artboard.js';
import { docVisible, execute, schema, state, preview } from './state.js';

// Handles: direction in x and y (-1 left/top, 0 middle, 1 right/bottom).
const HANDLES = { no: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], so: [-1, 1], o: [-1, 0] };
const CURSORS = { no: 'nwse', se: 'nwse', ne: 'nesw', so: 'nesw', n: 'ns', s: 'ns', e: 'ew', o: 'ew' };

export function createArtboard(ctx) {
  let measure = null; // "W × H" next to the pointer while dragging

  /** The document frame on screen. */
  function frame() {
    const doc = docVisible();
    const [zoom, , , , cx, cy] = ctx.cameraMatrix();
    const w = readMeta(schema, doc, 'width');
    const h = readMeta(schema, doc, 'height');
    return { x: cx, y: cy, w: w * zoom, h: h * zoom, width: w, height: h, zoom };
  }

  function draw() {
    const m = frame();
    ctx.overlay.append(ctx.create('rect', { class: 'selection artboard-frame', x: m.x, y: m.y, width: m.w, height: m.h }));
    for (const [name, [dx, dy]] of Object.entries(HANDLES)) {
      const x = m.x + ((dx + 1) / 2) * m.w;
      const y = m.y + ((dy + 1) / 2) * m.h;
      const handle = ctx.create('rect', { class: 'handle', 'data-handle': `artboard-${name}`, x: x - 4, y: y - 4, width: 8, height: 8 }, 'Resize the artboard; the drawing stays centered (Shift: keep proportions)');
      handle.style.cursor = `${CURSORS[name]}-resize`;
      ctx.overlay.append(handle);
    }
    if (measure) {
      const t = ctx.create('text', { class: 'artboard-size', x: measure.x + 14, y: measure.y - 10 });
      t.textContent = measure.text;
      ctx.overlay.append(t);
    }
  }

  function handle(e, name) {
    const [dx, dy] = HANDLES[name.slice('artboard-'.length)];
    const m = frame();
    // The center stays fixed on screen for the whole drag.
    const center = [m.x + m.w / 2, m.y + m.h / 2];
    const proportion = m.width / m.height;
    let size = null;

    ctx.drag(
      e,
      (ev) => {
        const [px, py] = ctx.screenPoint(ev);
        let width = dx ? Math.max(1, Math.round((2 * Math.abs(px - center[0])) / m.zoom)) : m.width;
        let height = dy ? Math.max(1, Math.round((2 * Math.abs(py - center[1])) / m.zoom)) : m.height;
        // Shift: keeps the proportion (on a side handle, the other side follows).
        if (ev.shiftKey) {
          if (dx && (!dy || width / m.width >= height / m.height)) height = Math.max(1, Math.round(width / proportion));
          else width = Math.max(1, Math.round(height * proportion));
        }
        size = [width, height];
        measure = { x: px, y: py, text: `${width} × ${height}` };
        preview(artboardOps(state.doc, schema, width, height));
      },
      () => {
        measure = null;
        if (!size || (size[0] === m.width && size[1] === m.height)) {
          preview(null);
          return ctx.redraw();
        }
        execute(artboardOps(state.doc, schema, ...size), `artboard ${size[0]} × ${size[1]}`);
      },
    );
  }

  return { draw, handle };
}
