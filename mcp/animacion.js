// Lógica de las herramientas de animación del MCP (set_keys, delete_keys, move_keys y el resumen de un clip), sin el
// transporte, para probarlas sin levantar el servidor. Los textos de error los lee la IA y el aviso del editor.

import { avisosDeClip, escalarTiempo, esEscena, evaluarClip, lineasDePosesDeParams, moverClave, ponerClave, tiemposDeClaves, valoresDeMontaje } from '../src/core/animacion.js';
import { mismoTiempo } from '../src/core/curvas.js';
import { buscar } from '../src/core/documento.js';
import { leer, sugerir } from '../src/core/esquema.js';
import { valorEfectivo } from '../src/core/estilos.js';
import { parsearD } from '../src/core/trazado.js';
import { svgDocumento, svgTira } from '../src/render/svg.js';
import { correrGuion } from '../src/core/vivo.js';

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
 * Los values de la pose de un momento, filtrados por `only` o `except` ("objeto.propiedad" o un id; "d" vale por
 * "vertices"). Error si la pose no existe, si se pasan los dos filtros o si uno nombra algo que la pose no fija.
 */
function valoresDePose(doc, k, i) {
  if (k.pose == null) {
    if (k.only?.length || k.except?.length) throw new Error(`keys[${i}]: only and except filter what pose copies; pass pose too`);
    return null;
  }
  const pose = buscar(doc, k.pose);
  if (pose?.type !== 'pose') {
    const poses = doc.objects.filter((o) => o.type === 'pose').map((o) => o.id);
    throw new Error(`keys[${i}].pose: there is no pose "${k.pose}".${sugerir(k.pose, poses)} Poses: ${poses.join(', ') || 'none'}`);
  }
  if (k.only?.length && k.except?.length) throw new Error(`keys[${i}]: pass only or except, not both`);
  const filtro = k.only?.length ? k.only : k.except;
  const valores = structuredClone(pose.values ?? {});
  if (!filtro?.length) return valores;
  const tiene = Object.entries(valores).flatMap(([id, campos]) => Object.keys(campos).map((prop) => `${id}.${prop}`));
  for (const x of filtro) {
    if (!Object.entries(valores).some(([id, campos]) => Object.keys(campos).some((prop) => elegida([x], id, prop)))) {
      throw new Error(`keys[${i}].${k.only?.length ? 'only' : 'except'}: pose "${k.pose}" doesn't set "${x}".${sugerir(x, Object.keys(valores))} It sets: ${tiene.join(', ') || 'nothing'}`);
    }
  }
  const quedan = {};
  for (const [id, campos] of Object.entries(valores)) {
    for (const [prop, v] of Object.entries(campos)) if (elegida(filtro, id, prop) === !!k.only?.length) (quedan[id] ??= {})[prop] = v;
  }
  return quedan;
}

