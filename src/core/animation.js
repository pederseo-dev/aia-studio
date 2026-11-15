// Animation clips: the value of each track at a time, and the pose that results from a clip at a time with the
// params on top. It is the single evaluator behind the editor, the AI preview, the runtime and (when baking) the
// video and Lottie. Order (see docs/decision-animacion.md §4):
//
//   setup → clip at t (absolute values) → params (the clip's override the outside ones) → drivers add their poses
//
// That is in a Puppet clip. An Animate scene is evaluated without drivers: setup + keyframes, like Design + what is
// animated (params, poses and drivers belong to the puppet; in a scene, a pose is copied as keyframes).

import { findObject } from './document.js';
import { applyCurve, sameTime } from './curves.js';
import { read } from './schema.js';
import { effectiveValue } from './styles.js';
import { blendColor, blendPoses, blendVertices, driverWeight, paramValues } from './blend.js';
import { blendCurves, blendPoints, withoutBones } from './mesh.js';

/**
 * The time inside the clip (0…duration) for a playback time, according to its loop. In a loop, the end of each
 * cycle (t = duration, 2·duration…) is the end and not the start: so the last frame of the strip, the playhead at
 * the end and the keyframe saved there talk about the same moment.
 */
export function localTime(schema, clip, t) {
  const d = read(schema, clip, 'duration');
  const mode = read(schema, clip, 'loop');
  if (!(d > 0) || !Number.isFinite(t)) return 0;
  // `t % d` alone, and `+ d` only for a negative t: `((t % d) + d) % d` loses precision (0.2 in 1.2 gives
  // 0.19999…) and a frame exactly at a keyframe would show the previous one.
  const wrap = (/** @type {number} */ x, /** @type {number} */ m) => {
    const r = x % m;
    return r < 0 ? r + m : r;
  };
  if (mode === 'loop') {
    const r = wrap(t, d);
    return r === 0 && t > 0 ? d : r;
  }
  if (mode === 'pingpong') {
    const cycle = wrap(t, 2 * d);
    return cycle <= d ? cycle : 2 * d - cycle;
  }
  return Math.max(0, Math.min(d, t));
}

/** Value of a list of keyframes at time t, according to the property kind (number, color, vertices, points, curves or discrete). */
export function trackValue(keys, t, kind) {
  if (!keys?.length) return undefined;
  if (t <= keys[0].t) return keys[0].value;
  const last = keys.at(-1);
  if (t >= last.t) return last.value;
  // Binary search for the span [a, b] that contains t (like Rive).
  let [lo, hi] = [0, keys.length - 1];
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (keys[m].t <= t) lo = m;
    else hi = m;
  }
  const [a, b] = [keys[lo], keys[hi]];
  if (a.ease === 'step') return a.value;
  const w = applyCurve(a.ease, (t - a.t) / (b.t - a.t));
  if (kind === 'number' && typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value - a.value) * w;
  if (kind === 'color') return blendColor(a.value, b.value, Math.max(0, Math.min(1, w)));
  if (kind === 'vertices' && Array.isArray(a.value) && Array.isArray(b.value)) return blendVertices(a.value, b.value, w);
  if (kind === 'points') return blendPoints(a.value, b.value, w);
  if (kind === 'curves') return blendCurves(a.value, b.value, w);
  // What is not interpolated changes abruptly at the next keyframe.
  return a.value;
}

/**
 * What a clip sets at (playback) time t: `values` ({ object: { property: value } }, like a pose) and
 * `params` ({ param: value }) from the param tracks.
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
        params[id] = trackValue(fields.value, local, kind === 'number' ? 'number' : 'discrete');
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

/** An Animate scene (not a Puppet clip): it is evaluated without params or drivers. */
export const isScene = (schema, clip) => clip?.type === 'animation' && read(schema, clip, 'usage') !== 'puppet';

/**
 * The pose seen with a clip at time t. In a Puppet clip, what is animated with the drivers adding their poses on
 * top; `params` are the outside ones (the app, the sliders) and the ones the clip animates override them. In an
 * Animate scene, only what is animated: `params` does not count and the drivers do not add.
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
 * Tracks with a keyframe set on `id.prop` at time t (replaces any at that time and keeps its curve if no other is
 * given). Does not modify the given tracks. Vertices and mesh points do not keep `bone` (it belongs to the setup).
 */
