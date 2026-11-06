// Clips de animación: el valor de cada pista en un tiempo, y la pose que resulta de un clip en un tiempo con los
// params encima. Es el evaluador único del que salen el editor, la vista previa de la IA, el runtime y (al hornear)
// el video y Lottie. Orden (ver docs/decision-animacion.md §4):
//
//   montaje → clip en t (valores absolutos) → params (los del clip pisan a los de afuera) → drivers suman sus poses
//
// Eso es en un clip de Puppet. Una escena de Animate se evalúa sin drivers: montaje + keyframes, como Design + lo
// animado (los params, las poses y los drivers son del muñeco; en una escena, una pose se copia como keyframes).

import { buscar } from './documento.js';
import { aplicarCurva, mismoTiempo } from './curvas.js';
import { leer } from './esquema.js';
import { valorEfectivo } from './estilos.js';
import { mezclarColor, mezclarPoses, mezclarVertices, pesoDeDriver, valoresDeParams } from './mezcla.js';

/**
 * El tiempo dentro del clip (0…duration) para un tiempo de reproducción, según su loop. En un loop, el final de cada
 * vuelta (t = duration, 2·duration…) es el final y no el principio: así el último cuadro de la tira, el playhead al
 * final y el keyframe que se guarda ahí hablan del mismo momento.
 */
