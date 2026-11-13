// Clips de animación: el valor de cada pista en un tiempo, y la pose que resulta de un clip en un tiempo con los
// params encima. Es el evaluador único del que salen el editor, la vista previa de la IA, el runtime y (al hornear)
// el video y Lottie. Orden (ver docs/decision-animacion.md §4):
//
//   montaje → clip en t (valores absolutos) → params (los del clip pisan a los de afuera) → drivers suman sus poses
//
// Eso es en un clip de Puppet. Una escena de Animate se evalúa sin drivers: montaje + keyframes, como Design + lo
// animado (los params, las poses y los drivers son del muñeco; en una escena, una pose se copia como keyframes).

import { findObject } from './document.js';
import { applyCurve, sameTime } from './curves.js';
import { read } from './schema.js';
import { effectiveValue } from './styles.js';
import { blendColor, blendPoses, blendVertices, driverWeight, paramValues } from './blend.js';

/**
 * El tiempo dentro del clip (0…duration) para un tiempo de reproducción, según su loop. En un loop, el final de cada
 * vuelta (t = duration, 2·duration…) es el final y no el principio: así el último cuadro de la tira, el playhead al
 * final y el keyframe que se guarda ahí hablan del mismo momento.
 */
export function localTime(schema, clip, t) {
  const d = read(schema, clip, 'duration');
  const mode = read(schema, clip, 'loop');
  if (!(d > 0) || !Number.isFinite(t)) return 0;
  if (mode === 'loop') {
    const r = ((t % d) + d) % d;
    return r === 0 && t > 0 ? d : r;
  }
  if (mode === 'pingpong') {
    const cycle = ((t % (2 * d)) + 2 * d) % (2 * d);
    return cycle <= d ? cycle : 2 * d - cycle;
  }
  return Math.max(0, Math.min(d, t));
}

/** Valor de una lista de keyframes en el tiempo t, según el tipo de la propiedad (number, color, vertices o discreto). */
export function trackValue(keys, t, tipo) {
  if (!keys?.length) return undefined;
  if (t <= keys[0].t) return keys[0].value;
  const last = keys.at(-1);
  if (t >= last.t) return last.value;
  // Búsqueda binaria del tramo [a, b] que contiene a t (como Rive).
  let [lo, hi] = [0, keys.length - 1];
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (keys[m].t <= t) lo = m;
    else hi = m;
  }
  const [a, b] = [keys[lo], keys[hi]];
  if (a.ease === 'step') return a.value;
  const w = applyCurve(a.ease, (t - a.t) / (b.t - a.t));
  if (tipo === 'number' && typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value - a.value) * w;
  if (tipo === 'color') return blendColor(a.value, b.value, Math.max(0, Math.min(1, w)));
  if (tipo === 'vertices' && Array.isArray(a.value) && Array.isArray(b.value)) return blendVertices(a.value, b.value, w);
  // Lo que no se interpola cambia de golpe en el keyframe siguiente.
  return a.value;
}

/**
 * Lo que fija un clip en el tiempo t (de reproducción): `values` ({ objeto: { propiedad: valor } }, como una pose) y
 * `params` ({ param: valor }) de las pistas de params.
 */
export function evaluateClip(doc, schema, clip, t) {
  const local = localTime(schema, clip, t);
  const values = {};
  const params = {};
  for (const [id, fields] of Object.entries(clip.tracks ?? {})) {
    const obj = findObject(doc, id);
    if (!obj) continue;
    if (obj.type === 'param') {
      if (fields.value?.length) {
        const kind = read(schema, obj, 'kind');
        params[id] = trackValue(fields.value, local, kind === 'number' ? 'number' : 'discreto');
      }
      continue;
    }
    const props = schema.types.get(obj.type)?.properties ?? {};
    for (const [prop, keys] of Object.entries(fields)) {
      if (!props[prop]?.animatable || !keys?.length) continue;
      (values[id] ??= {})[prop] = trackValue(keys, local, props[prop].type);
    }
  }
  return { values, params, time: local };
}

