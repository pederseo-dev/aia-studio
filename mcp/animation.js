// Lógica de las herramientas de animación del MCP (set_keys, delete_keys, move_keys y el resumen de un clip), sin el
// transporte, para probarlas sin levantar el servidor. Los textos de error los lee la IA y el aviso del editor.

import { clipWarnings, scaleTime, isScene, evaluateClip, paramPoseLines, moveKey, putKey, keyTimes, setupValues } from '../src/core/animation.js';
import { sameTime } from '../src/core/curves.js';
import { findObject } from '../src/core/document.js';
import { read, suggest } from '../src/core/schema.js';
import { effectiveValue } from '../src/core/styles.js';
import { parseD } from '../src/core/paths.js';
import { svgDocument, svgStrip } from '../src/render/svg.js';
import { runScript } from '../src/core/live.js';

const n = (t) => +t.toFixed(3);

function clipOf(doc, animation) {
  const clip = findObject(doc, animation);
  if (clip?.type === 'animation') return clip;
  const clips = doc.objects.filter((o) => o.type === 'animation').map((o) => o.id);
  throw new Error(`there is no animation "${animation}".${suggest(animation, clips)} Animations: ${clips.join(', ') || 'none'}`);
}

/** ¿La pista id.prop está entre `targets` ("objeto.propiedad" o un id; "d" vale por "vertices")? Sin targets, todas. */
const chosen = (targets, id, prop) => !targets?.length || targets.some((x) => x === id || x === `${id}.${prop}` || (prop === 'vertices' && x === `${id}.d`));

/**
 * Los values de la pose de un momento, filtrados por `only` o `except` ("objeto.propiedad" o un id; "d" vale por
 * "vertices"). Error si la pose no existe, si se pasan los dos filtros o si uno nombra algo que la pose no fija.
 */
function poseValues(doc, k, i) {
  if (k.pose == null) {
    if (k.only?.length || k.except?.length) throw new Error(`keys[${i}]: only and except filter what pose copies; pass pose too`);
    return null;
  }
  const pose = findObject(doc, k.pose);
  if (pose?.type !== 'pose') {
    const poses = doc.objects.filter((o) => o.type === 'pose').map((o) => o.id);
    throw new Error(`keys[${i}].pose: there is no pose "${k.pose}".${suggest(k.pose, poses)} Poses: ${poses.join(', ') || 'none'}`);
  }
  if (k.only?.length && k.except?.length) throw new Error(`keys[${i}]: pass only or except, not both`);
  const filter = k.only?.length ? k.only : k.except;
  const values = structuredClone(pose.values ?? {});
  if (!filter?.length) return values;
  const has = Object.entries(values).flatMap(([id, fields]) => Object.keys(fields).map((prop) => `${id}.${prop}`));
  for (const x of filter) {
    if (!Object.entries(values).some(([id, fields]) => Object.keys(fields).some((prop) => chosen([x], id, prop)))) {
      throw new Error(`keys[${i}].${k.only?.length ? 'only' : 'except'}: pose "${k.pose}" doesn't set "${x}".${suggest(x, Object.keys(values))} It sets: ${has.join(', ') || 'nothing'}`);
    }
  }
  const remain = {};
  for (const [id, fields] of Object.entries(values)) {
    for (const [prop, v] of Object.entries(fields)) if (chosen(filter, id, prop) === !!k.only?.length) (remain[id] ??= {})[prop] = v;
  }
  return remain;
}

/** "+=14" o "-=2.5": un valor relativo al del montaje (solo en propiedades numéricas). */
const RELATIVE = /^([+-])=\s*(\d+(?:\.\d+)?|\.\d+)$/;

/**
 * Lo que fija un momento de set_keys: con `setup`, el montaje de todo lo que el clip ya anima (y de lo que trae la
 * pose del momento); después los valores de su pose (filtrada con only o except), values (con "d" convertido y los
 * relativos "+=n" sumados al montaje) y params.
 */
