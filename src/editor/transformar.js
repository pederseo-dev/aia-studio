// Herramienta de selección: seleccionar (clic, Ctrl/Shift + clic, recuadro), mover y las manijas para rotar, escalar
// y mover el pivote. Con varios objetos, las manijas rodean a todos y giran o escalan desde el centro del conjunto.

import { buscar, hijos } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { aplicar, invertir, matrizLocal, matrizMundo, multiplicar } from '../core/geometria.js';
import { transformarVertices } from '../core/trazado.js';
import { alternarSeleccion, ejecutar, esquema, estado, previsualizar, seleccionRaices, seleccionar, seleccionarVarios } from './estado.js';

const redondear = (v, d = 10) => Math.round(v * d) / d;
const GRADOS = 180 / Math.PI;
const RADIANES = Math.PI / 180;

export function crearTransformar(ctx) {
  // ---------- Cajas en pantalla ----------

  /** Las cuatro esquinas de la caja de un elemento, en pantalla (giradas con él). Null si no se ve. */
  function esquinasDe(el) {
    if (!el || el.closest('[display="none"]')) return null;
    const m = el.getCTM();
    const caja = el.getBBox();
    if (!m || (!caja.width && !caja.height)) return null;
    const punto = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    return [punto(caja.x, caja.y), punto(caja.x + caja.width, caja.y), punto(caja.x + caja.width, caja.y + caja.height), punto(caja.x, caja.y + caja.height)];
  }

  /** Caja alineada a la pantalla que envuelve varias listas de esquinas. */
  function envolvente(listas) {
    const puntos = listas.flat();
    if (!puntos.length) return null;
    const xs = puntos.map((p) => p[0]);
    const ys = puntos.map((p) => p[1]);
    const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return { esquinas: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], centro: [(x0 + x1) / 2, (y0 + y1) / 2], x0, y0, x1, y1 };
  }

  const varios = () => estado.seleccionados.length > 1;

  // ---------- Dibujo de la selección y sus manijas ----------

  function dibujar() {
    if (varios()) return dibujarVarios();
    const el = estado.seleccion && ctx.elemento(estado.seleccion);
    if (!el) return;
    const obj = buscar(estado.doc, estado.seleccion);
    const esquinas = esquinasDe(el);
    if (esquinas) manijasDeCaja(esquinas);
    const m = el.getCTM();
    const [px, py] = [m.e, m.f];
    const movible = ['group', 'path', 'rect', 'ellipse'].includes(obj.type);
    ctx.superposicion.append(
      ctx.crear('circle', { class: movible ? 'pivote manija' : 'pivote', 'data-manija': movible ? 'pivote' : '', cx: px, cy: py, r: 5 }, movible ? 'Mover el pivote sin mover el dibujo' : 'Pivote'),
    );
  }

  function dibujarVarios() {
    const listas = estado.seleccionados.map((id) => esquinasDe(ctx.elemento(id))).filter(Boolean);
    for (const esquinas of listas) ctx.superposicion.append(ctx.crear('polygon', { class: 'seleccion secundaria', points: esquinas.map((p) => p.join(',')).join(' ') }));
    const caja = envolvente(listas);
    if (!caja) return;
    manijasDeCaja(caja.esquinas);
    ctx.superposicion.append(ctx.crear('circle', { class: 'pivote', cx: caja.centro[0], cy: caja.centro[1], r: 4 }, `${estado.seleccionados.length} objetos: giran y escalan desde el centro`));
  }

  function manijasDeCaja(esquinas) {
    ctx.superposicion.append(ctx.crear('polygon', { class: 'seleccion', points: esquinas.map((p) => p.join(',')).join(' ') }));
    // Manija de rotar: por encima del borde superior.
    const arriba = [(esquinas[0][0] + esquinas[1][0]) / 2, (esquinas[0][1] + esquinas[1][1]) / 2];
    const lado = [esquinas[0][0] - esquinas[3][0], esquinas[0][1] - esquinas[3][1]];
    const l = Math.hypot(...lado) || 1;
    const rotar = [arriba[0] + (lado[0] / l) * 26, arriba[1] + (lado[1] / l) * 26];
    ctx.superposicion.append(ctx.crear('line', { class: 'seleccion', x1: arriba[0], y1: arriba[1], x2: rotar[0], y2: rotar[1] }));
    ctx.superposicion.append(ctx.crear('circle', { class: 'manija', 'data-manija': 'rotar', cx: rotar[0], cy: rotar[1], r: 5 }, 'Rotar (Shift: de a 15°)'));
    const ayuda = varios() ? 'Escalar el conjunto desde su centro' : 'Escalar desde el pivote (Shift: proporcional)';
    esquinas.forEach(([x, y], i) => {
      ctx.superposicion.append(ctx.crear('rect', { class: 'manija', 'data-manija': `escalar-${i}`, x: x - 4, y: y - 4, width: 8, height: 8 }, ayuda));
    });
  }

  // ---------- Seleccionar y mover ----------

  function seleccionarYMover(e) {
    const g = e.target.closest('[data-id]');
    const sumar = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!g || !ctx.documentoG.contains(g)) return recuadro(e, sumar);
    const id = g.dataset.id;
    // Ctrl o Shift + clic: agrega o quita sin mover.
    if (sumar) return alternarSeleccion(id);
    // Clic sobre algo que ya es parte de una selección múltiple: se mueven todos; si no hubo arrastre, queda solo ese.
    const enGrupo = varios() && estado.seleccionados.includes(id);
    if (!enGrupo) seleccionar(id);
    else if (estado.seleccion !== id) seleccionarVarios(estado.seleccionados, id);

    const inicio = { x: e.clientX, y: e.clientY };
    const objetos = seleccionRaices().map((oid) => {
      const obj = buscar(estado.doc, oid);
      const inversa = invertir(multiplicar(ctx.matrizCamara(), matrizMundo(estado.doc, esquema, obj.parent ?? null)));
      return { id: oid, inversa, x0: leer(esquema, obj, 'x'), y0: leer(esquema, obj, 'y'), l0: aplicar(inversa, ...ctx.puntoPantalla(e)) };
    });
    let ops = null;

    ctx.arrastrar(
      e,
      (ev) => {
        if (!ops && Math.hypot(ev.clientX - inicio.x, ev.clientY - inicio.y) < 3) return;
        // Shift: mover solo en el eje dominante de la pantalla.
        const s0 = ctx.puntoPantalla(e);
        let s = ctx.puntoPantalla(ev);
        if (ev.shiftKey) s = Math.abs(s[0] - s0[0]) > Math.abs(s[1] - s0[1]) ? [s[0], s0[1]] : [s0[0], s[1]];
        ops = objetos.map((o) => {
          const [lx, ly] = aplicar(o.inversa, ...s);
          return { op: 'set', target: o.id, props: { x: redondear(o.x0 + lx - o.l0[0]), y: redondear(o.y0 + ly - o.l0[1]) } };
        });
        previsualizar(ops);
      },
      () => {
        if (ops) return ejecutar(ops, `mover ${nombre(objetos)}`);
        previsualizar(null);
        if (enGrupo) seleccionar(id);
      },
    );
  }

  const nombre = (objetos) => (objetos.length === 1 ? objetos[0].id : `${objetos.length} objetos`);

  /** Arrastrar en un lugar vacío: selecciona las formas que toca el recuadro. Con Ctrl o Shift, las suma. */
  function recuadro(e, sumar) {
    const base = sumar ? [...estado.seleccionados] : [];
    const s0 = ctx.puntoPantalla(e);
    const marco = ctx.crear('rect', { class: 'recuadro' });
    // Cajas de las formas visibles (no grupos: se elige lo que se ve, como con el clic).
    const formas = [...ctx.documentoG.querySelectorAll('[data-id]')]
      .filter((el) => buscar(estado.doc, el.dataset.id)?.type !== 'group')
      .map((el) => ({ id: el.dataset.id, caja: envolvente([esquinasDe(el) ?? []]) }))
      .filter((f) => f.caja);
    let movio = false;

    ctx.arrastrar(
      e,
      (ev) => {
        const s = ctx.puntoPantalla(ev);
        if (!movio && Math.hypot(s[0] - s0[0], s[1] - s0[1]) < 3) return;
        movio = true;
        const [x0, y0, x1, y1] = [Math.min(s0[0], s[0]), Math.min(s0[1], s[1]), Math.max(s0[0], s[0]), Math.max(s0[1], s[1])];
        const tocadas = formas.filter(({ caja: c }) => c.x0 <= x1 && c.x1 >= x0 && c.y0 <= y1 && c.y1 >= y0).map((f) => f.id);
        const ids = [...base, ...tocadas.filter((id) => !base.includes(id))];
        if (ids.join() !== estado.seleccionados.join()) seleccionarVarios(ids, ids.at(-1) ?? null);
        for (const [k, v] of Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })) marco.setAttribute(k, v);
        ctx.superposicion.append(marco); // la superposición se redibuja al cambiar la selección
      },
      () => {
        marco.remove();
        if (!movio && !sumar) seleccionar(null);
      },
    );
  }

  // ---------- Manijas ----------

  function manija(e, tipo) {
    if (seleccionRaices().length > 1) return manijaVarios(e, tipo);
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
      const sentido = sentidoDe(padre);
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
          } else if (obj.type === 'rect' || obj.type === 'ellipse') {
            // La forma se corre dentro de su marco: el pivote pasa a otra fracción del ancho y del alto.
            const [w, h] = [leer(esquema, obj, 'width'), leer(esquema, obj, 'height')];
            if (w && Math.abs(dx) > 1e-6) ops[0].props.originX = redondear(leer(esquema, obj, 'originX') + dx / w, 10000);
            if (h && Math.abs(dy) > 1e-6) ops[0].props.originY = redondear(leer(esquema, obj, 'originY') + dy / h, 10000);
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

  // Si el padre está espejado, el giro en pantalla va al revés.
  const sentidoDe = (m) => Math.sign(m[0] * m[3] - m[1] * m[2]) || 1;

  /**
   * Rotar o escalar varios objetos a la vez desde el centro de su caja común: cada uno gira o escala sobre sí mismo y
   * su pivote se desplaza alrededor del centro. Con varios, la escala siempre es proporcional.
   */
  function manijaVarios(e, tipo) {
    const ids = seleccionRaices();
    const caja = envolvente(ids.map((id) => esquinasDe(ctx.elemento(id))).filter(Boolean));
    if (!caja) return;
    const c = caja.centro;
    const objetos = ids.map((id) => {
      const obj = buscar(estado.doc, id);
      const padre = multiplicar(ctx.matrizCamara(), matrizMundo(estado.doc, esquema, obj.parent ?? null));
      const props = Object.fromEntries(['x', 'y', 'rotation', 'scaleX', 'scaleY'].map((p) => [p, leer(esquema, obj, p)]));
      return { id, padre, inversa: invertir(padre), props, pivote: aplicar(padre, props.x, props.y) };
    });
    const posicion = (o, [sx, sy]) => {
      const [x, y] = aplicar(o.inversa, sx, sy);
      return { x: redondear(x), y: redondear(y) };
    };
    let ops = null;
    const nota = `${tipo === 'rotar' ? 'rotar' : 'escalar'} ${objetos.length} objetos`;

    if (tipo === 'rotar') {
      const angulo = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]) * GRADOS;
      const a0 = angulo(ctx.puntoPantalla(e));
      return ctx.arrastrar(
        e,
        (ev) => {
          let delta = angulo(ctx.puntoPantalla(ev)) - a0;
          if (ev.shiftKey) delta = Math.round(delta / 15) * 15;
          const [cos, sin] = [Math.cos(delta * RADIANES), Math.sin(delta * RADIANES)];
          ops = objetos.map((o) => {
            const [dx, dy] = [o.pivote[0] - c[0], o.pivote[1] - c[1]];
            const p = posicion(o, [c[0] + dx * cos - dy * sin, c[1] + dx * sin + dy * cos]);
            return { op: 'set', target: o.id, props: { ...p, rotation: redondear(o.props.rotation + sentidoDe(o.padre) * delta) } };
          });
          previsualizar(ops);
        },
        () => (ops ? ejecutar(ops, nota) : previsualizar(null)),
      );
    }

    if (tipo.startsWith('escalar')) {
      const distancia = (p) => Math.hypot(p[0] - c[0], p[1] - c[1]);
      const d0 = Math.max(distancia(ctx.puntoPantalla(e)), 8);
      return ctx.arrastrar(
        e,
        (ev) => {
          const f = distancia(ctx.puntoPantalla(ev)) / d0;
          ops = objetos.map((o) => {
            const p = posicion(o, [c[0] + (o.pivote[0] - c[0]) * f, c[1] + (o.pivote[1] - c[1]) * f]);
            return { op: 'set', target: o.id, props: { ...p, scaleX: redondear(o.props.scaleX * f, 1000), scaleY: redondear(o.props.scaleY * f, 1000) } };
          });
          previsualizar(ops);
        },
        () => (ops ? ejecutar(ops, nota) : previsualizar(null)),
      );
    }
  }

  /**
   * Herramientas Rotar y Escalar (como en Moho): arrastrar en cualquier parte del lienzo transforma la selección.
   * Si se empieza sobre un objeto que no está seleccionado, primero se selecciona ese.
   */
  function conHerramienta(e, herramienta) {
    const g = e.target.closest('[data-id]');
    if (g && ctx.documentoG.contains(g) && !estado.seleccionados.includes(g.dataset.id)) seleccionar(g.dataset.id);
    if (!estado.seleccion) return;
    manija(e, herramienta === 'rotar' ? 'rotar' : 'escalar-libre');
  }

  return { dibujar, seleccionarYMover, manija, conHerramienta };
}
