// Lógica de las herramientas de animación del MCP (set_keys, delete_keys y el resumen de un clip), sin el
// transporte, para probarlas sin levantar el servidor. Los textos de error los lee la IA y el aviso del editor.

import { tiemposDeClaves } from '../src/core/animacion.js';
import { buscar } from '../src/core/documento.js';
import { leer, sugerir } from '../src/core/esquema.js';
import { parsearD } from '../src/core/trazado.js';

const MISMO_TIEMPO = 1e-6;
const redondearT = (t) => Math.round(t * 1e6) / 1e6;
const n = (t) => +t.toFixed(3);

/** Lo que fija un momento de set_keys: los valores de su pose, más values (con "d" convertido), más params. */
function valoresDelMomento(doc, k, i) {
  const valores = {};
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
 * set_keys: cada momento ({ t, values, params, pose, ease }) se vuelve keyframes del clip. `pose` copia los valores
 * de esa pose; `values` (como en set_pose, acepta "d") los suma o pisa; `params` anima params. Un keyframe en un
 * tiempo que ya tenía uno lo reemplaza (y conserva su ease si no se pasa otro). `remove` ("objeto.propiedad" o un id)
 * saca pistas enteras antes de agregar. Crea el clip si no existe y alarga la duración si un keyframe la pasa.
 */
export function planSetKeys(doc, esquema, animacion, { keys = [], usage, duration, loop, description, remove = [] } = {}) {
  const existente = buscar(doc, animacion);
  if (existente && existente.type !== 'animation') throw new Error(`"${animacion}" already exists and is a ${existente.type}; choose another id for the animation`);
  const pistas = structuredClone(existente?.tracks ?? {});
  for (const nombre of remove) {
    const [objeto, prop, ...sobra] = String(nombre).split('.');
    if (!objeto || sobra.length || prop === '') throw new Error(`remove: "${nombre}" should be "object.property" (for example "arm_bone.rotation") or an object id`);
    if (prop === undefined) delete pistas[objeto];
    else if (pistas[objeto]) {
      delete pistas[objeto][prop === 'd' ? 'vertices' : prop];
      if (!Object.keys(pistas[objeto]).length) delete pistas[objeto];
    }
  }
  for (const [i, k] of keys.entries()) {
    if (typeof k?.t !== 'number' || !Number.isFinite(k.t) || k.t < 0) throw new Error(`keys[${i}].t must be a number of seconds ≥ 0`);
    const valores = valoresDelMomento(doc, k, i);
    if (!Object.keys(valores).length) throw new Error(`keys[${i}] (t ${k.t}) sets nothing: pass values, params or pose`);
    const t = redondearT(k.t);
    for (const [id, campos] of Object.entries(valores)) {
      for (const [prop, v] of Object.entries(campos)) {
        const valor = prop === 'vertices' && Array.isArray(v) ? v.map(({ bone, ...resto }) => resto) : v;
        const claves = ((pistas[id] ??= {})[prop] ??= []);
        const j = claves.findIndex((c) => Math.abs(c.t - t) < MISMO_TIEMPO);
        const clave = { t, value: valor };
        const ease = k.ease ?? (j >= 0 ? claves[j].ease : undefined);
        if (ease !== undefined && ease !== 'linear') clave.ease = ease;
        if (j >= 0) claves[j] = clave;
        else claves.push(clave);
        claves.sort((a, b) => a.t - b.t);
      }
    }
  }
  const ultimo = Math.max(0, ...Object.values(pistas).flatMap((c) => Object.values(c).flatMap((claves) => claves.map((c) => c.t))));
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
  const clip = buscar(doc, animacion);
  if (clip?.type !== 'animation') {
    const clips = doc.objects.filter((o) => o.type === 'animation').map((o) => o.id);
    throw new Error(`there is no animation "${animacion}".${sugerir(animacion, clips)} Animations: ${clips.join(', ') || 'none'}`);
  }
  if (!times?.length && !targets?.length) throw new Error('pass times, targets or both (to delete the whole clip, use apply_ops with delete)');
  const elegida = (id, prop) => !targets?.length || targets.some((x) => x === id || x === `${id}.${prop}` || (prop === 'vertices' && x === `${id}.d`));
  const pistas = {};
  let quitadas = 0;
  for (const [id, campos] of Object.entries(clip.tracks ?? {})) {
    for (const [prop, claves] of Object.entries(campos)) {
      const quedan = !elegida(id, prop) ? claves : times?.length ? claves.filter((c) => !times.some((t) => Math.abs(c.t - t) < 1e-3)) : [];
      quitadas += claves.length - quedan.length;
      if (quedan.length) (pistas[id] ??= {})[prop] = quedan;
    }
  }
  return { ops: quitadas ? [{ op: 'set', target: animacion, props: { tracks: pistas } }] : [], quitadas };
}

/** Una línea que resume un clip: uso, duración, loop, qué anima y en qué tiempos. */
export function resumenDeClip(esquema, clip) {
  const pistas = Object.entries(clip.tracks ?? {}).flatMap(([id, campos]) => Object.keys(campos).map((k) => `${id}.${k}`));
  const tiempos = tiemposDeClaves(clip);
  const base = `${leer(esquema, clip, 'usage')}, ${n(leer(esquema, clip, 'duration'))} s, ${leer(esquema, clip, 'loop')}`;
  return `${base}; ${pistas.length ? `anima ${pistas.join(', ')}; keys en ${tiempos.map(n).join(', ')}` : 'sin keyframes'}`;
}

/** Tiempos para una tira de cuadros de un clip: los de sus keyframes (como mucho 12, repartidos) o, si no hay, 0. */
export function tiemposParaTira(clip, maximo = 12) {
  const tiempos = tiemposDeClaves(clip);
  if (tiempos.length <= maximo) return tiempos.length ? tiempos : [0];
  return Array.from({ length: maximo }, (_, i) => tiempos[Math.round((i * (tiempos.length - 1)) / (maximo - 1))]);
}
