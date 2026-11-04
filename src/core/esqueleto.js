// Esqueleto: dónde está cada hueso en el montaje y en una pose, y cuánto mueve la pose a lo que está enlazado.
//
// Como en Moho, los huesos viven en un `skeleton` (la capa de huesos), que también contiene el dibujo que mueven. Los
// huesos raíz nacen en el marco del skeleton: si el skeleton se mueve, gira o escala, el esqueleto entero va con él.
// El dibujo solo se enlaza a huesos de su skeleton.
//
// El montaje (los valores guardados en cada `bone`) es la pose de reposo, como el frame 0 de Moho. Una `pose`
// reemplaza algunos valores de algunos huesos. Un objeto con `bone` sigue al hueso según su "delta": la matriz que
// lleva al hueso de su lugar en el montaje a su lugar en la pose. En el montaje el delta es la identidad, así que
// enlazar no mueve nada; recién al posar, el dibujo acompaña.

import { buscar, esqueletoDe, hijos, huesosDe } from './documento.js';
import { leer } from './esquema.js';
import { IDENTIDAD, aplicar, invertir, matrizMundo, multiplicar } from './geometria.js';
import { tangentes } from './trazado.js';

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
  const fijados = pose?.values?.[hueso.id];
  if (fijados) {
    for (const k of CAMPOS_DE_POSE) if (fijados[k] !== undefined) v[k] = fijados[k];
    v.rotation = limitarAngulo(esquema, hueso, v.rotation);
  }
  return v;
}

/**
 * Evalúa todos los esqueletos del documento. `pose` es un objeto pose (o null = el montaje). Devuelve, por id de
 * hueso, su matriz de mundo (en coordenadas del documento) en el montaje (`reposo`), en la pose (`posado`) y el
 * `delta` entre las dos.
 *
 * El marco de un hueso raíz es el de su skeleton. Si el skeleton está enlazado a un hueso de otro skeleton que lo
 * contiene, en la pose ese marco también se mueve con el delta de aquel hueso.
 */