function momentValues(doc, schema, tracks, k, i) {
  let values = {};
  const fromPose = poseValues(doc, k, i);
  // Con setup, la pose solo dice qué propiedades vuelven al montaje (no se copian sus valores).
  if (k.setup) values = setupValues(doc, schema, tracks, fromPose);
  else if (fromPose) values = fromPose;
  for (const [id, fields] of Object.entries(k.values ?? {})) {
    const own = { ...fields };
    for (const [prop, v] of Object.entries(own)) {
      const m = typeof v === 'string' && v.match(RELATIVE);
      if (!m) continue;
      const obj = findObject(doc, id);
      if (!obj || obj.type === 'param' || schema.types.get(obj.type)?.properties[prop]?.type !== 'number') {
        throw new Error(`keys[${i}].values.${id}.${prop}: "${v}" (relative to the setup) only works on number properties of objects${obj ? '' : ` and there is no object "${id}"`}`);
      }
      own[prop] = Math.round((effectiveValue(schema, doc, obj, prop) + (m[1] === '-' ? -1 : 1) * Number(m[2])) * 1e6) / 1e6;
    }
    if (own.d !== undefined) {
      if (findObject(doc, id)?.type !== 'path') throw new Error(`keys[${i}].values.${id}.d: "d" only works on paths`);
      const subpaths = parseD(own.d);
      if (subpaths.length !== 1) throw new Error(`keys[${i}].values.${id}.d has ${subpaths.length} subpaths; a keyframe needs exactly one`);
      delete own.d;
      own.vertices = subpaths[0].vertices;
    }
    values[id] = { ...values[id], ...own };
  }
  for (const [id, v] of Object.entries(k.params ?? {})) {
    if (findObject(doc, id)?.type !== 'param') {
      const params = doc.objects.filter((o) => o.type === 'param').map((o) => o.id);
      throw new Error(`keys[${i}].params: there is no param "${id}".${suggest(id, params)} Params: ${params.join(', ') || 'none'}`);
    }
    values[id] = { value: v };
  }
  return values;
}

/** Propiedades de un clip de Puppet para Live, que set_keys acepta además de usage, loop y description. */
export const LIVE_PROPS = ['fade', 'next', 'blend', 'auto', 'repeat_min', 'repeat_max'];

/**
 * set_keys: cada momento ({ t, values, params, pose, setup, ease, targets }) se vuelve keyframes del clip. `pose`
 * copia los valores de esa pose; `setup` pone el montaje en todo lo que el clip anima; `values` (como en set_pose,
 * acepta "d") los suma o pisa; `params` anima params. Un momento con solo `ease` (y `targets`) cambia la curva de los
 * keyframes que ya hay en ese tiempo. Un keyframe en un tiempo que ya tenía uno lo reemplaza (y conserva su ease si no
 * se pasa otro). `remove` ("objeto.propiedad" o un id) saca pistas enteras antes de agregar. Crea el clip si no existe
 * y alarga la duración si un keyframe la pasa; una `duration` más corta que los keyframes es un error.
 */
