// Logic of the MCP animation tools (set_keys, delete_keys, move_keys and the clip summary), without the
// transport, to test them without starting the server. The error texts are read by the AI and the editor notice.

import { clipWarnings, scaleTime, isScene, evaluateClip, paramPoseLines, moveKey, putKey, keyTimes, setupValues } from '../src/core/animation.js';
import { sameTime } from '../src/core/curves.js';
import { findObject } from '../src/core/document.js';
import { read, suggest } from '../src/core/schema.js';
import { effectiveValue } from '../src/core/styles.js';
import { parseD } from '../src/core/paths.js';
import { resolveValues } from '../src/core/poseValues.js';
import { svgDocument, svgStrip } from '../src/render/svg.js';
import { runScript } from '../src/core/live.js';

const n = (t) => +t.toFixed(3);

function clipOf(doc, animation) {
  const clip = findObject(doc, animation);
  if (clip?.type === 'animation') return clip;
  const clips = doc.objects.filter((o) => o.type === 'animation').map((o) => o.id);
  throw new Error(`there is no animation "${animation}".${suggest(animation, clips)} Animations: ${clips.join(', ') || 'none'}`);
}

/** Is the track id.prop among `targets` ("object.property" or an id; "d" stands for "vertices")? No targets, all. */
const chosen = (targets, id, prop) => !targets?.length || targets.some((x) => x === id || x === `${id}.${prop}` || (prop === 'vertices' && x === `${id}.d`));

/**
 * The values of a moment's pose, filtered by `only` or `except` ("object.property" or an id; "d" stands for
 * "vertices"). Error if the pose does not exist, if both filters are given or if one names something the pose does
 * not set.
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

/**
 * What a set_keys moment sets: with `setup`, the setup of everything the clip already animates (and of what the
 * moment's pose brings); then the values of its pose (filtered with only or except), values (with "d" converted and
 * the relative "+=n" added to the setup) and params.
 */
