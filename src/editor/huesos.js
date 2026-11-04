// Huesos en el lienzo: se dibujan en la superposición (no son parte del personaje) y se manejan con la herramienta
// Hueso (B) en el montaje, o con cualquier herramienta cuando hay una pose activa.
//
// Los huesos viven en un skeleton (la capa de huesos de Moho). Montaje, herramienta Hueso: arrastrar en vacío crea un
// hueso (hijo del seleccionado o, si no hay hueso seleccionado, raíz del skeleton seleccionado o del que contiene la
// selección; sin ninguno, se crea un skeleton); arrastrar desde la punta del seleccionado encadena uno nuevo; arrastrar un hueso lo gira; la manija del origen lo mueve y Alt + la punta cambia
// dirección y largo. Con Mover, el hueso seleccionado muestra las mismas manijas y la punta ajusta sin Alt.
// Pose: arrastrar un hueso (o el dibujo enlazado a él) lo gira dentro de la pose; el origen lo desplaza.

import { buscar, esqueletoDe } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { enlacesPorCercania, evaluarEsqueleto, huesoDe, limitarAngulo, marcoDeHijos, soltarEnlacesAjenos, valoresDeHueso } from '../core/esqueleto.js';
import { aplicar, invertir, multiplicar } from '../core/geometria.js';
import { mezclarPoses } from '../core/mezcla.js';
import { avisar, docVisible, ejecutar, esquema, estado, idLibre, previsualizar, seleccionar } from './estado.js';

const redondear = (v, d = 10) => Math.round(v * d) / d;
const GRADOS = 180 / Math.PI;

/** La pose que se está editando en el documento indicado, o null. */
export function poseActiva(doc = estado.doc) {
  const p = estado.pose && buscar(doc, estado.pose);
  return p?.type === 'pose' ? p : null;
}

/** Lo que se ve: la pose que se edita, la mezcla de los params (vista Parámetros) o null (el montaje). */
export function poseVista(doc = estado.doc) {
  return poseActiva(doc) ?? (estado.params ? mezclarPoses(doc, esquema, estado.params) : null);
}

/** Lote que fija propiedades de un objeto dentro de una pose (conserva lo demás; undefined quita la propiedad). */
export function opsDePose(doc, poseId, id, campos) {
  const values = structuredClone(buscar(doc, poseId).values ?? {});
  values[id] = { ...values[id], ...campos };
  for (const [k, v] of Object.entries(values[id])) if (v === undefined) delete values[id][k];
  if (!Object.keys(values[id]).length) delete values[id];
  return [{ op: 'set', target: poseId, props: { values } }];
}

/** Variante que muestra un switch: la de la pose que se edita, si la fija; si no, la del montaje (o la primera). */
export function varianteDe(doc, sw) {
  const hijos = doc.objects.filter((o) => o.parent === sw.id);
  const elegida = poseActiva(doc)?.values?.[sw.id]?.active ?? sw.active;
  return hijos.find((o) => o.id === elegida)?.id ?? hijos[0]?.id ?? null;
}

/** Elegir qué muestra un switch: en la pose que se edita, si hay una; si no, en el montaje. */
export function elegirVariante(swId, hijo) {
  const pose = poseActiva();
  if (pose) return ejecutar(opsDePose(estado.doc, pose.id, swId, { active: hijo }), `pose ${pose.id}: ${swId} shows ${hijo}`);
  ejecutar([{ op: 'set', target: swId, props: { active: hijo } }], `${swId} shows ${hijo}`);
}

/**
 * Variantes que hay que mostrar aunque su switch muestre otra: la seleccionada (y sus ancestros dentro de switches),
 * para poder verla y editarla. Es solo de la vista: no cambia el documento.
 */
export function variantesAMostrar(doc = estado.doc) {
  const mostrar = {};
  for (let o = estado.seleccion && buscar(doc, estado.seleccion); o?.parent; o = buscar(doc, o.parent)) {
    const padre = buscar(doc, o.parent);
    if (padre?.type === 'switch' && varianteDe(doc, padre) !== o.id) mostrar[padre.id] = o.id;
  }
  return mostrar;
}

/**
 * El skeleton donde trabaja la herramienta Hueso: el seleccionado, el del hueso seleccionado o el que contiene la
 * selección. null si no hay ninguno.
 */
export function esqueletoActivo(doc = estado.doc) {
  const sel = estado.seleccion && buscar(doc, estado.seleccion);
  if (!sel) return null;
  return sel.type === 'skeleton' ? sel.id : esqueletoDe(doc, sel.id);
}

/** Por qué un objeto no puede seguir a un hueso (texto para el usuario), o null si puede. */
export function motivoParaNoEnlazar(doc, id, hueso) {
  const propio = esqueletoDe(doc, id);
  const delHueso = esqueletoDe(doc, hueso);
  if (propio === delHueso) return null;
  return propio ? `${id} is in skeleton ${propio}; it can only follow bones of that skeleton` : `${id} is not in skeleton ${delHueso}: move it inside (Hierarchy) to bind it to its bones`;
}

/** Pega un objeto al hueso o, si ya estaba pegado a ese, lo suelta. */
export function alternarEnlace(id, hueso) {
  const obj = buscar(estado.doc, id);
  if (!obj || !('bone' in (esquema.tipos.get(obj.type)?.properties ?? {}))) return;
  if (obj.bone === hueso) return ejecutar([{ op: 'unset', target: id, props: ['bone'] }], `unbind ${id}`);
  const motivo = motivoParaNoEnlazar(estado.doc, id, hueso);
  if (motivo) return avisar(motivo, true);
  ejecutar([{ op: 'set', target: id, props: { bone: hueso } }], `bind ${id} to ${hueso}`);
}

