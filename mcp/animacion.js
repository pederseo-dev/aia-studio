// Lógica de las herramientas de animación del MCP (set_keys, delete_keys, move_keys y el resumen de un clip), sin el
// transporte, para probarlas sin levantar el servidor. Los textos de error los lee la IA y el aviso del editor.

import { avisosDeClip, evaluarClip, moverClave, ponerClave, tiemposDeClaves, valoresDeMontaje } from '../src/core/animacion.js';
import { mismoTiempo } from '../src/core/curvas.js';
import { buscar } from '../src/core/documento.js';
import { leer, sugerir } from '../src/core/esquema.js';
import { parsearD } from '../src/core/trazado.js';
import { svgDocumento, svgTira } from '../src/render/svg.js';

const n = (t) => +t.toFixed(3);

function clipDe(doc, animacion) {
  const clip = buscar(doc, animacion);
  if (clip?.type === 'animation') return clip;
  const clips = doc.objects.filter((o) => o.type === 'animation').map((o) => o.id);
  throw new Error(`there is no animation "${animacion}".${sugerir(animacion, clips)} Animations: ${clips.join(', ') || 'none'}`);
}

/** ¿La pista id.prop está entre `targets` ("objeto.propiedad" o un id; "d" vale por "vertices")? Sin targets, todas. */
const elegida = (targets, id, prop) => !targets?.length || targets.some((x) => x === id || x === `${id}.${prop}` || (prop === 'vertices' && x === `${id}.d`));

/**
 * Lo que fija un momento de set_keys: con `setup`, el montaje de todo lo que el clip ya anima (y de lo que trae la
 * pose del momento); después los valores de su pose, values (con "d" convertido) y params.
 */
function valoresDelMomento(doc, esquema, pistas, k, i) {
  let valores = {};
  if (k.setup) {
    valores = valoresDeMontaje(doc, esquema, pistas, k.pose);
    // Con setup, la pose solo dice qué propiedades vuelven al montaje (no se copian sus valores).
    k = { ...k, pose: undefined };
  }
  if (k.pose != null) {
    const pose = buscar(doc, k.pose);
    if (pose?.type !== 'pose') {
      const poses = doc.objects.filter((o) => o.type === 'pose').map((o) => o.id);
      throw new Error(`keys[${i}].pose: there is no pose "${k.pose}".${sugerir(k.pose, poses)} Poses: ${poses.join(', ') || 'none'}`);
    }
    for (const [id, campos] of Object.entries(pose.values ?? {})) valores[id] = { ...campos };
  }
  for (const [id, campos] of Object.entries(k.values ?? {})) {
    const propios = { ...campos };
    if (propios.d !== undefined) {
      if (buscar(doc, id)?.type !== 'path') throw new Error(`keys[${i}].values.${id}.d: "d" only works on paths`);
      const subtrazados = parsearD(propios.d);
      if (subtrazados.length !== 1) throw new Error(`keys[${i}].values.${id}.d has ${subtrazados.length} subpaths; a keyframe needs exactly one`);
      delete propios.d;
      propios.vertices = subtrazados[0].vertices;
    }
    valores[id] = { ...valores[id], ...propios };
  }
  for (const [id, v] of Object.entries(k.params ?? {})) {
    if (buscar(doc, id)?.type !== 'param') {
      const params = doc.objects.filter((o) => o.type === 'param').map((o) => o.id);
      throw new Error(`keys[${i}].params: there is no param "${id}".${sugerir(id, params)} Params: ${params.join(', ') || 'none'}`);
    }
    valores[id] = { value: v };
  }
  return valores;
}

/**
 * set_keys: cada momento ({ t, values, params, pose, setup, ease, targets }) se vuelve keyframes del clip. `pose`
 * copia los valores de esa pose; `setup` pone el montaje en todo lo que el clip anima; `values` (como en set_pose,
 * acepta "d") los suma o pisa; `params` anima params. Un momento con solo `ease` (y `targets`) cambia la curva de los
 * keyframes que ya hay en ese tiempo. Un keyframe en un tiempo que ya tenía uno lo reemplaza (y conserva su ease si no
 * se pasa otro). `remove` ("objeto.propiedad" o un id) saca pistas enteras antes de agregar. Crea el clip si no existe
 * y alarga la duración si un keyframe la pasa; una `duration` más corta que los keyframes es un error.
 */