export function tiempoLocal(esquema, clip, t) {
  const d = leer(esquema, clip, 'duration');
  const modo = leer(esquema, clip, 'loop');
  if (!(d > 0) || !Number.isFinite(t)) return 0;
  if (modo === 'loop') {
    const r = ((t % d) + d) % d;
    return r === 0 && t > 0 ? d : r;
  }
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

/** Una escena de Animate (no un clip de Puppet): se evalúa sin params ni drivers. */
export const esEscena = (esquema, clip) => clip?.type === 'animation' && leer(esquema, clip, 'usage') !== 'puppet';

/**
 * La pose que se ve con un clip en el tiempo t. En un clip de Puppet, lo animado con los drivers sumando sus poses
 * encima; `params` son los de afuera (la app, los sliders) y los que el clip anima los pisan. En una escena de
 * Animate, solo lo animado: `params` no cuenta y los drivers no suman.
 */
export function poseDeClip(doc, esquema, clip, t, params = {}) {
  const c = typeof clip === 'string' ? buscar(doc, clip) : clip;
  if (c?.type !== 'animation') return null;
  const evaluado = evaluarClip(doc, esquema, c, t);
  if (esEscena(esquema, c)) return { id: null, type: 'pose', values: evaluado.values, params: {}, clip: c.id, tiempo: evaluado.tiempo };
  const pose = mezclarPoses(doc, esquema, { ...params, ...evaluado.params }, evaluado.values);
  return { ...pose, clip: c.id, tiempo: evaluado.tiempo };
}

export const redondearTiempo = (t) => Math.round(t * 1e6) / 1e6;

/**
 * Pistas con un keyframe puesto en `id.prop` en el tiempo t (reemplaza el que hubiera en ese tiempo y conserva su
 * curva si no se pasa otra). No modifica las pistas recibidas. Los vértices no guardan `bone` (es del montaje).
 */
export function ponerClave(pistas, id, prop, t, valor, ease) {
  const nuevas = structuredClone(pistas ?? {});
  const claves = ((nuevas[id] ??= {})[prop] ??= []);
  const tiempo = redondearTiempo(t);
  const j = claves.findIndex((c) => mismoTiempo(c.t, tiempo));
  const clave = { t: tiempo, value: prop === 'vertices' && Array.isArray(valor) ? valor.map(({ bone, ...v }) => v) : valor };
  const curva = ease ?? (j >= 0 ? claves[j].ease : undefined);
  if (curva !== undefined && curva !== 'linear') clave.ease = curva;
  if (j >= 0) claves[j] = clave;
  else claves.push(clave);
  claves.sort((a, b) => a.t - b.t);
  return nuevas;
}

/** Pistas sin el keyframe de `id.prop` en el tiempo t (una pista que queda vacía sale). */
export function quitarClave(pistas, id, prop, t) {
  const nuevas = structuredClone(pistas ?? {});
  const claves = nuevas[id]?.[prop];
  if (!claves) return nuevas;
  nuevas[id][prop] = claves.filter((c) => !mismoTiempo(c.t, t));
  if (!nuevas[id][prop].length) delete nuevas[id][prop];
  if (!Object.keys(nuevas[id]).length) delete nuevas[id];
  return nuevas;
}

/** Tiempos de todos los keyframes de un clip, ordenados y sin repetir (para la tira de cuadros y el resumen). */
export function tiemposDeClaves(clip) {
  const tiempos = new Set();
  for (const campos of Object.values(clip.tracks ?? {})) for (const claves of Object.values(campos)) for (const c of claves ?? []) tiempos.add(c.t);
  return [...tiempos].sort((a, b) => a - b);
}

/**
 * El valor que hay que guardar en la pista para que se vea `visto` (autokey): lo que se ve ya trae lo que suman los
 * drivers, y al evaluar se sumaría otra vez. En los números se resta ese aporte; lo demás (colores, vértices,
 * discretos) se guarda tal cual, porque la pista del clip gana sobre los drivers (ver mezclarPoses).
 */
export function valorAGuardar(doc, esquema, clip, t, params, id, prop, visto) {
  const obj = buscar(doc, id);
  if (typeof visto !== 'number' || !obj || obj.type === 'param' || esquema.tipos.get(obj.type)?.properties[prop]?.type !== 'number') return visto;
  const c = typeof clip === 'string' ? buscar(doc, clip) : clip;
  const delClip = evaluarClip(doc, esquema, c, t).values[id]?.[prop] ?? valorEfectivo(esquema, doc, obj, prop);
  const final = poseDeClip(doc, esquema, c, t, params).values[id]?.[prop] ?? delClip;
  const aporte = final - delClip;
  return Math.abs(aporte) < 1e-9 ? visto : Math.round((visto - aporte) * 1e6) / 1e6;
}

/**
 * Los valores del montaje de todo lo que el clip anima (y de lo que fija `pose`, si se pasa: el id de una pose o sus
 * values ya filtrados), con los params en su valor inicial: { objeto: { propiedad: valor } }. Es «Key setup» del
 * editor y `setup: true` de set_keys.
 */
export function valoresDeMontaje(doc, esquema, pistas, pose = null) {
  const params = valoresDeParams(doc, esquema);
  const props = new Map(Object.entries(pistas ?? {}).map(([id, campos]) => [id, new Set(Object.keys(campos))]));
  const extra = typeof pose === 'string' ? buscar(doc, pose)?.values : pose;
  for (const [id, campos] of Object.entries(extra ?? {})) for (const prop of Object.keys(campos)) (props.get(id) ?? props.set(id, new Set()).get(id)).add(prop);
  const valores = {};
  for (const [id, nombres] of props) {
    const obj = buscar(doc, id);
    if (!obj) continue;
    for (const prop of nombres) (valores[id] ??= {})[prop] = obj.type === 'param' ? params[id] : valorEfectivo(esquema, doc, obj, prop);
  }
  return valores;
}

/**
 * Pistas con el keyframe de `id.prop` en `desde` movido a `hasta` (conserva valor y curva), o null si no hay
 * keyframe en `desde`. Error si en `hasta` ya hay otro: moverlo encima lo borraría.
 */
export function moverClave(pistas, id, prop, desde, hasta) {
  const claves = pistas?.[id]?.[prop] ?? [];
  const clave = claves.find((c) => mismoTiempo(c.t, desde));
  if (!clave) return null;
  if (!mismoTiempo(desde, hasta) && claves.some((c) => c !== clave && mismoTiempo(c.t, hasta))) throw new Error(`${id}.${prop} already has a keyframe at ${redondearTiempo(hasta)} s: delete it first or move to another time`);
  return ponerClave(quitarClave(pistas, id, prop, clave.t), id, prop, hasta, clave.value, clave.ease ?? 'linear');
}

/**
 * Avisos de un clip para la IA y el editor: las pistas numéricas a las que un driver activo les suma su pose encima
 * (un param animado, o uno con valor inicial distinto de 0), en los tiempos de sus keyframes. Así no sorprende que
 * un hueso keyado en 10 se vea en 40.
 */
export function avisosDeClip(doc, esquema, clip, params = {}) {
  const c = typeof clip === 'string' ? buscar(doc, clip) : clip;
  // Una escena no tiene drivers encima (ver poseDeClip).
  if (c?.type !== 'animation' || esEscena(esquema, c)) return [];
  const avisos = new Map();
  const drivers = doc.objects.filter((o) => o.type === 'driver' && buscar(doc, o.pose)?.type === 'pose');
  for (const t of tiemposDeClaves(c)) {
    const valores = valoresDeParams(doc, esquema, { ...params, ...evaluarClip(doc, esquema, c, t).params });
    for (const d of drivers) {
      if (!(d.param in valores)) continue;
      const w = pesoDeDriver(doc, esquema, d, valores[d.param]);
      if (w <= 0) continue;
      for (const [id, campos] of Object.entries(buscar(doc, d.pose).values ?? {})) {
        for (const prop of Object.keys(campos)) {
          if (!c.tracks?.[id]?.[prop]) continue;
          if (esquema.tipos.get(buscar(doc, id)?.type)?.properties[prop]?.type !== 'number') continue;
          const clave = `${id}.${prop} ${d.id}`;
          if (!avisos.has(clave)) avisos.set(clave, `${id}.${prop}: the clip keys it and driver ${d.id} (${d.param} = ${JSON.stringify(valores[d.param])}${c.tracks?.[d.param] ? ', animated by the clip' : ''}) adds pose ${d.pose} on top (weight ${Math.round(w * 100)}% at ${t} s), so it shows more than the keyed value`);
        }
      }
    }
  }
  return [...avisos.values()];
}

/**
 * Reescala el tiempo de un tramo de un clip: los keyframes entre `desde` y `hasta` se estiran o comprimen en
 * proporción para que el tramo dure `largo`, y los de después se corren lo mismo (con su valor y su curva). Sin
 * desde/hasta, el clip entero. Devuelve { pistas, duracion } (la duración cambia lo mismo que el tramo). Error si
 * dos keyframes de una pista quedarían en el mismo momento.
 */
export function escalarTiempo(pistas, duracion, { desde = 0, hasta = duracion, largo }) {
  if (!(desde >= 0) || !(hasta <= duracion + 1e-9) || !(hasta - desde > 0)) throw new Error(`the stretch to scale must be inside the clip (0…${redondearTiempo(duracion)} s) with from < to (received ${desde}…${hasta})`);
  if (!(largo > 0) || !Number.isFinite(largo)) throw new Error(`the new length must be a number of seconds > 0 (received ${largo})`);
  const viejo = hasta - desde;
  const delta = largo - viejo;
  const mapear = (t) => redondearTiempo(t <= desde ? t : t >= hasta - 1e-9 ? t + delta : desde + ((t - desde) * largo) / viejo);
  const nuevas = {};
  for (const [id, campos] of Object.entries(pistas ?? {})) {
    for (const [prop, claves] of Object.entries(campos)) {
      const movidas = claves.map((c) => ({ ...c, t: mapear(c.t) }));
      for (let i = 1; i < movidas.length; i++) {
        if (mismoTiempo(movidas[i - 1].t, movidas[i].t)) throw new Error(`${id}.${prop}: the keyframes at ${claves[i - 1].t} and ${claves[i].t} s would land on the same time (${movidas[i].t} s). Use a longer length, or delete one of them first`);
      }
      (nuevas[id] ??= {})[prop] = movidas;
    }
  }
  return { pistas: nuevas, duracion: redondearTiempo(duracion + delta) };
}

/**
 * Qué mueve cada param que anima un clip de Puppet: [{ param, poses: [{ driver, pose, objetos }] }], con las poses de
 * sus drivers y los objetos que toca cada una. Así la IA (y la timeline) ven que animar `happiness` mueve también,
 * por ejemplo, `mirando_arriba`. En una escena, nada (no tiene params ni drivers).
 */
export function posesDeParamsAnimados(doc, esquema, clip) {
  const c = typeof clip === 'string' ? buscar(doc, clip) : clip;
  if (c?.type !== 'animation' || esEscena(esquema, c)) return [];
  const drivers = doc.objects.filter((o) => o.type === 'driver');
  return Object.keys(c.tracks ?? {})
    .filter((id) => buscar(doc, id)?.type === 'param' && c.tracks[id].value?.length)
    .map((param) => ({
      param,
      poses: drivers.filter((d) => d.param === param && buscar(doc, d.pose)?.type === 'pose').map((d) => ({ driver: d.id, pose: d.pose, objetos: Object.keys(buscar(doc, d.pose).values ?? {}) })),
    }));
}

/** Una línea por param animado: «happiness → happy (eye_l, mouth), mirando_arriba (head_bone)». */
export function lineasDePosesDeParams(doc, esquema, clip) {
  const objetos = (ids) => (ids.length > 6 ? `${ids.slice(0, 6).join(', ')}…` : ids.join(', '));
  return posesDeParamsAnimados(doc, esquema, clip).map(({ param, poses }) =>
    `${param} → ${poses.length ? poses.map((p) => `${p.pose} (${objetos(p.objetos) || 'empty'})`).join(', ') : 'no driver: it moves nothing'}`,
  );
}