/** «Bind all by proximity»: el dibujo del skeleton que no sigue a ningún hueso va al más cercano. */
export function enlazarPorCercania(esqueletoId) {
  let enlaces;
  try {
    enlaces = enlacesPorCercania(estado.doc, esquema, esqueletoId);
  } catch {
    return avisar(`Skeleton ${esqueletoId} has no bones yet: create them with the Bone tool (B)`, true);
  }
  if (!enlaces.length) return avisar(`All the drawing in ${esqueletoId} already follows a bone`);
  ejecutar(
    enlaces.map(({ id, bone }) => ({ op: 'set', target: id, props: { bone } })),
    `bind all by proximity in ${esqueletoId} (${enlaces.length})`,
  );
  avisar(`Bound ${enlaces.length}: ${enlaces.map((e) => `${e.id} → ${e.bone}`).join(', ')}`);
}

/**
 * Antes de mover `id` a `padre`: lo que suelta los enlaces que dejarían de valer (dibujo que sale del skeleton de su
 * hueso, o huesos que se van a otro skeleton). Va en el mismo lote, antes del move.
 */
export function soltarAlMover(doc, id, padre) {
  const copia = structuredClone(doc);
  buscar(copia, id).parent = padre;
  return soltarEnlacesAjenos(copia, esquema);
}

/** Aviso para lo que soltarAlMover soltó. */
export function avisarSueltos(ops) {
  const ids = [...new Set(ops.map((o) => o.target))];
  if (ids.length) avisar(`Unbound ${ids.join(', ')}: a drawing only follows bones of its own skeleton`);
}

export function crearHuesos(ctx) {
  const activos = () => estado.herramienta === 'hueso' || !!estado.pose;
  const esHueso = (id) => buscar(estado.doc, id)?.type === 'bone';

  // ---------- Dibujo ----------

  function dibujar() {
    const doc = docVisible();
    const huesos = doc.objects.filter((o) => o.type === 'bone');
    if (!huesos.length) return;
    const { posado } = evaluarEsqueleto(doc, esquema, poseVista(doc));
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
      if (padre?.type === 'bone') {
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
        ctx.superposicion.append(ctx.crear('polygon', { class: 'enlazado', points: puntos }, `${o.id} follows ${marcado}`));
      }
    }

    // Manijas del hueso principal seleccionado (también con Mover, para ajustarlo).
    const conManijas = activos() || estado.herramienta === 'seleccionar';
    const sel = conManijas && estado.seleccion && buscar(doc, estado.seleccion);
    if (sel?.type === 'bone') {
      const m = multiplicar(camara, posado.get(sel.id));
      const [ox, oy] = aplicar(m, 0, 0);
      const [tx, ty] = aplicar(m, leer(esquema, sel, 'length'), 0);
      ctx.superposicion.append(ctx.crear('circle', { class: 'manija', 'data-manija': 'hueso-origen', cx: ox, cy: oy, r: 5 }, estado.pose ? 'Offset the bone in the pose' : 'Move the bone origin'));
      ctx.superposicion.append(ctx.crear('circle', { class: 'manija', 'data-manija': 'hueso-punta', cx: tx, cy: ty, r: 5 }, estado.pose ? 'Rotate the bone' : estado.herramienta === 'hueso' ? 'Drag: chain a new bone · Alt: direction and length' : 'Direction and length (Shift: 15° steps)'));
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
    // El marco del padre: el hueso padre o, para un hueso raíz, su skeleton.
    const deHueso = buscar(doc, h.parent)?.type === 'bone';
    const padre = multiplicar(camara, deHueso ? mundo.get(h.parent) : marcoDeHijos(doc, esquema, h.parent));
    // El giro se mide contra el padre, salvo con ángulo independiente (solo hereda la posición del hueso padre).
    const giro = !deHueso || !leer(esquema, h, 'independentAngle') ? padre : camara;
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
      () => (ops ? ejecutar(ops, nota(id, 'rotate')) : previsualizar(null)),
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
        terminar('move'),
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
        terminar('adjust'),
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

  /**
   * Arrastrar en vacío crea un hueso. Es hijo del hueso seleccionado (si se empieza en su punta, se encadena) o un
   * hueso raíz del skeleton activo. Sin skeleton, se crea uno en la raíz en el mismo paso.
   */
  function crear(e) {
    const doc = estado.doc;
    const sel = estado.seleccion && buscar(doc, estado.seleccion);
    const padre = sel?.type === 'bone' ? sel : null;
    const esqueleto = padre ? null : esqueletoActivo(doc);
    const camara = ctx.matrizCamara();
    const marco = multiplicar(camara, marcoDeHijos(doc, esquema, padre?.id ?? esqueleto));
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
        const ops = [];
        let destino = padre?.id ?? esqueleto;
        if (!destino) {
          destino = idLibre('skeleton');
          ops.push({ op: 'create', type: 'skeleton', id: destino });
        }
        ops.push({ op: 'create', type: 'bone', id, parent: destino, props });
        ejecutar(ops, padre || esqueleto ? `create ${id}` : `create ${destino} with ${id}`);
        seleccionar(id);
        if (!padre && !esqueleto) avisar(`Bones live in a skeleton, so ${destino} was created. Drag the drawing into it in the Hierarchy, then bind it.`);
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
