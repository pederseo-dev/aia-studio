// El muñeco en marcha (Puppet en vivo): lo que la app o su IA manejan con tres verbos —play(clip), set(param, valor)
// y stop(clip)— y que se avanza con avanzar(dt). Es el runtime que exporta la fase 7; el editor (▶ Live) y la vista
// previa de la IA (render_preview con live) usan este mismo. Ver docs/decision-animacion.md §9.
//
// Capas, de abajo hacia arriba:
//   montaje → bases (loop/pingpong, con fundido cruzado) → gestos (once, en orden) → auto (repeat/always) → drivers
// Cada capa pisa lo de abajo con su peso (o suma, si es additive). Los params se mezclan igual: el valor de la app
// debajo y lo que animan los clips encima; los drivers se calculan una sola vez, con los params ya mezclados.

import { buscar } from './documento.js';
import { evaluarClip } from './animacion.js';
import { leer } from './esquema.js';
import { valorEfectivo } from './estilos.js';
import { mezclarColor, mezclarPoses, mezclarVertices, valoresDeParams } from './mezcla.js';

/** Generador de números al azar con semilla (mulberry32): el mismo guion da la misma tira. */
function azar(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Curva del fundido: suave al entrar y al salir (ease-in-out). */
const suave = (w) => w * w * (3 - 2 * w);

/** Clips de Puppet que la app puede disparar (no los auto ni las escenas). */
export function clipsDisparables(doc, esquema) {
  return doc.objects.filter((o) => o.type === 'animation' && leer(esquema, o, 'usage') === 'puppet' && leer(esquema, o, 'auto') === 'off');
}

/** Es un clip de base (se queda sonando) o un gesto (una vez, encima). */
export const esBase = (esquema, clip) => leer(esquema, clip, 'loop') !== 'once';

/**
 * Crea el muñeco en marcha. `params`: valores iniciales de la app. `semilla`: para el azar de los clips auto repeat.
 * Devuelve { play, stop, set, avanzar, pose, estado, actualizar }.
 */
export function crearVivo(doc, esquema, { params = {}, semilla = 1 } = {}) {
  let documento = doc;
  const aleatorio = azar(semilla);
  let reloj = 0;
  const app = {}; // valores de la app (los que falten, el inicial)
  // Entradas que suenan: { clip, t, peso, objetivo, fade, capa: 'base' | 'gesto' | 'auto', siguienteHecho }
  let entradas = [];
  // Clips auto repeat: id → segundos que faltan para la próxima vez.
  const esperas = new Map();

  const clipDe = (id) => {
    const c = buscar(documento, id);
    return c?.type === 'animation' ? c : null;
  };
  const fadeDe = (clip) => Math.max(0, leer(esquema, clip, 'fade'));
  const espera = (clip) => {
    const [a, b] = [leer(esquema, clip, 'repeat_min'), leer(esquema, clip, 'repeat_max')];
    return a + aleatorio() * Math.max(0, b - a);
  };

  /** Arranca las capas auto que falten y quita las de clips que ya no son auto. */
  function sincronizarAuto() {
    const autos = documento.objects.filter((o) => o.type === 'animation' && leer(esquema, o, 'usage') === 'puppet' && leer(esquema, o, 'auto') !== 'off');
    const ids = new Set(autos.map((c) => c.id));
    entradas = entradas.filter((e) => e.capa !== 'auto' || ids.has(e.clip));
    for (const id of [...esperas.keys()]) if (!ids.has(id) || leer(esquema, clipDe(id), 'auto') !== 'repeat') esperas.delete(id);
    for (const c of autos) {
      const modo = leer(esquema, c, 'auto');
      if (modo === 'always' && !entradas.some((e) => e.clip === c.id && e.capa === 'auto')) entradas.push({ clip: c.id, t: 0, peso: 1, objetivo: 1, capa: 'auto' });
      if (modo === 'repeat' && !esperas.has(c.id) && !entradas.some((e) => e.clip === c.id && e.capa === 'auto')) esperas.set(c.id, espera(c));
    }
  }

  function play(id) {
    const clip = clipDe(id);
    if (!clip) {
      const ids = clipsDisparables(documento, esquema).map((c) => c.id);
      throw new Error(`there is no clip "${id}". Clips you can play: ${ids.join(', ') || 'none'}`);
    }
    if (leer(esquema, clip, 'usage') !== 'puppet') throw new Error(`"${id}" is a scene (Animate); only Puppet clips play live`);
    if (leer(esquema, clip, 'auto') !== 'off') throw new Error(`"${id}" is an auto clip (${leer(esquema, clip, 'auto')}): it plays by itself`);
    const fade = fadeDe(clip);
    if (esBase(esquema, clip)) {
      const actual = entradas.find((e) => e.capa === 'base' && e.objetivo === 1);
      if (actual?.clip === id) return;
      // La base anterior sale al ritmo de la nueva (fundido cruzado).
      for (const e of entradas) if (e.capa === 'base') Object.assign(e, { objetivo: 0, fade });
      entradas.push({ clip: id, t: 0, peso: fade > 0 ? 0 : 1, objetivo: 1, fade, capa: 'base' });
      return;
    }
    const existente = entradas.find((e) => e.capa === 'gesto' && e.clip === id);
    if (existente) Object.assign(existente, { t: 0, objetivo: 1, fade, siguienteHecho: false });
    else entradas.push({ clip: id, t: 0, peso: fade > 0 ? 0 : 1, objetivo: 1, fade, capa: 'gesto' });
  }

  function stop(id) {
    for (const e of entradas) if (e.capa !== 'auto' && (id == null || e.clip === id)) e.objetivo = 0;
  }

  function set(id, valor) {
    const p = buscar(documento, id);
    if (p?.type !== 'param') {
      const ids = documento.objects.filter((o) => o.type === 'param').map((o) => o.id);
      throw new Error(`there is no param "${id}". Params: ${ids.join(', ') || 'none'}`);
    }
    if (leer(esquema, p, 'kind') === 'enum' && !leer(esquema, p, 'options').includes(valor)) throw new Error(`param "${id}" is an enum: use one of ${leer(esquema, p, 'options').join(', ')}`);
    app[id] = valor;
  }
  for (const [k, v] of Object.entries(params)) set(k, v);

  /** Avanza el tiempo; en pasos de 1/60 s como mucho, para que los fundidos no dependan del tamaño del paso. */
  function avanzar(dt) {
    if (!(dt > 0)) return;
    for (let falta = dt; falta > 1e-12; falta -= Math.min(falta, 1 / 60)) avanzarPaso(Math.min(falta, 1 / 60));
  }

  function avanzarPaso(dt) {
    reloj += dt;
    sincronizarAuto();
    // Los auto repeat cuya espera terminó vuelven a sonar.
    for (const [id, falta] of esperas) {
      if (falta - dt > 0) {
        esperas.set(id, falta - dt);
        continue;
      }
      esperas.delete(id);
      const c = clipDe(id);
      const fade = fadeDe(c);
      entradas.push({ clip: id, t: Math.max(0, dt - falta), peso: fade > 0 ? 0 : 1, objetivo: 1, fade, capa: 'auto' });
    }
    const nuevas = [];
    for (const e of entradas) {
      const clip = clipDe(e.clip);
      if (!clip) continue;
      const enAuto = e.capa === 'auto' && leer(esquema, clip, 'auto') === 'always';
      if (!(e.capa === 'gesto' || e.capa === 'auto') || enAuto || e.t < leer(esquema, clip, 'duration')) e.t += dt;
      // El peso va hacia su objetivo a razón de 1/fade por segundo.
      const fade = e.fade ?? fadeDe(clip);
      e.peso = fade > 0 ? Math.max(0, Math.min(1, e.peso + Math.sign(e.objetivo - e.peso) * Math.min(Math.abs(e.objetivo - e.peso), dt / fade))) : e.objetivo;
      if (Math.abs(e.peso - e.objetivo) < 1e-9) e.peso = e.objetivo;
      // Un clip once empieza a salir a tiempo para terminar en su final; ahí se dispara su next.
      if ((e.capa === 'gesto' || (e.capa === 'auto' && !enAuto)) && e.objetivo === 1) {
        const d = leer(esquema, clip, 'duration');
        if (e.t >= d - fade - 1e-9) {
          e.objetivo = 0;
          if (fade === 0) e.peso = e.t >= d - 1e-9 ? 0 : e.peso;
          const next = leer(esquema, clip, 'next');
          if (e.capa === 'gesto' && next && !e.siguienteHecho && clipDe(next)) {
            e.siguienteHecho = true;
            nuevas.push(next);
          }
        }
      }
      if (fade === 0 && e.objetivo === 0) e.peso = 0;
    }
    // Las que ya salieron del todo se van; un auto repeat espera la próxima vez.
    entradas = entradas.filter((e) => {
      if (e.peso > 0 || e.objetivo > 0) return true;
      if (e.capa === 'auto' && clipDe(e.clip) && leer(esquema, clipDe(e.clip), 'auto') === 'repeat') esperas.set(e.clip, espera(clipDe(e.clip)));
      return false;
    });
    for (const id of nuevas) play(id);
  }

  /** La pose que se ve ahora (un objeto pose, como mezclarPoses), con `params` = los params ya mezclados. */
  function pose() {
    sincronizarAuto();
    const values = {};
    const P = valoresDeParams(documento, esquema, app);
    const montaje = (id, prop) => valorEfectivo(esquema, documento, buscar(documento, id), prop);
    const orden = { base: 0, gesto: 1, auto: 2 };
    const capas = entradas.map((e, i) => [e, i]).sort(([a, i], [b, j]) => orden[a.capa] - orden[b.capa] || i - j).map(([e]) => e);
    for (const e of capas) {
      const clip = clipDe(e.clip);
      const w = suave(e.peso);
      if (!clip || w <= 0) continue;
      const suma = leer(esquema, clip, 'blend') === 'additive';
      const ev = evaluarClip(documento, esquema, clip, e.t);
      for (const [id, campos] of Object.entries(ev.values)) {
        const props = esquema.tipos.get(buscar(documento, id).type).properties;
        for (const [prop, v] of Object.entries(campos)) {
          const tipo = props[prop].type;
          const actual = values[id]?.[prop] ?? montaje(id, prop);
          let nuevo;
          if (suma) {
            if (tipo !== 'number' || typeof v !== 'number') continue;
            nuevo = actual + w * (v - montaje(id, prop));
          } else if (w >= 1) nuevo = v;
          else if (tipo === 'number' && typeof v === 'number' && typeof actual === 'number') nuevo = actual + (v - actual) * w;
          else if (tipo === 'color') nuevo = mezclarColor(actual, v, w);
          else if (tipo === 'vertices' && Array.isArray(actual) && Array.isArray(v)) nuevo = mezclarVertices(actual, v, w);
          else if (w >= 0.5) nuevo = v;
          else continue;
          (values[id] ??= {})[prop] = nuevo;
        }
      }
      for (const [id, v] of Object.entries(ev.params)) {
        const param = buscar(documento, id);
        const numero = leer(esquema, param, 'kind') === 'number';
        if (suma) {
          if (numero) P[id] += w * (v - leer(esquema, param, 'default'));
        } else if (numero) P[id] = w >= 1 ? v : P[id] + (v - P[id]) * w;
        else if (w >= 0.5) P[id] = v;
      }
    }
    return mezclarPoses(documento, esquema, P, values);
  }

  /** Qué suena ahora: cada clip con su capa, su tiempo y su peso (0 a 1), y los valores de la app. */
  function estado() {
    sincronizarAuto();
    return {
      reloj,
      sonando: entradas.map((e) => ({ clip: e.clip, capa: e.capa, t: e.t, peso: e.peso, saliendo: e.objetivo === 0 })),
      params: valoresDeParams(documento, esquema, app),
      app: { ...app },
    };
  }

  /** Cambia el documento (el editor, al editar con Live apagado y volver): conserva lo que suena si sigue existiendo. */
  function actualizar(nuevo) {
    documento = nuevo;
    entradas = entradas.filter((e) => clipDe(e.clip));
    for (const id of Object.keys(app)) if (buscar(documento, id)?.type !== 'param') delete app[id];
  }

  sincronizarAuto();
  return { play, stop, set, avanzar, pose, estado, actualizar };
}

/**
 * Corre un guion ([{ t, play | stop | set }]) y devuelve la pose y el estado en cada uno de `tiempos` (segundos).
 * `stop: true` para todo; `set: { param: valor }`. Avanza en pasos de 1/60 s, como un cuadro de la app.
 */
export function correrGuion(doc, esquema, guion = [], tiempos = [], { params, semilla, paso = 1 / 60 } = {}) {
  const vivo = crearVivo(doc, esquema, { params, semilla });
  const eventos = [...guion].map((e, i) => ({ ...e, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  const pedidos = [...tiempos].map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
  const cuadros = new Array(tiempos.length);
  let ahora = 0;
  let k = 0;
  const aplicar = (e) => {
    if (e.set) for (const [id, v] of Object.entries(e.set)) vivo.set(id, v);
    if (e.stop !== undefined && e.stop !== false) vivo.stop(e.stop === true ? undefined : e.stop);
    if (e.play) vivo.play(e.play);
  };
  for (const pedido of pedidos) {
    while (ahora < pedido.t - 1e-9) {
      while (k < eventos.length && eventos[k].t <= ahora + 1e-9) aplicar(eventos[k++]);
      const dt = Math.min(paso, pedido.t - ahora);
      vivo.avanzar(dt);
      ahora += dt;
    }
    while (k < eventos.length && eventos[k].t <= ahora + 1e-9) aplicar(eventos[k++]);
    cuadros[pedido.i] = { t: pedido.t, pose: vivo.pose(), estado: vivo.estado() };
  }
  return cuadros;
}
