// Pluma: clic agrega un vértice recto; clic y arrastrar agrega uno curvo (mirrored). Clic en el primer vértice
// cierra la forma; Enter o Escape la terminan abierta.

import { aplicar, invertir, matrizMundo, multiplicar } from '../core/geometry.js';
import { verticeDesdeTangentes, verticesAD } from '../core/paths.js';
import { ejecutar, esquema, estado, fijar, idLibre, padreParaNuevo, seleccionar } from './state.js';

const CERCA = 9; // px en pantalla para cerrar en el primer vértice

export function crearPluma(ctx) {
  // Puntos en pantalla: { p, entrada, salida } con las tangentes como vectores.
  let puntos = [];
  let cursor = null;

  const cerca = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= CERCA;

  function pointerdown(e) {
    const p = ctx.puntoPantalla(e);
    if (puntos.length >= 2 && cerca(p, puntos[0].p)) return terminar(true);
    const punto = { p, entrada: [0, 0], salida: [0, 0] };
    puntos.push(punto);
    ctx.redibujar();
    ctx.arrastrar(
      e,
      (ev) => {
        const q = ctx.puntoPantalla(ev);
        const v = [q[0] - p[0], q[1] - p[1]];
        if (Math.hypot(...v) < 3) return;
        punto.salida = v;
        punto.entrada = [-v[0], -v[1]];
        ctx.redibujar();
      },
      () => {},
    );
  }

  function hover(e) {
    if (!puntos.length) return;
    cursor = ctx.puntoPantalla(e);
    ctx.redibujar();
  }

  function dibujar() {
    if (estado.herramienta !== 'path' || !puntos.length) return;
    const vertices = puntos.map((pt) => verticeDesdeTangentes(pt.p[0], pt.p[1], pt.entrada, pt.salida));
    ctx.superposicion.append(ctx.crear('path', { class: 'trazo-pluma', d: verticesAD(vertices, false) }));
    if (cursor) {
      const u = puntos.at(-1).p;
      ctx.superposicion.append(ctx.crear('line', { class: 'trazo-pluma guia', x1: u[0], y1: u[1], x2: cursor[0], y2: cursor[1] }));
    }
    puntos.forEach((pt, i) => {
      if (Math.hypot(...pt.salida) > 0) {
        for (const t of [pt.entrada, pt.salida]) {
          ctx.superposicion.append(ctx.crear('line', { class: 'tangente', x1: pt.p[0], y1: pt.p[1], x2: pt.p[0] + t[0], y2: pt.p[1] + t[1] }));
        }
      }
      const cierra = i === 0 && puntos.length >= 2 && cursor && cerca(cursor, pt.p);
      ctx.superposicion.append(ctx.crear('rect', { class: `ancla${cierra ? ' activa' : ''}`, x: pt.p[0] - 4, y: pt.p[1] - 4, width: 8, height: 8 }));
    });
  }

  /** Crea el path con los puntos dibujados (en coordenadas del padre) y vuelve a la herramienta de selección. */
  function terminar(cerrado) {
    const dibujados = puntos;
    puntos = [];
    cursor = null;
    if (dibujados.length < 2) return ctx.redibujar();

    const padre = padreParaNuevo();
    const inversa = invertir(multiplicar(ctx.matrizCamara(), matrizMundo(estado.doc, esquema, padre)));
    const lineal = ([x, y]) => [inversa[0] * x + inversa[2] * y, inversa[1] * x + inversa[3] * y];
    const [ox, oy] = aplicar(inversa, ...dibujados[0].p).map((v) => Math.round(v * 10) / 10);
    const vertices = dibujados.map((pt) => {
      const [x, y] = aplicar(inversa, ...pt.p);
      return verticeDesdeTangentes(x - ox, y - oy, lineal(pt.entrada), lineal(pt.salida));
    });
    const props = { x: ox, y: oy, vertices, closed: cerrado };
    if (!cerrado) Object.assign(props, { fill: null, stroke: '#2b2135', strokeWidth: 3 });
    const id = idLibre('path');
    ejecutar([{ op: 'create', type: 'path', id, parent: padre, props }], `draw ${id}`);
    fijar({ herramienta: 'seleccionar' });
    seleccionar(id);
  }

  return {
    pointerdown,
    hover,
    dibujar,
    terminar,
    activa: () => puntos.length > 0,
    cancelar: () => {
      puntos = [];
      cursor = null;
      ctx.redibujar();
    },
  };
}