/** @param {any} doc @param {any} schema @param {string} animation @param {Record<string, any>} [options] keys, usage, duration, loop, description, remove y lo de Live */
export function planSetKeys(doc, schema, animation, { keys = [], usage, duration, loop, description, remove = [], ...live } = {}) {
  const existing = findObject(doc, animation);
  if (existing && existing.type !== 'animation') throw new Error(`"${animation}" already exists and is a ${existing.type}; choose another id for the animation`);
  let tracks = structuredClone(existing?.tracks ?? {});
  for (const name of remove) {
    const [object, prop, ...extra] = String(name).split('.');
    if (!object || extra.length || prop === '') throw new Error(`remove: "${name}" should be "object.property" (for example "arm_bone.rotation") or an object id`);
    if (prop === undefined) delete tracks[object];
    else if (tracks[object]) {
      delete tracks[object][prop === 'd' ? 'vertices' : prop];
      if (!Object.keys(tracks[object]).length) delete tracks[object];
    }
  }
  // Los momentos con setup van al final: así vuelven al montaje también las pistas que agregan los demás momentos.
  const order = keys.map((k, i) => [i, k]).sort(([, a], [, b]) => Number(!!a?.setup) - Number(!!b?.setup));
  for (const [i, k] of order) {
    if (typeof k?.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) throw new Error(`keys[${i}].t must be a number of seconds ≥ 0`);
    const values = momentValues(doc, schema, tracks, k, i);
    if (!Object.keys(values).length) {
      if (k.setup) throw new Error(`keys[${i}] (t ${k.t}): setup keys the setup values of what the clip already animates, and this clip animates nothing yet. Add the other moments first (in the same call is fine), or pass pose to say which properties go back to the setup`);
      // Solo una curva: cambia la de los keyframes que ya hay en ese tiempo (sin tocar sus valores).
      if (k.ease === undefined) throw new Error(`keys[${i}] (t ${k.t}) sets nothing: pass values, params, pose or setup (or only ease, to change the ease of the keyframes already at that time)`);
      let changed = 0;
      for (const [id, fields] of Object.entries(tracks)) {
        for (const [prop, keys] of Object.entries(fields)) {
          const key = keys.find((c) => sameTime(c.t, k.t));
          if (!key || !chosen(k.targets, id, prop)) continue;
          tracks = putKey(tracks, id, prop, key.t, key.value, k.ease);
          changed++;
        }
      }
      if (!changed) throw new Error(`keys[${i}]: there are no keyframes at t ${k.t}${k.targets?.length ? ` in ${k.targets.join(', ')}` : ''} to change the ease of. Keys at: ${keyTimes({ tracks: tracks }).map(n).join(', ') || 'none'}`);
      continue;
    }
    for (const [id, fields] of Object.entries(values)) {
      for (const [prop, v] of Object.entries(fields)) tracks = putKey(tracks, id, prop, k.t, v, k.ease);
    }
  }
  const last = Math.max(0, ...Object.values(tracks).flatMap((c) => Object.values(c).flatMap((keys) => keys.map((c) => c.t))));
  if (duration !== undefined && duration < last) {
    throw new Error(`duration ${duration} s is shorter than the keyframes, which go up to ${n(last)} s. To shorten the clip, first delete or move the later keyframes (delete_keys, move_keys), or use a duration of at least ${n(last)} s.`);
  }
  const requested = duration ?? read(schema, existing ?? { type: 'animation' }, 'duration');
  const final = Math.max(requested, last);
  // Sin momentos ni remove no se tocan las pistas (cambiar solo fade o loop no ensucia el historial con tracks).
  const props = keys.length || remove.length || !existing ? { tracks: tracks } : {};
  // Lo de Live (fade, next, blend, auto, repeat_min, repeat_max) pasa tal cual: la validación dice si no corresponde.
  for (const [k, v] of Object.entries({ usage, loop, description })) if (v !== undefined) props[k] = v;
  for (const k of LIVE_PROPS) if (live[k] !== undefined) props[k] = live[k];
  if (duration !== undefined || final !== requested || !existing) props.duration = final;
  const ops = existing ? [{ op: 'set', target: animation, props }] : [{ op: 'create', type: 'animation', id: animation, props }];
  return { ops, duration: final, extendedFrom: final > requested ? requested : null };
}

/**
 * delete_keys: quita keyframes de un clip. `times` (segundos) elige los momentos; `targets` ("objeto.propiedad" o
 * un id) elige las pistas; sin times, la pista entera; sin targets, todas. Una pista que queda vacía sale.
 */
/** @param {any} doc @param {string} animation @param {{ times?: number[], targets?: string[] }} [options] */
export function planDeleteKeys(doc, animation, { times, targets } = {}) {
  const clip = clipOf(doc, animation);
  if (!times?.length && !targets?.length) throw new Error('pass times, targets or both (to delete the whole clip, use apply_ops with delete)');
  const tracks = {};
  let removed = 0;
  for (const [id, fields] of Object.entries(clip.tracks ?? {})) {
    for (const [prop, keys] of Object.entries(fields)) {
      const remain = !chosen(targets, id, prop) ? keys : times?.length ? keys.filter((c) => !times.some((t) => sameTime(c.t, t))) : [];
      removed += keys.length - remain.length;
      if (remain.length) (tracks[id] ??= {})[prop] = remain;
    }
  }
  return { ops: removed ? [{ op: 'set', target: animation, props: { tracks: tracks } }] : [], removed };
}

/**
 * move_keys: mueve los keyframes de un momento (`from`) a otro (`to`), con su valor y su curva, en las pistas de
 * `targets` (o en todas). Falla si en `to` ya hay un keyframe en alguna de esas pistas (lo borraría) o si `to` pasa
 * la duración.
 */
