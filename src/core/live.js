// El muñeco en marcha (Puppet en vivo): lo que la app o su IA manejan con tres verbos —play(clip), set(param, valor)
// y stop(clip)— y que se avanza con avanzar(dt). Es el runtime que exporta la fase 7; el editor (▶ Live) y la vista
// previa de la IA (render_preview con live) usan este mismo. Ver docs/decision-animacion.md §9.
//
// Capas, de abajo hacia arriba:
//   montaje → bases (loop/pingpong, con fundido cruzado) → gestos (once, en orden) → auto (repeat/always) → drivers
// Cada capa pisa lo de abajo con su peso (o suma, si es additive). Los params se mezclan igual: el valor de la app
// debajo y lo que animan los clips encima; los drivers se calculan una sola vez, con los params ya mezclados.

import { findObject } from './document.js';
import { evaluateClip } from './animation.js';
import { read } from './schema.js';
import { effectiveValue } from './styles.js';
import { blendColor, blendPoses, blendVertices, paramValues } from './blend.js';

/** Generador de números al azar con semilla (mulberry32): el mismo guion da la misma tira. */
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

/** Curva del fundido: suave al entrar y al salir (ease-in-out). */
const smooth = (w) => w * w * (3 - 2 * w);

/** Clips de Puppet que la app puede disparar (no los auto ni las escenas). */
export function triggerableClips(doc, schema) {
  return doc.objects.filter((o) => o.type === 'animation' && read(schema, o, 'usage') === 'puppet' && read(schema, o, 'auto') === 'off');
}

/** Es un clip de base (se queda sonando) o un gesto (una vez, encima). */
export const isBase = (schema, clip) => read(schema, clip, 'loop') !== 'once';

/**
 * Crea el muñeco en marcha. `params`: valores iniciales de la app. `semilla`: para el azar de los clips auto repeat.
 * `auto: false` apaga las capas auto (para comparar un guion con y sin parpadeo o respiración).
 * Devuelve { play, stop, set, avanzar, pose, estado, actualizar }.
 */
