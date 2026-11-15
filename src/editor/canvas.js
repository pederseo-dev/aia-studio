// Canvas: draws the document, handles the camera (pan and zoom) and dispatches events among the tools:
// select (with handles), pen, point editing, creating shapes and bones (with the active pose, if any).

import { findObject } from '../core/document.js';
import { readMeta } from '../core/schema.js';
import { apply, invert } from '../core/geometry.js';
import { svgContent } from '../render/svg.js';
import { parseD } from '../core/paths.js';
import { ellipseD, rectD } from '../core/mesh.js';
import { commitShape, drawingTarget } from './drawing.js';
import { notify, docVisible, schema, state, setState, select, subscribe, pickable } from './state.js';
import { addImages, imagesOnly, assetUrl } from './images.js';
import { createArtboard } from './artboard.js';
import { createBones, bindPicked } from './bones.js';
import { openedClip, variantsToShow } from './editing.js';
import { createPen } from './pen.js';
import { createPoints } from './points.js';
import { createTransform, isFree } from './transform.js';
import { createShapePoints } from './shapePoints.js';
import { togglePlayback } from './timeline.js';

const NS = 'http://www.w3.org/2000/svg';

export function mountCanvas(container) {
  const view = container.querySelector('#view');
  const cameraG = view.querySelector('#camera');
  const documentG = view.querySelector('#document');
  const overlay = view.querySelector('#overlay');
  const camera = { x: 0, y: 0, zoom: 1 };
  let adjustedFor = null;
  let space = false;
  let showing = '{}'; // switch variants that are shown because of the selection
  let drawnSize = null; // { id, w, h } of the last draw: if the size changes, the center stays still on screen

  // What the tools share. "Screen" = pixels inside the canvas, the overlay's space.
  const ctx = {
    documentG,
    overlay,
    cameraMatrix: () => [camera.zoom, 0, 0, camera.zoom, camera.x, camera.y],
    screenPoint: (e) => {
      const r = view.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    },
    element: (id) => documentG.querySelector(`[data-id="${CSS.escape(id)}"]`),
    create(kind, attributes, title) {
      const el = document.createElementNS(NS, kind);
      for (const [k, v] of Object.entries(attributes)) if (v !== '') el.setAttribute(k, v);
      if (title) el.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: title }));
      return el;
    },
    drag,
    redraw: () => drawOverlay(),
  };
  const transform = createTransform(ctx);
  const shapePoints = createShapePoints(ctx);
  const pen = createPen(ctx);
  const points = createPoints(ctx);
  const bones = createBones(ctx);
  const artboard = createArtboard(ctx);

  subscribe((c) => {
    if ('pose' in c) container.classList.toggle('mode-pose', !!state.pose);
    if ('params' in c) container.classList.toggle('mode-params', !!state.params && !state.pose);
    if ('live' in c) container.classList.toggle('in-live', state.live);
    if ('doc' in c || 'previewDoc' in c || 'pose' in c || 'params' in c || 'time' in c || 'livePose' in c) drawDocument();
    // Selecting a hidden variant of a switch shows it (only in the view): the document must be redrawn.
    else if ('selection' in c && JSON.stringify(variantsToShow()) !== showing) drawDocument();
    else if ('selection' in c || 'editing' in c || 'vertex' in c || 'bindTarget' in c || 'bindPicked' in c) drawOverlay();
    if ('tool' in c) {
      container.className = `tool-${state.tool}${state.pose ? ' mode-pose' : ''}${state.live ? ' in-live' : ''}`;
      if (state.tool !== 'path' && pen.active()) pen.finish(false);
      if (state.tool !== 'select' && state.editing) setState({ editing: null, vertex: null });
      drawOverlay();
    }
    // Leave point editing if the selection changes or the path disappears.
    if (state.editing && ('selection' in c || 'doc' in c) && (state.selection !== state.editing || state.selected.length > 1 || !findObject(state.doc, state.editing))) {
      setState({ editing: null, vertex: null });
    }
    if ('id' in c && state.doc && adjustedFor !== state.id) adjust();
  });

  // Dropping images on the canvas: one image layer per file, where it was dropped.
  view.addEventListener('dragover', (e) => {
    if (!state.doc || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  view.addEventListener('drop', (e) => {
    const files = imagesOnly(e.dataTransfer?.files);
    if (!state.doc || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (!files.length) return notify('Only PNG, JPG, WebP or SVG images can be dropped here.', true);
    addImages(files, apply(invert(ctx.cameraMatrix()), ...ctx.screenPoint(e)));
  });

  new ResizeObserver(() => state.doc && (adjustedFor === state.id ? applyCamera() : adjust())).observe(container);

  // ---------- Drawing ----------

  function drawDocument() {
    const doc = docVisible();
    if (!doc) return documentG.replaceChildren();
    const w = readMeta(schema, doc, 'width');
    const h = readMeta(schema, doc, 'height');
    // The size changes anchored to the center (core/artboard.js): the camera shifts so the center does not jump.
    if (drawnSize?.id === state.id && (drawnSize.w !== w || drawnSize.h !== h)) {
      camera.x -= ((w - drawnSize.w) / 2) * camera.zoom;
      camera.y -= ((h - drawnSize.h) / 2) * camera.zoom;
      cameraG.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`);
    }
    drawnSize = { id: state.id, w, h };
    // What is seen: the pose being edited, the blend of the params (Parameters view) or the setup.
    const clip = openedClip(doc);
    // With Live on, what the runtime gives in this frame (as the app would see it).
    const view = state.live ? { pose: state.livePose } : clip ? { animation: clip.id, time: state.time, params: state.params ?? {} } : state.pose ? { pose: state.pose } : state.params ? { params: state.params } : {};
    const show = state.live || (state.params && !state.pose) ? {} : variantsToShow(doc);
    showing = JSON.stringify(show);
    documentG.innerHTML = `${svgContent(doc, schema, { ...view, show, assets: (src) => assetUrl(src) })}<rect class="document-frame" width="${w}" height="${h}" vector-effect="non-scaling-stroke"/>`;
    // Locked: clicks pass through (they reach what is below), and its children inherit it.
    for (const o of doc.objects) if (o.locked) ctx.element(o.id)?.style.setProperty('pointer-events', 'none');
    drawOverlay();
  }

  function drawOverlay() {
    overlay.replaceChildren();
    if (!state.doc) return;
    if (state.editing) {
      const el = ctx.element(state.editing);
      if (el) {
        // Outline of the path being edited, on top of everything.
        const outline = el.querySelector(':scope > path')?.cloneNode();
        if (outline) {
          const m = el.getCTM();
          outline.setAttribute('class', 'editing-outline');
          outline.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
          overlay.append(outline);
        }
      }
      points.draw();
    } else if (state.tool !== 'bindPoints') {
      // In a pose, handles only appear for what does not follow a bone (transform.draw decides). Bind Points shows
      // the layer's points instead (bones.draw).
      transform.draw();
      shapePoints.draw();
    }
    bones.draw();
    pen.draw();
    if (state.tool === 'artboard') artboard.draw();
  }

  // ---------- Camera ----------

  function applyCamera() {
    cameraG.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`);
    document.querySelector('#zoom').textContent = `${Math.round(camera.zoom * 100)}%`;
    drawOverlay();
  }

  /** Fixed zoom, keeping the center of the view. */
  function setZoom(zoom) {
    const r = container.getBoundingClientRect();
    const [cx, cy] = [r.width / 2, r.height / 2];
    camera.x = cx - ((cx - camera.x) * zoom) / camera.zoom;
    camera.y = cy - ((cy - camera.y) * zoom) / camera.zoom;
    camera.zoom = zoom;
    applyCamera();
  }

  function adjust() {
    const r = container.getBoundingClientRect();
    if (!r.width || !state.doc) return;
    const w = readMeta(schema, state.doc, 'width');
    const h = readMeta(schema, state.doc, 'height');
    camera.zoom = Math.min((r.width - 60) / w, (r.height - 60) / h);
    camera.x = (r.width - w * camera.zoom) / 2;
    camera.y = (r.height - h * camera.zoom) / 2;
    adjustedFor = state.id;
    applyCamera();
  }

  view.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const [mx, my] = ctx.screenPoint(e);
        const zoom = Math.min(20, Math.max(0.05, camera.zoom * Math.exp(-e.deltaY * 0.002)));
        camera.x = mx - ((mx - camera.x) * zoom) / camera.zoom;
        camera.y = my - ((my - camera.y) * zoom) / camera.zoom;
        camera.zoom = zoom;
      } else {
        camera.x -= e.shiftKey ? e.deltaY : e.deltaX;
        camera.y -= e.shiftKey ? 0 : e.deltaY;
      }
      applyCamera();
    },
    { passive: false },
  );

  // Space held + drag pans; a tap (no pan while it was held) plays or pauses the timeline.
  let panned = false;
  window.addEventListener('keydown', (e) => {
    // Not in fields, on buttons (Space presses them) or with a dialog open.
    if (e.code === 'Space' && !(/** @type {Element} */ (e.target)).closest?.('input, select, textarea, button, dialog') && !document.querySelector('dialog[open]')) {
      if (!space) panned = false;
      space = true;
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !space) return;
    space = false;
    e.preventDefault();
    if (panned) return;
    // Bind Points (as in Moho): Space binds the picked points to the picked bone.
    if (state.tool === 'bindPoints' && !state.pose && state.bindPicked.length) {
      const bone = state.selection && findObject(state.doc, state.selection);
      if (bone?.type === 'bone') bindPicked(bone.id);
      else notify('Bind Points: click the bone the picked points should follow, then press Space', true);
      return;
    }
    togglePlayback();
  });

  // Follows the pointer until it is released.
  function drag(e, move, release) {
    try {
      view.setPointerCapture(e.pointerId);
    } catch {
      // pointer that is no longer active (or synthetic event): it is followed without capture
    }
    const onRelease = (ev) => {
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', onRelease);
      view.removeEventListener('pointercancel', onRelease);
      release(ev);
    };
    view.addEventListener('pointermove', move);
    view.addEventListener('pointerup', onRelease);
    view.addEventListener('pointercancel', onRelease);
  }

  // ---------- Events ----------

  view.addEventListener('pointerdown', (e) => {
    container.focus();
    if (!state.doc) return;
    if (e.button === 1 || (e.button === 0 && space)) return pan(e);
    if (e.button !== 0) return;
    const handle = e.target.closest('[data-handle]')?.dataset.handle;
    if (handle?.startsWith('bone')) return bones.handle(e, handle);
    if (handle?.startsWith('artboard-')) return artboard.handle(e, handle);
    // Artboard: the canvas stays picked (the inspector shows its properties); outside the handles it does nothing.
    if (state.tool === 'artboard') return state.selection && select(null);
    if (handle?.startsWith('sp-')) return shapePoints.handle(e, handle);
    if (handle) return state.editing ? points.handle(e, handle) : transform.handle(e, handle);
    // Dragging the picked shape moves its points (Transform Points), in the setup or in the open pose or clip.
    const hit = e.target.closest('[data-id]');
    if (shapePoints.active() && hit?.dataset.id === state.selection && !(e.ctrlKey || e.metaKey || e.shiftKey)) return shapePoints.move(e);
    // With an active pose, the canvas poses: bones are rotated (or the drawing through its bone).
    // What follows no bone is picked, moved, rotated and scaled as in the setup; it stays in the pose (or the clip).
    if (state.pose) {
      const g = e.target.closest('[data-id]');
      if (g && documentG.contains(g) && !e.target.closest('[data-bone]') && isFree(state.doc, pickable(g.dataset.id))) return transform.selectAndMove(e);
      return bones.pointerdownPose(e);
    }
    // In the Parameters view the blend is viewed: a click only selects.
    if (state.params) {
      const g = e.target.closest('[data-id]');
      return select(g && documentG.contains(g) ? pickable(g.dataset.id) : null);
    }
    if (state.tool === 'bone') return bones.pointerdown(e);
    if (state.tool === 'manipulate') return bones.pointerdownManipulate(e);
    if (state.tool === 'reparent') return bones.pointerdownReparent(e);
    if (state.tool === 'bindLayer') return bones.pointerdownBindLayer(e);
    if (state.tool === 'bindPoints') return bones.pointerdownBindPoints(e);
    if (state.tool === 'path') return pen.pointerdown(e);
    if (state.tool === 'rotate' || state.tool === 'scale') return transform.withTool(e, state.tool);
    if (state.tool === 'rect' || state.tool === 'ellipse') return createShape(e, state.tool);
    if (state.editing) {
      if (points.pointerdown(e)) return;
      setState({ editing: null, vertex: null });
    }
    transform.selectAndMove(e);
  });

  view.addEventListener('pointermove', (e) => state.tool === 'path' && pen.hover(e));

  view.addEventListener('dblclick', (e) => {
    if (state.tool !== 'select') return;
    // Because of pointer capture, the double click reaches the view: what is below is looked up.
    const below = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
    const handle = below.closest('[data-handle^="anchor"]')?.dataset.handle;
    if (handle && state.editing) return points.toggle(Number(handle.split('-')[1]));
    // The drawing below the handles: the first click picked the layer, whose pivot and box may cover the shape.
    const drawn = document.elementsFromPoint(e.clientX, e.clientY).find((el) => documentG.contains(el) && el.closest('[data-id]'));
    const g = (drawn ?? below).closest('[data-id]');
    const obj = g && documentG.contains(g) && findObject(state.doc, g.dataset.id);
    if (obj?.type === 'path') editPoints(obj.id);
    // As in Moho's Select Shape: a double click picks the shape inside the vector layer (its fill and stroke).
    if (obj?.type === 'shape') select(obj.id);
  });

  function pan(e) {
    e.preventDefault();
    panned = true;
    container.classList.add('panning');
    const start = { x: e.clientX - camera.x, y: e.clientY - camera.y };
    drag(
      e,
      (ev) => {
        camera.x = ev.clientX - start.x;
        camera.y = ev.clientY - start.y;
        applyCamera();
      },
      () => container.classList.remove('panning'),
    );
  }

  /** Rectangle and Ellipse: drag a box; the shape goes into the active vector layer (or a new one), as in Moho. */
  function createShape(e, kind) {
    const target = drawingTarget(ctx);
    const s0 = ctx.screenPoint(e);
    const draft = ctx.create(kind === 'ellipse' ? 'ellipse' : 'rect', { class: 'draft' });
    overlay.append(draft);

    const box = (ev) => {
      const s = ctx.screenPoint(ev);
      let dx = s[0] - s0[0];
      let dy = s[1] - s0[1];
      // Shift: square or circle.
      if (ev.shiftKey) {
        const side = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * side;
        dy = Math.sign(dy || 1) * side;
      }
      return { x: Math.min(s0[0], s0[0] + dx), y: Math.min(s0[1], s0[1] + dy), w: Math.abs(dx), h: Math.abs(dy), end: [s0[0] + dx, s0[1] + dy] };
    };

    drag(
      e,
      (ev) => {
        const c = box(ev);
        const attributes = kind === 'ellipse' ? { cx: c.x + c.w / 2, cy: c.y + c.h / 2, rx: c.w / 2, ry: c.h / 2 } : { x: c.x, y: c.y, width: c.w, height: c.h };
        for (const [k, v] of Object.entries(attributes)) draft.setAttribute(k, v);
      },
      (ev) => {
        draft.remove();
        const c = box(ev);
        // A click without dragging draws a 100 × 100 shape there (as the default size of the old rect/ellipse).
        const [ax, ay] = apply(target.toLocal, ...s0);
        const [bx, by] = c.w < 4 && c.h < 4 ? [ax + 100, ay + 100] : apply(target.toLocal, ...c.end);
        const [x, y, w, h] = c.w < 4 && c.h < 4 ? [ax - 50, ay - 50, 100, 100] : [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
        const d = kind === 'ellipse' ? ellipseD(x + w / 2, y + h / 2, w / 2, h / 2) : rectD(x, y, w, h);
        commitShape(target, parseD(d));
      },
    );
  }

  function editPoints(id) {
    setState({ tool: 'select', selection: id, selected: [id], editing: id, vertex: null });
  }

  return {
    adjust,
    setZoom,
    editPoints,
    shapePoints,
    pen,
    points,
  };
}