/** "+=14" o "-=2.5": un valor relativo al del montaje (solo en propiedades numéricas). */
const RELATIVO = /^([+-])=\s*(\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Lo que fija un momento de set_keys: con `setup`, el montaje de todo lo que el clip ya anima (y de lo que trae la
 * pose del momento); después los valores de su pose (filtrada con only o except), values (con "d" convertido y los
 * relativos "+=n" sumados al montaje) y params.
 */
function valoresDelMomento(doc, esquema, pistas, k, i) {
  let valores = {};
  const dePose = valoresDePose(doc, k, i);
  // Con setup, la pose solo dice qué propiedades vuelven al montaje (no se copian sus valores).
  if (k.setup) valores = valoresDeMontaje(doc, esquema, pistas, dePose);
  else if (dePose) valores = dePose;
  for (const [id, campos] of Object.entries(k.values ?? {})) {
    const propios = { ...campos };
    for (const [prop, v] of Object.entries(propios)) {
      const m = typeof v === 'string' && v.match(RELATIVO);
      if (!m) continue;
      const obj = buscar(doc, id);
      if (!obj || obj.type === 'param' || esquema.tipos.get(obj.type)?.properties[prop]?.type !== 'number') {
        throw new Error(`keys[${i}].values.${id}.${prop}: "${v}" (relative to the setup) only works on number properties of objects${obj ? '' : ` and there is no object "${id}"`}`);
      }
      propios[prop] = Math.round((valorEfectivo(esquema, doc, obj, prop) + (m[1] === '-' ? -1 : 1) * Number(m[2])) * 1e6) / 1e6;
    }
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

/** Propiedades de un clip de Puppet para Live, que set_keys acepta además de usage, loop y description. */
export const PROPS_EN_VIVO = ['fade', 'next', 'blend', 'auto', 'repeat_min', 'repeat_max'];

/**
 * set_keys: cada momento ({ t, values, params, pose, setup, ease, targets }) se vuelve keyframes del clip. `pose`
 * copia los valores de esa pose; `setup` pone el montaje en todo lo que el clip anima; `values` (como en set_pose,
 * acepta "d") los suma o pisa; `params` anima params. Un momento con solo `ease` (y `targets`) cambia la curva de los
 * keyframes que ya hay en ese tiempo. Un keyframe en un tiempo que ya tenía uno lo reemplaza (y conserva su ease si no
 * se pasa otro). `remove` ("objeto.propiedad" o un id) saca pistas enteras antes de agregar. Crea el clip si no existe
 * y alarga la duración si un keyframe la pasa; una `duration` más corta que los keyframes es un error.
 */
/** @param {any} doc @param {any} esquema @param {string} animacion @param {Record<string, any>} [opciones] keys, usage, duration, loop, description, remove y lo de Live */
export function planSetKeys(doc, esquema, animacion, { keys = [], usage, duration, loop, description, remove = [], ...vivo } = {}) {
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
  // Sin momentos ni remove no se tocan las pistas (cambiar solo fade o loop no ensucia el historial con tracks).
  const props = keys.length || remove.length || !existente ? { tracks: pistas } : {};
  // Lo de Live (fade, next, blend, auto, repeat_min, repeat_max) pasa tal cual: la validación dice si no corresponde.
  for (const [k, v] of Object.entries({ usage, loop, description })) if (v !== undefined) props[k] = v;
  for (const k of PROPS_EN_VIVO) if (vivo[k] !== undefined) props[k] = vivo[k];
  if (duration !== undefined || final !== pedida || !existente) props.duration = final;
  const ops = existente ? [{ op: 'set', target: animacion, props }] : [{ op: 'create', type: 'animation', id: animacion, props }];
  return { ops, duracion: final, alargadaDesde: final > pedida ? pedida : null };
}

/**
 * delete_keys: quita keyframes de un clip. `times` (segundos) elige los momentos; `targets` ("objeto.propiedad" o
 * un id) elige las pistas; sin times, la pista entera; sin targets, todas. Una pista que queda vacía sale.
 */
/** @param {any} doc @param {string} animacion @param {{ times?: number[], targets?: string[] }} [opciones] */
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
/** @param {any} doc @param {any} esquema @param {string} animacion @param {{ from?: number, to?: number, targets?: string[] }} [opciones] */
export function planMoveKeys(doc, esquema, animacion, { from, to, targets } = {}) {
  const clip = clipDe(doc, animacion);
  const duracion = leer(esquema, clip, 'duration');
  if (!(to >= 0) || to > duracion + 1e-9) throw new Error(`to must be between 0 and the clip's duration (${n(duracion)} s); to move a keyframe later, first make duration longer`);
  // Mover al mismo tiempo no cambia nada: error, para no dejar en el historial una entrada vacía.
  if (mismoTiempo(from, to)) throw new Error(`from and to are the same time (${n(from)} s): nothing to move`);
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
  return `${base}${enVivo(esquema, clip)}; ${pistas.length ? `anima ${pistas.join(', ')}; keys en ${tiempos.map(n).join(', ')}` : 'sin keyframes'}`;
}

/** Lo de Live de un clip de Puppet, para el resumen: «, gesto, fade 0.2 s, next idle». Vacío en una escena. */
function enVivo(esquema, clip) {
  if (leer(esquema, clip, 'usage') !== 'puppet') return '';
  const auto = leer(esquema, clip, 'auto');
  const partes = [auto !== 'off' ? `auto ${auto}${auto === 'repeat' ? ` cada ${n(leer(esquema, clip, 'repeat_min'))}–${n(leer(esquema, clip, 'repeat_max'))} s` : ''}` : leer(esquema, clip, 'loop') === 'once' ? 'gesto' : 'base'];
  partes.push(`fade ${n(leer(esquema, clip, 'fade'))} s`);
  if (leer(esquema, clip, 'next')) partes.push(`next ${leer(esquema, clip, 'next')}`);
  if (leer(esquema, clip, 'blend') === 'additive') partes.push('additive');
  return `, ${partes.join(', ')}`;
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
  // Una escena se ve sin params ni drivers (como se exporta): params ahí no cambiaría nada y confundiría.
  if (esEscena(esquema, clip) && Object.keys(params ?? {}).length) throw new Error(`"${animation}" is a scene (Animate): scenes play without params or drivers (setup + keyframes). Drop params, or to see an expression in the scene, key it with set_keys and pose`);
  const tiempos = time != null ? [time] : times?.length ? times : tiemposParaTira(clip);
  const opciones = { animation, params: params ?? {}, region, huesos: bones };
  const svg = tiempos.length === 1 ? svgDocumento(doc, esquema, { ...opciones, time: tiempos[0] }) : svgTira(doc, esquema, { ...opciones, times: tiempos });
  const animados = Object.keys(evaluarClip(doc, esquema, clip, 0).params);
  const todos = tiemposDeClaves(clip).length;
  const recortada = time == null && !times?.length && todos > tiempos.length ? ` (${tiempos.length} de sus ${todos} tiempos de keyframes, repartidos; pasa times para ver otros)` : '';
  const cuadros = tiempos.length === 1 ? `cuadro en t = ${tiempos[0]} s` : `${tiempos.length} cuadros en t = ${tiempos.join(', ')} s${recortada}`;
  const avisos = avisosDeClip(doc, esquema, clip, params ?? {});
  const poses = textoDePosesDeParams(doc, esquema, clip);
  const texto = `Clip "${animation}" (${resumenDeClip(esquema, clip)}): ${cuadros}${animados.length ? `; el clip anima los params ${animados.join(', ')}` : ''}.${poses ? `\n${poses}` : ''}${avisos.length ? `\nOjo, drivers que suman encima del clip:\n${avisos.map((a) => `- ${a}`).join('\n')}` : ''}`;
  return { svg, ancho: tiempos.length === 1 ? 600 : 1000, texto };
}

/** Por qué una combinación de opciones de render_preview no sirve (null si sirve). */
/** @param {Record<string, any>} [opciones] pose, animation, time, times, live */
export function errorDeVistaPrevia({ pose, animation, time, times, live } = {}) {
  if (live && (animation || pose || time != null)) return 'live runs a script on the live puppet (its clips with fades); it does not go with animation, pose or time. To see one clip by itself use animation; for frames of the script use times';
  if (animation && pose) return 'pass either pose or animation, not both: a clip already sets its own values (to see a pose at some moment of a clip, key it there with set_keys and pose)';
  if (!animation && (time != null || (times?.length && !live))) return 'time and times need animation (the id of a clip)';
  return null;
}

/**
 * scale_time: estira o comprime en proporción el tiempo de un clip (o del tramo from…to) para que dure `duration`
 * (o `factor` veces lo que dura). Los keyframes de después del tramo se corren y la duración del clip cambia lo mismo.
 * Un solo paso de deshacer.
 */
/** @param {any} doc @param {any} esquema @param {string} animacion @param {{ duration?: number, factor?: number, from?: number, to?: number }} [opciones] */
export function planScaleTime(doc, esquema, animacion, { duration, factor, from, to } = {}) {
  const clip = clipDe(doc, animacion);
  const total = leer(esquema, clip, 'duration');
  if ((duration === undefined) === (factor === undefined)) throw new Error('pass duration (the new length in seconds) or factor (0.5 = twice as fast), one of the two');
  const desde = from ?? 0;
  const hasta = to ?? total;
  const largo = duration ?? (hasta - desde) * factor;
  if (!tiemposDeClaves(clip).length) throw new Error(`"${animacion}" has no keyframes to scale; to change its length use set_keys with duration`);
  const { pistas, duracion } = escalarTiempo(clip.tracks, total, { desde, hasta, largo });
  return { ops: [{ op: 'set', target: animacion, props: { tracks: pistas, duration: duracion } }], antes: total, duracion, desde, hasta: n(hasta), largo: n(largo) };
}

/**
 * Rotaciones de un clip de Puppet que quedan a más de 180° del montaje: en vivo, el fundido interpola los números, así
 * que un brazo en 140 cuando el montaje lo tiene en -178 da casi una vuelta entera al entrar o salir (aunque en
 * pantalla se vea parecido). Devuelve una línea por pista.
 */
export function avisosDeGiro(doc, esquema, clip) {
  if (leer(esquema, clip, 'usage') !== 'puppet') return [];
  const avisos = [];
  for (const [id, campos] of Object.entries(clip.tracks ?? {})) {
    const obj = buscar(doc, id);
    if (!obj || !Array.isArray(campos.rotation)) continue;
    const montaje = valorEfectivo(esquema, doc, obj, 'rotation');
    const lejos = campos.rotation.filter((c) => typeof c.value === 'number' && Math.abs(c.value - montaje) > 180);
    if (!lejos.length) continue;
    const ejemplo = lejos[0].value;
    const cerca = ejemplo - 360 * Math.round((ejemplo - montaje) / 360);
    avisos.push(`${id}.rotation: ${lejos.map((c) => `${n(c.value)} en t ${n(c.t)}`).join(', ')} queda a más de 180° del montaje (${n(montaje)}); en vivo, el fundido lo hace girar casi una vuelta. Para el mismo ángulo en pantalla usa ${n(cerca)}.`);
  }
  return avisos;
}

/** Las líneas «param → poses (objetos)» de un clip de Puppet, como texto para la IA (vacío si no anima params). */
export function textoDePosesDeParams(doc, esquema, clip) {
  const lineas = lineasDePosesDeParams(doc, esquema, clip);
  return lineas.length ? `Params animados y las poses que mueven (por sus drivers; todas se suman):\n${lineas.map((l) => `- ${l}`).join('\n')}` : '';
}

/**
 * render_preview con live: corre un guion ([{ t, play | stop | set }]) en el runtime en vivo (el mismo de la app) y
 * devuelve la tira de cuadros en `times` (por defecto, cada 0.25 s hasta 0.5 s después del último evento; como mucho
 * 24), con el texto de qué suena en cada cuadro. Devuelve { svg, ancho, texto }.
 */
/** @param {any} doc @param {any} esquema @param {Record<string, any>} opciones live, times, until, auto, params, region, bones */
export function planVistaEnVivo(doc, esquema, { live, times, until, auto, params, region, bones }) {
  for (const [i, e] of live.entries()) {
    const verbos = ['play', 'stop', 'set'].filter((k) => e[k] !== undefined);
    if (verbos.length !== 1) throw new Error(`live[${i}] (t ${e.t}) needs exactly one of play, stop or set${verbos.length ? ` (it has ${verbos.join(' and ')}; split it into two events at the same t)` : ''}`);
  }
  // Hasta cuándo: `until` o, si no, hasta que termine lo último que se disparó (un gesto entero; una base, medio
  // segundo más). Cada 0.25 s si entra en 24 cuadros; si no, 24 cuadros repartidos (el texto dice cada cuánto).
  const fin =
    until ??
    Math.max(
      0.5,
      ...live.map((e) => {
        const clip = e.play ? buscar(doc, e.play) : null;
        return e.t + (clip?.type === 'animation' && leer(esquema, clip, 'loop') === 'once' ? leer(esquema, clip, 'duration') + 0.25 : 0.5);
      }),
    );
  const paso = fin / 0.25 + 1 <= 24 ? 0.25 : fin / 23;
  const tiempos = times?.length ? times : Array.from({ length: Math.floor(fin / paso + 1e-9) + 1 }, (_, i) => n(i * paso));
  const cuadros = correrGuion(doc, esquema, live, tiempos, { params, auto });
  const opciones = { region, huesos: bones };
  const svg = cuadros.length === 1 ? svgDocumento(doc, esquema, { ...opciones, pose: cuadros[0].pose }) : svgTira(doc, esquema, { ...opciones, times: tiempos, poses: cuadros.map((c) => c.pose) });
  const pct = (w) => `${Math.round(w * 100)}%`;
  const lineas = cuadros.map((c) => {
    const sonando = c.estado.sonando.filter((s) => s.peso > 0).map((s) => `${s.clip} (${s.capa === 'gesto' ? 'gesto' : s.capa}, ${pct(s.peso)}${s.saliendo ? ', saliendo' : ''})`);
    return `- t = ${n(c.t)} s: ${sonando.join(', ') || 'nada (montaje y params)'}`;
  });
  // En el último cuadro: el valor que se ve (mezclado con los clips que animan params) y, si difiere, el de la app.
  const ultimo = cuadros.at(-1);
  const valor = (v) => (typeof v === 'number' ? n(v) : v);
  const conValor = Object.entries(ultimo?.pose.params ?? {}).map(([k, v]) => {
    const app = ultimo.estado.params[k];
    return `${k} ${valor(v)}${valor(app) !== valor(v) ? ` (la app: ${valor(app)})` : ''}`;
  });
  const finParams = conValor.length ? `\nParams en el último cuadro (mezclados con los clips): ${conValor.join(', ')}` : '';
  const reparto = times?.length ? '' : ` (cada ${n(paso)} s hasta ${n(fin)} s${paso > 0.25 ? '; para ver más de cerca, pasa times o un until más corto' : ''})`;
  const autos = cuadros.repeticiones.length ? `\nClips auto repeat que sonaron (pueden caer entre cuadros): ${cuadros.repeticiones.map((r) => `${r.clip} ${n(r.desde)}–${n(r.hasta)} s`).join(', ')}` : '';
  const apagados = auto === false ? '\nCapas auto apagadas (auto: false).' : '';
  const texto = `En vivo (como lo vería la app), ${cuadros.length} cuadros${reparto}:\n${lineas.join('\n')}${finParams}${autos}${apagados}`;
  return { svg, ancho: cuadros.length === 1 ? 600 : 1000, texto };
}