/** @param {any} doc @param {any} schema @param {string} animation @param {{ from?: number, to?: number, targets?: string[] }} [options] */
export function planMoveKeys(doc, schema, animation, { from, to, targets } = {}) {
  const clip = clipOf(doc, animation);
  const newDuration = read(schema, clip, 'duration');
  if (!(to >= 0) || to > newDuration + 1e-9) throw new Error(`to must be between 0 and the clip's duration (${n(newDuration)} s); to move a keyframe later, first make duration longer`);
  // Mover al mismo tiempo no cambia nada: error, para no dejar en el historial una entrada vacía.
  if (sameTime(from, to)) throw new Error(`from and to are the same time (${n(from)} s): nothing to move`);
  let tracks = clip.tracks ?? {};
  const moved = [];
  for (const [id, fields] of Object.entries(clip.tracks ?? {})) {
    for (const prop of Object.keys(fields)) {
      if (!chosen(targets, id, prop)) continue;
      const created = moveKey(tracks, id, prop, from, to);
      if (!created) continue;
      tracks = created;
      moved.push(`${id}.${prop}`);
    }
  }
  if (!moved.length) throw new Error(`there are no keyframes at t ${from}${targets?.length ? ` in ${targets.join(', ')}` : ''}. Keys at: ${keyTimes(clip).map(n).join(', ') || 'none'}`);
  return { ops: [{ op: 'set', target: animation, props: { tracks: tracks } }], moved };
}

/** Una línea que resume un clip: uso, duración, loop, qué anima y en qué tiempos. */
export function clipSummary(schema, clip) {
  const tracks = Object.entries(clip.tracks ?? {}).flatMap(([id, fields]) => Object.keys(fields).map((k) => `${id}.${k}`));
  const frameTimes = keyTimes(clip);
  const base = `${read(schema, clip, 'usage')}, ${n(read(schema, clip, 'duration'))} s, ${read(schema, clip, 'loop')}`;
  return `${base}${live(schema, clip)}; ${tracks.length ? `anima ${tracks.join(', ')}; keys en ${frameTimes.map(n).join(', ')}` : 'sin keyframes'}`;
}

/** Lo de Live de un clip de Puppet, para el resumen: «, gesto, fade 0.2 s, next idle». Vacío en una escena. */
function live(schema, clip) {
  if (read(schema, clip, 'usage') !== 'puppet') return '';
  const auto = read(schema, clip, 'auto');
  const parts = [auto !== 'off' ? `auto ${auto}${auto === 'repeat' ? ` cada ${n(read(schema, clip, 'repeat_min'))}–${n(read(schema, clip, 'repeat_max'))} s` : ''}` : read(schema, clip, 'loop') === 'once' ? 'gesto' : 'base'];
  parts.push(`fade ${n(read(schema, clip, 'fade'))} s`);
  if (read(schema, clip, 'next')) parts.push(`next ${read(schema, clip, 'next')}`);
  if (read(schema, clip, 'blend') === 'additive') parts.push('additive');
  return `, ${parts.join(', ')}`;
}

/**
 * Las pistas de un clip, una línea por pista con sus keyframes («t = valor (curva)»), para leer un clip sin el JSON
 * entero: los vértices se resumen por cantidad de puntos.
 */
export function trackLines(clip) {
  const value = (v) => (Array.isArray(v) ? `(${v.length} puntos)` : typeof v === 'number' ? n(v) : JSON.stringify(v));
  const curve = (e) => (e === undefined ? '' : ` ${Array.isArray(e) ? `[${e.join(', ')}]` : e}`);
  return Object.entries(clip.tracks ?? {}).flatMap(([id, fields]) =>
    Object.entries(fields).map(([prop, keys]) => `${id}.${prop}: ${keys.map((c) => `${n(c.t)} = ${value(c.value)}${curve(c.ease)}`).join(' · ')}`),
  );
}

/** Tiempos para una tira de cuadros de un clip: los de sus keyframes (como mucho 12, repartidos) o, si no hay, 0. */
export function timesForStrip(clip, max = 12) {
  const frameTimes = keyTimes(clip);
  if (frameTimes.length <= max) return frameTimes.length ? frameTimes : [0];
  return Array.from({ length: max }, (_, i) => frameTimes[Math.round((i * (frameTimes.length - 1)) / (max - 1))]);
}

/**
 * render_preview con animation: un cuadro (time) o una tira de cuadros (times, o los tiempos de sus keyframes), con
 * el texto para la IA (qué params anima el clip y qué drivers suman encima). Devuelve { svg, ancho, texto }; el
 * servidor lo pasa a PNG.
 */