/** Una escena de Animate (no un clip de Puppet): se evalúa sin params ni drivers. */
export const isScene = (schema, clip) => clip?.type === 'animation' && read(schema, clip, 'usage') !== 'puppet';

/**
 * La pose que se ve con un clip en el tiempo t. En un clip de Puppet, lo animado con los drivers sumando sus poses
 * encima; `params` son los de afuera (la app, los sliders) y los que el clip anima los pisan. En una escena de
 * Animate, solo lo animado: `params` no cuenta y los drivers no suman.
 */
export function clipPose(doc, schema, clip, t, params = {}) {
  const c = typeof clip === 'string' ? findObject(doc, clip) : clip;
  if (c?.type !== 'animation') return null;
  const evaluated = evaluateClip(doc, schema, c, t);
  if (isScene(schema, c)) return { id: null, type: 'pose', values: evaluated.values, params: {}, clip: c.id, time: evaluated.time };
  const pose = blendPoses(doc, schema, { ...params, ...evaluated.params }, evaluated.values);
  return { ...pose, clip: c.id, time: evaluated.time };
}

export const roundTime = (t) => Math.round(t * 1e6) / 1e6;

/**
 * Pistas con un keyframe puesto en `id.prop` en el tiempo t (reemplaza el que hubiera en ese tiempo y conserva su
 * curva si no se pasa otra). No modifica las pistas recibidas. Los vértices no guardan `bone` (es del montaje).
 */
export function putKey(tracks, id, prop, t, value, ease) {
  const created = structuredClone(tracks ?? {});
  const keys = ((created[id] ??= {})[prop] ??= []);
  const time = roundTime(t);
  const j = keys.findIndex((c) => sameTime(c.t, time));
  const key = { t: time, value: prop === 'vertices' && Array.isArray(value) ? value.map(({ bone, ...v }) => v) : value };
  const curve = ease ?? (j >= 0 ? keys[j].ease : undefined);
  if (curve !== undefined && curve !== 'linear') key.ease = curve;
  if (j >= 0) keys[j] = key;
  else keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  return created;
}

/** Pistas sin el keyframe de `id.prop` en el tiempo t (una pista que queda vacía sale). */
export function removeKey(tracks, id, prop, t) {
  const created = structuredClone(tracks ?? {});
  const keys = created[id]?.[prop];
  if (!keys) return created;
  created[id][prop] = keys.filter((c) => !sameTime(c.t, t));
  if (!created[id][prop].length) delete created[id][prop];
  if (!Object.keys(created[id]).length) delete created[id];
  return created;
}

/** Tiempos de todos los keyframes de un clip, ordenados y sin repetir (para la tira de cuadros y el resumen). */
export function keyTimes(clip) {
  const times = new Set();
  for (const fields of Object.values(clip.tracks ?? {})) for (const keys of Object.values(fields)) for (const c of keys ?? []) times.add(c.t);
  return [...times].sort((a, b) => a - b);
}

/**
 * El valor que hay que guardar en la pista para que se vea `visto` (autokey): lo que se ve ya trae lo que suman los
 * drivers, y al evaluar se sumaría otra vez. En los números se resta ese aporte; lo demás (colores, vértices,
 * discretos) se guarda tal cual, porque la pista del clip gana sobre los drivers (ver mezclarPoses).
 */
export function valueToSave(doc, schema, clip, t, params, id, prop, seen) {
  const obj = findObject(doc, id);
  if (typeof seen !== 'number' || !obj || obj.type === 'param' || schema.types.get(obj.type)?.properties[prop]?.type !== 'number') return seen;
  const c = typeof clip === 'string' ? findObject(doc, clip) : clip;
  const fromClip = evaluateClip(doc, schema, c, t).values[id]?.[prop] ?? effectiveValue(schema, doc, obj, prop);
  const final = clipPose(doc, schema, c, t, params).values[id]?.[prop] ?? fromClip;
  const contribution = final - fromClip;
  return Math.abs(contribution) < 1e-9 ? seen : Math.round((seen - contribution) * 1e6) / 1e6;
}

