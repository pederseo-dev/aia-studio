// Lienzo: dibuja el documento, maneja la cámara (pan y zoom) y las herramientas de seleccionar, mover y crear formas.

import { buscar } from '../core/documento.js';
import { leer, leerMeta } from '../core/esquema.js';
import { aplicar, invertir, matrizMundo } from '../core/geometria.js';
import { contenidoSvg } from '../render/svg.js';
import { docVisible, ejecutar, esquema, estado, fijar, idLibre, padreParaNuevo, previsualizar, seleccionar, suscribir } from './estado.js';

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

  suscribir((c) => {
    if ('doc' in c || 'previa' in c) dibujarDocumento();
    else if ('seleccion' in c) dibujarSuperposicion();
    if ('herramienta' in c) contenedor.className = `herramienta-${estado.herramienta}`;
    if ('id' in c && estado.doc && ajustadoPara !== estado.id) ajustar();
  });

  new ResizeObserver(() => estado.doc && (ajustadoPara === estado.id ? aplicarCamara() : ajustar())).observe(contenedor);

  // ---------- Dibujo ----------

  function dibujarDocumento() {
    const doc = docVisible();
    if (!doc) return documentoG.replaceChildren();
    const w = leerMeta(esquema, doc, 'width');
    const h = leerMeta(esquema, doc, 'height');
    documentoG.innerHTML = `${contenidoSvg(doc, esquema)}<rect class="marco-documento" width="${w}" height="${h}" vector-effect="non-scaling-stroke"/>`;
    dibujarSuperposicion();
  }

  function dibujarSuperposicion() {
    superposicion.replaceChildren();
    const el = estado.seleccion && documentoG.querySelector(`[data-id="${CSS.escape(estado.seleccion)}"]`);
    if (!el) return;
    const m = el.getCTM();
    const punto = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    const caja = el.getBBox();
    if (caja.width || caja.height) {
      const esquinas = [
        punto(caja.x, caja.y),
        punto(caja.x + caja.width, caja.y),
        punto(caja.x + caja.width, caja.y + caja.height),
        punto(caja.x, caja.y + caja.height),
      ];
      superposicion.append(crear('polygon', { class: 'seleccion', points: esquinas.map((p) => p.join(',')).join(' ') }));
    }
    const [px, py] = punto(0, 0);
    superposicion.append(crear('circle', { class: 'pivote', cx: px, cy: py, r: 4 }));
  }

  function crear(tipo, atributos) {
    const el = document.createElementNS(NS, tipo);
    for (const [k, v] of Object.entries(atributos)) el.setAttribute(k, v);
    return el;
  }

  // ---------- Cámara ----------

  function aplicarCamara() {
    camaraG.setAttribute('transform', `translate(${camara.x} ${camara.y}) scale(${camara.zoom})`);
    document.querySelector('#zoom').textContent = `${Math.round(camara.zoom * 100)}%`;
    dibujarSuperposicion();
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

  const pantallaADoc = (e) => {
    const r = vista.getBoundingClientRect();
    return [(e.clientX - r.left - camara.x) / camara.zoom, (e.clientY - r.top - camara.y) / camara.zoom];
  };

  vista.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = vista.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
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
    if (e.code === 'Space' && !e.target.closest('input, select, textarea')) {
      espacio = true;
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => e.code === 'Space' && (espacio = false));

  // Sigue el puntero hasta soltarlo.
  function arrastrar(e, mover, soltar) {
    vista.setPointerCapture(e.pointerId);
    const alMover = (ev) => mover(ev);
    const alSoltar = (ev) => {
      vista.removeEventListener('pointermove', alMover);
      vista.removeEventListener('pointerup', alSoltar);
      vista.removeEventListener('pointercancel', alSoltar);
      soltar(ev);
    };
    vista.addEventListener('pointermove', alMover);
    vista.addEventListener('pointerup', alSoltar);
    vista.addEventListener('pointercancel', alSoltar);
  }

  // ---------- Herramientas ----------

  vista.addEventListener('pointerdown', (e) => {
    contenedor.focus();
    if (!estado.doc) return;
    if (e.button === 1 || (e.button === 0 && espacio)) return panear(e);
    if (e.button !== 0) return;
    if (estado.herramienta === 'seleccionar') return seleccionarYMover(e);
    return crearForma(e, estado.herramienta);
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

  function seleccionarYMover(e) {
    const g = e.target.closest('[data-id]');
    if (!g || !documentoG.contains(g)) return seleccionar(null);
    const id = g.dataset.id;
    seleccionar(id);

    const obj = buscar(estado.doc, id);
    const inversa = invertir(matrizMundo(estado.doc, esquema, obj.parent ?? null));
    const x0 = leer(esquema, obj, 'x');
    const y0 = leer(esquema, obj, 'y');
    const [lx0, ly0] = aplicar(inversa, ...pantallaADoc(e));
    const inicio = { x: e.clientX, y: e.clientY };
    let ops = null;

    arrastrar(
      e,
      (ev) => {
        if (!ops && Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y) < 3) return;
        let [lx, ly] = aplicar(inversa, ...pantallaADoc(ev));
        // Shift: mover solo en el eje dominante.
        if (ev.shiftKey) Math.abs(lx - lx0) > Math.abs(ly - ly0) ? (ly = ly0) : (lx = lx0);
        ops = [{ op: 'set', target: id, props: { x: redondear(x0 + lx - lx0), y: redondear(y0 + ly - ly0) } }];
        previsualizar(ops);
      },
      () => (ops ? ejecutar(ops, `mover ${id}`) : previsualizar(null)),
    );
  }

  function crearForma(e, tipo) {
    const padre = padreParaNuevo();
    const inversa = invertir(matrizMundo(estado.doc, esquema, padre));
    const p0 = pantallaADoc(e);
    const s0 = [e.clientX, e.clientY];
    const r = vista.getBoundingClientRect();
    const borrador = crear(tipo === 'ellipse' ? 'ellipse' : 'rect', { class: 'borrador' });
    superposicion.append(borrador);

    const caja = (ev) => {
      let dx = ev.clientX - s0[0];
      let dy = ev.clientY - s0[1];
      // Shift: cuadrado o círculo.
      if (ev.shiftKey) {
        const lado = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * lado;
        dy = Math.sign(dy || 1) * lado;
      }
      return { x: Math.min(s0[0], s0[0] + dx) - r.left, y: Math.min(s0[1], s0[1] + dy) - r.top, w: Math.abs(dx), h: Math.abs(dy), dx, dy };
    };

    arrastrar(
      e,
      (ev) => {
        const c = caja(ev);
        if (tipo === 'ellipse') Object.entries({ cx: c.x + c.w / 2, cy: c.y + c.h / 2, rx: c.w / 2, ry: c.h / 2 }).forEach(([k, v]) => borrador.setAttribute(k, v));
        else Object.entries({ x: c.x, y: c.y, width: c.w, height: c.h }).forEach(([k, v]) => borrador.setAttribute(k, v));
      },
      (ev) => {
        borrador.remove();
        const c = caja(ev);
        const p1 = [p0[0] + c.dx / camara.zoom, p0[1] + c.dy / camara.zoom];
        const [ax, ay] = aplicar(inversa, ...p0);
        const [bx, by] = aplicar(inversa, ...p1);
        const chica = c.w < 4 && c.h < 4;
        const props = chica
          ? { x: redondear(ax), y: redondear(ay) }
          : { x: redondear((ax + bx) / 2), y: redondear((ay + by) / 2), width: redondear(Math.abs(bx - ax)), height: redondear(Math.abs(by - ay)) };
        const id = idLibre(tipo);
        ejecutar([{ op: 'create', type: tipo, id, parent: padre, props }], `crear ${id}`);
        fijar({ herramienta: 'seleccionar' });
        seleccionar(id);
      },
    );
  }

  return { ajustar };
}