export function evaluarEsqueleto(doc, esquema, pose = null) {
  const huesos = doc.objects.filter((o) => o.type === 'bone');
  const reposo = new Map();
  const posado = pose ? new Map() : reposo;
  // Marco de los huesos raíz: el del skeleton (o el documento, para un hueso suelto de un documento sin migrar).
  const marcoDeRaiz = (esqueleto, conPose, resolver) => {
    if (!esqueleto) return IDENTIDAD;
    const marco = matrizMundo(doc, esquema, esqueleto.id);
    const externo = conPose && huesoDe(doc, esqueleto.id);
    if (!externo || buscar(doc, externo)?.type !== 'bone') return marco;
    return multiplicar(multiplicar(resolver(buscar(doc, externo)), invertir(reposo.get(externo))), marco);
  };
  const calcular = (mundo, conPose) => {
    // Padres antes que hijos, aunque la lista plana no venga en ese orden.
    const resolver = (h) => {
      if (mundo.has(h.id)) return mundo.get(h.id);
      const v = valoresDeHueso(esquema, h, conPose ? pose : null);
      const padre = h.parent && buscar(doc, h.parent);
      let m;
      if (padre?.type !== 'bone') m = multiplicar(marcoDeRaiz(padre, conPose, resolver), matriz(v));
      else if (leer(esquema, h, 'independentAngle')) {
        // Ángulo independiente: toma solo la posición del padre.
        const [x, y] = aplicar(resolver(padre), v.x, v.y);
        m = matriz({ ...v, x, y });
      } else m = multiplicar(resolver(padre), matriz(v));
      mundo.set(h.id, m);
      return m;
    };
    huesos.forEach(resolver);
  };
  calcular(reposo, false);
  if (pose) calcular(posado, true);
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

/** Marco en el que nacen los hijos de `padreId` (un hueso o un skeleton), en el montaje y en coordenadas del documento. */
export function marcoDeHijos(doc, esquema, padreId) {
  const padre = padreId && buscar(doc, padreId);
  if (!padre) return IDENTIDAD;
  if (padre.type === 'bone') return evaluarEsqueleto(doc, esquema).reposo.get(padre.id);
  return matrizMundo(doc, esquema, padre.id);
}

/** Distancia de un punto al segmento de un hueso (origen → punta), en coordenadas del documento. */
function distanciaAHueso([px, py], [ax, ay], [bx, by]) {
  const [dx, dy] = [bx - ax, by - ay];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

const segmento = (esquema, h, mundo) => ({ id: h.id, a: aplicar(mundo.get(h.id), 0, 0), b: puntaDe(esquema, h, mundo.get(h.id)) });

/** El segmento (hueso) más cercano a un punto. */
const masCercano = (segmentos, p) =>
  segmentos.reduce(
    (mejor, s) => {
      const d = distanciaAHueso(p, s.a, s.b);
      return d < mejor.d ? { id: s.id, d } : mejor;
    },
    { id: null, d: Infinity },
  );

/**
 * Enlace por punto automático: cada vértice del path pasa a seguir al hueso más cercano (en el montaje) de los
 * indicados, o de todos los de su skeleton. Devuelve los vértices nuevos.
 */
export function repartirEntreHuesos(doc, esquema, pathId, ids = null) {
  const path = buscar(doc, pathId);
  const esqueleto = esqueletoDe(doc, pathId);
  if (!esqueleto) throw new Error(`"${pathId}" no está dentro de un skeleton: el enlace por punto usa los huesos del skeleton que lo contiene`);
  const propios = huesosDe(doc, esqueleto);
  if (ids) {
    const ajenos = ids.filter((id) => !propios.some((h) => h.id === id));
    if (ajenos.length) throw new Error(`${ajenos.join(', ')} no ${ajenos.length > 1 ? 'son huesos' : 'es un hueso'} del skeleton "${esqueleto}". Sus huesos: ${propios.map((h) => h.id).join(', ') || 'ninguno'}`);
  }
  const huesos = ids ? propios.filter((h) => ids.includes(h.id)) : propios;
  if (!huesos.length) throw new Error(`el skeleton "${esqueleto}" no tiene huesos`);
  const { reposo } = evaluarEsqueleto(doc, esquema);
  const segmentos = huesos.map((h) => segmento(esquema, h, reposo));
  const mundo = matrizMundo(doc, esquema, pathId);
  return leer(esquema, path, 'vertices').map((v) => ({ ...v, bone: masCercano(segmentos, aplicar(mundo, v.x, v.y)).id }));
}

/**
 * Caja (en coordenadas del documento, en el montaje) de un objeto de dibujo y sus hijos: [minX, minY, maxX, maxY], o
 * null si no dibuja nada. Es aproximada para las curvas (usa anclas y tangentes), que alcanza para elegir un hueso.
 */
export function cajaDe(doc, esquema, id) {
  const caja = [Infinity, Infinity, -Infinity, -Infinity];
  const sumar = (m, x, y) => {
    const [px, py] = aplicar(m, x, y);
    caja[0] = Math.min(caja[0], px);
    caja[1] = Math.min(caja[1], py);
    caja[2] = Math.max(caja[2], px);
    caja[3] = Math.max(caja[3], py);
  };
  const recorrer = (o) => {
    if (o.type === 'bone' || esquema.tipos.get(o.type)?.resource) return;
    const m = matrizMundo(doc, esquema, o.id);
    if (o.type === 'rect' || o.type === 'ellipse') {
      const [w, h] = [leer(esquema, o, 'width'), leer(esquema, o, 'height')];
      const [x0, y0] = [-w * leer(esquema, o, 'originX'), -h * leer(esquema, o, 'originY')];
      for (const [x, y] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]]) sumar(m, x, y);
    } else if (o.type === 'path') {
      for (const v of leer(esquema, o, 'vertices')) {
        const { entrada, salida } = tangentes(v);
        sumar(m, v.x, v.y);
        sumar(m, v.x + entrada[0], v.y + entrada[1]);
        sumar(m, v.x + salida[0], v.y + salida[1]);
      }
    }
    hijos(doc, o.id).forEach(recorrer);
  };
  recorrer(buscar(doc, id));
  return caja[0] <= caja[2] ? caja : null;
}

/** ¿`ancestro` contiene a `id` (a cualquier profundidad)? */
function dentroDe(doc, id, ancestro) {
  for (let o = buscar(doc, buscar(doc, id)?.parent); o; o = buscar(doc, o.parent)) if (o.id === ancestro) return true;
  return false;
}

/**
 * «Bind all by proximity»: el dibujo del skeleton que todavía no sigue a ningún hueso se enlaza (por capa) al hueso
 * más cercano al centro de su caja. Se enlazan las piezas más grandes que se pueda: un grupo (o switch, o skeleton
 * anidado) sin nada enlazado adentro va entero; si adentro ya hay algo enlazado, se baja a sus hijos para no cambiar
 * lo que ya estaba decidido. No se tocan lo que ya tiene hueso propio ni los paths enlazados por punto.
 * Devuelve [{ id, bone }] en orden de la lista.
 */
