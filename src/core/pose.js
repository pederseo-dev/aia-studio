// De params a pose, y de pose a matrices del mundo por hueso.

import { leerDestino, ordenarHuesos } from './documento.js';

export function valoresIniciales(doc) {
  return Object.fromEntries(doc.rig.params.map((p) => [p.id, p.default ?? 0]));
}

// Interpolación lineal por tramos, con los extremos fijos.
function tramos(v, xs, ys) {
  if (v <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (v <= xs[i]) return ys[i - 1] + ((v - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ys[i] - ys[i - 1]);
  }
  return ys.at(-1);
}

/**
 * Parte del montaje (rig) y suma el efecto de cada driver.
 * Los drivers numéricos son aditivos; los de slot eligen la última opción cuyo umbral se alcanzó.
 */
export function evaluar(doc, valores = {}) {
  const pose = { bones: {}, parts: {}, slots: {} };
  for (const b of doc.rig.bones) {
    pose.bones[b.id] = { x: b.x ?? 0, y: b.y ?? 0, rotation: b.rotation ?? 0, scaleX: b.scaleX ?? 1, scaleY: b.scaleY ?? 1 };
  }
  for (const p of doc.rig.parts) pose.parts[p.id] = { opacity: p.opacity ?? 1 };
  for (const s of doc.rig.slots) pose.slots[s.id] = { active: s.active };

  const params = new Map(doc.rig.params.map((p) => [p.id, p]));
  for (const d of doc.drivers) {
    const p = params.get(d.param);
    const v = Math.min(p.range[1], Math.max(p.range[0], valores[d.param] ?? p.default ?? 0));
    const { coleccion, id, prop } = leerDestino(d.target);
    const destino = pose[coleccion][id];
    if (d.steps) {
      let elegida;
      for (const [umbral, opcion] of d.steps) if (v >= umbral) elegida = opcion;
      if (elegida !== undefined) destino[prop] = elegida;
    } else {
      destino[prop] += tramos(v, d.in, d.out);
    }
  }
  return pose;
}

// Matrices afines [a, b, c, d, e, f], las mismas que usa SVG en matrix(...).
function local({ x, y, rotation, scaleX, scaleY }) {
  const r = (rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * scaleX, s * scaleX, -s * scaleY, c * scaleY, x, y];
}

export function multiplicar(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Resuelve la jerarquía: cada hueso hereda la transformación de su padre. */
export function matricesDelMundo(doc, pose) {
  const mundo = {};
  for (const b of ordenarHuesos(doc.rig.bones)) {
    const m = local(pose.bones[b.id]);
    mundo[b.id] = b.parent == null ? m : multiplicar(mundo[b.parent], m);
  }
  return mundo;
}