function momentValues(doc, schema, tracks, k, i) {
  let values = {};
  const fromPose = poseValues(doc, k, i);
  // With setup, the pose only says which properties go back to the setup (its values are not copied).
  if (k.setup) values = setupValues(doc, schema, tracks, fromPose);
  else if (fromPose) values = fromPose;
  for (const [id, own] of Object.entries(resolveValues(doc, schema, k.values ?? {}, `keys[${i}].values`))) {
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

/** Properties of a Puppet clip for Live, which set_keys accepts besides usage, loop and description. */
export const LIVE_PROPS = ['fade', 'next', 'blend', 'auto', 'repeat_min', 'repeat_max'];

/**
 * set_keys: each moment ({ t, values, params, pose, setup, ease, targets }) becomes keyframes of the clip. `pose`
 * copies the values of that pose; `setup` puts the setup on everything the clip animates; `values` (as in set_pose,
 * accepts "d") adds or overwrites them; `params` animates params. A moment with only `ease` (and `targets`) changes
 * the curve of the keyframes already at that time. A keyframe at a time that already had one replaces it (and keeps
 * its ease if no other is given). `remove` ("object.property" or an id) removes whole tracks before adding. Creates
 * the clip if it does not exist and extends the duration if a keyframe goes past it; a `duration` shorter than the
 * keyframes is an error.
 */
/** @param {any} doc @param {any} schema @param {string} animation @param {Record<string, any>} [options] keys, usage, duration, loop, description, remove and the Live ones */
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
  // Moments with setup go last: that way the tracks added by the other moments also go back to the setup.
  const order = keys.map((k, i) => [i, k]).sort(([, a], [, b]) => Number(!!a?.setup) - Number(!!b?.setup));
  for (const [i, k] of order) {
    if (typeof k?.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) throw new Error(`keys[${i}].t must be a number of seconds ≥ 0`);
    const values = momentValues(doc, schema, tracks, k, i);
    if (!Object.keys(values).length) {
      if (k.setup) throw new Error(`keys[${i}] (t ${k.t}): setup keys the setup values of what the clip already animates, and this clip animates nothing yet. Add the other moments first (in the same call is fine), or pass pose to say which properties go back to the setup`);
      // Only a curve: changes the one of the keyframes already at that time (without touching their values).
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
  // Without moments or remove the tracks are not touched (changing only fade or loop does not clutter the history
  // with tracks).
  const props = keys.length || remove.length || !existing ? { tracks: tracks } : {};
  // The Live ones (fade, next, blend, auto, repeat_min, repeat_max) pass as is: validation says if they do not apply.
  for (const [k, v] of Object.entries({ usage, loop, description })) if (v !== undefined) props[k] = v;
  for (const k of LIVE_PROPS) if (live[k] !== undefined) props[k] = live[k];
  if (duration !== undefined || final !== requested || !existing) props.duration = final;
  const ops = existing ? [{ op: 'set', target: animation, props }] : [{ op: 'create', type: 'animation', id: animation, props }];
  // An ease shapes the stretch that leaves its keyframe: on the clip's last keyframe there is none (a common slip).
  const lastEase = keys.filter((k) => k?.ease !== undefined && k.ease !== 'linear' && sameTime(k.t, last)).map((k) => n(k.t));
  const warnings = lastEase.length ? [`the ease at t ${lastEase[0]} s does nothing: it is the last keyframe, and an ease shapes the stretch that leaves its keyframe. To soften the arrival, put the ease on the moment before`] : [];
  return { ops, duration: final, extendedFrom: final > requested ? requested : null, warnings };
}

/**
 * delete_keys: removes keyframes from a clip. `times` (seconds) picks the moments; `targets` ("object.property" or
 * an id) picks the tracks; without times, the whole track; without targets, all. A track left empty is removed.
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
 * move_keys: moves the keyframes of one moment (`from`) to another (`to`), with their value and curve, on the
 * `targets` tracks (or on all). Fails if `to` already has a keyframe on any of those tracks (it would delete it) or
 * if `to` goes past the duration.
 */
/** @param {any} doc @param {any} schema @param {string} animation @param {{ from?: number, to?: number, targets?: string[] }} [options] */
export function planMoveKeys(doc, schema, animation, { from, to, targets } = {}) {
  const clip = clipOf(doc, animation);
  const newDuration = read(schema, clip, 'duration');
  if (!(to >= 0) || to > newDuration + 1e-9) throw new Error(`to must be between 0 and the clip's duration (${n(newDuration)} s); to move a keyframe later, first make duration longer`);
  // Moving to the same time changes nothing: error, so as not to leave an empty entry in the history.
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

/** A line summarizing a clip: usage, duration, loop, what it animates and at which times. */
export function clipSummary(schema, clip) {
  const tracks = Object.entries(clip.tracks ?? {}).flatMap(([id, fields]) => Object.keys(fields).map((k) => `${id}.${k}`));
  const frameTimes = keyTimes(clip);
  const base = `${read(schema, clip, 'usage')}, ${n(read(schema, clip, 'duration'))} s, ${read(schema, clip, 'loop')}`;
  return `${base}${live(schema, clip)}; ${tracks.length ? `animates ${tracks.join(', ')}; keys at ${frameTimes.map(n).join(', ')}` : 'no keyframes'}`;
}

/** The Live part of a Puppet clip, for the summary: ", gesture, fade 0.2 s, next idle". Empty in a scene. */
function live(schema, clip) {
  if (read(schema, clip, 'usage') !== 'puppet') return '';
  const auto = read(schema, clip, 'auto');
  const parts = [auto !== 'off' ? `auto ${auto}${auto === 'repeat' ? ` every ${n(read(schema, clip, 'repeat_min'))}–${n(read(schema, clip, 'repeat_max'))} s` : ''}` : read(schema, clip, 'loop') === 'once' ? 'gesture' : 'base'];
  parts.push(`fade ${n(read(schema, clip, 'fade'))} s`);
  if (read(schema, clip, 'next')) parts.push(`next ${read(schema, clip, 'next')}`);
  if (read(schema, clip, 'blend') === 'additive') parts.push('additive');
  return `, ${parts.join(', ')}`;
}

/**
 * The tracks of a clip, one line per track with its keyframes ("t = value (curve)"), to read a clip without the
 * whole JSON: vertices are summarized by point count.
 */
export function trackLines(clip) {
  const value = (v) => (Array.isArray(v) ? `(${v.length} points)` : typeof v === 'number' ? n(v) : JSON.stringify(v));
  const curve = (e) => (e === undefined ? '' : ` ${Array.isArray(e) ? `[${e.join(', ')}]` : e}`);
  return Object.entries(clip.tracks ?? {}).flatMap(([id, fields]) =>
    Object.entries(fields).map(([prop, keys]) => `${id}.${prop}: ${keys.map((c) => `${n(c.t)} = ${value(c.value)}${curve(c.ease)}`).join(' · ')}`),
  );
}

/** Times for a frame strip of a clip: those of its keyframes (at most 12, spread out) or, if there are none, 0. */
export function timesForStrip(clip, max = 12) {
  const frameTimes = keyTimes(clip);
  if (frameTimes.length <= max) return frameTimes.length ? frameTimes : [0];
  return Array.from({ length: max }, (_, i) => frameTimes[Math.round((i * (frameTimes.length - 1)) / (max - 1))]);
}

/**
 * render_preview with animation: one frame (time) or a frame strip (times, or the times of its keyframes), with
 * the text for the AI (which params the clip animates and which drivers add on top). Returns { svg, width, text };
 * the server turns it into PNG.
 */
export function planClipView(doc, schema, { region, bones, params, animation, time, times }) {
  const clip = clipOf(doc, animation);
  // A scene is shown without params or drivers (as it is exported): params there would change nothing and confuse.
  if (isScene(schema, clip) && Object.keys(params ?? {}).length) throw new Error(`"${animation}" is a scene (Animate): scenes play without params or drivers (setup + keyframes). Drop params, or to see an expression in the scene, key it with set_keys and pose`);
  const frameTimes = time != null ? [time] : times?.length ? times : timesForStrip(clip);
  const options = { animation, params: params ?? {}, region, bones: bones };
  const svg = frameTimes.length === 1 ? svgDocument(doc, schema, { ...options, time: frameTimes[0] }) : svgStrip(doc, schema, { ...options, times: frameTimes });
  const animated = Object.keys(evaluateClip(doc, schema, clip, 0).params);
  const all = keyTimes(clip).length;
  const clipped = time == null && !times?.length && all > frameTimes.length ? ` (${frameTimes.length} of its ${all} keyframe times, spread out; pass times to see others)` : '';
  const frames = frameTimes.length === 1 ? `frame at t = ${frameTimes[0]} s` : `${frameTimes.length} frames at t = ${frameTimes.join(', ')} s${clipped}`;
  const warnings = clipWarnings(doc, schema, clip, params ?? {});
  const poses = paramPoseText(doc, schema, clip);
  const text = `Clip "${animation}" (${clipSummary(schema, clip)}): ${frames}${animated.length ? `; the clip animates the params ${animated.join(', ')}` : ''}.${poses ? `\n${poses}` : ''}${warnings.length ? `\nCareful, drivers that add on top of the clip:\n${warnings.map((a) => `- ${a}`).join('\n')}` : ''}`;
  return { svg, width: frameTimes.length === 1 ? 600 : 1000, text };
}

/** Why a combination of render_preview options does not work (null if it works). */
/** @param {Record<string, any>} [options] pose, animation, time, times, live */
export function previewError({ pose, animation, time, times, live } = {}) {
  if (live && (animation || pose || time != null)) return 'live runs a script on the live puppet (its clips with fades); it does not go with animation, pose or time. To see one clip by itself use animation; for frames of the script use times';
  if (animation && pose) return 'pass either pose or animation, not both: a clip already sets its own values (to see a pose at some moment of a clip, key it there with set_keys and pose)';
  if (!animation && (time != null || (times?.length && !live))) return 'time and times need animation (the id of a clip)';
  return null;
}

/**
 * scale_time: stretches or compresses proportionally the time of a clip (or of the span from…to) so it lasts
 * `duration` (or `factor` times its length). Keyframes after the span shift and the clip's duration changes by the
 * same amount. A single undo step.
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
 * Rotations of a Puppet clip that end up more than 180° from the setup: live, the fade interpolates the numbers, so
 * an arm at 140 when the setup has it at -178 makes almost a full turn when entering or leaving (even if on
 * screen it looks similar). Returns one line per track.
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
    warnings.push(`${id}.rotation: ${far.map((c) => `${n(c.value)} at t ${n(c.t)}`).join(', ')} is more than 180° from the setup (${n(setup)}); live, the fade makes it spin almost a full turn. For the same angle on screen use ${n(near)}.`);
  }
  return warnings;
}

/** The "param → poses (objects)" lines of a Puppet clip, as text for the AI (empty if it animates no params). */
export function paramPoseText(doc, schema, clip) {
  const lines = paramPoseLines(doc, schema, clip);
  return lines.length ? `Animated params and the poses they move (through their drivers; they all add up):\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}

/**
 * render_preview with live: runs a script ([{ t, play | stop | set }]) in the live runtime (the same one as the app)
 * and returns the frame strip at `times` (by default, every 0.25 s until 0.5 s after the last event; at most
 * 24), with the text of what is playing in each frame. Returns { svg, width, text }.
 */
/** @param {any} doc @param {any} schema @param {Record<string, any>} options live, times, until, auto, params, region, bones */
export function planLiveView(doc, schema, { live, times, until, auto, params, region, bones }) {
  for (const [i, e] of live.entries()) {
    const verbs = ['play', 'stop', 'set'].filter((k) => e[k] !== undefined);
    if (verbs.length !== 1) throw new Error(`live[${i}] (t ${e.t}) needs exactly one of play, stop or set${verbs.length ? ` (it has ${verbs.join(' and ')}; split it into two events at the same t)` : ''}`);
  }
  // Until when: `until` or, if not, until the last thing triggered ends (a whole gesture; a base, half a
  // second more). Every 0.25 s if it fits in 24 frames; if not, 24 frames spread out (the text says how often).
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
    const playing = c.state.playing.filter((s) => s.weight > 0).map((s) => `${s.clip} (${s.layer === 'gesture' ? 'gesture' : s.layer}, ${pct(s.weight)}${s.leaving ? ', leaving' : ''})`);
    return `- t = ${n(c.t)} s: ${playing.join(', ') || 'nothing (setup and params)'}`;
  });
  // In the last frame: the visible value (blended with the clips that animate params) and, if it differs, the app's.
  const last = frames.at(-1);
  const value = (v) => (typeof v === 'number' ? n(v) : v);
  const withValue = Object.entries(last?.pose.params ?? {}).map(([k, v]) => {
    const app = last.state.params[k];
    return `${k} ${value(v)}${value(app) !== value(v) ? ` (the app: ${value(app)})` : ''}`;
  });
  const paramsEnd = withValue.length ? `\nParams in the last frame (blended with the clips): ${withValue.join(', ')}` : '';
  const distribution = times?.length ? '' : ` (every ${n(step)} s until ${n(end)} s${step > 0.25 ? '; to look closer, pass times or a shorter until' : ''})`;
  const repeating = doc.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'puppet' && read(schema, o, 'auto') === 'repeat').map((o) => o.id);
  const autos = frames.repeats.length
    ? `\nAuto repeat clips that played (they may fall between frames): ${frames.repeats.map((r) => `${r.clip} ${n(r.from)}–${n(r.to)} s`).join(', ')}`
    : repeating.length && auto !== false
      ? `\nAuto repeat clips that did not play before ${n(end)} s: ${repeating.join(', ')} (they wait repeat_min…repeat_max seconds; pass a longer until to see them)`
      : '';
  const apagados = auto === false ? '\nAuto layers off (auto: false).' : '';
  const text = `Live (as the app would see it), ${frames.length} frames${distribution}:\n${lines.join('\n')}${paramsEnd}${autos}${apagados}`;
  return { svg, width: frames.length === 1 ? 600 : 1000, text };
}