export function putKey(tracks, id, prop, t, value, ease) {
  const created = structuredClone(tracks ?? {});
  const keys = ((created[id] ??= {})[prop] ??= []);
  const time = roundTime(t);
  const j = keys.findIndex((c) => sameTime(c.t, time));
  const kind = prop === 'vertices' ? 'vertices' : prop === 'points' ? 'points' : null;
  let given = kind ? withoutBones({ type: kind }, value) : value;
  // A vector layer's points and curves are added id by id to a keyframe already at that time (as in a pose).
  if ((prop === 'points' || prop === 'curves') && j >= 0 && given && typeof given === 'object' && keys[j].value && typeof keys[j].value === 'object') given = { ...keys[j].value, ...given };
  const key = { t: time, value: given };
  const curve = ease ?? (j >= 0 ? keys[j].ease : undefined);
  if (curve !== undefined && curve !== 'linear') key.ease = curve;
  if (j >= 0) keys[j] = key;
  else keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  return created;
}

/** Tracks without the keyframe of `id.prop` at time t (a track left empty is removed). */
export function removeKey(tracks, id, prop, t) {
  const created = structuredClone(tracks ?? {});
  const keys = created[id]?.[prop];
  if (!keys) return created;
  created[id][prop] = keys.filter((c) => !sameTime(c.t, t));
  if (!created[id][prop].length) delete created[id][prop];
  if (!Object.keys(created[id]).length) delete created[id];
  return created;
}

/** Times of all keyframes of a clip, sorted and without repeats (for the frame strip and the summary). */
export function keyTimes(clip) {
  const times = new Set();
  for (const fields of Object.values(clip.tracks ?? {})) for (const keys of Object.values(fields)) for (const c of keys ?? []) times.add(c.t);
  return [...times].sort((a, b) => a - b);
}

/**
 * The value to save in the track so that `seen` shows (autokey): what is seen already includes what the drivers
 * add, and evaluating would add it again. For numbers that contribution is subtracted; the rest (colors, vertices,
 * discrete) is saved as is, because the clip track wins over the drivers (see blendPoses).
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
 * The batch that leaves `fields` ({ property: value }) of an object as keyframes of the clip at time `t` (editor
 * autokey). Each value is what should be seen, with the params in `params`: it is saved without what the drivers add
 * (valueToSave). An undefined value removes the keyframe of that property at `t`.
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
 * The setup values of everything the clip animates (and of what `pose` sets, if given: the id of a pose or its
 * already filtered values), with the params at their initial value: { object: { property: value } }. It is the
 * editor's «Key setup» and `setup: true` of set_keys.
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
 * Tracks with the keyframe of `id.prop` at `from` moved to `to` (keeps value and curve), or null if there is no
 * keyframe at `from`. Error if there is already another at `to`: moving it on top would delete it.
 */
export function moveKey(tracks, id, prop, from, to) {
  const keys = tracks?.[id]?.[prop] ?? [];
  const key = keys.find((c) => sameTime(c.t, from));
  if (!key) return null;
  if (!sameTime(from, to) && keys.some((c) => c !== key && sameTime(c.t, to))) throw new Error(`${id}.${prop} already has a keyframe at ${roundTime(to)} s: delete it first or move to another time`);
  return putKey(removeKey(tracks, id, prop, key.t), id, prop, to, key.value, key.ease ?? 'linear');
}

/**
 * Warnings of a clip for the AI and the editor: the numeric tracks to which an active driver adds its pose on top
 * (an animated param, or one with an initial value other than 0), at the times of their keyframes. So it is no
 * surprise that a bone keyed at 10 shows at 40.
 */
export function clipWarnings(doc, schema, clip, params = {}) {
  const c = typeof clip === 'string' ? findObject(doc, clip) : clip;
  // A scene has no drivers on top (see clipPose).
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
 * Rescales the time of a span of a clip: the keyframes between `from` and `to` are stretched or compressed
 * proportionally so the span lasts `length`, and the ones after are shifted by the same amount (with their value
 * and curve). Without from/to, the whole clip. Returns { tracks, duration } (the duration changes as much as the
 * span). Error if two keyframes of a track would land on the same moment.
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
 * What each param animated by a Puppet clip moves: [{ param, poses: [{ driver, pose, objects }] }], with the poses
 * of its drivers and the objects each one touches. So the AI (and the timeline) see that animating `happiness` also
 * moves, for example, `mirando_arriba`. In a scene, nothing (it has no params or drivers).
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

/** One line per animated param: «happiness → happy (eye_l, mouth), mirando_arriba (head_bone)». */
export function paramPoseLines(doc, schema, clip) {
  const objects = (ids) => (ids.length > 6 ? `${ids.slice(0, 6).join(', ')}…` : ids.join(', '));
  return animatedParamPoses(doc, schema, clip).map(({ param, poses }) =>
    `${param} → ${poses.length ? poses.map((p) => `${p.pose} (${objects(p.objects) || 'empty'})`).join(', ') : 'no driver: it moves nothing'}`,
  );
}