export function createLive(doc, schema, { params = {}, seed = 1, auto = true } = {}) {
  let documentData = doc;
  const rng = random(seed);
  let clock = 0;
  const app = {}; // valores de la app (los que falten, el inicial)
  // Entradas que suenan: { clip, t, peso, objetivo, fade, capa: 'base' | 'gesture' | 'auto', siguienteHecho }
  let entries = [];
  // Clips auto repeat: id → segundos que faltan para la próxima vez.
  const waits = new Map();

  const clipOf = (id) => {
    const c = findObject(documentData, id);
    return c?.type === 'animation' ? c : null;
  };
  // Un clip once no puede fundirse más de la mitad de lo que dura: si no, empezaría a salir antes de terminar de
  // entrar y nunca llegaría al 100%.
  const fadeOf = (clip) => {
    const fade = Math.max(0, read(schema, clip, 'fade'));
    return read(schema, clip, 'loop') === 'once' ? Math.min(fade, read(schema, clip, 'duration') / 2) : fade;
  };
  /** El clip con el que se evalúa una entrada: un auto always suena siempre en loop, aunque el clip diga once. */
  const howItSounds = (clip, e) => (e.layer === 'auto' && read(schema, clip, 'auto') === 'always' && read(schema, clip, 'loop') === 'once' ? { ...clip, loop: 'loop' } : clip);
  const wait = (clip) => {
    const [a, b] = [read(schema, clip, 'repeat_min'), read(schema, clip, 'repeat_max')];
    return a + rng() * Math.max(0, b - a);
  };

  /** Arranca las capas auto que falten y quita las de clips que ya no son auto. */
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
      // La base anterior sale al ritmo de la nueva (fundido cruzado). Si la pedida estaba saliendo, vuelve a entrar
      // desde donde estaba (sin saltar de fase).
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

  /** Avanza el tiempo; en pasos de 1/60 s como mucho, para que los fundidos no dependan del tamaño del paso. */
  function advance(dt) {
    if (!(dt > 0)) return;
    for (let missing = dt; missing > 1e-12; missing -= Math.min(missing, 1 / 60)) advanceStep(Math.min(missing, 1 / 60));
  }

  function advanceStep(dt) {
    clock += dt;
    syncAuto();
    // Los auto repeat cuya espera terminó vuelven a sonar.
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
      // El peso va hacia su objetivo a razón de 1/fade por segundo.
      const fade = e.fade ?? fadeOf(clip);
      e.weight = fade > 0 ? Math.max(0, Math.min(1, e.weight + Math.sign(e.target - e.weight) * Math.min(Math.abs(e.target - e.weight), dt / fade))) : e.target;
      if (Math.abs(e.weight - e.target) < 1e-9) e.weight = e.target;
      // Un clip once empieza a salir a tiempo para terminar en su final; ahí se dispara su next.
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
    // Las que ya salieron del todo se van; un auto repeat espera la próxima vez.
    entries = entries.filter((e) => {
      if (e.weight > 0 || e.target > 0) return true;
      if (e.layer === 'auto' && clipOf(e.clip) && read(schema, clipOf(e.clip), 'auto') === 'repeat') waits.set(e.clip, wait(clipOf(e.clip)));
      return false;
    });
    for (const id of created) play(id);
  }

  /** La pose que se ve ahora (un objeto pose, como mezclarPoses), con `params` = los params ya mezclados. */
  function pose() {
    syncAuto();
    const values = {};
    const P = paramValues(documentData, schema, app);
    const setup = (id, prop) => effectiveValue(schema, documentData, findObject(documentData, id), prop);
    const typeOf = (id, prop) => schema.types.get(findObject(documentData, id).type).properties[prop].type;
    const number = (id) => read(schema, findObject(documentData, id), 'kind') === 'number';

    /** Pisa `actual` con `v` por el peso w, según el tipo (lo que no se interpola cambia en w ≥ 0.5). */
    const overwrite = (kind, current, v, w) => {
      if (w >= 1) return v;
      if (kind === 'number' && typeof v === 'number' && typeof current === 'number') return current + (v - current) * w;
      if (kind === 'color') return blendColor(current, v, w);
      if (kind === 'vertices' && Array.isArray(current) && Array.isArray(v)) return blendVertices(current, v, w);
      return w >= 0.5 ? v : undefined;
    };
    /** Una capa (lo que fija un clip, o la mezcla de las bases) encima de lo que hay, con su peso. */
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

    // 1. Las bases (override) se promedian entre sí por sus pesos, y esa mezcla pisa el montaje con el peso total de
    // la capa: en un fundido cruzado entre dos bases que dejan el brazo en 30, el brazo se queda en 30 (el montaje no
    // se cuela), y la primera base entra desde el montaje.
    const bases = entries.filter((e) => e.layer === 'base').map(evaluated).filter((b) => b && b.w > 0);
    const overlap = bases.filter((b) => read(schema, b.clip, 'blend') !== 'additive');
    const total = overlap.reduce((s, b) => s + b.w, 0);
    if (total > 0) {
      const layer = { values: {}, params: {} };
      let accumulated = 0;
      for (const b of overlap) {
        accumulated += b.w;
        const r = b.w / accumulated; // peso relativo: el promedio ponderado de las bases, de a una
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

    // 2. Gestos y capas auto, de a uno y en orden, cada uno encima de lo de abajo.
    for (const e of entries.filter((x) => x.layer === 'gesture').concat(entries.filter((x) => x.layer === 'auto'))) {
      const c = evaluated(e);
      if (c && c.w > 0) apply(c.ev, c.w, read(schema, c.clip, 'blend') === 'additive');
    }
    return blendPoses(documentData, schema, P, values);
  }

  /** Qué suena ahora: cada clip con su capa, su tiempo y su peso (0 a 1), y los valores de la app. */
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
   * Cambia el documento (lo edita la IA por MCP, o se deshace algo, con Live encendido): sigue sonando lo que todavía
   * existe y todavía es de su capa (una base que pasó a once, o un clip que pasó a Animate, sale).
   */
  function update(created) {
    documentData = created;
    entries = entries.filter((e) => {
      const c = clipOf(e.clip);
      if (!c || read(schema, c, 'usage') !== 'puppet') return false;
      if (e.layer === 'auto') return true; // sincronizarAuto decide
      return read(schema, c, 'auto') === 'off' && isBase(schema, c) === (e.layer === 'base');
    });
    for (const id of Object.keys(app)) if (findObject(documentData, id)?.type !== 'param') delete app[id];
  }

  syncAuto();
  return { play, stop, set, advance, pose, state, update };
}

/**
 * Corre un guion ([{ t, play | stop | set }]) y devuelve la pose y el estado en cada uno de `tiempos` (segundos).
 * `stop: true` para todo; `set: { param: valor }`. Avanza en pasos de 1/60 s, como un cuadro de la app. El arreglo
 * devuelto trae además `repeticiones`: cuándo sonó cada clip auto repeat ([{ clip, desde, hasta }]), porque un
 * parpadeo corto suele caer entre dos cuadros.
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
