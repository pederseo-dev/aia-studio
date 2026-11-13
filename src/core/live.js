// The running puppet (live Puppet): what the app or its AI drives with three verbs —play(clip), set(param, value)
// and stop(clip)— and that is advanced with advance(dt). It is the runtime that phase 7 exports; the editor
// (▶ Live) and the AI preview (render_preview with live) use this same one. See docs/decision-animacion.md §9.
//
// Layers, from bottom to top:
//   setup → bases (loop/pingpong, with crossfade) → gestures (once, in order) → auto (repeat/always) → drivers
// Each layer overrides what is below with its weight (or adds, if it is additive). Params are blended the same way:
// the app's value below and what the clips animate on top; drivers are computed only once, with the params already
// blended.

import { findObject } from './document.js';
import { evaluateClip } from './animation.js';
import { read } from './schema.js';
import { effectiveValue } from './styles.js';
import { blendColor, blendPoses, blendVertices, paramValues } from './blend.js';

/** Seeded random number generator (mulberry32): the same script gives the same strip. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fade curve: smooth in and out (ease-in-out). */
const smooth = (w) => w * w * (3 - 2 * w);

/** Puppet clips the app can trigger (not the auto ones nor the scenes). */
export function triggerableClips(doc, schema) {
  return doc.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'puppet' && read(schema, o, 'auto') === 'off');
}

/** Whether it is a base clip (it keeps playing) or a gesture (once, on top). */
export const isBase = (schema, clip) => read(schema, clip, 'loop') !== 'once';

/**
 * Creates the running puppet. `params`: initial values from the app. `seed`: for the randomness of auto repeat clips.
 * `auto: false` turns off the auto layers (to compare a script with and without blinking or breathing).
 * Returns { play, stop, set, advance, pose, state, update }.
 */
