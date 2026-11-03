// Esqueleto: dónde está cada hueso en el montaje y en una pose, y cuánto mueve la pose a lo que está enlazado.
//
// El montaje (los valores guardados en cada `bone`) es la pose de reposo, como el frame 0 de Moho. Una `pose`
// reemplaza algunos valores de algunos huesos. Un objeto con `bone` sigue al hueso según su "delta": la matriz que
// lleva al hueso de su lugar en el montaje a su lugar en la pose. En el montaje el delta es la identidad, así que
// enlazar no mueve nada; recién al posar, el dibujo acompaña.

import { buscar } from './documento.js';
import { leer } from './esquema.js';
import { IDENTIDAD, aplicar, invertir, matrizMundo, multiplicar } from './geometria.js';

export const CAMPOS_DE_POSE = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];

/** translate · rotate · scale a partir de valores sueltos. */
function matriz({ x, y, rotation, scaleX, scaleY }) {
  const r = (rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * scaleX, s * scaleX, -s * scaleY, c * scaleY, x, y];
}

/** Rotación limitada por minAngle / maxAngle del hueso. */
export function limitarAngulo(esquema, hueso, rotacion) {
  const min = leer(esquema, hueso, 'minAngle');
  const max = leer(esquema, hueso, 'maxAngle');
  if (min != null && rotacion < min) return min;
  if (max != null && rotacion > max) return max;
  return rotacion;
}

/** Valores de un hueso: los del montaje, con lo que fije la pose encima (la rotación, dentro de sus límites). */
export function valoresDeHueso(esquema, hueso, pose) {
  const v = Object.fromEntries(CAMPOS_DE_POSE.map((k) => [k, leer(esquema, hueso, k)]));
  const fijados = pose?.bones?.[hueso.id];
  if (fijados) {
    Object.assign(v, fijados);
    v.rotation = limitarAngulo(esquema, hueso, v.rotation);
  }
  return v;
}

/**
 * Evalúa el esqueleto. `pose` es un objeto pose (o null = el montaje). Devuelve, por id de hueso, su matriz de mundo
 * en el montaje (`reposo`), en la pose (`posado`) y el `delta` entre las dos.
 */
export function evaluarEsqueleto(doc, esquema, pose = null) {
  const huesos = doc.objects.filter((o) => o.type === 'bone');
  const calcular = (conPose) => {
    const mundo = new Map();
    // Padres antes que hijos, aunque la lista plana no venga en ese orden.
    const resolver = (h) => {
      if (mundo.has(h.id)) return mundo.get(h.id);
      const v = valoresDeHueso(esquema, h, conPose ? pose : null);
      const padre = h.parent && buscar(doc, h.parent);
      let m;
      if (!padre) m = matriz(v);
      else if (leer(esquema, h, 'independentAngle')) {
        // Ángulo independiente: toma solo la posición del padre.
        const [x, y] = aplicar(resolver(padre), v.x, v.y);
        m = matriz({ ...v, x, y });
      } else m = multiplicar(resolver(padre), matriz(v));
      mundo.set(h.id, m);
      return m;
    };
    huesos.forEach(resolver);
    return mundo;
  };
  const reposo = calcular(false);
  const posado = pose ? calcular(true) : reposo;
  const delta = new Map(huesos.map((h) => [h.id, pose ? multiplicar(posado.get(h.id), invertir(reposo.get(h.id))) : IDENTIDAD]));
  return { reposo, posado, delta, pose };
}

/** Hueso que mueve a un objeto: el suyo o, si no tiene, el de su padre más cercano que tenga uno. */
export function huesoDe(doc, id) {
  for (let o = buscar(doc, id); o; o = buscar(doc, o.parent)) if (o.bone) return o.bone;
  return null;
}

/** Delta que la pose le aplica a un objeto (identidad si no sigue a ningún hueso). */
export function deltaDe(doc, esqueleto, id) {
  const hueso = huesoDe(doc, id);
  return (hueso && esqueleto.delta.get(hueso)) || IDENTIDAD;
}

/** Punta de un hueso (en coordenadas del documento) según una matriz de mundo. */
export function puntaDe(esquema, hueso, mundo) {
  return aplicar(mundo, leer(esquema, hueso, 'length'), 0);
}

/** Distancia de un punto al segmento de un hueso (origen → punta), en coordenadas del documento. */
function distanciaAHueso([px, py], [ax, ay], [bx, by]) {
  const [dx, dy] = [bx - ax, by - ay];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Enlace por punto automático: cada vértice del path pasa a seguir al hueso más cercano (en el montaje) de los
 * indicados, o de todos. Devuelve los vértices nuevos.
 */
export function repartirEntreHuesos(doc, esquema, pathId, ids = null) {
  const path = buscar(doc, pathId);
  const huesos = doc.objects.filter((o) => o.type === 'bone' && (!ids || ids.includes(o.id)));
  if (!huesos.length) throw new Error(ids ? `ninguno de ${ids.join(', ')} es un hueso` : 'el documento no tiene huesos');
  const { reposo } = evaluarEsqueleto(doc, esquema);
  const segmentos = huesos.map((h) => ({ id: h.id, a: aplicar(reposo.get(h.id), 0, 0), b: puntaDe(esquema, h, reposo.get(h.id)) }));
  const mundo = matrizMundo(doc, esquema, pathId);
  return leer(esquema, path, 'vertices').map((v) => {
    const p = aplicar(mundo, v.x, v.y);
    const cercano = segmentos.reduce((mejor, s) => {
      const d = distanciaAHueso(p, s.a, s.b);
      return d < mejor.d ? { id: s.id, d } : mejor;
    }, { id: null, d: Infinity });
    return { ...v, bone: cercano.id };
  });
}

/**
 * Azúcar para crear o mover huesos con coordenadas del documento: `from` (origen) y `to` (punta), como [x, y].
 * Devuelve las props con x, y, rotation y length calculados en el marco del hueso padre.
 */
export function expandirDesdeHasta(doc, esquema, padreId, props, actual = {}) {
  if (props?.from === undefined && props?.to === undefined) return props;
  const punto = (nombre) => {
    const p = props[nombre];
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${nombre} debe ser [x, y] en coordenadas del documento`);
    return p;
  };
  const { from, to, ...resto } = props;
  const valores = { ...actual, ...resto };
  const padre = padreId ? evaluarEsqueleto(doc, esquema).reposo.get(padreId) : IDENTIDAD;
  if (!padre) throw new Error(`"${padreId}" no es un hueso`);
  const r1 = (v) => Math.round(v * 10) / 10 || 0;
  const salida = { ...resto };
  // Origen actual en el documento, si solo se da `to`.
  const origenLocal = from !== undefined ? aplicar(invertir(padre), ...punto('from')) : [valores.x ?? 0, valores.y ?? 0];
  if (from !== undefined) [salida.x, salida.y] = origenLocal.map(r1);
  if (to !== undefined) {
    const origen = aplicar(padre, ...origenLocal);
    const [tx, ty] = punto('to');
    // El ángulo se mide contra el padre, salvo con ángulo independiente.
    const giro = valores.independentAngle ? IDENTIDAD : padre;
    const lineal = invertir([...giro.slice(0, 4), 0, 0]);
    const [dx, dy] = aplicar(lineal, tx - origen[0], ty - origen[1]);
    salida.rotation = r1((Math.atan2(dy, dx) * 180) / Math.PI);
    salida.length = r1(Math.hypot(dx, dy) / (valores.scaleX ?? 1));
  }
  return salida;
}