/**
 * El lote que deja `campos` ({ propiedad: valor }) de un objeto como keyframes del clip en el tiempo `t` (autokey del
 * editor). Cada valor es lo que se quiere ver, con los params en `params`: se guarda sin lo que suman los drivers
 * (valorAGuardar). Un valor undefined quita el keyframe de esa propiedad en `t`.
 * @param {import('./types.js').Document} doc @param {any} schema @param {string} clipId @param {string} id
 * @param {Record<string, any>} fields @param {number} t @param {Record<string, any>} [params]
 * @returns {import('./types.js').Operation[]}
 */
export function opsForKeysInClip(doc, schema, clipId, id, fields, t, params = {}) {
  const clip = findObject(doc, clipId);
  let tracks = clip.tracks ?? {};
  for (const [k, v] of Object.entries(fields)) tracks = v === undefined ? removeKey(tracks, id, k, t) : putKey(tracks, id, k, t, valueToSave(doc, schema, clip, t, params, id, k, v));
  return [{ op: 'set', target: clipId, props: { tracks } }];
}

/**
 * Los valores del montaje de todo lo que el clip anima (y de lo que fija `pose`, si se pasa: el id de una pose o sus
 * values ya filtrados), con los params en su valor inicial: { objeto: { propiedad: valor } }. Es «Key setup» del
 * editor y `setup: true` de set_keys.
 */
export function setupValues(doc, schema, tracks, pose = null) {
  const params = paramValues(doc, schema);
  const props = new Map(Object.entries(tracks ?? {}).map(([id, fields]) => [id, new Set(Object.keys(fields))]));
  const extra = typeof pose === 'string' ? findObject(doc, pose)?.values : pose;
  for (const [id, fields] of Object.entries(extra ?? {})) for (const prop of Object.keys(fields)) (props.get(id) ?? props.set(id, new Set()).get(id)).add(prop);
  const values = {};
  for (const [id, names] of props) {
    const obj = findObject(doc, id);
    if (!obj) continue;
    for (const prop of names) (values[id] ??= {})[prop] = obj.type === 'param' ? params[id] : effectiveValue(schema, doc, obj, prop);
  }
  return values;
}

/**
 * Pistas con el keyframe de `id.prop` en `desde` movido a `hasta` (conserva valor y curva), o null si no hay
 * keyframe en `desde`. Error si en `hasta` ya hay otro: moverlo encima lo borraría.
 */
export function moveKey(tracks, id, prop, from, to) {
  const keys = tracks?.[id]?.[prop] ?? [];
  const key = keys.find((c) => sameTime(c.t, from));
  if (!key) return null;
  if (!sameTime(from, to) && keys.some((c) => c !== key && sameTime(c.t, to))) throw new Error(`${id}.${prop} already has a keyframe at ${roundTime(to)} s: delete it first or move to another time`);
  return putKey(removeKey(tracks, id, prop, key.t), id, prop, to, key.value, key.ease ?? 'linear');
}

/**
 * Avisos de un clip para la IA y el editor: las pistas numéricas a las que un driver activo les suma su pose encima
 * (un param animado, o uno con valor inicial distinto de 0), en los tiempos de sus keyframes. Así no sorprende que
 * un hueso keyado en 10 se vea en 40.
 */
export function clipWarnings(doc, schema, clip, params = {}) {
  const c = typeof clip === 'string' ? findObject(doc, clip) : clip;
  // Una escena no tiene drivers encima (ver poseDeClip).
  if (c?.type !== 'animation' || isScene(schema, c)) return [];
  const warnings = new Map();
  const drivers = doc.objects.filter((o) => o.type === 'driver' && findObject(doc, o.pose)?.type === 'pose');
  for (const t of keyTimes(c)) {
    const values = paramValues(doc, schema, { ...params, ...evaluateClip(doc, schema, c, t).params });
    for (const d of drivers) {
      if (!(d.param in values)) continue;
      const w = driverWeight(doc, schema, d, values[d.param]);
      if (w <= 0) continue;
      for (const [id, fields] of Object.entries(findObject(doc, d.pose).values ?? {})) {
        for (const prop of Object.keys(fields)) {
          if (!c.tracks?.[id]?.[prop]) continue;
          if (schema.types.get(findObject(doc, id)?.type)?.properties[prop]?.type !== 'number') continue;
          const key = `${id}.${prop} ${d.id}`;
          if (!warnings.has(key)) warnings.set(key, `${id}.${prop}: the clip keys it and driver ${d.id} (${d.param} = ${JSON.stringify(values[d.param])}${c.tracks?.[d.param] ? ', animated by the clip' : ''}) adds pose ${d.pose} on top (weight ${Math.round(w * 100)}% at ${t} s), so it shows more than the keyed value`);
        }
      }
    }
  }
  return [...warnings.values()];
}

