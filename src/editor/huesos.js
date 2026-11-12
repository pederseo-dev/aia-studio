// Huesos en el lienzo: se dibujan en la superposición (no son parte del personaje ni filas de Layers) y se manejan con
// dos herramientas, como en Moho:
//
// - Add Bone (B): solo crea. Arrastrar en vacío crea un hueso (hijo del seleccionado o, si no hay hueso seleccionado,
//   raíz del skeleton seleccionado o del que contiene la selección; sin ninguno, se crea un skeleton). Arrastrar desde
//   la punta del hueso seleccionado encadena uno nuevo. Un clic en un hueso lo elige (para colgarle hijos).
// - Manipulate Bones (M): solo ajusta. Arrastrar un hueso lo gira; la manija del origen lo mueve y la de la punta
//   cambia dirección y largo.
// - Reparent Bone: nada pasa solo al hacer clic. Clic elige un hueso, Shift/Ctrl + clic suma más, clic en vacío
//   suelta la selección. Los botones de la barra hacen el cambio: «Parent to …» cuelga los elegidos del último que
//   se eligió, y «Clear parent» los deja como raíz. No se mueven en pantalla. Mientras está activa se dibuja la
//   jerarquía.
// - Bind Layer (L): clic en un hueso y después en el dibujo (o su fila de Layers) para que lo siga entero; otro clic lo
//   suelta. Alt + clic toma el grupo que lo contiene.
// - Bind Points: clic en un hueso y después en puntos de los paths de su skeleton (o un recuadro alrededor) para que
//   sigan a ese hueso; Alt suelta. Cada hueso tiene un color y sus puntos se pintan con él.
//
// En el montaje esos ajustes cambian el reposo. Con una pose activa, cualquier herramienta posa: arrastrar un hueso (o
// el dibujo enlazado a él) lo gira dentro de la pose y el origen lo desplaza.

import { buscar, esqueletoDe } from '../core/documento.js';
import { leer } from '../core/esquema.js';
import { evaluarEnPose, evaluarEsqueleto, huesoDe, limitarAngulo, marcoDeHijos, motivoParaNoEnlazar, opsParaSoltarAlMover, planEnlazarPorCercania, planReparentarHuesos, valoresDeHueso } from '../core/esqueleto.js';
import { aplicar, invertir, matrizMundo, multiplicar } from '../core/geometria.js';
import { opsParaClavesEnClip, poseDeClip } from '../core/animacion.js';
import { aplicarPose, mezclarPoses, opsParaFijarPose } from '../core/mezcla.js';
import { alternarSeleccion, avisar, docVisible, ejecutar, esquema, estado, idLibre, previsualizar, seleccionar, seleccionarVarios } from './estado.js';

const redondear = (v, d = 10) => Math.round(v * d) / d;

/** Herramientas del grupo de huesos (con cualquiera de ellas, los huesos se pueden tocar en el lienzo). */
export const HERRAMIENTAS_DE_HUESO = ['hueso', 'manipular', 'reparentar', 'enlazarCapa', 'enlazarPuntos'];

// Un color por hueso (como en Rive), para ver qué puntos y qué dibujo siguen a cuál.
const COLORES = ['#ff6b6b', '#ffa94d', '#e9d94a', '#69db7c', '#3bc9db', '#5c9dff', '#b197fc', '#f783ac'];

export function colorDeHueso(doc, id) {
  const i = doc.objects.filter((o) => o.type === 'bone').findIndex((h) => h.id === id);
  return i < 0 ? '#ffffffaa' : COLORES[i % COLORES.length];
}

/** El hueso elegido, si lo hay. */
const huesoElegido = (doc = estado.doc) => {
  const sel = estado.seleccion && buscar(doc, estado.seleccion);
  return sel?.type === 'bone' ? sel : null;
};

