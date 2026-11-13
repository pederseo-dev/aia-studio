// Lienzo: dibuja el documento, maneja la cámara (pan y zoom) y reparte los eventos entre las herramientas:
// seleccionar (con manijas), pluma, edición de puntos, creación de formas y huesos (con la pose activa, si hay).

import { findObject } from '../core/document.js';
import { readMeta } from '../core/schema.js';
import { apply, invert, worldMatrix, multiply } from '../core/geometry.js';
import { svgContent } from '../render/svg.js';
import { notify, docVisible, execute, schema, state, setState, freeId, parentForNew, select, subscribe } from './state.js';
import { addImages, imagesOnly, assetUrl } from './images.js';
import { createArtboard } from './artboard.js';
import { createBones } from './bones.js';
import { openedClip, variantsToShow } from './editing.js';
import { createPen } from './pen.js';
import { createPoints } from './points.js';
import { createTransform, isFree } from './transform.js';

const NS = 'http://www.w3.org/2000/svg';
const round = (v) => Math.round(v * 10) / 10;

export function mountCanvas(container) {
  const view = container.querySelector('#vista');
  const cameraG = view.querySelector('#camara');
  const documentG = view.querySelector('#documento');
  const overlay = view.querySelector('#superposicion');
  const camera = { x: 0, y: 0, zoom: 1 };
  let adjustedFor = null;
  let space = false;
  let showing = '{}'; // variantes de switch que se muestran por la selección
  let drawnSize = null; // { id, w, h } del último dibujo: si cambia el tamaño, el centro queda quieto en pantalla

  // Lo que comparten las herramientas. "Pantalla" = píxeles dentro del lienzo, el espacio de la superposición.
  const ctx = {
    documentG,
    overlay,
    cameraMatrix: () => [camera.zoom, 0, 0, camera.zoom, camera.x, camera.y],
    screenPoint: (e) => {
      const r = view.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    },
    element: (id) => documentG.querySelector(`[data-id="${CSS.escape(id)}"]`),
    crear(kind, attributes, title) {
      const el = document.createElementNS(NS, kind);
      for (const [k, v] of Object.entries(attributes)) if (v !== '') el.setAttribute(k, v);
      if (title) el.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: title }));
      return el;
    },
    drag,
    redraw: () => drawOverlay(),
  };
  const transform = createTransform(ctx);
  const pen = createPen(ctx);
  const points = createPoints(ctx);
  const bones = createBones(ctx);
  const artboard = createArtboard(ctx);

  subscribe((c) => {
    if ('pose' in c) container.classList.toggle('modo-pose', !!state.pose);
    if ('params' in c) container.classList.toggle('modo-params', !!state.params && !state.pose);
    if ('live' in c) container.classList.toggle('en-vivo', state.live);
    if ('doc' in c || 'previewDoc' in c || 'pose' in c || 'params' in c || 'time' in c || 'livePose' in c) drawDocument();
    // Seleccionar una variante oculta de un switch la muestra (solo en la vista): hay que redibujar el documento.
    else if ('selection' in c && JSON.stringify(variantsToShow()) !== showing) drawDocument();
    else if ('selection' in c || 'editing' in c || 'vertex' in c) drawOverlay();
    if ('tool' in c) {
      container.className = `herramienta-${state.tool}${state.pose ? ' modo-pose' : ''}${state.live ? ' en-vivo' : ''}`;
      if (state.tool !== 'path' && pen.active()) pen.finish(false);
      if (state.tool !== 'seleccionar' && state.editing) setState({ editing: null, vertex: null });
      drawOverlay();
    }
    // Salir de la edición de puntos si cambia la selección o el path desaparece.
    if (state.editing && ('selection' in c || 'doc' in c) && (state.selection !== state.editing || state.selected.length > 1 || !findObject(state.doc, state.editing))) {
      setState({ editing: null, vertex: null });
    }
    if ('id' in c && state.doc && adjustedFor !== state.id) adjust();
  });

  // Soltar imágenes sobre el lienzo: una capa image por archivo, donde se soltó.
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

  // ---------- Dibujo ----------

  function drawDocument() {
    const doc = docVisible();
    if (!doc) return documentG.replaceChildren();
    const w = readMeta(schema, doc, 'width');
    const h = readMeta(schema, doc, 'height');
    // El tamaño cambia anclado al centro (core/tamano.js): la cámara se corre para que el centro no salte.
    if (drawnSize?.id === state.id && (drawnSize.w !== w || drawnSize.h !== h)) {
      camera.x -= ((w - drawnSize.w) / 2) * camera.zoom;
      camera.y -= ((h - drawnSize.h) / 2) * camera.zoom;
      cameraG.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`);
    }
    drawnSize = { id: state.id, w, h };
    // Lo que se ve: la pose que se edita, la mezcla de los params (vista Parámetros) o el montaje.
    const clip = openedClip(doc);
    // Con Live encendido, lo que da el runtime en este cuadro (como lo vería la app).
    const view = state.live ? { pose: state.livePose } : clip ? { animation: clip.id, time: state.time, params: state.params ?? {} } : state.pose ? { pose: state.pose } : state.params ? { params: state.params } : {};
    const show = state.live || (state.params && !state.pose) ? {} : variantsToShow(doc);
    showing = JSON.stringify(show);
    documentG.innerHTML = `${svgContent(doc, schema, { ...view, show, assets: (src) => assetUrl(src) })}<rect class="marco-documento" width="${w}" height="${h}" vector-effect="non-scaling-stroke"/>`;
    // Con candado: los clics pasan de largo (llegan a lo de abajo), y sus hijos lo heredan.
    for (const o of doc.objects) if (o.locked) ctx.element(o.id)?.style.setProperty('pointer-events', 'none');
    drawOverlay();
  }

  function drawOverlay() {
    overlay.replaceChildren();
    if (!state.doc) return;
    if (state.editing) {
      const el = ctx.element(state.editing);
      if (el) {
        // Contorno del path en edición, encima de todo.
        const outline = el.querySelector(':scope > path')?.cloneNode();
        if (outline) {
          const m = el.getCTM();
          outline.setAttribute('class', 'contorno-edicion');
          outline.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
          overlay.append(outline);
        }
      }
      points.draw();
    } else {
      // En una pose, las manijas solo salen para lo que no sigue a un hueso (transformar.dibujar lo decide).
      transform.draw();
    }
    bones.draw();
    pen.draw();
    if (state.tool === 'artboard') artboard.draw();
  }

  // ---------- Cámara ----------

  function applyCamera() {
    cameraG.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`);
    document.querySelector('#zoom').textContent = `${Math.round(camera.zoom * 100)}%`;
    drawOverlay();
  }

  /** Zoom fijo, manteniendo el centro de la vista. */
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

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(/** @type {Element} */ (e.target)).closest('input, select, textarea')) {
      space = true;
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => e.code === 'Space' && (space = false));

  // Sigue el puntero hasta soltarlo.
  function drag(e, move, release) {
    try {
      view.setPointerCapture(e.pointerId);
    } catch {
      // puntero que ya no está activo (o evento sintético): se sigue sin captura
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

  // ---------- Eventos ----------

  view.addEventListener('pointerdown', (e) => {
    container.focus();
    if (!state.doc) return;
    if (e.button === 1 || (e.button === 0 && space)) return pan(e);
    if (e.button !== 0) return;
    const handle = e.target.closest('[data-manija]')?.dataset.manija;
    if (handle?.startsWith('hueso-')) return bones.handle(e, handle);
    if (handle?.startsWith('artboard-')) return artboard.handle(e, handle);
    // Artboard: el lienzo queda elegido (el inspector muestra sus propiedades); fuera de las manijas no hace nada.
    if (state.tool === 'artboard') return state.selection && select(null);
    if (handle) return state.editing ? points.handle(e, handle) : transform.handle(e, handle);
    // Con una pose activa, el lienzo posa: se giran huesos (o el dibujo a través de su hueso).
    // Lo que no sigue a un hueso se elige, mueve, gira y escala como en el montaje; queda en la pose (o en el clip).
    if (state.pose) {
      const g = e.target.closest('[data-id]');
      if (g && documentG.contains(g) && !e.target.closest('[data-hueso]') && isFree(state.doc, g.dataset.id)) return transform.selectAndMove(e);
      return bones.pointerdownPose(e);
    }
    // En la vista Parámetros se mira la mezcla: un clic solo selecciona.
    if (state.params) {
      const g = e.target.closest('[data-id]');
      return select(g && documentG.contains(g) ? g.dataset.id : null);
    }
    if (state.tool === 'hueso') return bones.pointerdown(e);
    if (state.tool === 'manipular') return bones.pointerdownManipulate(e);
    if (state.tool === 'reparentar') return bones.pointerdownReparent(e);
    if (state.tool === 'enlazarCapa') return bones.pointerdownBindLayer(e);
    if (state.tool === 'enlazarPuntos') return bones.pointerdownBindPoints(e);
    if (state.tool === 'path') return pen.pointerdown(e);
    if (state.tool === 'rotar' || state.tool === 'escalar') return transform.withTool(e, state.tool);
    if (state.tool === 'rect' || state.tool === 'ellipse') return createShape(e, state.tool);
    if (state.editing) {
      if (points.pointerdown(e)) return;
      setState({ editing: null, vertex: null });
    }
    transform.selectAndMove(e);
  });

  view.addEventListener('pointermove', (e) => state.tool === 'path' && pen.hover(e));

  view.addEventListener('dblclick', (e) => {
    if (state.tool !== 'seleccionar') return;
    // Por la captura del puntero, el doble clic llega a la vista: se busca qué hay debajo.
    const below = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
    const handle = below.closest('[data-manija^="ancla-"]')?.dataset.manija;
    if (handle && state.editing) return points.toggle(Number(handle.split('-')[1]));
    const g = below.closest('[data-id]');
    const obj = g && documentG.contains(g) && findObject(state.doc, g.dataset.id);
    if (obj?.type === 'path') editPoints(obj.id);
  });

  function pan(e) {
    e.preventDefault();
    container.classList.add('paneando');
    const start = { x: e.clientX - camera.x, y: e.clientY - camera.y };
    drag(
      e,
      (ev) => {
        camera.x = ev.clientX - start.x;
        camera.y = ev.clientY - start.y;
        applyCamera();
      },
      () => container.classList.remove('paneando'),
    );
  }

  function createShape(e, kind) {
    const parent = parentForNew();
    const inverse = invert(multiply(ctx.cameraMatrix(), worldMatrix(state.doc, schema, parent)));
    const s0 = ctx.screenPoint(e);
    const draft = ctx.crear(kind === 'ellipse' ? 'ellipse' : 'rect', { class: 'borrador' });
    overlay.append(draft);

    const box = (ev) => {
      const s = ctx.screenPoint(ev);
      let dx = s[0] - s0[0];
      let dy = s[1] - s0[1];
      // Shift: cuadrado o círculo.
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
        const [ax, ay] = apply(inverse, ...s0);
        const [bx, by] = apply(inverse, ...c.end);
        const props =
          c.w < 4 && c.h < 4
            ? { x: round(ax), y: round(ay) }
            : { x: round((ax + bx) / 2), y: round((ay + by) / 2), width: round(Math.abs(bx - ax)), height: round(Math.abs(by - ay)) };
        const id = freeId(kind);
        execute([{ op: 'create', type: kind, id, parent: parent, props }], `create ${id}`);
        setState({ tool: 'seleccionar' });
        select(id);
      },
    );
  }

  function editPoints(id) {
    setState({ tool: 'seleccionar', selection: id, selected: [id], editing: id, vertex: null });
  }

  return {
    adjust,
    setZoom,
    editPoints,
    pen,
    points,
  };
}