export function enlacesPorCercania(doc, esquema, esqueletoId) {
  const esqueleto = buscar(doc, esqueletoId);
  if (esqueleto?.type !== 'skeleton') throw new Error(`"${esqueletoId}" no es un skeleton`);
  const huesos = huesosDe(doc, esqueletoId);
  if (!huesos.length) throw new Error(`el skeleton "${esqueletoId}" no tiene huesos: créalos antes de enlazar`);
  const { reposo } = evaluarEsqueleto(doc, esquema);
  const segmentos = huesos.map((h) => segmento(esquema, h, reposo));
  const porPunto = (o) => o.vertices?.some((v) => v.bone);
  const enlazadoAdentro = (id) => doc.objects.some((o) => (o.bone || porPunto(o)) && dentroDe(doc, o.id, id));
  const enlaces = [];
  const recorrer = (padreId) => {
    for (const o of hijos(doc, padreId)) {
      const tipo = esquema.tipos.get(o.type);
      if (!tipo || !('bone' in tipo.properties) || o.bone || porPunto(o)) continue;
      if (tipo.container && o.type !== 'skeleton' && enlazadoAdentro(o.id)) {
        recorrer(o.id);
        continue;
      }
      const caja = cajaDe(doc, esquema, o.id);
      if (caja) enlaces.push({ id: o.id, bone: masCercano(segmentos, [(caja[0] + caja[2]) / 2, (caja[1] + caja[3]) / 2]).id });
    }
  };
  recorrer(esqueletoId);
  return enlaces;
}

/**
 * Enlaces que dejaron de valer porque el objeto cambió de skeleton (por ejemplo, al sacar un dibujo del skeleton):
 * el lote que los suelta (un unset de bone, o los vértices sin ese bone).
 */
export function soltarEnlacesAjenos(doc, esquema) {
  const ops = [];
  for (const o of doc.objects) {
    const props = esquema.tipos.get(o.type)?.properties ?? {};
    const propio = esqueletoDe(doc, o.id);
    const ajeno = (hueso) => buscar(doc, hueso)?.type === 'bone' && esqueletoDe(doc, hueso) !== propio;
    if ('bone' in props && o.bone && ajeno(o.bone)) ops.push({ op: 'unset', target: o.id, props: ['bone'] });
    for (const [prop, p] of Object.entries(props)) {
      if (p.type !== 'vertices' || !o[prop]?.some((v) => v.bone && ajeno(v.bone))) continue;
      ops.push({ op: 'set', target: o.id, props: { [prop]: o[prop].map(({ bone, ...v }) => (bone && !ajeno(bone) ? { ...v, bone } : v)) } });
    }
  }
  return ops;
}

/**
 * Azúcar para crear o mover huesos con coordenadas del documento: `from` (origen) y `to` (punta), como [x, y].
 * Devuelve las props con x, y, rotation y length calculados en el marco del padre (el hueso padre o, para un hueso
 * raíz, el skeleton).
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
  const padreObj = padreId && buscar(doc, padreId);
  if (padreObj && padreObj.type !== 'bone' && padreObj.type !== 'skeleton') throw new Error(`"${padreId}" es un ${padreObj.type}: un hueso va dentro de un skeleton o de otro bone`);
  const padre = marcoDeHijos(doc, esquema, padreId);
  const raiz = padreObj?.type !== 'bone';
  const r1 = (v) => Math.round(v * 10) / 10 || 0;
  const salida = { ...resto };
  // Origen actual en el documento, si solo se da `to`.
  const origenLocal = from !== undefined ? aplicar(invertir(padre), ...punto('from')) : [valores.x ?? 0, valores.y ?? 0];
  if (from !== undefined) [salida.x, salida.y] = origenLocal.map(r1);
  if (to !== undefined) {
    const origen = aplicar(padre, ...origenLocal);
    const [tx, ty] = punto('to');
    // El ángulo se mide contra el padre, salvo con ángulo independiente (que no cuenta en un hueso raíz).
    const giro = valores.independentAngle && !raiz ? IDENTIDAD : padre;
    const lineal = invertir([...giro.slice(0, 4), 0, 0]);
    const [dx, dy] = aplicar(lineal, tx - origen[0], ty - origen[1]);
    salida.rotation = r1((Math.atan2(dy, dx) * 180) / Math.PI);
    salida.length = r1(Math.hypot(dx, dy) / (valores.scaleX ?? 1));
  }
  return salida;
}