/**
 * Reparent Bone: lo que harían los botones con la selección actual. Los hijos son los huesos elegidos menos el
 * principal (el último elegido), que es el padre. Devuelve { padre, hijos, ops, problema } para «Parent to…» y
 * { sueltos, ops } para «Clear parent» (los elegidos que no son raíz).
 */
export function planDeReparentar(doc = estado.doc) {
  return planReparentarHuesos(doc, esquema, estado.seleccionados, estado.seleccion);
}

/** El hueso al que enlaza Bind Layer: el elegido, con esa herramienta activa (y fuera de una pose). */
export function huesoParaEnlazar(doc = estado.doc) {
  return estado.herramienta === 'enlazarCapa' && !estado.pose ? (huesoElegido(doc)?.id ?? null) : null;
}
const GRADOS = 180 / Math.PI;

/**
 * La pose que se está editando en el documento indicado, o null. Con un clip abierto, es lo que se ve en el tiempo
 * del playhead (con el id del clip, para que los cambios vayan a sus keyframes).
 */
export function poseActiva(doc = estado.doc) {
  // Con Live encendido no se edita nada: no hay pose ni clip que reciba cambios.
  if (estado.vivo) return null;
  const p = estado.pose && buscar(doc, estado.pose);
  if (p?.type === 'animation') return { ...poseDeClip(doc, esquema, p, estado.tiempo, estado.params ?? {}), id: p.id };
  return p?.type === 'pose' ? p : null;
}

/** Cómo se nombra en el historial lo que se edita: «pose happy» o «clip wave @ 0.5s». */
export function nombreDeEdicion(id = estado.pose) {
  return buscar(estado.doc, id)?.type === 'animation' ? `clip ${id} @ ${+estado.tiempo.toFixed(3)}s` : `pose ${id}`;
}

/** El clip abierto (animation), o null. */
export function clipAbierto(doc = estado.doc) {
  const p = estado.pose && doc && buscar(doc, estado.pose);
  return p?.type === 'animation' ? p : null;
}

/** Lo que se ve: la pose que se edita, la mezcla de los params (vista Parámetros) o null (el montaje). */
export function poseVista(doc = estado.doc) {
  if (estado.vivo) return estado.poseViva;
  return poseActiva(doc) ?? (estado.params ? mezclarPoses(doc, esquema, estado.params) : null);
}

/**
 * Lote que fija propiedades de un objeto dentro de una pose (conserva lo demás; undefined quita la propiedad). En un
 * clip, cada propiedad queda como keyframe en el tiempo del playhead (autokey); undefined quita ese keyframe. La
 * lógica está en el núcleo, la misma que usa el MCP.
 */
export function opsDePose(doc, poseId, id, campos) {
  if (buscar(doc, poseId)?.type === 'animation') return opsParaClavesEnClip(doc, esquema, poseId, id, campos, estado.tiempo, estado.params ?? {});
  return opsParaFijarPose(doc, poseId, { [id]: campos });
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
  if (pose) return ejecutar(opsDePose(estado.doc, pose.id, swId, { active: hijo }), `${nombreDeEdicion(pose.id)}: ${swId} shows ${hijo}`);
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

// Lo usan el árbol y main.js; vive en el núcleo.
export { motivoParaNoEnlazar };

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
  let plan;
  try {
    plan = planEnlazarPorCercania(estado.doc, esquema, esqueletoId);
  } catch {
    return avisar(`Skeleton ${esqueletoId} has no bones yet: create them with Add Bone (B)`, true);
  }
  const { ops, enlaces } = plan;
  if (!enlaces.length) return avisar(`All the drawing in ${esqueletoId} already follows a bone`);
  ejecutar(ops, `bind all by proximity in ${esqueletoId} (${enlaces.length})`);
  avisar(`Bound ${enlaces.length}: ${enlaces.map((e) => `${e.id} → ${e.bone}`).join(', ')}`);
}

