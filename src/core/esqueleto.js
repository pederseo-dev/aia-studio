// Esqueleto: dónde está cada hueso en el montaje y en una pose, y cuánto mueve la pose a lo que está enlazado.
//
// El montaje (los valores guardados en cada `bone`) es la pose de reposo, como el frame 0 de Moho. Una `pose`
// reemplaza algunos valores de algunos huesos. Un objeto con `bone` sigue al hueso según su "delta": la matriz que
// lleva al hueso de su lugar en el montaje a su lugar en la pose. En el montaje el delta es la identidad, así que
// enlazar no mueve nada; recién al posar, el dibujo acompaña.

import { buscar } from './documento.js';
import { leer } from './esquema.js';
import { IDENTIDAD, aplicar, invertir, multiplicar } from './geometria.js';

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