export function createLive(doc, schema, { params = {}, seed = 1, auto = true } = {}) {
  let documentData = doc;
  const rng = random(seed);
  let clock = 0;
  const app = {}; // app values (the missing ones, the initial value)
  // Playing entries: { clip, t, weight, target, fade, layer: 'base' | 'gesture' | 'auto', nextDone }
  let entries = [];
  // Auto repeat clips: id → seconds left until the next time.
  const waits = new Map();

  const clipOf = (id) => {
    const c = findObject(documentData, id);
    return c?.type === 'animation' ? c : null;
  };
  // A once clip cannot fade for more than half of its length: otherwise, it would start leaving before it finished
  // entering and would never reach 100%.
  const fadeOf = (clip) => {
    const fade = Math.max(0, read(schema, clip, 'fade'));
    return read(schema, clip, 'loop') === 'once' ? Math.min(fade, read(schema, clip, 'duration') / 2) : fade;
  };
  /** The clip an entry is evaluated with: an auto always one always plays in a loop, even if the clip says once. */
  const howItSounds = (clip, e) => (e.layer === 'auto' && read(schema, clip, 'auto') === 'always' && read(schema, clip, 'loop') === 'once' ? { ...clip, loop: 'loop' } : clip);
  const wait = (clip) => {
    const [a, b] = [read(schema, clip, 'repeat_min'), read(schema, clip, 'repeat_max')];
    return a + rng() * Math.max(0, b - a);
  };

  /** Starts the missing auto layers and removes those of clips that are no longer auto. */
  function syncAuto() {
    const autos = auto ? documentData.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'puppet' && read(schema, o, 'auto') !== 'off') : [];
    const ids = new Set(autos.map((c) => c.id));
    entries = entries.filter((e) => e.layer !== 'auto' || ids.has(e.clip));
    for (const id of [...waits.keys()]) if (!ids.has(id) || read(schema, clipOf(id), 'auto') !== 'repeat') waits.delete(id);
    for (const c of autos) {
      const mode = read(schema, c, 'auto');
      if (mode === 'always' && !entries.some((e) => e.clip === c.id && e.layer === 'auto')) entries.push({ clip: c.id, t: 0, weight: 1, target: 1, layer: 'auto' });
      if (mode === 'repeat' && !waits.has(c.id) && !entries.some((e) => e.clip === c.id && e.layer === 'auto')) waits.set(c.id, wait(c));
    }
  }

  function play(id) {
    const clip = clipOf(id);
    if (!clip) {
      const ids = triggerableClips(documentData, schema).map((c) => c.id);
      throw new Error(`there is no clip "${id}". Clips you can play: ${ids.join(', ') || 'none'}`);
    }
    if (read(schema, clip, 'usage') !== 'puppet') throw new Error(`"${id}" is a scene (Animate); only Puppet clips play live`);
    if (read(schema, clip, 'auto') !== 'off') throw new Error(`"${id}" is an auto clip (${read(schema, clip, 'auto')}): it plays by itself`);
    const fade = fadeOf(clip);
    if (isBase(schema, clip)) {
      const current = entries.find((e) => e.layer === 'base' && e.target === 1);
      if (current?.clip === id) return;
      // The previous base leaves at the pace of the new one (crossfade). If the requested one was leaving, it enters
      // again from where it was (without jumping phase).
      for (const e of entries) if (e.layer === 'base') Object.assign(e, { target: 0, fade });
      const leaving = entries.find((e) => e.layer === 'base' && e.clip === id);
      if (leaving) Object.assign(leaving, { target: 1 });
      else entries.push({ clip: id, t: 0, weight: fade > 0 ? 0 : 1, target: 1, fade, layer: 'base' });
      return;
    }
    const existing = entries.find((e) => e.layer === 'gesture' && e.clip === id);
    if (existing) Object.assign(existing, { t: 0, target: 1, fade, nextDone: false });
    else entries.push({ clip: id, t: 0, weight: fade > 0 ? 0 : 1, target: 1, fade, layer: 'gesture' });
  }

  function stop(id) {
    if (id != null) {
      const clip = clipOf(id);
      if (!clip || read(schema, clip, 'usage') !== 'puppet') {
        const ids = triggerableClips(documentData, schema).map((c) => c.id);
        throw new Error(`there is no clip "${id}". Clips you can stop: ${ids.join(', ') || 'none'}`);
      }
      if (read(schema, clip, 'auto') !== 'off') throw new Error(`"${id}" is an auto clip (${read(schema, clip, 'auto')}): it plays by itself and can't be stopped`);
    }
    for (const e of entries) if (e.layer !== 'auto' && (id == null || e.clip === id)) e.target = 0;
  }

  function set(id, value) {
    const p = findObject(documentData, id);
    if (p?.type !== 'param') {
      const ids = documentData.objects.filter((o) => o.type === 'param').map((o) => o.id);
      throw new Error(`there is no param "${id}". Params: ${ids.join(', ') || 'none'}`);
    }
    if (read(schema, p, 'kind') === 'enum' && !read(schema, p, 'options').includes(value)) throw new Error(`param "${id}" is an enum: use one of ${read(schema, p, 'options').join(', ')}`);
    app[id] = value;
  }
  for (const [k, v] of Object.entries(params)) set(k, v);

  /** Advances time; in steps of 1/60 s at most, so that the fades do not depend on the step size. */
  function advance(dt) {
    if (!(dt > 0)) return;
    for (let missing = dt; missing > 1e-12; missing -= Math.min(missing, 1 / 60)) advanceStep(Math.min(missing, 1 / 60));
  }

  function advanceStep(dt) {
    clock += dt;
    syncAuto();
    // Auto repeat clips whose wait ended play again.
    for (const [id, missing] of waits) {
      if (missing - dt > 0) {
        waits.set(id, missing - dt);
        continue;
      }
      waits.delete(id);
      const c = clipOf(id);
      const fade = fadeOf(c);
      entries.push({ clip: id, t: Math.max(0, dt - missing), weight: fade > 0 ? 0 : 1, target: 1, fade, layer: 'auto' });
    }
    const created = [];
    for (const e of entries) {
      const clip = clipOf(e.clip);
      if (!clip) continue;
      const inAuto = e.layer === 'auto' && read(schema, clip, 'auto') === 'always';
      if (!(e.layer === 'gesture' || e.layer === 'auto') || inAuto || e.t < read(schema, clip, 'duration')) e.t += dt;
      // The weight moves toward its target at a rate of 1/fade per second.
      const fade = e.fade ?? fadeOf(clip);
      e.weight = fade > 0 ? Math.max(0, Math.min(1, e.weight + Math.sign(e.target - e.weight) * Math.min(Math.abs(e.target - e.weight), dt / fade))) : e.target;
      if (Math.abs(e.weight - e.target) < 1e-9) e.weight = e.target;
      // A once clip starts leaving in time to finish at its end; there its next is triggered.
      if ((e.layer === 'gesture' || (e.layer === 'auto' && !inAuto)) && e.target === 1) {
        const d = read(schema, clip, 'duration');
        if (e.t >= d - fade - 1e-9) {
          e.target = 0;
          if (fade === 0) e.weight = e.t >= d - 1e-9 ? 0 : e.weight;
          const next = read(schema, clip, 'next');
          if (e.layer === 'gesture' && next && !e.nextDone && clipOf(next)) {
            e.nextDone = true;
            created.push(next);
          }
        }
      }
      if (fade === 0 && e.target === 0) e.weight = 0;
    }
    // Those that have fully left go away; an auto repeat waits for the next time.
    entries = entries.filter((e) => {
      if (e.weight > 0 || e.target > 0) return true;
      if (e.layer === 'auto' && clipOf(e.clip) && read(schema, clipOf(e.clip), 'auto') === 'repeat') waits.set(e.clip, wait(clipOf(e.clip)));
      return false;
    });
    for (const id of created) play(id);
  }

  /** The pose seen now (a pose object, like blendPoses), with `params` = the already blended params. */
  function pose() {
    syncAuto();
    const values = {};
    const P = paramValues(documentData, schema, app);
    const setup = (id, prop) => effectiveValue(schema, documentData, findObject(documentData, id), prop);
    const typeOf = (id, prop) => schema.types.get(findObject(documentData, id).type).properties[prop].type;
    const number = (id) => read(schema, findObject(documentData, id), 'kind') === 'number';

    /** Overrides `current` with `v` by the weight w, by kind (what is not interpolated changes at w ≥ 0.5). */
    const overwrite = (kind, current, v, w) => {
      if (w >= 1) return v;
      if (kind === 'number' && typeof v === 'number' && typeof current === 'number') return current + (v - current) * w;
      if (kind === 'color') return blendColor(current, v, w);
      if (kind === 'vertices' && Array.isArray(current) && Array.isArray(v)) return blendVertices(current, v, w);
      return w >= 0.5 ? v : undefined;
    };
    /** A layer (what a clip sets, or the blend of the bases) on top of what there is, with its weight. */
    const apply = ({ values: vs, params: ps }, w, sum) => {
      for (const [id, fields] of Object.entries(vs)) {
        for (const [prop, v] of Object.entries(fields)) {
          const kind = typeOf(id, prop);
          const current = values[id]?.[prop] ?? setup(id, prop);
          let created;
          if (sum) {
            if (kind !== 'number' || typeof v !== 'number') continue;
            created = current + w * (v - setup(id, prop));
          } else created = overwrite(kind, current, v, w);
          if (created !== undefined) (values[id] ??= {})[prop] = created;
        }
      }
      for (const [id, v] of Object.entries(ps)) {
        if (sum) {
          if (number(id)) P[id] += w * (v - read(schema, findObject(documentData, id), 'default'));
        } else {
          const created = overwrite(number(id) ? 'number' : 'discreto', P[id], v, w);
          if (created !== undefined) P[id] = created;
        }
      }
    };
    const evaluated = (e) => {
      const clip = clipOf(e.clip);
      return clip ? { clip, w: smooth(e.weight), ev: evaluateClip(documentData, schema, howItSounds(clip, e), e.t) } : null;
    };

    // 1. The bases (override) are averaged among themselves by their weights, and that blend overrides the setup with
    // the total weight of the layer: in a crossfade between two bases that leave the arm at 30, the arm stays at 30
    // (the setup does not leak in), and the first base enters from the setup.
    const bases = entries.filter((e) => e.layer === 'base').map(evaluated).filter((b) => b && b.w > 0);
    const overlap = bases.filter((b) => read(schema, b.clip, 'blend') !== 'additive');
    const total = overlap.reduce((s, b) => s + b.w, 0);
    if (total > 0) {
      const layer = { values: {}, params: {} };
      let accumulated = 0;
      for (const b of overlap) {
        accumulated += b.w;
        const r = b.w / accumulated; // relative weight: the weighted average of the bases, one at a time
        for (const [id, fields] of Object.entries(b.ev.values)) {
          for (const [prop, v] of Object.entries(fields)) {
            const before = layer.values[id]?.[prop];
            const created = before === undefined ? v : overwrite(typeOf(id, prop), before, v, r);
            if (created !== undefined) (layer.values[id] ??= {})[prop] = created;
          }
        }
        for (const [id, v] of Object.entries(b.ev.params)) {
          const before = layer.params[id];
          const created = before === undefined ? v : overwrite(number(id) ? 'number' : 'discreto', before, v, r);
          if (created !== undefined) layer.params[id] = created;
        }
      }
      apply(layer, Math.min(1, total), false);
    }
    for (const b of bases.filter((x) => !overlap.includes(x))) apply(b.ev, b.w, true);

    // 2. Gestures and auto layers, one at a time and in order, each on top of what is below.
    for (const e of entries.filter((x) => x.layer === 'gesture').concat(entries.filter((x) => x.layer === 'auto'))) {
      const c = evaluated(e);
      if (c && c.w > 0) apply(c.ev, c.w, read(schema, c.clip, 'blend') === 'additive');
    }
    return blendPoses(documentData, schema, P, values);
  }

  /** What is playing now: each clip with its layer, its time and its weight (0 to 1), and the app values. */
  function state() {
    syncAuto();
    return {
      clock,
      playing: entries.map((e) => ({ clip: e.clip, layer: e.layer, t: e.t, weight: e.weight, leaving: e.target === 0 })),
      params: paramValues(documentData, schema, app),
      app: { ...app },
    };
  }

  /**
   * Changes the document (the AI edits it through MCP, or something is undone, with Live on): what still exists and
   * still belongs to its layer keeps playing (a base that became once, or a clip that became Animate, leaves).
   */
  function update(created) {
    documentData = created;
    entries = entries.filter((e) => {
      const c = clipOf(e.clip);
      if (!c || read(schema, c, 'usage') !== 'puppet') return false;
      if (e.layer === 'auto') return true; // syncAuto decides
      return read(schema, c, 'auto') === 'off' && isBase(schema, c) === (e.layer === 'base');
    });
    for (const id of Object.keys(app)) if (findObject(documentData, id)?.type !== 'param') delete app[id];
  }

  syncAuto();
  return { play, stop, set, advance, pose, state, update };
}