export function planClipView(doc, schema, { region, bones, params, animation, time, times }) {
  const clip = clipOf(doc, animation);
  // Una escena se ve sin params ni drivers (como se exporta): params ahí no cambiaría nada y confundiría.
  if (isScene(schema, clip) && Object.keys(params ?? {}).length) throw new Error(`"${animation}" is a scene (Animate): scenes play without params or drivers (setup + keyframes). Drop params, or to see an expression in the scene, key it with set_keys and pose`);
  const frameTimes = time != null ? [time] : times?.length ? times : timesForStrip(clip);
  const options = { animation, params: params ?? {}, region, bones: bones };
  const svg = frameTimes.length === 1 ? svgDocument(doc, schema, { ...options, time: frameTimes[0] }) : svgStrip(doc, schema, { ...options, times: frameTimes });
  const animated = Object.keys(evaluateClip(doc, schema, clip, 0).params);
  const all = keyTimes(clip).length;
  const clipped = time == null && !times?.length && all > frameTimes.length ? ` (${frameTimes.length} de sus ${all} tiempos de keyframes, repartidos; pasa times para ver otros)` : '';
  const frames = frameTimes.length === 1 ? `cuadro en t = ${frameTimes[0]} s` : `${frameTimes.length} cuadros en t = ${frameTimes.join(', ')} s${clipped}`;
  const warnings = clipWarnings(doc, schema, clip, params ?? {});
  const poses = paramPoseText(doc, schema, clip);
  const text = `Clip "${animation}" (${clipSummary(schema, clip)}): ${frames}${animated.length ? `; el clip anima los params ${animated.join(', ')}` : ''}.${poses ? `\n${poses}` : ''}${warnings.length ? `\nOjo, drivers que suman encima del clip:\n${warnings.map((a) => `- ${a}`).join('\n')}` : ''}`;
  return { svg, width: frameTimes.length === 1 ? 600 : 1000, text };
}

