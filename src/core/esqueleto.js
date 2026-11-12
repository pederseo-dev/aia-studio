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

import { buscar, esqueletoDe, hijos, huesosDe, subarbol } from './documento.js';
import { leer } from './esquema.js';
import { IDENTIDAD, aplicar, invertir, matrizMundo, multiplicar } from './geometria.js';
import { aplicarPose } from './mezcla.js';
// operaciones.js también importa este archivo: el ciclo es seguro porque solo se usan funciones, al llamarlas.
import { aplicarOperaciones } from './operaciones.js';
import { tangentes } from './trazado.js';

export const CAMPOS_DE_POSE = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];

/** translate · rotate · scale a partir de valores sueltos. */
/** @param {Record<string, any>} valores x, y, rotation, scaleX, scaleY */
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

/**
 * Como evaluarEsqueleto, pero con los valores de la pose aplicados también a lo que no es hueso (el skeleton o sus
 * grupos de arriba que la pose mueva): es lo que se ve. `reposo` queda en el marco posado del skeleton.
 */
export function evaluarEnPose(doc, esquema, pose = null) {
  return evaluarEsqueleto(pose ? aplicarPose(doc, esquema, pose) : doc, esquema, pose);
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
    if (o.type === 'rect' || o.type === 'ellipse' || o.type === 'image') {
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

const r4 = (v) => Math.round(v * 1e4) / 1e4 || 0;

/** Matriz de mundo de un hueso con estos valores, colgado de `marco` (con ángulo independiente, solo la posición). */
function mundoDeValores(v, marco, independiente) {
  const local = matriz(v);
  if (!independiente) return multiplicar(marco, local);
  const [x, y] = aplicar(marco, v.x, v.y);
  return [...local.slice(0, 4), x, y];
}

/** Valores (x, y, rotation, scaleX, scaleY) que dejan al hueso con esa matriz de mundo, colgado de `marco`. */
function valoresDeMundo(mundo, marco, independiente) {
  const [x, y] = aplicar(invertir(marco), mundo[4], mundo[5]);
  const [a, b, c, d] = independiente ? mundo : multiplicar(invertir([...marco.slice(0, 4), 0, 0]), [...mundo.slice(0, 4), 0, 0]);
  const scaleX = Math.hypot(a, b);
  const scaleY = (a * d - b * c) / (scaleX || 1);
  // Con un marco que deforma (escala desigual y giro), el hueso no se puede expresar sin torcerlo.
  if (Math.abs(a * c + b * d) > 1e-6 * Math.max(1, scaleX * Math.abs(scaleY))) return null;
  return { x: r4(x), y: r4(y), rotation: r4((Math.atan2(b, a) * 180) / Math.PI), scaleX: r4(scaleX), scaleY: r4(scaleY) };
}

/**
 * Lote para cambiar el padre de un hueso (otro hueso del mismo skeleton, o el skeleton para dejarlo como raíz) sin
 * que se mueva en el montaje: sus valores se recalculan en el marco nuevo, y los que fijan las poses también (con el
 * mismo cambio de marco del montaje). Sus hijos lo siguen como siempre.
 *
 * En una pose que mueve al padre viejo (o a un ancestro que el padre nuevo no comparte), o al padre nuevo, el hueso
 * sí cambia de lugar: ahora sigue a otro. `reparentarHueso` dice en qué poses pasa y puede compensarlas.
 */
export function opsParaReparentar(doc, esquema, huesoId, padreId) {
  const hueso = buscar(doc, huesoId);
  if (hueso?.type !== 'bone') throw new Error(`"${huesoId}" no es un hueso`);
  const padre = buscar(doc, padreId);
  if (padre?.type !== 'bone' && padre?.type !== 'skeleton') throw new Error(`"${padreId}" no es un hueso ni un skeleton`);
  const esqueleto = esqueletoDe(doc, huesoId);
  const destino = padre.type === 'skeleton' ? padre.id : esqueletoDe(doc, padre.id);
  if (destino !== esqueleto) throw new Error(`"${padreId}" es de otro skeleton (${destino}); un hueso solo cambia de padre dentro de "${esqueleto}"`);
  if (padre.type === 'bone' && dentroDe(doc, padreId, huesoId)) throw new Error(`"${padreId}" cuelga de "${huesoId}": un hueso no puede ser hijo de su descendiente`);
  if (padreId === huesoId) throw new Error('un hueso no puede ser su propio padre');
  if ((hueso.parent ?? null) === padreId) return [];

  const { reposo } = evaluarEsqueleto(doc, esquema);
  const marcoDe = (id) => (buscar(doc, id)?.type === 'bone' ? reposo.get(id) : marcoDeHijos(doc, esquema, id));
  const independiente = leer(esquema, hueso, 'independentAngle');
  const marcoViejo = marcoDe(hueso.parent);
  const marcoNuevo = marcoDe(padreId);
  const indepViejo = independiente && buscar(doc, hueso.parent)?.type === 'bone';
  const indepNuevo = independiente && padre.type === 'bone';
  const montaje = valoresDeHueso(esquema, hueso, null);
  const convertir = (valores) => {
    const nuevos = valoresDeMundo(mundoDeValores(valores, marcoViejo, indepViejo), marcoNuevo, indepNuevo);
    if (!nuevos) throw new Error(`no se puede colgar "${huesoId}" de "${padreId}" sin deformarlo (su marco tiene escala desigual con giro)`);
    return nuevos;
  };
  const nuevos = convertir(montaje);
  const props = { x: nuevos.x, y: nuevos.y, rotation: nuevos.rotation };
  for (const k of ['scaleX', 'scaleY']) if (hueso[k] !== undefined || Math.abs(nuevos[k] - 1) > 1e-4) props[k] = nuevos[k];
  // Los límites de ángulo usan la misma referencia que rotation.
  const giro = nuevos.rotation - montaje.rotation;
  for (const k of ['minAngle', 'maxAngle']) if (hueso[k] != null && giro) props[k] = r4(hueso[k] + giro);
  /** @type {import('./tipos.js').Operacion[]} */
  const ops = [{ op: 'move', target: huesoId, parent: padreId }, { op: 'set', target: huesoId, props }];
  for (const pose of doc.objects.filter((p) => p.type === 'pose' && p.values?.[huesoId])) {
    const fijados = pose.values[huesoId];
    const enPose = convertir({ ...montaje, ...Object.fromEntries(CAMPOS_DE_POSE.filter((k) => fijados[k] !== undefined).map((k) => [k, fijados[k]])) });
    const campos = { ...fijados };
    if (fijados.x !== undefined || fijados.y !== undefined) [campos.x, campos.y] = [enPose.x, enPose.y];
    for (const k of ['rotation', 'scaleX', 'scaleY']) if (fijados[k] !== undefined) campos[k] = enPose[k];
    ops.push({ op: 'set', target: pose.id, props: { values: { ...pose.values, [huesoId]: campos } } });
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
  /** @returns {import('./tipos.js').Punto} */
  const punto = (nombre) => {
    const p = props[nombre];
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${nombre} debe ser [x, y] en coordenadas del documento`);
    return [p[0], p[1]];
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
  /** @type {import('./tipos.js').Punto} */
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

const casiIgual = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

/**
 * Cambia el padre de un hueso como opsParaReparentar y además revisa las poses. Devuelve { ops, movidas }:
 * `movidas` son las poses en las que, después del lote, el hueso (y lo que lo sigue) queda en otro lugar que antes.
 * Con `conservarEnPoses`, el lote también fija en esas poses los valores del hueso que lo dejan donde estaba (como
 * en Moho, que conserva la animación al cambiar el padre); `movidas` queda con las que no se pudieron compensar (por
 * minAngle/maxAngle o por un marco que deforma).
 */
/**
 * Varios cambios de padre seguidos ([[hueso, padre], ...]), cada uno sobre el documento como quedó con el anterior
 * (lo que hace Reparent Bone del editor con varios huesos elegidos). Devuelve { ops, movidas } como reparentarHueso,
 * con las poses de todos los pasos.
 */
export function reparentarVarios(doc, esquema, pasos, opciones = {}) {
  let actual = doc;
  const ops = [];
  const movidas = new Set();
  for (const [hueso, padre] of pasos) {
    const paso = reparentarHueso(actual, esquema, hueso, padre, opciones);
    if (!paso.ops.length) continue;
    actual = aplicarOperaciones(actual, paso.ops, esquema).doc;
    ops.push(...paso.ops);
    paso.movidas.forEach((p) => movidas.add(p));
  }
  return { ops, movidas: [...movidas] };
}

export function reparentarHueso(doc, esquema, huesoId, padreId, { conservarEnPoses = false } = {}) {
  const ops = opsParaReparentar(doc, esquema, huesoId, padreId);
  if (!ops.length) return { ops, movidas: [] };
  const despues = (lote) => aplicarOperaciones(doc, lote, esquema).doc;
  const poses = doc.objects.filter((o) => o.type === 'pose');
  const mundoEn = (d, pose) => evaluarEnPose(d, esquema, pose).posado.get(huesoId);
  const antes = new Map(poses.map((p) => [p.id, mundoEn(doc, p)]));
  const queSeMueven = (d) => poses.filter((p) => !casiIgual(antes.get(p.id), mundoEn(d, buscar(d, p.id)))).map((p) => p.id);

  let final = despues(ops);
  let movidas = queSeMueven(final);
  if (!conservarEnPoses || !movidas.length) return { ops, movidas };

  const independiente = leer(esquema, buscar(final, huesoId), 'independentAngle') && buscar(final, padreId).type === 'bone';
  const compensar = [];
  for (const poseId of movidas) {
    const pose = buscar(final, poseId);
    const posado = evaluarEnPose(final, esquema, pose).posado;
    const hueso = buscar(final, huesoId);
    // Marco del padre nuevo en la pose: el hueso padre o, para un hueso raíz, el del skeleton (mundo · local⁻¹).
    const marco = buscar(final, padreId).type === 'bone' ? posado.get(padreId) : multiplicar(posado.get(huesoId), invertir(matriz(valoresDeHueso(esquema, hueso, pose))));
    const valores = valoresDeMundo(antes.get(poseId), marco, independiente);
    if (!valores) continue;
    const campos = { ...pose.values?.[huesoId], x: valores.x, y: valores.y, rotation: valores.rotation };
    for (const k of ['scaleX', 'scaleY']) if (campos[k] !== undefined || Math.abs(valores[k] - leer(esquema, hueso, k)) > 1e-4) campos[k] = valores[k];
    compensar.push({ op: 'set', target: poseId, props: { values: { ...pose.values, [huesoId]: campos } } });
  }
  if (!compensar.length) return { ops, movidas };
  final = despues([...ops, ...compensar]);
  return { ops: [...ops, ...compensar], movidas: queSeMueven(final) };
}

// ---------- Planes que usan el editor y el MCP ----------

/** Por qué un objeto no puede seguir a un hueso (texto para el usuario), o null si puede. */
export function motivoParaNoEnlazar(doc, id, hueso) {
  const propio = esqueletoDe(doc, id);
  const delHueso = esqueletoDe(doc, hueso);
  if (propio === delHueso) return null;
  return propio ? `${id} is in skeleton ${propio}; it can only follow bones of that skeleton` : `${id} is not in skeleton ${delHueso}: move it inside (Layers) to bind it to its bones`;
}

/**
 * Antes de mover `id` a `padre`: lo que suelta los enlaces que dejarían de valer (dibujo que sale del skeleton de su
 * hueso, o huesos que se van a otro skeleton). Va en el mismo lote, antes del move.
 */
export function opsParaSoltarAlMover(doc, esquema, id, padre) {
  const copia = structuredClone(doc);
  buscar(copia, id).parent = padre;
  return soltarEnlacesAjenos(copia, esquema);
}

/**
 * «Bind all by proximity» del editor y bind_by_proximity del MCP: el dibujo del skeleton que no sigue a ningún hueso
 * va al más cercano. Devuelve el lote y los enlaces ([{ id, bone }]).
 */
export function planEnlazarPorCercania(doc, esquema, esqueletoId) {
  const enlaces = enlacesPorCercania(doc, esquema, esqueletoId);
  return { ops: enlaces.map(({ id, bone }) => ({ op: 'set', target: id, props: { bone } })), enlaces };
}

/**
 * Reparentar varios huesos a la vez (la barra de opciones del editor): `ids` son los elegidos y `principal`, el que
 * será el padre. Devuelve el lote para colgarlos del principal (`ops`), el que además compensa las poses
 * (`opsConservando()`), por qué no se puede (`problema`), y lo mismo para soltarlos a la raíz del skeleton (`sueltos`,
 * `opsSoltar`, `opsSoltarConservando()`). Cada lote trae `movidas`: las poses en que algún hueso queda en otro lugar.
 * @param {import('./tipos.js').Documento} doc @param {any} esquema @param {string[]} ids @param {string | null} principal
 */
export function planReparentarHuesos(doc, esquema, ids, principal) {
  const elegidos = ids.map((id) => buscar(doc, id)).filter((o) => o?.type === 'bone');
  const padre = elegidos.find((h) => h.id === principal) ?? null;
  const hijosElegidos = elegidos.filter((h) => h !== padre);
  // Se arma paso a paso: cada hueso se cuelga sobre el documento como quedó con el anterior. `movidas`: poses en las
  // que algún hueso queda en otro lugar (ahora sigue a otro padre); con `conservar`, esas poses se compensan.
  const encadenar = (pasos, conservar = false) => {
    const { ops, movidas } = reparentarVarios(doc, esquema, pasos, { conservarEnPoses: conservar });
    return Object.assign(ops, { movidas });
  };
  let problema = null;
  if (padre) {
    for (const h of hijosElegidos) {
      if (esqueletoDe(doc, h.id) !== esqueletoDe(doc, padre.id)) problema = `${h.id} is in another skeleton than ${padre.id}`;
      else if (subarbol(doc, h.id).includes(padre.id)) problema = `${padre.id} hangs from ${h.id}: pick a parent outside its chain`;
    }
  }
  /** @type {any} */
  let ops = [];
  let opsConservando = () => [];
  if (padre && hijosElegidos.length && !problema) {
    try {
      ops = encadenar(hijosElegidos.map((h) => [h.id, padre.id]));
      opsConservando = () => encadenar(hijosElegidos.map((h) => [h.id, padre.id]), true);
    } catch {
      problema = `can’t hang them from ${padre.id} without distorting them`;
    }
  }
  const sueltos = elegidos.filter((h) => buscar(doc, h.parent)?.type === 'bone');
  /** @type {any} */
  let opsSoltar = [];
  const pasosSoltar = sueltos.map((h) => [h.id, esqueletoDe(doc, h.id)]);
  const opsSoltarConservando = () => encadenar(pasosSoltar, true);
  try {
    opsSoltar = encadenar(pasosSoltar);
  } catch {
    opsSoltar = [];
  }
  return { padre, hijos: hijosElegidos, ops, opsConservando, problema, sueltos, opsSoltar, opsSoltarConservando };
}
