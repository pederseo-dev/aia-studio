// Huesos en el lienzo: se dibujan en la superposición (no son parte del personaje) y se manejan con la herramienta
// Hueso (B) en el montaje, o con cualquier herramienta cuando hay una pose activa.
//
// Montaje, herramienta Hueso: arrastrar en vacío crea un hueso (hijo del seleccionado); arrastrar desde la punta del
// seleccionado encadena uno nuevo; arrastrar un hueso lo gira; la manija del origen lo mueve y Alt + la punta cambia
// dirección y largo. Con Mover, el hueso seleccionado muestra las mismas manijas y la punta ajusta sin Alt.
// Pose: arrastrar un hueso (o el dibujo enlazado a él) lo gira dentro de la pose; el origen lo desplaza.

import { buscar } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { evaluarEsqueleto, huesoDe, limitarAngulo, valoresDeHueso } from '../core/esqueleto.js';
import { IDENTIDAD, aplicar, invertir, multiplicar } from '../core/geometria.js';
import { docVisible, ejecutar, esquema, estado, idLibre, previsualizar, seleccionar } from './estado.js';

const redondear = (v, d = 10) => Math.round(v * d) / d;
const GRADOS = 180 / Math.PI;

/** La pose activa del documento indicado, o null (montaje). */
export function poseActiva(doc = estado.doc) {
  const p = estado.pose && buscar(doc, estado.pose);
  return p?.type === 'pose' ? p : null;
}

/** Lote que fija campos de un hueso dentro de una pose (conserva lo demás que la pose ya tenía). */
export function opsDePose(doc, poseId, hueso, campos) {
  const bones = structuredClone(buscar(doc, poseId).bones ?? {});
  bones[hueso] = { ...bones[hueso], ...campos };
  for (const [k, v] of Object.entries(bones[hueso])) if (v === undefined) delete bones[hueso][k];
  if (!Object.keys(bones[hueso]).length) delete bones[hueso];
  return [{ op: 'set', target: poseId, props: { bones } }];
}

/** Pega un objeto al hueso o, si ya estaba pegado a ese, lo suelta. */
export function alternarEnlace(id, hueso) {
  const obj = buscar(estado.doc, id);
  if (!obj || !('bone' in (esquema.tipos.get(obj.type)?.properties ?? {}))) return;
  if (obj.bone === hueso) return ejecutar([{ op: 'unset', target: id, props: ['bone'] }], `desenlazar ${id}`);
  ejecutar([{ op: 'set', target: id, props: { bone: hueso } }], `enlazar ${id} a ${hueso}`);
}