/**
 * Reescala el tiempo de un tramo de un clip: los keyframes entre `desde` y `hasta` se estiran o comprimen en
 * proporción para que el tramo dure `largo`, y los de después se corren lo mismo (con su valor y su curva). Sin
 * desde/hasta, el clip entero. Devuelve { pistas, duracion } (la duración cambia lo mismo que el tramo). Error si
 * dos keyframes de una pista quedarían en el mismo momento.
 */
export function scaleTime(tracks, duration, { from = 0, to = duration, length }) {
  if (!(from >= 0) || !(to <= duration + 1e-9) || !(to - from > 0)) throw new Error(`the stretch to scale must be inside the clip (0…${roundTime(duration)} s) with from < to (received ${from}…${to})`);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error(`the new length must be a number of seconds > 0 (received ${length})`);
  const old = to - from;
  const delta = length - old;
  const map = (t) => roundTime(t <= from ? t : t >= to - 1e-9 ? t + delta : from + ((t - from) * length) / old);
  const created = {};
  for (const [id, fields] of Object.entries(tracks ?? {})) {
    for (const [prop, keys] of Object.entries(fields)) {
      const moved = keys.map((c) => ({ ...c, t: map(c.t) }));
      for (let i = 1; i < moved.length; i++) {
        if (sameTime(moved[i - 1].t, moved[i].t)) throw new Error(`${id}.${prop}: the keyframes at ${keys[i - 1].t} and ${keys[i].t} s would land on the same time (${moved[i].t} s). Use a longer length, or delete one of them first`);
      }
      (created[id] ??= {})[prop] = moved;
    }
  }
  return { tracks: created, duration: roundTime(duration + delta) };
}

/**
 * Qué mueve cada param que anima un clip de Puppet: [{ param, poses: [{ driver, pose, objetos }] }], con las poses de
 * sus drivers y los objetos que toca cada una. Así la IA (y la timeline) ven que animar `happiness` mueve también,
 * por ejemplo, `mirando_arriba`. En una escena, nada (no tiene params ni drivers).
 */
export function animatedParamPoses(doc, schema, clip) {
  const c = typeof clip === 'string' ? findObject(doc, clip) : clip;
  if (c?.type !== 'animation' || isScene(schema, c)) return [];
  const drivers = doc.objects.filter((o) => o.type === 'driver');
  return Object.keys(c.tracks ?? {})
    .filter((id) => findObject(doc, id)?.type === 'param' && c.tracks[id].value?.length)
    .map((param) => ({
      param,
      poses: drivers.filter((d) => d.param === param && findObject(doc, d.pose)?.type === 'pose').map((d) => ({ driver: d.id, pose: d.pose, objects: Object.keys(findObject(doc, d.pose).values ?? {}) })),
    }));
}

/** Una línea por param animado: «happiness → happy (eye_l, mouth), mirando_arriba (head_bone)». */
export function paramPoseLines(doc, schema, clip) {
  const objects = (ids) => (ids.length > 6 ? `${ids.slice(0, 6).join(', ')}…` : ids.join(', '));
  return animatedParamPoses(doc, schema, clip).map(({ param, poses }) =>
    `${param} → ${poses.length ? poses.map((p) => `${p.pose} (${objects(p.objects) || 'empty'})`).join(', ') : 'no driver: it moves nothing'}`,
  );
}
