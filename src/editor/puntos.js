// Edición de puntos de un path: arrastrar anclas y tangentes, doble clic en un ancla para alternar recto/curvo,
// clic sobre el contorno para agregar un vértice y Supr para borrar el seleccionado. Alt al arrastrar una tangente
// la separa de la otra (pico).

import { buscar } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { aplicar, invertir, matrizMundo, multiplicar } from '../core/geometria.js';
import { aplicarPose } from '../core/mezcla.js';
import { conHueso, dividirTramo, manijas, muestrearTramo, tangentes, verticeDesdeTangentes } from '../core/trazado.js';
import { docVisible, ejecutar, esquema, estado, fijar, previsualizar } from './estado.js';
import { nombreDeEdicion, opsDePose, poseActiva } from './huesos.js';

const CERCA_DEL_CONTORNO = 8; // px

export function crearPuntos(ctx) {
  // Con una pose activa se editan los vértices de la pose (el morph); sin pose, los del montaje.
  const path = () => buscar(aplicarPose(docVisible(), esquema, poseActiva(docVisible())), estado.edicion);
  // La matriz del dibujo en pantalla tal como se ve (con huesos y pose incluidos).
  const matriz = () => {
    const m = ctx.elemento(estado.edicion)?.getCTM();
    return m ? [m.a, m.b, m.c, m.d, m.e, m.f] : multiplicar(ctx.matrizCamara(), matrizMundo(docVisible(), esquema, estado.edicion));
  };
  const opsDeVertices = (vertices) => {
    const pose = poseActiva();
    return pose ? opsDePose(estado.doc, pose.id, estado.edicion, { vertices }) : [{ op: 'set', target: estado.edicion, props: { vertices } }];
  };
  const guardar = (vertices, nota) => ejecutar(opsDeVertices(vertices), `${estado.pose ? `${nombreDeEdicion()}: ` : ''}${nota} in ${estado.edicion}`);

  function dibujar() {
    const obj = path();
    if (!obj) return;
    const m = matriz();
    const pantalla = (p) => aplicar(m, ...p);
    const vertices = leer(esquema, obj, 'vertices');
    manijas(vertices).forEach((h, i) => {
      const a = pantalla(h.ancla);
      for (const [cual, punto] of [['entrada', h.entrada], ['salida', h.salida]]) {
        if (!punto) continue;
        const t = pantalla(punto);
        ctx.superposicion.append(ctx.crear('line', { class: 'tangente', x1: a[0], y1: a[1], x2: t[0], y2: t[1] }));
        ctx.superposicion.append(ctx.crear('circle', { class: 'manija tangente-punto', 'data-manija': `${cual}-${i}`, cx: t[0], cy: t[1], r: 4 }, 'Tangent (Alt: break)'));
      }
      ctx.superposicion.append(
        ctx.crear(
          'rect',
          { class: `manija ancla${i === estado.vertice ? ' activa' : ''}${vertices[i].bone ? ' con-hueso' : ''}`, 'data-manija': `ancla-${i}`, x: a[0] - 4.5, y: a[1] - 4.5, width: 9, height: 9 },
          `Vertex ${i}${vertices[i].bone ? `, follows ${vertices[i].bone}` : ''} (double-click: straight/curved)`,
        ),
      );
    });
  }

  /** Arrastre de un ancla o de una tangente. */
  function manija(e, tipo) {
    const [cual, texto] = tipo.split('-');
    const i = Number(texto);
    const obj = path();
    const vertices = leer(esquema, obj, 'vertices');
    const inversa = invertir(matriz());
    const local = (ev) => aplicar(inversa, ...ctx.puntoPantalla(ev));
    const inicio = local(e);
    fijar({ vertice: i });
    let cambio = null;

    ctx.arrastrar(
      e,
      (ev) => {
        const p = local(ev);
        const v = vertices[i];
        const nuevos = [...vertices];
        if (cual === 'ancla') {
          nuevos[i] = { ...v, x: Math.round((v.x + p[0] - inicio[0]) * 100) / 100, y: Math.round((v.y + p[1] - inicio[1]) * 100) / 100 };
        } else {
          const t = tangentes(v);
          const otra = cual === 'entrada' ? 'salida' : 'entrada';
          t[cual] = [p[0] - v.x, p[1] - v.y];
          const modo = ev.altKey ? 'detached' : (v.mode ?? 'straight');
          if (modo === 'mirrored') t[otra] = [-t[cual][0], -t[cual][1]];
          if (modo === 'asymmetric') {
            const largoOtra = Math.hypot(...t[otra]);
            const l = Math.hypot(...t[cual]) || 1;
            t[otra] = [(-t[cual][0] / l) * largoOtra, (-t[cual][1] / l) * largoOtra];
          }
          nuevos[i] = conHueso(v, verticeDesdeTangentes(v.x, v.y, t.entrada, t.salida));
        }
        cambio = nuevos;
        previsualizar(opsDeVertices(nuevos));
      },
      () => (cambio ? guardar(cambio, cual === 'ancla' ? 'move vertex' : 'adjust curve') : previsualizar(null)),
    );
  }

  /** Clic en el lienzo fuera de las manijas. Devuelve true si lo resolvió (agregar un vértice). */
  function pointerdown(e) {
    const obj = path();
    if (!obj) return false;
    const vertices = leer(esquema, obj, 'vertices');
    const m = matriz();
    const p = ctx.puntoPantalla(e);
    const tramos = leer(esquema, obj, 'closed') ? vertices.length : vertices.length - 1;
    let mejor = null;
    for (let i = 0; i < tramos; i++) {
      for (const { t, p: q } of muestrearTramo(vertices, i, 40)) {
        const s = aplicar(m, ...q);
        const d = Math.hypot(s[0] - p[0], s[1] - p[1]);
        if (!mejor || d < mejor.d) mejor = { d, i, t };
      }
    }
    if (!mejor || mejor.d > CERCA_DEL_CONTORNO || mejor.t < 0.02 || mejor.t > 0.98) return false;
    guardar(dividirTramo(vertices, mejor.i, mejor.t), 'add vertex');
    fijar({ vertice: mejor.i + 1 });
    return true;
  }

  /** Doble clic en un ancla: recto ↔ curvo. */
  function alternar(i) {
    const obj = path();
    const vertices = leer(esquema, obj, 'vertices');
    const v = vertices[i];
    const nuevos = [...vertices];
    if ((v.mode ?? 'straight') !== 'straight') {
      nuevos[i] = conHueso(v, { x: v.x, y: v.y });
    } else {
      // Tangente paralela a la línea entre los vecinos, de un tercio de la distancia media.
      const anterior = vertices[(i - 1 + vertices.length) % vertices.length];
      const siguiente = vertices[(i + 1) % vertices.length];
      const dx = siguiente.x - anterior.x;
      const dy = siguiente.y - anterior.y;
      const dist = Math.round((Math.hypot(dx, dy) / 6) * 100) / 100 || 20;
      nuevos[i] = conHueso(v, { x: v.x, y: v.y, mode: 'mirrored', angle: Math.round((Math.atan2(dy, dx) * 180) / Math.PI * 100) / 100, dist });
    }
    guardar(nuevos, 'toggle vertex');
  }

  function borrarVertice() {
    const obj = path();
    const vertices = leer(esquema, obj, 'vertices');
    if (estado.vertice == null || vertices.length <= 2) return false;
    guardar(vertices.filter((_, i) => i !== estado.vertice), 'delete vertex');
    fijar({ vertice: null });
    return true;
  }

  return { dibujar, manija, pointerdown, alternar, borrarVertice };
}