export function planSetKeys(doc, esquema, animacion, { keys = [], usage, duration, loop, description, remove = [] } = {}) {
  const existente = buscar(doc, animacion);
  if (existente && existente.type !== 'animation') throw new Error(`"${animacion}" already exists and is a ${existente.type}; choose another id for the animation`);
  let pistas = structuredClone(existente?.tracks ?? {});
  for (const nombre of remove) {
    const [objeto, prop, ...sobra] = String(nombre).split('.');
    if (!objeto || sobra.length || prop === '') throw new Error(`remove: "${nombre}" should be "object.property" (for example "arm_bone.rotation") or an object id`);
    if (prop === undefined) delete pistas[objeto];
    else if (pistas[objeto]) {
      delete pistas[objeto][prop === 'd' ? 'vertices' : prop];
      if (!Object.keys(pistas[objeto]).length) delete pistas[objeto];
    }
  }
  // Los momentos con setup van al final: así vuelven al montaje también las pistas que agregan los demás momentos.
  const orden = keys.map((k, i) => [i, k]).sort(([, a], [, b]) => Number(!!a?.setup) - Number(!!b?.setup));
  for (const [i, k] of orden) {
    if (typeof k?.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) throw new Error(`keys[${i}].t must be a number of seconds ≥ 0`);
    const valores = valoresDelMomento(doc, esquema, pistas, k, i);
    if (!Object.keys(valores).length) {
      if (k.setup) throw new Error(`keys[${i}] (t ${k.t}): setup keys the setup values of what the clip already animates, and this clip animates nothing yet. Add the other moments first (in the same call is fine), or pass pose to say which properties go back to the setup`);
      // Solo una curva: cambia la de los keyframes que ya hay en ese tiempo (sin tocar sus valores).
      if (k.ease === undefined) throw new Error(`keys[${i}] (t ${k.t}) sets nothing: pass values, params, pose or setup (or only ease, to change the ease of the keyframes already at that time)`);
      let cambiadas = 0;
      for (const [id, campos] of Object.entries(pistas)) {
        for (const [prop, claves] of Object.entries(campos)) {
          const clave = claves.find((c) => mismoTiempo(c.t, k.t));
          if (!clave || !elegida(k.targets, id, prop)) continue;
          pistas = ponerClave(pistas, id, prop, clave.t, clave.value, k.ease);
          cambiadas++;
        }
      }
      if (!cambiadas) throw new Error(`keys[${i}]: there are no keyframes at t ${k.t}${k.targets?.length ? ` in ${k.targets.join(', ')}` : ''} to change the ease of. Keys at: ${tiemposDeClaves({ tracks: pistas }).map(n).join(', ') || 'none'}`);
      continue;
    }
    for (const [id, campos] of Object.entries(valores)) {
      for (const [prop, v] of Object.entries(campos)) pistas = ponerClave(pistas, id, prop, k.t, v, k.ease);
    }
  }
  const ultimo = Math.max(0, ...Object.values(pistas).flatMap((c) => Object.values(c).flatMap((claves) => claves.map((c) => c.t))));
  if (duration !== undefined && duration < ultimo) {
    throw new Error(`duration ${duration} s is shorter than the keyframes, which go up to ${n(ultimo)} s. To shorten the clip, first delete or move the later keyframes (delete_keys, move_keys), or use a duration of at least ${n(ultimo)} s.`);
  }
  const pedida = duration ?? leer(esquema, existente ?? { type: 'animation' }, 'duration');
  const final = Math.max(pedida, ultimo);
  const props = { tracks: pistas };
  for (const [k, v] of Object.entries({ usage, loop, description })) if (v !== undefined) props[k] = v;
  if (duration !== undefined || final !== pedida || !existente) props.duration = final;
  const ops = existente ? [{ op: 'set', target: animacion, props }] : [{ op: 'create', type: 'animation', id: animacion, props }];
  return { ops, duracion: final, alargadaDesde: final > pedida ? pedida : null };
}

/**
 * delete_keys: quita keyframes de un clip. `times` (segundos) elige los momentos; `targets` ("objeto.propiedad" o
 * un id) elige las pistas; sin times, la pista entera; sin targets, todas. Una pista que queda vacía sale.
 */
export function planDeleteKeys(doc, animacion, { times, targets } = {}) {
  const clip = clipDe(doc, animacion);
  if (!times?.length && !targets?.length) throw new Error('pass times, targets or both (to delete the whole clip, use apply_ops with delete)');
  const pistas = {};
  let quitadas = 0;
  for (const [id, campos] of Object.entries(clip.tracks ?? {})) {
    for (const [prop, claves] of Object.entries(campos)) {
      const quedan = !elegida(targets, id, prop) ? claves : times?.length ? claves.filter((c) => !times.some((t) => mismoTiempo(c.t, t))) : [];
      quitadas += claves.length - quedan.length;
      if (quedan.length) (pistas[id] ??= {})[prop] = quedan;
    }
  }
  return { ops: quitadas ? [{ op: 'set', target: animacion, props: { tracks: pistas } }] : [], quitadas };
}

/**
 * move_keys: mueve los keyframes de un momento (`from`) a otro (`to`), con su valor y su curva, en las pistas de
 * `targets` (o en todas). Falla si en `to` ya hay un keyframe en alguna de esas pistas (lo borraría) o si `to` pasa
 * la duración.
 */