/**
 * Runs a script ([{ t, play | stop | set }]) and returns the pose and the state at each of `times` (seconds).
 * `stop: true` stops everything; `set: { param: value }`. Advances in steps of 1/60 s, like an app frame. The
 * returned array also carries `repeats`: when each auto repeat clip played ([{ clip, from, to }]), because a short
 * blink usually falls between two frames.
 */
/**
 * @param {any} doc @param {any} schema @param {any[]} [script] @param {number[]} [times]
 * @param {{ params?: Record<string, number>, seed?: number, auto?: boolean, step?: number }} [options]
 */
export function runScript(doc, schema, script = [], times = [], { params, seed, auto, step = 1 / 60 } = {}) {
  const live = createLive(doc, schema, { params, seed, auto });
  const repeats = [];
  const open = new Map();
  const note = (t) => {
    const now = new Set();
    for (const s of live.state().playing) {
      if (s.layer !== 'auto' || !(s.weight > 0) || read(schema, findObject(doc, s.clip), 'auto') !== 'repeat') continue;
      now.add(s.clip);
      if (!open.has(s.clip)) open.set(s.clip, repeats.push({ clip: s.clip, from: t, to: t }) - 1);
      else repeats[open.get(s.clip)].to = t;
    }
    for (const id of [...open.keys()]) if (!now.has(id)) open.delete(id);
  };
  const events = [...script].map((e, i) => ({ ...e, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const requests = [...times].map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
  const frames = new Array(times.length);
  let now = 0;
  let k = 0;
  const apply = (e) => {
    if (e.set) for (const [id, v] of Object.entries(e.set)) live.set(id, v);
    if (e.stop !== undefined && e.stop !== false) live.stop(e.stop === true ? undefined : e.stop);
    if (e.play) live.play(e.play);
  };
  for (const requested of requests) {
    while (now < requested.t - 1e-9) {
      while (k < events.length && events[k].t <= now + 1e-9) apply(events[k++]);
      const dt = Math.min(step, requested.t - now);
      live.advance(dt);
      now += dt;
      note(now);
    }
    while (k < events.length && events[k].t <= now + 1e-9) apply(events[k++]);
    frames[requested.i] = { t: requested.t, pose: live.pose(), state: live.state() };
  }
  return Object.assign(frames, { repeats });
}