/** Por qué una combinación de opciones de render_preview no sirve (null si sirve). */
/** @param {Record<string, any>} [options] pose, animation, time, times, live */
export function previewError({ pose, animation, time, times, live } = {}) {
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
/** @param {any} doc @param {any} schema @param {string} animation @param {{ duration?: number, factor?: number, from?: number, to?: number }} [options] */
export function planScaleTime(doc, schema, animation, { duration, factor, from, to } = {}) {
  const clip = clipOf(doc, animation);
  const total = read(schema, clip, 'duration');
  if ((duration === undefined) === (factor === undefined)) throw new Error('pass duration (the new length in seconds) or factor (0.5 = twice as fast), one of the two');
  const rangeStart = from ?? 0;
  const rangeEnd = to ?? total;
  const length = duration ?? (rangeEnd - rangeStart) * factor;
  if (!keyTimes(clip).length) throw new Error(`"${animation}" has no keyframes to scale; to change its length use set_keys with duration`);
  const { tracks, duration: newDuration } = scaleTime(clip.tracks, total, { from: rangeStart, to: rangeEnd, length });
  return { ops: [{ op: 'set', target: animation, props: { tracks: tracks, duration: newDuration } }], before: total, duration: newDuration, from: rangeStart, to: n(rangeEnd), length: n(length) };
}

/**
 * Rotaciones de un clip de Puppet que quedan a más de 180° del montaje: en vivo, el fundido interpola los números, así
 * que un brazo en 140 cuando el montaje lo tiene en -178 da casi una vuelta entera al entrar o salir (aunque en
 * pantalla se vea parecido). Devuelve una línea por pista.
 */
export function rotationWarnings(doc, schema, clip) {
  if (read(schema, clip, 'usage') !== 'puppet') return [];
  const warnings = [];
  for (const [id, fields] of Object.entries(clip.tracks ?? {})) {
    const obj = findObject(doc, id);
    if (!obj || !Array.isArray(fields.rotation)) continue;
    const setup = effectiveValue(schema, doc, obj, 'rotation');
    const far = fields.rotation.filter((c) => typeof c.value === 'number' && Math.abs(c.value - setup) > 180);
    if (!far.length) continue;
    const example = far[0].value;
    const near = example - 360 * Math.round((example - setup) / 360);
    warnings.push(`${id}.rotation: ${far.map((c) => `${n(c.value)} en t ${n(c.t)}`).join(', ')} queda a más de 180° del montaje (${n(setup)}); en vivo, el fundido lo hace girar casi una vuelta. Para el mismo ángulo en pantalla usa ${n(near)}.`);
  }
  return warnings;
}

/** Las líneas «param → poses (objetos)» de un clip de Puppet, como texto para la IA (vacío si no anima params). */
export function paramPoseText(doc, schema, clip) {
  const lines = paramPoseLines(doc, schema, clip);
  return lines.length ? `Params animados y las poses que mueven (por sus drivers; todas se suman):\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}

/**
 * render_preview con live: corre un guion ([{ t, play | stop | set }]) en el runtime en vivo (el mismo de la app) y
 * devuelve la tira de cuadros en `times` (por defecto, cada 0.25 s hasta 0.5 s después del último evento; como mucho
 * 24), con el texto de qué suena en cada cuadro. Devuelve { svg, ancho, texto }.
 */
/** @param {any} doc @param {any} schema @param {Record<string, any>} options live, times, until, auto, params, region, bones */
export function planLiveView(doc, schema, { live, times, until, auto, params, region, bones }) {
  for (const [i, e] of live.entries()) {
    const verbs = ['play', 'stop', 'set'].filter((k) => e[k] !== undefined);
    if (verbs.length !== 1) throw new Error(`live[${i}] (t ${e.t}) needs exactly one of play, stop or set${verbs.length ? ` (it has ${verbs.join(' and ')}; split it into two events at the same t)` : ''}`);
  }
  // Hasta cuándo: `until` o, si no, hasta que termine lo último que se disparó (un gesto entero; una base, medio
  // segundo más). Cada 0.25 s si entra en 24 cuadros; si no, 24 cuadros repartidos (el texto dice cada cuánto).
  const end =
    until ??
    Math.max(
      0.5,
      ...live.map((e) => {
        const clip = e.play ? findObject(doc, e.play) : null;
        return e.t + (clip?.type === 'animation' && read(schema, clip, 'loop') === 'once' ? read(schema, clip, 'duration') + 0.25 : 0.5);
      }),
    );
  const step = end / 0.25 + 1 <= 24 ? 0.25 : end / 23;
  const frameTimes = times?.length ? times : Array.from({ length: Math.floor(end / step + 1e-9) + 1 }, (_, i) => n(i * step));
  const frames = runScript(doc, schema, live, frameTimes, { params, auto });
  const options = { region, bones: bones };
  const svg = frames.length === 1 ? svgDocument(doc, schema, { ...options, pose: frames[0].pose }) : svgStrip(doc, schema, { ...options, times: frameTimes, poses: frames.map((c) => c.pose) });
  const pct = (w) => `${Math.round(w * 100)}%`;
  const lines = frames.map((c) => {
    const playing = c.state.playing.filter((s) => s.weight > 0).map((s) => `${s.clip} (${s.layer === 'gesto' ? 'gesto' : s.layer}, ${pct(s.weight)}${s.leaving ? ', saliendo' : ''})`);
    return `- t = ${n(c.t)} s: ${playing.join(', ') || 'nada (montaje y params)'}`;
  });
  // En el último cuadro: el valor que se ve (mezclado con los clips que animan params) y, si difiere, el de la app.
  const last = frames.at(-1);
  const value = (v) => (typeof v === 'number' ? n(v) : v);
  const withValue = Object.entries(last?.pose.params ?? {}).map(([k, v]) => {
    const app = last.state.params[k];
    return `${k} ${value(v)}${value(app) !== value(v) ? ` (la app: ${value(app)})` : ''}`;
  });
  const paramsEnd = withValue.length ? `\nParams en el último cuadro (mezclados con los clips): ${withValue.join(', ')}` : '';
  const distribution = times?.length ? '' : ` (cada ${n(step)} s hasta ${n(end)} s${step > 0.25 ? '; para ver más de cerca, pasa times o un until más corto' : ''})`;
  const autos = frames.repeats.length ? `\nClips auto repeat que sonaron (pueden caer entre cuadros): ${frames.repeats.map((r) => `${r.clip} ${n(r.from)}–${n(r.to)} s`).join(', ')}` : '';
  const apagados = auto === false ? '\nCapas auto apagadas (auto: false).' : '';
  const text = `En vivo (como lo vería la app), ${frames.length} cuadros${distribution}:\n${lines.join('\n')}${paramsEnd}${autos}${apagados}`;
  return { svg, width: frames.length === 1 ? 600 : 1000, text };
}
