// Lienzo: dibuja el documento, maneja la cámara (pan y zoom) y reparte los eventos entre las herramientas:
// seleccionar (con manijas), pluma, edición de puntos, creación de formas y huesos (con la pose activa, si hay).

import { buscar } from '../core/documento.js';
import { leerMeta } from '../core/esquema.js';
import { aplicar, invertir, matrizMundo, multiplicar } from '../core/geometria.js';
import { contenidoSvg } from '../render/svg.js';
import { avisar, docVisible, ejecutar, esquema, estado, fijar, idLibre, padreParaNuevo, seleccionar, suscribir } from './estado.js';
import { agregarImagenes, soloImagenes, urlDeAsset } from './imagenes.js';
import { crearArtboard } from './artboard.js';
import { crearHuesos } from './huesos.js';
import { clipAbierto, variantesAMostrar } from './edicion.js';
import { crearPluma } from './pluma.js';
import { crearPuntos } from './puntos.js';
import { crearTransformar, esLibre } from './transformar.js';

const NS = 'http://www.w3.org/2000/svg';
const redondear = (v) => Math.round(v * 10) / 10;

export function montarLienzo(contenedor) {
  const vista = contenedor.querySelector('#vista');
  const camaraG = vista.querySelector('#camara');
  const documentoG = vista.querySelector('#documento');
  const superposicion = vista.querySelector('#superposicion');
  const camara = { x: 0, y: 0, zoom: 1 };
  let ajustadoPara = null;
  let espacio = false;
  let mostrando = '{}'; // variantes de switch que se muestran por la selección
  let tamanoDibujado = null; // { id, w, h } del último dibujo: si cambia el tamaño, el centro queda quieto en pantalla

  // Lo que comparten las herramientas. "Pantalla" = píxeles dentro del lienzo, el espacio de la superposición.
  const ctx = {
    documentoG,
    superposicion,
    matrizCamara: () => [camara.zoom, 0, 0, camara.zoom, camara.x, camara.y],
    puntoPantalla: (e) => {
      const r = vista.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    },
    elemento: (id) => documentoG.querySelector(`[data-id="${CSS.escape(id)}"]`),
    crear(tipo, atributos, titulo) {
      const el = document.createElementNS(NS, tipo);
      for (const [k, v] of Object.entries(atributos)) if (v !== '') el.setAttribute(k, v);
      if (titulo) el.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: titulo }));
      return el;
    },
    arrastrar,
    redibujar: () => dibujarSuperposicion(),
  };
  const transformar = crearTransformar(ctx);
  const pluma = crearPluma(ctx);
  const puntos = crearPuntos(ctx);
  const huesos = crearHuesos(ctx);
  const artboard = crearArtboard(ctx);

  suscribir((c) => {
    if ('pose' in c) contenedor.classList.toggle('modo-pose', !!estado.pose);
    if ('params' in c) contenedor.classList.toggle('modo-params', !!estado.params && !estado.pose);
    if ('vivo' in c) contenedor.classList.toggle('en-vivo', estado.vivo);
    if ('doc' in c || 'previa' in c || 'pose' in c || 'params' in c || 'tiempo' in c || 'poseViva' in c) dibujarDocumento();
    // Seleccionar una variante oculta de un switch la muestra (solo en la vista): hay que redibujar el documento.
    else if ('seleccion' in c && JSON.stringify(variantesAMostrar()) !== mostrando) dibujarDocumento();
    else if ('seleccion' in c || 'edicion' in c || 'vertice' in c) dibujarSuperposicion();
    if ('herramienta' in c) {
      contenedor.className = `herramienta-${estado.herramienta}${estado.pose ? ' modo-pose' : ''}${estado.vivo ? ' en-vivo' : ''}`;
      if (estado.herramienta !== 'path' && pluma.activa()) pluma.terminar(false);
      if (estado.herramienta !== 'seleccionar' && estado.edicion) fijar({ edicion: null, vertice: null });
      dibujarSuperposicion();
    }
    // Salir de la edición de puntos si cambia la selección o el path desaparece.
    if (estado.edicion && ('seleccion' in c || 'doc' in c) && (estado.seleccion !== estado.edicion || estado.seleccionados.length > 1 || !buscar(estado.doc, estado.edicion))) {
      fijar({ edicion: null, vertice: null });
    }
    if ('id' in c && estado.doc && ajustadoPara !== estado.id) ajustar();
  });

  // Soltar imágenes sobre el lienzo: una capa image por archivo, donde se soltó.
  vista.addEventListener('dragover', (e) => {
    if (!estado.doc || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  vista.addEventListener('drop', (e) => {
    const archivos = soloImagenes(e.dataTransfer?.files);
    if (!estado.doc || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    if (!archivos.length) return avisar('Only PNG, JPG, WebP or SVG images can be dropped here.', true);
    agregarImagenes(archivos, aplicar(invertir(ctx.matrizCamara()), ...ctx.puntoPantalla(e)));
  });

  new ResizeObserver(() => estado.doc && (ajustadoPara === estado.id ? aplicarCamara() : ajustar())).observe(contenedor);

  // ---------- Dibujo ----------

  function dibujarDocumento() {
    const doc = docVisible();
    if (!doc) return documentoG.replaceChildren();
    const w = leerMeta(esquema, doc, 'width');
    const h = leerMeta(esquema, doc, 'height');
    // El tamaño cambia anclado al centro (core/tamano.js): la cámara se corre para que el centro no salte.
    if (tamanoDibujado?.id === estado.id && (tamanoDibujado.w !== w || tamanoDibujado.h !== h)) {
      camara.x -= ((w - tamanoDibujado.w) / 2) * camara.zoom;
      camara.y -= ((h - tamanoDibujado.h) / 2) * camara.zoom;
      camaraG.setAttribute('transform', `translate(${camara.x} ${camara.y}) scale(${camara.zoom})`);
    }
    tamanoDibujado = { id: estado.id, w, h };
    // Lo que se ve: la pose que se edita, la mezcla de los params (vista Parámetros) o el montaje.
    const clip = clipAbierto(doc);
    // Con Live encendido, lo que da el runtime en este cuadro (como lo vería la app).
    const vista = estado.vivo ? { pose: estado.poseViva } : clip ? { animation: clip.id, time: estado.tiempo, params: estado.params ?? {} } : estado.pose ? { pose: estado.pose } : estado.params ? { params: estado.params } : {};
    const mostrar = estado.vivo || (estado.params && !estado.pose) ? {} : variantesAMostrar(doc);
    mostrando = JSON.stringify(mostrar);
    documentoG.innerHTML = `${contenidoSvg(doc, esquema, { ...vista, mostrar, assets: (src) => urlDeAsset(src) })}<rect class="marco-documento" width="${w}" height="${h}" vector-effect="non-scaling-stroke"/>`;
    // Con candado: los clics pasan de largo (llegan a lo de abajo), y sus hijos lo heredan.
    for (const o of doc.objects) if (o.locked) ctx.elemento(o.id)?.style.setProperty('pointer-events', 'none');
    dibujarSuperposicion();
  }

  function dibujarSuperposicion() {
    superposicion.replaceChildren();
    if (!estado.doc) return;
    if (estado.edicion) {
      const el = ctx.elemento(estado.edicion);
      if (el) {
        // Contorno del path en edición, encima de todo.
        const contorno = el.querySelector(':scope > path')?.cloneNode();
        if (contorno) {
          const m = el.getCTM();
          contorno.setAttribute('class', 'contorno-edicion');
          contorno.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
          superposicion.append(contorno);
        }
      }
      puntos.dibujar();
    } else {
      // En una pose, las manijas solo salen para lo que no sigue a un hueso (transformar.dibujar lo decide).
      transformar.dibujar();
    }
    huesos.dibujar();
    pluma.dibujar();
    if (estado.herramienta === 'artboard') artboard.dibujar();
  }

  // ---------- Cámara ----------

  function aplicarCamara() {
    camaraG.setAttribute('transform', `translate(${camara.x} ${camara.y}) scale(${camara.zoom})`);
    document.querySelector('#zoom').textContent = `${Math.round(camara.zoom * 100)}%`;
    dibujarSuperposicion();
  }

  /** Zoom fijo, manteniendo el centro de la vista. */
  function fijarZoom(zoom) {
    const r = contenedor.getBoundingClientRect();
    const [cx, cy] = [r.width / 2, r.height / 2];
    camara.x = cx - ((cx - camara.x) * zoom) / camara.zoom;
    camara.y = cy - ((cy - camara.y) * zoom) / camara.zoom;
    camara.zoom = zoom;
    aplicarCamara();
  }

  function ajustar() {
    const r = contenedor.getBoundingClientRect();
    if (!r.width || !estado.doc) return;
    const w = leerMeta(esquema, estado.doc, 'width');
    const h = leerMeta(esquema, estado.doc, 'height');
    camara.zoom = Math.min((r.width - 60) / w, (r.height - 60) / h);
    camara.x = (r.width - w * camara.zoom) / 2;
    camara.y = (r.height - h * camara.zoom) / 2;
    ajustadoPara = estado.id;
    aplicarCamara();
  }

  vista.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const [mx, my] = ctx.puntoPantalla(e);
        const zoom = Math.min(20, Math.max(0.05, camara.zoom * Math.exp(-e.deltaY * 0.002)));
        camara.x = mx - ((mx - camara.x) * zoom) / camara.zoom;
        camara.y = my - ((my - camara.y) * zoom) / camara.zoom;
        camara.zoom = zoom;
      } else {
        camara.x -= e.shiftKey ? e.deltaY : e.deltaX;
        camara.y -= e.shiftKey ? 0 : e.deltaY;
      }
      aplicarCamara();
    },
    { passive: false },
  );

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !(/** @type {Element} */ (e.target)).closest('input, select, textarea')) {
      espacio = true;
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => e.code === 'Space' && (espacio = false));

  // Sigue el puntero hasta soltarlo.
  function arrastrar(e, mover, soltar) {
    try {
      vista.setPointerCapture(e.pointerId);
    } catch {
      // puntero que ya no está activo (o evento sintético): se sigue sin captura
    }
    const alSoltar = (ev) => {
      vista.removeEventListener('pointermove', mover);
      vista.removeEventListener('pointerup', alSoltar);
      vista.removeEventListener('pointercancel', alSoltar);
      soltar(ev);
    };
    vista.addEventListener('pointermove', mover);
    vista.addEventListener('pointerup', alSoltar);
    vista.addEventListener('pointercancel', alSoltar);
  }

  // ---------- Eventos ----------

  vista.addEventListener('pointerdown', (e) => {
    contenedor.focus();
    if (!estado.doc) return;
    if (e.button === 1 || (e.button === 0 && espacio)) return panear(e);
    if (e.button !== 0) return;
    const manija = e.target.closest('[data-manija]')?.dataset.manija;
    if (manija?.startsWith('hueso-')) return huesos.manija(e, manija);
    if (manija?.startsWith('artboard-')) return artboard.manija(e, manija);
    // Artboard: el lienzo queda elegido (el inspector muestra sus propiedades); fuera de las manijas no hace nada.
    if (estado.herramienta === 'artboard') return estado.seleccion && seleccionar(null);
    if (manija) return estado.edicion ? puntos.manija(e, manija) : transformar.manija(e, manija);
    // Con una pose activa, el lienzo posa: se giran huesos (o el dibujo a través de su hueso).
    // Lo que no sigue a un hueso se elige, mueve, gira y escala como en el montaje; queda en la pose (o en el clip).
    if (estado.pose) {
      const g = e.target.closest('[data-id]');
      if (g && documentoG.contains(g) && !e.target.closest('[data-hueso]') && esLibre(estado.doc, g.dataset.id)) return transformar.seleccionarYMover(e);
      return huesos.pointerdownPose(e);
    }
    // En la vista Parámetros se mira la mezcla: un clic solo selecciona.
    if (estado.params) {
      const g = e.target.closest('[data-id]');
      return seleccionar(g && documentoG.contains(g) ? g.dataset.id : null);
    }
    if (estado.herramienta === 'hueso') return huesos.pointerdown(e);
    if (estado.herramienta === 'manipular') return huesos.pointerdownManipular(e);
    if (estado.herramienta === 'reparentar') return huesos.pointerdownReparentar(e);
    if (estado.herramienta === 'enlazarCapa') return huesos.pointerdownEnlazarCapa(e);
    if (estado.herramienta === 'enlazarPuntos') return huesos.pointerdownEnlazarPuntos(e);
    if (estado.herramienta === 'path') return pluma.pointerdown(e);
    if (estado.herramienta === 'rotar' || estado.herramienta === 'escalar') return transformar.conHerramienta(e, estado.herramienta);
    if (estado.herramienta === 'rect' || estado.herramienta === 'ellipse') return crearForma(e, estado.herramienta);
    if (estado.edicion) {
      if (puntos.pointerdown(e)) return;
      fijar({ edicion: null, vertice: null });
    }
    transformar.seleccionarYMover(e);
  });

  vista.addEventListener('pointermove', (e) => estado.herramienta === 'path' && pluma.hover(e));

  vista.addEventListener('dblclick', (e) => {
    if (estado.herramienta !== 'seleccionar') return;
    // Por la captura del puntero, el doble clic llega a la vista: se busca qué hay debajo.
    const debajo = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
    const manija = debajo.closest('[data-manija^="ancla-"]')?.dataset.manija;
    if (manija && estado.edicion) return puntos.alternar(Number(manija.split('-')[1]));
    const g = debajo.closest('[data-id]');
    const obj = g && documentoG.contains(g) && buscar(estado.doc, g.dataset.id);
    if (obj?.type === 'path') editarPuntos(obj.id);
  });

  function panear(e) {
    e.preventDefault();
    contenedor.classList.add('paneando');
    const inicio = { x: e.clientX - camara.x, y: e.clientY - camara.y };
    arrastrar(
      e,
      (ev) => {
        camara.x = ev.clientX - inicio.x;
        camara.y = ev.clientY - inicio.y;
        aplicarCamara();
      },
      () => contenedor.classList.remove('paneando'),
    );
  }

  function crearForma(e, tipo) {
    const padre = padreParaNuevo();
    const inversa = invertir(multiplicar(ctx.matrizCamara(), matrizMundo(estado.doc, esquema, padre)));
    const s0 = ctx.puntoPantalla(e);
    const borrador = ctx.crear(tipo === 'ellipse' ? 'ellipse' : 'rect', { class: 'borrador' });
    superposicion.append(borrador);

    const caja = (ev) => {
      const s = ctx.puntoPantalla(ev);
      let dx = s[0] - s0[0];
      let dy = s[1] - s0[1];
      // Shift: cuadrado o círculo.
      if (ev.shiftKey) {
        const lado = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * lado;
        dy = Math.sign(dy || 1) * lado;
      }
      return { x: Math.min(s0[0], s0[0] + dx), y: Math.min(s0[1], s0[1] + dy), w: Math.abs(dx), h: Math.abs(dy), fin: [s0[0] + dx, s0[1] + dy] };
    };

    arrastrar(
      e,
      (ev) => {
        const c = caja(ev);
        const atributos = tipo === 'ellipse' ? { cx: c.x + c.w / 2, cy: c.y + c.h / 2, rx: c.w / 2, ry: c.h / 2 } : { x: c.x, y: c.y, width: c.w, height: c.h };
        for (const [k, v] of Object.entries(atributos)) borrador.setAttribute(k, v);
      },
      (ev) => {
        borrador.remove();
        const c = caja(ev);
        const [ax, ay] = aplicar(inversa, ...s0);
        const [bx, by] = aplicar(inversa, ...c.fin);
        const props =
          c.w < 4 && c.h < 4
            ? { x: redondear(ax), y: redondear(ay) }
            : { x: redondear((ax + bx) / 2), y: redondear((ay + by) / 2), width: redondear(Math.abs(bx - ax)), height: redondear(Math.abs(by - ay)) };
        const id = idLibre(tipo);
        ejecutar([{ op: 'create', type: tipo, id, parent: padre, props }], `create ${id}`);
        fijar({ herramienta: 'seleccionar' });
        seleccionar(id);
      },
    );
  }

  function editarPuntos(id) {
    fijar({ herramienta: 'seleccionar', seleccion: id, seleccionados: [id], edicion: id, vertice: null });
  }

  return {
    ajustar,
    fijarZoom,
    editarPuntos,
    pluma,
    puntos,
  };
}