export function planMoveKeys(doc, esquema, animacion, { from, to, targets } = {}) {
  const clip = clipDe(doc, animacion);
  const duracion = leer(esquema, clip, 'duration');
  if (!(to >= 0) || to > duracion + 1e-9) throw new Error(`to must be between 0 and the clip's duration (${n(duracion)} s); to move a keyframe later, first make duration longer`);
  let pistas = clip.tracks ?? {};
  const movidas = [];
  for (const [id, campos] of Object.entries(clip.tracks ?? {})) {
    for (const prop of Object.keys(campos)) {
      if (!elegida(targets, id, prop)) continue;
      const nuevas = moverClave(pistas, id, prop, from, to);
      if (!nuevas) continue;
      pistas = nuevas;
      movidas.push(`${id}.${prop}`);
    }
  }
  if (!movidas.length) throw new Error(`there are no keyframes at t ${from}${targets?.length ? ` in ${targets.join(', ')}` : ''}. Keys at: ${tiemposDeClaves(clip).map(n).join(', ') || 'none'}`);
  return { ops: [{ op: 'set', target: animacion, props: { tracks: pistas } }], movidas };
}

/** Una línea que resume un clip: uso, duración, loop, qué anima y en qué tiempos. */
export function resumenDeClip(esquema, clip) {
  const pistas = Object.entries(clip.tracks ?? {}).flatMap(([id, campos]) => Object.keys(campos).map((k) => `${id}.${k}`));
  const tiempos = tiemposDeClaves(clip);
  const base = `${leer(esquema, clip, 'usage')}, ${n(leer(esquema, clip, 'duration'))} s, ${leer(esquema, clip, 'loop')}`;
  return `${base}; ${pistas.length ? `anima ${pistas.join(', ')}; keys en ${tiempos.map(n).join(', ')}` : 'sin keyframes'}`;
}

/**
 * Las pistas de un clip, una línea por pista con sus keyframes («t = valor (curva)»), para leer un clip sin el JSON
 * entero: los vértices se resumen por cantidad de puntos.
 */
export function lineasDePistas(clip) {
  const valor = (v) => (Array.isArray(v) ? `(${v.length} puntos)` : typeof v === 'number' ? n(v) : JSON.stringify(v));
  const curva = (e) => (e === undefined ? '' : ` ${Array.isArray(e) ? `[${e.join(', ')}]` : e}`);
  return Object.entries(clip.tracks ?? {}).flatMap(([id, campos]) =>
    Object.entries(campos).map(([prop, claves]) => `${id}.${prop}: ${claves.map((c) => `${n(c.t)} = ${valor(c.value)}${curva(c.ease)}`).join(' · ')}`),
  );
}

/** Tiempos para una tira de cuadros de un clip: los de sus keyframes (como mucho 12, repartidos) o, si no hay, 0. */
export function tiemposParaTira(clip, maximo = 12) {
  const tiempos = tiemposDeClaves(clip);
  if (tiempos.length <= maximo) return tiempos.length ? tiempos : [0];
  return Array.from({ length: maximo }, (_, i) => tiempos[Math.round((i * (tiempos.length - 1)) / (maximo - 1))]);
}

/**
 * render_preview con animation: un cuadro (time) o una tira de cuadros (times, o los tiempos de sus keyframes), con
 * el texto para la IA (qué params anima el clip y qué drivers suman encima). Devuelve { svg, ancho, texto }; el
 * servidor lo pasa a PNG.
 */
export function planVistaDeClip(doc, esquema, { region, bones, params, animation, time, times }) {
  const clip = clipDe(doc, animation);
  const tiempos = time != null ? [time] : times?.length ? times : tiemposParaTira(clip);
  const opciones = { animation, params: params ?? {}, region, huesos: bones };
  const svg = tiempos.length === 1 ? svgDocumento(doc, esquema, { ...opciones, time: tiempos[0] }) : svgTira(doc, esquema, { ...opciones, times: tiempos });
  const animados = Object.keys(evaluarClip(doc, esquema, clip, 0).params);
  const cuadros = tiempos.length === 1 ? `cuadro en t = ${tiempos[0]} s` : `${tiempos.length} cuadros en t = ${tiempos.join(', ')} s`;
  const avisos = avisosDeClip(doc, esquema, clip, params ?? {});
  const texto = `Clip "${animation}" (${resumenDeClip(esquema, clip)}): ${cuadros}${animados.length ? `; el clip anima los params ${animados.join(', ')}` : ''}.${avisos.length ? `\nOjo, drivers que suman encima del clip:\n${avisos.map((a) => `- ${a}`).join('\n')}` : ''}`;
  return { svg, ancho: tiempos.length === 1 ? 600 : 1000, texto };
}

/** Por qué una combinación de opciones de render_preview no sirve (null si sirve). */
export function errorDeVistaPrevia({ pose, animation, time, times } = {}) {
  if (animation && pose) return 'pass either pose or animation, not both: a clip already sets its own values (to see a pose at some moment of a clip, key it there with set_keys and pose)';
  if (!animation && (time != null || times?.length)) return 'time and times need animation (the id of a clip)';
  return null;
}
