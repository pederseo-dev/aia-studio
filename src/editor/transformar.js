// Herramienta de selección: seleccionar, mover y las manijas para rotar, escalar y mover el pivote.

import { buscar, hijos } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { aplicar, invertir, matrizLocal, matrizMundo, multiplicar } from '../core/geometria.js';
import { transformarVertices } from '../core/trazado.js';
import { ejecutar, esquema, estado, previsualizar, seleccionar } from './estado.js';

const redondear = (v, d = 10) => Math.round(v * d) / d;
const GRADOS = 180 / Math.PI;

export function crearTransformar(ctx) {
  // ---------- Dibujo de la selección y sus manijas ----------

  function dibujar() {
    const el = estado.seleccion && ctx.elemento(estado.seleccion);
    if (!el) return;
    const obj = buscar(estado.doc, estado.seleccion);
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
      ctx.superposicion.append(ctx.crear('polygon', { class: 'seleccion', points: esquinas.map((p) => p.join(',')).join(' ') }));
      // Manija de rotar: por encima del borde superior.
      const arriba = [(esquinas[0][0] + esquinas[1][0]) / 2, (esquinas[0][1] + esquinas[1][1]) / 2];
      const lado = [esquinas[0][0] - esquinas[3][0], esquinas[0][1] - esquinas[3][1]];
      const l = Math.hypot(...lado) || 1;
      const rotar = [arriba[0] + (lado[0] / l) * 26, arriba[1] + (lado[1] / l) * 26];
      ctx.superposicion.append(ctx.crear('line', { class: 'seleccion', x1: arriba[0], y1: arriba[1], x2: rotar[0], y2: rotar[1] }));
      ctx.superposicion.append(ctx.crear('circle', { class: 'manija', 'data-manija': 'rotar', cx: rotar[0], cy: rotar[1], r: 5 }, 'Rotar (Shift: de a 15°)'));
      esquinas.forEach(([x, y], i) => {
        ctx.superposicion.append(ctx.crear('rect', { class: 'manija', 'data-manija': `escalar-${i}`, x: x - 4, y: y - 4, width: 8, height: 8 }, 'Escalar desde el pivote (Shift: proporcional)'));
      });
    }
    const [px, py] = punto(0, 0);
    const movible = obj.type === 'group' || obj.type === 'path';
    ctx.superposicion.append(
      ctx.crear('circle', { class: movible ? 'pivote manija' : 'pivote', 'data-manija': movible ? 'pivote' : '', cx: px, cy: py, r: 5 }, movible ? 'Mover el pivote sin mover el dibujo' : 'Pivote'),
    );
  }

  // ---------- Seleccionar y mover ----------

  function seleccionarYMover(e) {
    const g = e.target.closest('[data-id]');
    if (!g || !ctx.documentoG.contains(g)) return seleccionar(null);
    const id = g.dataset.id;
    seleccionar(id);

    const obj = buscar(estado.doc, id);
    const inversa = invertir(multiplicar(ctx.matrizCamara(), matrizMundo(estado.doc, esquema, obj.parent ?? null)));
    const x0 = leer(esquema, obj, 'x');
    const y0 = leer(esquema, obj, 'y');
    const [lx0, ly0] = aplicar(inversa, ...ctx.puntoPantalla(e));
    const inicio = { x: e.clientX, y: e.clientY };
    let ops = null;

    ctx.arrastrar(
      e,
      (ev) => {
        if (!ops && Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y) < 3) return;
        let [lx, ly] = aplicar(inversa, ...ctx.puntoPantalla(ev));
        // Shift: mover solo en el eje dominante.
        if (ev.shiftKey) Math.abs(lx - lx0) > Math.abs(ly - ly0) ? (ly = ly0) : (lx = lx0);
        ops = [{ op: 'set', target: id, props: { x: redondear(x0 + lx - lx0), y: redondear(y0 + ly - ly0) } }];
        previsualizar(ops);
      },
      () => (ops ? ejecutar(ops, `mover ${id}`) : previsualizar(null)),
    );
  }

  // ---------- Manijas ----------

  function manija(e, tipo) {
    const id = estado.seleccion;
    const obj = buscar(estado.doc, id);
    const padre = multiplicar(ctx.matrizCamara(), matrizMundo(estado.doc, esquema, obj.parent ?? null));
    const x0 = leer(esquema, obj, 'x');
    const y0 = leer(esquema, obj, 'y');
    const rot0 = leer(esquema, obj, 'rotation');
    const sx0 = leer(esquema, obj, 'scaleX');
    const sy0 = leer(esquema, obj, 'scaleY');
    const pivote = aplicar(padre, x0, y0); // en pantalla
    let ops = null;
    const terminar = (nota) => () => (ops ? ejecutar(ops, nota) : previsualizar(null));

    if (tipo === 'rotar') {
      // Si el padre está espejado, el giro en pantalla va al revés.
      const sentido = Math.sign(padre[0] * padre[3] - padre[1] * padre[2]) || 1;
      const angulo = (p) => Math.atan2(p[1] - pivote[1], p[0] - pivote[0]) * GRADOS;
      const a0 = angulo(ctx.puntoPantalla(e));
      return ctx.arrastrar(
        e,
        (ev) => {
          let rot = rot0 + sentido * (angulo(ctx.puntoPantalla(ev)) - a0);
          rot = ev.shiftKey ? Math.round(rot / 15) * 15 : redondear(rot);
          ops = [{ op: 'set', target: id, props: { rotation: rot } }];
          previsualizar(ops);
        },
        terminar(`rotar ${id}`),
      );
    }

    if (tipo === 'escalar-libre') {
      // Herramienta Escalar: arrastrar en cualquier lugar escala de forma proporcional según la distancia al pivote.
      const distancia = (p) => Math.hypot(p[0] - pivote[0], p[1] - pivote[1]);
      const d0 = Math.max(distancia(ctx.puntoPantalla(e)), 8);
      return ctx.arrastrar(
        e,
        (ev) => {
          const f = distancia(ctx.puntoPantalla(ev)) / d0;
          ops = [{ op: 'set', target: id, props: { scaleX: redondear(sx0 * f, 1000), scaleY: redondear(sy0 * f, 1000) } }];
          previsualizar(ops);
        },
        terminar(`escalar ${id}`),
      );
    }

    if (tipo.startsWith('escalar')) {
      // Coordenadas del objeto girado pero sin su escala: así el cociente da la escala nueva.
      const marco = invertir(multiplicar(padre, matrizLocal(esquema, { ...obj, scaleX: 1, scaleY: 1 })));
      const p0 = aplicar(marco, ...ctx.puntoPantalla(e));
      return ctx.arrastrar(
        e,
        (ev) => {
          const p = aplicar(marco, ...ctx.puntoPantalla(ev));
          let sx = Math.abs(p0[0]) > 1 ? (sx0 * p[0]) / p0[0] : sx0;
          let sy = Math.abs(p0[1]) > 1 ? (sy0 * p[1]) / p0[1] : sy0;
          if (ev.shiftKey) {
            const f = Math.hypot(...p) / (Math.hypot(...p0) || 1);
            [sx, sy] = [sx0 * f, sy0 * f];
          }
          ops = [{ op: 'set', target: id, props: { scaleX: redondear(sx, 1000), scaleY: redondear(sy, 1000) } }];
          previsualizar(ops);
        },
        terminar(`escalar ${id}`),
      );
    }

    if (tipo === 'pivote') {
      // Mueve el pivote y compensa el contenido (hijos o vértices) para que el dibujo no se mueva.
      const inversaPadre = invertir(padre);
      const lineal = invertir([...matrizLocal(esquema, obj).slice(0, 4), 0, 0]);
      return ctx.arrastrar(
        e,
        (ev) => {
          const [x, y] = aplicar(inversaPadre, ...ctx.puntoPantalla(ev)).map((v) => redondear(v));
          const [dx, dy] = aplicar(lineal, x - x0, y - y0);
          ops = [{ op: 'set', target: id, props: { x, y } }];
          if (obj.type === 'path') {
            ops[0].props.vertices = transformarVertices(leer(esquema, obj, 'vertices'), [1, 0, 0, 1, -dx, -dy]);
          } else {
            for (const h of hijos(estado.doc, id)) {
              ops.push({ op: 'set', target: h.id, props: { x: redondear(leer(esquema, h, 'x') - dx, 100), y: redondear(leer(esquema, h, 'y') - dy, 100) } });
            }
          }
          previsualizar(ops);
        },
        terminar(`mover pivote de ${id}`),
      );
    }
  }

  /**
   * Herramientas Rotar y Escalar (como en Moho): arrastrar en cualquier parte del lienzo transforma la selección.
   * Si se empieza sobre otro objeto, primero se selecciona ese.
   */
  function conHerramienta(e, herramienta) {
    const g = e.target.closest('[data-id]');
    if (g && ctx.documentoG.contains(g)) seleccionar(g.dataset.id);
    if (!estado.seleccion) return;
    manija(e, herramienta === 'rotar' ? 'rotar' : 'escalar-libre');
  }

  return { dibujar, seleccionarYMover, manija, conHerramienta };
}
