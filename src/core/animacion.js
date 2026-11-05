// Clips de animación: el valor de cada pista en un tiempo, y la pose que resulta de un clip en un tiempo con los
// params encima. Es el evaluador único del que salen el editor, la vista previa de la IA, el runtime y (al hornear)
// el video y Lottie. Orden (ver docs/decision-animacion.md §4):
//
//   montaje → clip en t (valores absolutos) → params (los del clip pisan a los de afuera) → drivers suman sus poses

import { buscar } from './documento.js';
import { aplicarCurva } from './curvas.js';
import { leer } from './esquema.js';
import { mezclarColor, mezclarPoses, mezclarVertices } from './mezcla.js';

/** El tiempo dentro del clip (0…duration) para un tiempo de reproducción, según su loop. */
export function tiempoLocal(esquema, clip, t) {
  const d = leer(esquema, clip, 'duration');
  const modo = leer(esquema, clip, 'loop');
  if (!(d > 0) || !Number.isFinite(t)) return 0;
  if (modo === 'loop') return ((t % d) + d) % d;
  if (modo === 'pingpong') {
    const ciclo = ((t % (2 * d)) + 2 * d) % (2 * d);
    return ciclo <= d ? ciclo : 2 * d - ciclo;
  }
  return Math.max(0, Math.min(d, t));
}

/** Valor de una lista de keyframes en el tiempo t, según el tipo de la propiedad (number, color, vertices o discreto). */
export function valorDePista(claves, t, tipo) {
  if (!claves?.length) return undefined;
  if (t <= claves[0].t) return claves[0].value;
  const ultimo = claves.at(-1);
  if (t >= ultimo.t) return ultimo.value;
  // Búsqueda binaria del tramo [a, b] que contiene a t (como Rive).
  let [lo, hi] = [0, claves.length - 1];
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (claves[m].t <= t) lo = m;
    else hi = m;
  }
  const [a, b] = [claves[lo], claves[hi]];
  if (a.ease === 'step') return a.value;
  const w = aplicarCurva(a.ease, (t - a.t) / (b.t - a.t));
  if (tipo === 'number' && typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value - a.value) * w;
  if (tipo === 'color') return mezclarColor(a.value, b.value, Math.max(0, Math.min(1, w)));
  if (tipo === 'vertices' && Array.isArray(a.value) && Array.isArray(b.value)) return mezclarVertices(a.value, b.value, w);
  // Lo que no se interpola cambia de golpe en el keyframe siguiente.
  return a.value;
}

/**
 * Lo que fija un clip en el tiempo t (de reproducción): `values` ({ objeto: { propiedad: valor } }, como una pose) y
 * `params` ({ param: valor }) de las pistas de params.
 */
export function evaluarClip(doc, esquema, clip, t) {
  const local = tiempoLocal(esquema, clip, t);
  const values = {};
  const params = {};
  for (const [id, campos] of Object.entries(clip.tracks ?? {})) {
    const obj = buscar(doc, id);
    if (!obj) continue;
    if (obj.type === 'param') {
      if (campos.value?.length) {
        const kind = leer(esquema, obj, 'kind');
        params[id] = valorDePista(campos.value, local, kind === 'number' ? 'number' : 'discreto');
      }
      continue;
    }
    const props = esquema.tipos.get(obj.type)?.properties ?? {};
    for (const [prop, claves] of Object.entries(campos)) {
      if (!props[prop]?.animatable || !claves?.length) continue;
      (values[id] ??= {})[prop] = valorDePista(claves, local, props[prop].type);
    }
  }
  return { values, params, tiempo: local };
}

/**
 * La pose que se ve con un clip en el tiempo t: lo animado, con los drivers sumando sus poses encima. `params` son
 * los de afuera (la app, los sliders); los que el clip anima los pisan.
 */
export function poseDeClip(doc, esquema, clip, t, params = {}) {
  const c = typeof clip === 'string' ? buscar(doc, clip) : clip;
  if (c?.type !== 'animation') return null;
  const evaluado = evaluarClip(doc, esquema, c, t);
  const pose = mezclarPoses(doc, esquema, { ...params, ...evaluado.params }, evaluado.values);
  return { ...pose, clip: c.id, tiempo: evaluado.tiempo };
}

/** Tiempos de todos los keyframes de un clip, ordenados y sin repetir (para la tira de cuadros y el resumen). */
export function tiemposDeClaves(clip) {
  const tiempos = new Set();
  for (const campos of Object.values(clip.tracks ?? {})) for (const claves of Object.values(campos)) for (const c of claves ?? []) tiempos.add(c.t);
  return [...tiempos].sort((a, b) => a - b);
}