/**
 * Antes de mover `id` a `padre`: lo que suelta los enlaces que dejarían de valer (dibujo que sale del skeleton de su
 * hueso, o huesos que se van a otro skeleton). Va en el mismo lote, antes del move.
 */
export function soltarAlMover(doc, id, padre) {
  return opsParaSoltarAlMover(doc, esquema, id, padre);
}

/** Aviso para lo que soltarAlMover soltó. */
export function avisarSueltos(ops) {
  const ids = [...new Set(ops.map((o) => o.target))];
  if (ids.length) avisar(`Unbound ${ids.join(', ')}: a drawing only follows bones of its own skeleton`);
}

export function crearHuesos(ctx) {
  const activos = () => HERRAMIENTAS_DE_HUESO.includes(estado.herramienta) || !!estado.pose;
  const ajustando = () => estado.herramienta === 'manipular' || !!estado.pose;
  const esHueso = (id) => buscar(estado.doc, id)?.type === 'bone';

  // ---------- Dibujo ----------

  function dibujar() {
    const doc = docVisible();
    const huesos = doc.objects.filter((o) => o.type === 'bone');
    if (!huesos.length) return;
    const { posado } = evaluarEnPose(doc, esquema, poseVista(doc));
    const camara = ctx.matrizCamara();
    const capa = ctx.crear('g', { class: `huesos${activos() ? ' activos' : ''}` });
    const elegido = huesoElegido(doc);
    for (const h of huesos) {
      const m = multiplicar(camara, posado.get(h.id));
      const o = aplicar(m, 0, 0);
      const t = aplicar(m, leer(esquema, h, 'length'), 0);
      const largo = Math.hypot(t[0] - o[0], t[1] - o[1]);
      // El padre y los hijos del hueso elegido, marcados para ver la cadena.
      // Con Reparent Bone y varios elegidos, el principal es el padre que se va a usar: se marca distinto.
      const reparentando = estado.herramienta === 'reparentar' && estado.seleccionados.length > 1;
      const parentesco = reparentando ? (h.id === estado.seleccion ? ' padre-nuevo' : '') : elegido && h.id === elegido.parent ? ' padre' : elegido && h.parent === elegido.id ? ' hijo' : '';
      const clase = `hueso${estado.seleccionados.includes(h.id) ? ' seleccionado' : ''}${h.id === estado.seleccion ? ' principal' : ''}${parentesco}`;
      const color = { style: `--c: ${colorDeHueso(doc, h.id)}` };
      // Unión punteada cuando el hueso no nace en la punta de su padre.
      const padre = h.parent && buscar(doc, h.parent);
      if (padre?.type === 'bone') {
        const mp = multiplicar(camara, posado.get(padre.id));
        const punta = aplicar(mp, leer(esquema, padre, 'length'), 0);
        if (Math.hypot(punta[0] - o[0], punta[1] - o[1]) > 2) capa.append(ctx.crear('line', { class: 'union-hueso', x1: punta[0], y1: punta[1], x2: o[0], y2: o[1] }));
      }
      if (largo < 4) {
        capa.append(ctx.crear('circle', { class: clase, 'data-hueso': h.id, cx: o[0], cy: o[1], r: 4, ...color }, h.id));
        continue;
      }
      // Forma de rombo alargado, como en Moho: ancho cerca del origen, en punta hacia el final.
      const [dx, dy] = [(t[0] - o[0]) / largo, (t[1] - o[1]) / largo];
      const ancho = Math.min(9, Math.max(3, largo * 0.12));
      const q = [o[0] + dx * largo * 0.2, o[1] + dy * largo * 0.2];
      const puntos = [o, [q[0] - dy * ancho, q[1] + dx * ancho], t, [q[0] + dy * ancho, q[1] - dx * ancho]];
      capa.append(ctx.crear('polygon', { class: clase, 'data-hueso': h.id, points: puntos.map((p) => p.join(',')).join(' '), ...color }, h.id));
    }
    // Reparent Bone: la jerarquía entera, una línea de cada hueso a la mitad de su padre.
    if (estado.herramienta === 'reparentar' && !estado.pose) {
      for (const h of huesos) {
        const padre = buscar(doc, h.parent);
        if (padre?.type !== 'bone') continue;
        const o = aplicar(multiplicar(camara, posado.get(h.id)), 0, 0);
        const p = aplicar(multiplicar(camara, posado.get(padre.id)), leer(esquema, padre, 'length') / 2, 0);
        capa.prepend(ctx.crear('line', { class: 'linea-padre', x1: o[0], y1: o[1], x2: p[0], y2: p[1] }, `${h.id} hangs from ${padre.id}`));
      }
    }
    ctx.superposicion.append(capa);
    if (estado.herramienta === 'enlazarPuntos' && !estado.pose) dibujarPuntos(doc);

    // Lo que mueve el hueso elegido, marcado en el dibujo.
    const marcado = elegido?.id;
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

    // Manijas del hueso principal seleccionado: con Manipulate (o en una pose), origen y punta para ajustarlo; con Add
    // Bone, solo la punta, para encadenar.
    const sel = activos() && estado.seleccion && buscar(doc, estado.seleccion);
    if (sel?.type === 'bone') {
      const m = multiplicar(camara, posado.get(sel.id));
      const [ox, oy] = aplicar(m, 0, 0);
      const [tx, ty] = aplicar(m, leer(esquema, sel, 'length'), 0);
      if (ajustando()) ctx.superposicion.append(ctx.crear('circle', { class: 'manija', 'data-manija': 'hueso-origen', cx: ox, cy: oy, r: 5 }, estado.pose ? 'Offset the bone in the pose' : 'Move the bone origin'));
      const titulo = estado.pose ? 'Rotate the bone' : ajustando() ? 'Direction and length (Shift: 15° steps)' : 'Drag: chain a new bone from this tip';
      if (ajustando() || estado.herramienta === 'hueso') ctx.superposicion.append(ctx.crear('circle', { class: `manija${ajustando() ? '' : ' manija-encadenar'}`, 'data-manija': 'hueso-punta', cx: tx, cy: ty, r: 5 }, titulo));
    }
  }

  /** Bind Points: los puntos de los paths del skeleton activo, con el color del hueso que siguen. */
  function dibujarPuntos(doc) {
    const esqueleto = esqueletoActivo(doc);
    if (!esqueleto) return;
    const camara = ctx.matrizCamara();
    const capa = ctx.crear('g', { class: 'puntos-hueso' });
    for (const path of doc.objects.filter((o) => o.type === 'path' && esqueletoDe(doc, o.id) === esqueleto)) {
      const m = multiplicar(camara, matrizMundo(doc, esquema, path.id));
      leer(esquema, path, 'vertices').forEach((v, i) => {
        const [x, y] = aplicar(m, v.x, v.y);
        const atributos = { class: `punto-hueso${v.bone ? '' : ' libre'}`, 'data-punto': `${path.id}:${i}`, cx: x, cy: y, r: 4 };
        if (v.bone) atributos.style = `--c: ${colorDeHueso(doc, v.bone)}`;
        capa.append(ctx.crear('circle', atributos, `${path.id} point ${i}${v.bone ? ` → ${v.bone}` : ' (follows the shape)'}`));
      });
    }
    ctx.superposicion.append(capa);
  }

  // ---------- Matrices de trabajo ----------

  /** Lo que hace falta para arrastrar un hueso: su matriz en pantalla y la del marco de su padre. */
  function marcos(id) {
    const doc = estado.doc;
    const pose = poseActiva(doc);
    // Lo que se ve: con la pose aplicada también al skeleton y a sus grupos de arriba.
    const visto = pose ? aplicarPose(doc, esquema, pose) : doc;
    const ev = evaluarEsqueleto(visto, esquema, pose);
    const mundo = pose ? ev.posado : ev.reposo;
    const h = buscar(doc, id);
    const camara = ctx.matrizCamara();
    // El marco del padre: el hueso padre o, para un hueso raíz, su skeleton.
    const deHueso = buscar(doc, h.parent)?.type === 'bone';
    const padre = multiplicar(camara, deHueso ? mundo.get(h.parent) : marcoDeHijos(visto, esquema, h.parent));
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

  const nota = (id, que) => (estado.pose ? `${nombreDeEdicion()}: ${que} ${id}` : `${que} ${id}`);

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
      // En la pose, la punta solo gira. Con Add Bone encadena uno nuevo; con Manipulate cambia dirección y largo.
      if (estado.pose) return rotar(e, id);
      if (!ajustando()) return crear(e);
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

  /** Add Bone en el montaje: un clic en un hueso lo elige; arrastrar en vacío crea uno. */
  function pointerdown(e) {
    const id = e.target.closest('[data-hueso]')?.dataset.hueso;
    if (id) return seleccionar(id);
    crear(e);
  }

  /** Manipulate Bones en el montaje: arrastrar un hueso lo gira; Ctrl + clic lo suma o lo quita; un clic en vacío suelta la selección. */
  function pointerdownManipular(e) {
    const id = e.target.closest('[data-hueso]')?.dataset.hueso;
    if (!id) return recuadroDeHuesos(e, e.ctrlKey || e.metaKey || e.shiftKey);
    if (e.ctrlKey || e.metaKey) return alternarSeleccion(id);
    seleccionar(id);
    rotar(e, id);
  }

  /**
   * Arrastrar en un lugar vacío: elige los huesos que toca el recuadro (con Ctrl o Shift, los suma). Clic: suelta
   * todo. Con `conFormas` (en una pose o un clip) también elige las formas que toca, para keyar varias a la vez.
   */
  function recuadroDeHuesos(e, sumar, conFormas = false) {
    const doc = docVisible();
    const base = sumar ? (conFormas ? [...estado.seleccionados] : estado.seleccionados.filter(esHueso)) : [];
    const { posado } = evaluarEnPose(doc, esquema, poseVista(doc));
    const camara = ctx.matrizCamara();
    // Cada hueso como unos puntos a lo largo de su eje, en pantalla: lo toca el recuadro si alguno cae adentro.
    const huesos = doc.objects.filter((o) => o.type === 'bone').map((h) => {
      const m = multiplicar(camara, posado.get(h.id));
      const largo = leer(esquema, h, 'length');
      return { id: h.id, puntos: Array.from({ length: 13 }, (_, i) => aplicar(m, (largo * i) / 12, 0)) };
    });
    // Formas visibles (no contenedores, como con el clic), con su caja en pantalla; las ocultas miden 0 y quedan afuera.
    const CONTENEDORES = ['group', 'skeleton', 'switch'];
    const formas = !conFormas ? [] : [...ctx.documentoG.querySelectorAll('[data-id]')]
      .filter((el) => !CONTENEDORES.includes(buscar(doc, el.dataset.id)?.type))
      .map((el) => {
        const r = el.getBoundingClientRect();
        const [x0, y0] = ctx.puntoPantalla({ clientX: r.left, clientY: r.top });
        return r.width || r.height ? { id: el.dataset.id, caja: [x0, y0, x0 + r.width, y0 + r.height] } : null;
      })
      .filter(Boolean);
    const s0 = ctx.puntoPantalla(e);
    const caja = ctx.crear('rect', { class: 'recuadro' });
    let movio = false;
    ctx.arrastrar(
      e,
      (ev) => {
        const s = ctx.puntoPantalla(ev);
        if (!movio && Math.hypot(s[0] - s0[0], s[1] - s0[1]) < 3) return;
        movio = true;
        const [x0, y0, x1, y1] = [Math.min(s0[0], s[0]), Math.min(s0[1], s[1]), Math.max(s0[0], s[0]), Math.max(s0[1], s[1])];
        const tocados = [
          ...formas.filter(({ caja: c }) => c[0] <= x1 && c[2] >= x0 && c[1] <= y1 && c[3] >= y0).map((f) => f.id),
          ...huesos.filter((h) => h.puntos.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)).map((h) => h.id),
        ];
        const ids = [...base, ...tocados.filter((t) => !base.includes(t))];
        if (ids.join() !== estado.seleccionados.join()) seleccionarVarios(ids, ids.at(-1) ?? null);
        for (const [k, v] of Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })) caja.setAttribute(k, v);
        ctx.superposicion.append(caja); // la superposición se redibuja al cambiar la selección
      },
      () => {
        caja.remove();
        if (!movio && !sumar) seleccionar(null);
      },
    );
  }

  const huesoTocado = (e) => e.target.closest('[data-hueso]')?.dataset.hueso ?? null;

  /**
   * Reparent Bone: el clic solo selecciona (Shift/Ctrl + clic suma o quita; clic en vacío suelta todo). El cambio lo
   * hacen los botones de la barra de opciones (ver planDeReparentar).
   */
  function pointerdownReparentar(e) {
    const tocado = huesoTocado(e);
    if (tocado && (e.shiftKey || e.ctrlKey || e.metaKey)) return alternarSeleccion(tocado);
    seleccionar(tocado);
  }

  /** Bind Layer: clic en un hueso lo elige; clic en el dibujo lo enlaza a él (o lo suelta). Alt: su grupo. */
  function pointerdownEnlazarCapa(e) {
    const tocado = huesoTocado(e);
    if (tocado) return seleccionar(tocado);
    const g = e.target.closest('[data-id]');
    if (!g || !ctx.documentoG.contains(g)) return;
    const hueso = huesoParaEnlazar();
    if (!hueso) return avisar('Bind Layer: first click the bone the drawing should follow', true);
    const obj = buscar(estado.doc, g.dataset.id);
    alternarEnlace(e.altKey && obj.parent && buscar(estado.doc, obj.parent)?.type !== 'skeleton' ? obj.parent : obj.id, hueso);
  }

  /**
   * Bind Points: clic en un hueso lo elige; clic en un punto lo enlaza a ese hueso (o lo suelta si ya era suyo);
   * arrastrar hace un recuadro y enlaza todos los puntos de adentro (con Alt, los suelta).
   */
  function pointerdownEnlazarPuntos(e) {
    const doc = estado.doc;
    const tocado = huesoTocado(e);
    const punto = e.target.closest('[data-punto]')?.dataset.punto;
    if (tocado && !punto) return seleccionar(tocado);
    const hueso = huesoElegido(doc);
    if (!hueso) return avisar('Bind Points: first click the bone the points should follow', true);
    if (punto) {
      const [pathId, i] = [punto.slice(0, punto.lastIndexOf(':')), Number(punto.slice(punto.lastIndexOf(':') + 1))];
      const v = leer(esquema, buscar(doc, pathId), 'vertices')[i];
      return guardarPuntos(new Map([[pathId, new Map([[i, e.altKey || v.bone === hueso.id ? null : hueso.id]])]]), hueso.id);
    }
    // Recuadro.
    const s0 = ctx.puntoPantalla(e);
    const caja = ctx.crear('rect', { class: 'recuadro', x: s0[0], y: s0[1], width: 0, height: 0 });
    ctx.superposicion.append(caja);
    let s1 = s0;
    ctx.arrastrar(
      e,
      (ev) => {
        s1 = ctx.puntoPantalla(ev);
        Object.entries({ x: Math.min(s0[0], s1[0]), y: Math.min(s0[1], s1[1]), width: Math.abs(s1[0] - s0[0]), height: Math.abs(s1[1] - s0[1]) }).forEach(([k, v]) => caja.setAttribute(k, v));
        ctx.superposicion.append(caja);
      },
      (ev) => {
        caja.remove();
        if (Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) < 4) return;
        const [x0, x1] = [Math.min(s0[0], s1[0]), Math.max(s0[0], s1[0])];
        const [y0, y1] = [Math.min(s0[1], s1[1]), Math.max(s0[1], s1[1])];
        const camara = ctx.matrizCamara();
        const esqueleto = esqueletoDe(doc, hueso.id);
        const cambios = new Map();
        for (const path of doc.objects.filter((o) => o.type === 'path' && esqueletoDe(doc, o.id) === esqueleto)) {
          const m = multiplicar(camara, matrizMundo(doc, esquema, path.id));
          leer(esquema, path, 'vertices').forEach((v, i) => {
            const [x, y] = aplicar(m, v.x, v.y);
            if (x < x0 || x > x1 || y < y0 || y > y1) return;
            (cambios.get(path.id) ?? cambios.set(path.id, new Map()).get(path.id)).set(i, ev.altKey || e.altKey ? null : hueso.id);
          });
        }
        if (cambios.size) guardarPuntos(cambios, hueso.id);
      },
    );
  }

  /** Lote con los vértices nuevos de cada path: cambios = Map(pathId → Map(índice → hueso o null)). */
  function guardarPuntos(cambios, hueso) {
    const ops = [];
    let n = 0;
    for (const [pathId, porIndice] of cambios) {
      const vertices = leer(esquema, buscar(estado.doc, pathId), 'vertices').map((v, i) => {
        if (!porIndice.has(i)) return v;
        n++;
        const { bone, ...resto } = v;
        return porIndice.get(i) ? { ...resto, bone: porIndice.get(i) } : resto;
      });
      ops.push({ op: 'set', target: pathId, props: { vertices } });
    }
    const suelta = [...cambios.values()].every((m) => [...m.values()].every((b) => b === null));
    ejecutar(ops, suelta ? `unbind ${n} point${n === 1 ? '' : 's'}` : `bind ${n} point${n === 1 ? '' : 's'} to ${hueso}`);
  }

  /** Con una pose activa: se gira el hueso tocado, o el hueso del dibujo tocado. */
  function pointerdownPose(e) {
    let id = e.target.closest('[data-hueso]')?.dataset.hueso;
    if (!id) {
      const g = e.target.closest('[data-id]');
      if (!g || !ctx.documentoG.contains(g)) return recuadroDeHuesos(e, e.ctrlKey || e.metaKey || e.shiftKey, true);
      id = huesoDe(estado.doc, g.dataset.id) ?? huesoCercanoDePuntos(g.dataset.id, ctx.puntoPantalla(e));
      if (!id) return e.ctrlKey || e.metaKey ? alternarSeleccion(g.dataset.id) : seleccionar(g.dataset.id);
    }
    // Ctrl + clic: suma o quita de la selección sin girar (para ver y keyar varios en la timeline).
    if (e.ctrlKey || e.metaKey) return alternarSeleccion(id);
    seleccionar(id);
    rotar(e, id);
  }

  /** Path enlazado por punto: el hueso (de los que siguen sus vértices) más cercano al clic, en la pose. */
  function huesoCercanoDePuntos(pathId, punto) {
    const path = buscar(estado.doc, pathId);
    const ids = [...new Set((path?.vertices ?? []).map((v) => v.bone).filter(Boolean))];
    if (!ids.length) return null;
    const { posado } = evaluarEnPose(estado.doc, esquema, poseActiva());
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
        if (!padre && !esqueleto) avisar(`Bones live in a skeleton, so ${destino} was created. Drag the drawing into it in Layers, then bind it.`);
      },
    );
  }

  return { dibujar, manija, pointerdown, pointerdownManipular, pointerdownPose, pointerdownReparentar, pointerdownEnlazarCapa, pointerdownEnlazarPuntos };
}