export function crearHuesos(ctx) {
  const activos = () => estado.herramienta === 'hueso' || !!estado.pose;
  const esHueso = (id) => buscar(estado.doc, id)?.type === 'bone';

  // ---------- Dibujo ----------

  function dibujar() {
    const doc = docVisible();
    const huesos = doc.objects.filter((o) => o.type === 'bone');
    if (!huesos.length) return;
    const { posado } = evaluarEsqueleto(doc, esquema, poseActiva(doc));
    const camara = ctx.matrizCamara();
    const capa = ctx.crear('g', { class: `huesos${activos() ? ' activos' : ''}` });
    for (const h of huesos) {
      const m = multiplicar(camara, posado.get(h.id));
      const o = aplicar(m, 0, 0);
      const t = aplicar(m, leer(esquema, h, 'length'), 0);
      const largo = Math.hypot(t[0] - o[0], t[1] - o[1]);
      const clase = `hueso${estado.seleccionados.includes(h.id) ? ' seleccionado' : ''}${h.id === estado.seleccion ? ' principal' : ''}`;
      // Unión punteada cuando el hueso no nace en la punta de su padre.
      const padre = h.parent && buscar(doc, h.parent);
      if (padre) {
        const mp = multiplicar(camara, posado.get(padre.id));
        const punta = aplicar(mp, leer(esquema, padre, 'length'), 0);
        if (Math.hypot(punta[0] - o[0], punta[1] - o[1]) > 2) capa.append(ctx.crear('line', { class: 'union-hueso', x1: punta[0], y1: punta[1], x2: o[0], y2: o[1] }));
      }
      if (largo < 4) {
        capa.append(ctx.crear('circle', { class: clase, 'data-hueso': h.id, cx: o[0], cy: o[1], r: 4 }, h.id));
        continue;
      }
      // Forma de rombo alargado, como en Moho: ancho cerca del origen, en punta hacia el final.
      const [dx, dy] = [(t[0] - o[0]) / largo, (t[1] - o[1]) / largo];
      const ancho = Math.min(9, Math.max(3, largo * 0.12));
      const q = [o[0] + dx * largo * 0.2, o[1] + dy * largo * 0.2];
      const puntos = [o, [q[0] - dy * ancho, q[1] + dx * ancho], t, [q[0] + dy * ancho, q[1] - dx * ancho]];
      capa.append(ctx.crear('polygon', { class: clase, 'data-hueso': h.id, points: puntos.map((p) => p.join(',')).join(' ') }, h.id));
    }
    ctx.superposicion.append(capa);

    // Lo que mueve el hueso elegido (o el que se está enlazando), marcado en el dibujo.
    const marcado = estado.enlazando ?? (estado.seleccion && buscar(doc, estado.seleccion)?.type === 'bone' ? estado.seleccion : null);
    if (marcado) {
      for (const o of doc.objects.filter((x) => x.bone === marcado)) {
        const el = ctx.elemento(o.id);
        const m = el?.getCTM();
        const caja = el?.getBBox();
        if (!m || !caja || (!caja.width && !caja.height)) continue;
        const p = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f].join(',');
        const puntos = [p(caja.x, caja.y), p(caja.x + caja.width, caja.y), p(caja.x + caja.width, caja.y + caja.height), p(caja.x, caja.y + caja.height)].join(' ');
        ctx.superposicion.append(ctx.crear('polygon', { class: 'enlazado', points: puntos }, `${o.id} sigue a ${marcado}`));
      }
    }

    // Manijas del hueso principal seleccionado (también con Mover, para ajustarlo).
    const conManijas = activos() || estado.herramienta === 'seleccionar';
    const sel = conManijas && estado.seleccion && buscar(doc, estado.seleccion);
    if (sel?.type === 'bone') {
      const m = multiplicar(camara, posado.get(sel.id));
      const [ox, oy] = aplicar(m, 0, 0);
      const [tx, ty] = aplicar(m, leer(esquema, sel, 'length'), 0);
      ctx.superposicion.append(ctx.crear('circle', { class: 'manija', 'data-manija': 'hueso-origen', cx: ox, cy: oy, r: 5 }, estado.pose ? 'Desplazar el hueso en la pose' : 'Mover el origen del hueso'));
      ctx.superposicion.append(ctx.crear('circle', { class: 'manija', 'data-manija': 'hueso-punta', cx: tx, cy: ty, r: 5 }, estado.pose ? 'Girar el hueso' : estado.herramienta === 'hueso' ? 'Arrastrar: encadenar un hueso nuevo · Alt: dirección y largo' : 'Dirección y largo (Shift: de a 15°)'));
    }
  }

  // ---------- Matrices de trabajo ----------

  /** Lo que hace falta para arrastrar un hueso: su matriz en pantalla y la del marco de su padre. */
  function marcos(id) {
    const doc = estado.doc;
    const pose = poseActiva(doc);
    const ev = evaluarEsqueleto(doc, esquema, pose);
    const mundo = pose ? ev.posado : ev.reposo;
    const h = buscar(doc, id);
    const camara = ctx.matrizCamara();
    const padre = h.parent ? multiplicar(camara, mundo.get(h.parent)) : camara;
    // El giro se mide contra el padre, salvo con ángulo independiente (solo hereda la posición).
    const giro = h.parent && !leer(esquema, h, 'independentAngle') ? padre : camara;
    return { doc, pose, h, valores: valoresDeHueso(esquema, h, pose), propio: multiplicar(camara, mundo.get(id)), padre, giro };
  }

  const sentidoDe = (m) => Math.sign(m[0] * m[3] - m[1] * m[2]) || 1;

  /** Lote para cambiar un hueso: en la pose activa si la hay, si no en el montaje. */
  function cambio(id, campos) {
    const pose = poseActiva();
    if (pose) {
      if (campos.rotation !== undefined) campos.rotation = limitarAngulo(esquema, buscar(estado.doc, id), campos.rotation);
      return opsDePose(estado.doc, pose.id, id, campos);
    }
    return [{ op: 'set', target: id, props: campos }];
  }

  const nota = (id, que) => (estado.pose ? `pose ${estado.pose}: ${que} ${id}` : `${que} ${id}`);

  // ---------- Interacción ----------

  /** Girar un hueso arrastrando alrededor de su origen. */
  function rotar(e, id) {
    const { valores, propio, giro } = marcos(id);
    const origen = aplicar(propio, 0, 0);
    const angulo = (p) => Math.atan2(p[1] - origen[1], p[0] - origen[0]) * GRADOS;
    const sentido = sentidoDe(giro);
    let anterior = angulo(ctx.puntoPantalla(e));
    let acumulado = 0;
    let ops = null;
    ctx.arrastrar(
      e,
      (ev) => {
        const a = angulo(ctx.puntoPantalla(ev));
        // Sin saltos al cruzar ±180°.
        acumulado += ((a - anterior + 540) % 360) - 180;
        anterior = a;
        let rot = valores.rotation + sentido * acumulado;
        rot = ev.shiftKey ? Math.round(rot / 15) * 15 : redondear(rot);
        ops = cambio(id, { rotation: rot });
        previsualizar(ops);
      },
      () => (ops ? ejecutar(ops, nota(id, 'girar')) : previsualizar(null)),
    );
  }

  function manija(e, tipo) {
    const id = estado.seleccion;
    if (!esHueso(id)) return;
    const { valores, padre, giro, propio } = marcos(id);
    let ops = null;
    const terminar = (que) => () => (ops ? ejecutar(ops, nota(id, que)) : previsualizar(null));

    if (tipo === 'hueso-origen') {
      const inversa = invertir(padre);
      return ctx.arrastrar(
        e,
        (ev) => {
          const [x, y] = aplicar(inversa, ...ctx.puntoPantalla(ev)).map((v) => redondear(v));
          ops = cambio(id, { x, y });
          previsualizar(ops);
        },
        terminar('mover'),
      );
    }

    if (tipo === 'hueso-punta') {
      // En la pose, la punta solo gira. Con la herramienta Hueso encadena uno nuevo (Alt: ajustar este).
      if (estado.pose) return rotar(e, id);
      if (estado.herramienta === 'hueso' && !e.altKey) return crear(e);
      const inversa = invertir(giro);
      const origen = aplicar(inversa, ...aplicar(propio, 0, 0));
      return ctx.arrastrar(
        e,
        (ev) => {
          const p = aplicar(inversa, ...ctx.puntoPantalla(ev));
          const [dx, dy] = [p[0] - origen[0], p[1] - origen[1]];
          let rotation = Math.atan2(dy, dx) * GRADOS;
          rotation = ev.shiftKey ? Math.round(rotation / 15) * 15 : redondear(rotation);
          const length = redondear(Math.hypot(dx, dy) / (valores.scaleX || 1));
          ops = cambio(id, { rotation, length });
          previsualizar(ops);
        },
        terminar('ajustar'),
      );
    }
  }

  /** Herramienta Hueso en el montaje. */
  function pointerdown(e) {
    const id = e.target.closest('[data-hueso]')?.dataset.hueso;
    if (id) {
      seleccionar(id);
      return rotar(e, id);
    }
    crear(e);
  }

  /** Con una pose activa: se gira el hueso tocado, o el hueso del dibujo tocado. */
  function pointerdownPose(e) {
    let id = e.target.closest('[data-hueso]')?.dataset.hueso;
    if (!id) {
      const g = e.target.closest('[data-id]');
      if (!g || !ctx.documentoG.contains(g)) return seleccionar(null);
      id = huesoDe(estado.doc, g.dataset.id) ?? huesoCercanoDePuntos(g.dataset.id, ctx.puntoPantalla(e));
      if (!id) return seleccionar(g.dataset.id);
    }
    seleccionar(id);
    rotar(e, id);
  }

  /** Path enlazado por punto: el hueso (de los que siguen sus vértices) más cercano al clic, en la pose. */
  function huesoCercanoDePuntos(pathId, punto) {
    const path = buscar(estado.doc, pathId);
    const ids = [...new Set((path?.vertices ?? []).map((v) => v.bone).filter(Boolean))];
    if (!ids.length) return null;
    const { posado } = evaluarEsqueleto(estado.doc, esquema, poseActiva());
    const camara = ctx.matrizCamara();
    let mejor = null;
    for (const id of ids) {
      const m = multiplicar(camara, posado.get(id));
      const a = aplicar(m, 0, 0);
      const b = aplicar(m, leer(esquema, buscar(estado.doc, id), 'length'), 0);
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((punto[0] - a[0]) * dx + (punto[1] - a[1]) * dy) / l2));
      const d = Math.hypot(punto[0] - a[0] - dx * t, punto[1] - a[1] - dy * t);
      if (!mejor || d < mejor.d) mejor = { id, d };
    }
    return mejor.id;
  }

  /** Arrastrar en vacío crea un hueso. Es hijo del hueso seleccionado; si se empieza en su punta, se encadena. */
  function crear(e) {
    const doc = estado.doc;
    const sel = estado.seleccion && buscar(doc, estado.seleccion);
    const padre = sel?.type === 'bone' ? sel : null;
    const { reposo } = evaluarEsqueleto(doc, esquema);
    const camara = ctx.matrizCamara();
    const marco = padre ? multiplicar(camara, reposo.get(padre.id)) : multiplicar(camara, IDENTIDAD);
    const inversa = invertir(marco);
    const s0 = ctx.puntoPantalla(e);
    const puntaPadre = padre && aplicar(marco, leer(esquema, padre, 'length'), 0);
    const encadenado = puntaPadre && Math.hypot(s0[0] - puntaPadre[0], s0[1] - puntaPadre[1]) < 10;
    const inicio = encadenado ? puntaPadre : s0;
    const local0 = encadenado ? [leer(esquema, padre, 'length'), 0] : aplicar(inversa, ...s0);
    const borrador = ctx.crear('line', { class: 'borrador-hueso', x1: inicio[0], y1: inicio[1], x2: inicio[0], y2: inicio[1] });
    ctx.superposicion.append(borrador);
    let fin = null;

    ctx.arrastrar(
      e,
      (ev) => {
        fin = ctx.puntoPantalla(ev);
        borrador.setAttribute('x2', fin[0]);
        borrador.setAttribute('y2', fin[1]);
        ctx.superposicion.append(borrador);
      },
      () => {
        borrador.remove();
        if (!fin || Math.hypot(fin[0] - inicio[0], fin[1] - inicio[1]) < 6) {
          if (!encadenado) seleccionar(null);
          return;
        }
        const local1 = aplicar(inversa, ...fin);
        const [dx, dy] = [local1[0] - local0[0], local1[1] - local0[1]];
        const id = idLibre('bone');
        const props = { x: redondear(local0[0]), y: redondear(local0[1]), rotation: redondear(Math.atan2(dy, dx) * GRADOS), length: redondear(Math.hypot(dx, dy)) };
        ejecutar([{ op: 'create', type: 'bone', id, parent: padre?.id ?? null, props }], `crear ${id}`);
        seleccionar(id);
      },
    );
  }

  /** «Enlazar dibujo…»: cada clic en el dibujo lo pega al hueso o lo suelta (Alt: el grupo que lo contiene). */
  function alEnlazar(e) {
    const g = e.target.closest('[data-id]');
    if (!g || !ctx.documentoG.contains(g)) return;
    const obj = buscar(estado.doc, g.dataset.id);
    const elegido = e.altKey && obj.parent ? obj.parent : obj.id;
    alternarEnlace(elegido, estado.enlazando);
  }

  return { dibujar, manija, pointerdown, pointerdownPose, alEnlazar };
}
