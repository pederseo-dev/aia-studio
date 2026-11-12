// Params, drivers y poses: cómo el valor de un param se convierte en el peso de una pose, y cómo se suman las poses
// sobre el montaje (como las acciones de los smart bones de Moho, pero con la conexión explícita en un driver).
//
// - Números (rotación, posición, opacidad...): se suman las diferencias con el montaje, cada una por su peso.
// - Colores y vértices: se interpolan hacia el valor de cada pose, en orden.
// - Lo que no se puede interpolar (el hijo activo de un switch, booleanos, textos): gana la pose con peso ≥ 0.5.

import { buscar } from './documento.js';
import { leer } from './esquema.js';
import { valorEfectivo } from './estilos.js';
import { tangentes, verticeDesdeTangentes } from './trazado.js';

/** Valor de cada param: el pedido o, si no, su valor inicial. Los enum valen un texto; los demás, un número. */
export function valoresDeParams(doc, esquema, pedidos = {}) {
  const valores = {};
  for (const p of doc.objects.filter((o) => o.type === 'param')) {
    const tipo = leer(esquema, p, 'kind');
    if (tipo === 'enum') {
      const opciones = leer(esquema, p, 'options');
      const v = pedidos[p.id] ?? leer(esquema, p, 'initial') ?? opciones[0] ?? null;
      valores[p.id] = opciones.includes(v) ? v : (opciones[0] ?? null);
    } else {
      let v = Number(pedidos[p.id] ?? leer(esquema, p, 'default'));
      if (tipo === 'boolean') v = pedidos[p.id] === true || v >= 0.5 ? 1 : 0;
      else v = Math.min(leer(esquema, p, 'max'), Math.max(leer(esquema, p, 'min'), Number.isFinite(v) ? v : 0));
      valores[p.id] = v;
    }
  }
  return valores;
}

/**
 * Params que eligen la variante de un switch: los que tienen drivers hacia poses que fijan el `active` de ese
 * switch. Es solo información (para la barra de opciones y el árbol de la IA).
 */
export function paramsDeSwitch(doc, switchId) {
  const ids = doc.objects
    .filter((d) => d.type === 'driver' && d.param && buscar(doc, d.pose)?.values?.[switchId]?.active !== undefined)
    .map((d) => d.param)
    .filter((id) => buscar(doc, id)?.type === 'param');
  return [...new Set(ids)];
}

/** Peso (0 a 1) que un driver le da a su pose con el valor actual de su param. */
export function pesoDeDriver(doc, esquema, driver, valor) {
  const param = buscar(doc, driver.param);
  const [outMin, outMax] = [leer(esquema, driver, 'outMin'), leer(esquema, driver, 'outMax')];
  if (leer(esquema, param, 'kind') === 'enum') {
    const equals = leer(esquema, driver, 'equals');
    if (equals != null) return valor === equals ? outMax : outMin;
    // Sin equals, un enum se mueve como un número: la posición de la opción.
    valor = leer(esquema, param, 'options').indexOf(valor);
  }
  const [inMin, inMax] = [leer(esquema, driver, 'inMin'), leer(esquema, driver, 'inMax')];
  const t = inMax === inMin ? (valor >= inMin ? 1 : 0) : Math.max(0, Math.min(1, (valor - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

// ---------- Interpolación por tipo de propiedad ----------

const sinHueso = (vertices) => vertices.map(({ bone, ...v }) => v);

/**
 * Vértices de una pose con el enlace por punto del montaje: el vértice i toma el `bone` del vértice i del montaje (y
 * los que sobran, ninguno). Lo que una pose vieja haya guardado en `bone` se ignora.
 */
export function conEnlaceDelMontaje(vertices, montaje) {
  return vertices.map(({ bone, ...v }, i) => (montaje?.[i]?.bone ? { ...v, bone: montaje[i].bone } : v));
}

function aRgba(color) {
  let h = color.slice(1);
  if (h.length === 3) h = [...h].map((d) => d + d).join('');
  return [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
}

export function mezclarColor(a, b, w) {
  if (a == null || b == null) return w >= 0.5 ? b : a;
  const [ca, cb] = [aRgba(a), aRgba(b)];
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * w));
  const hex = c.map((v) => v.toString(16).padStart(2, '0'));
  return `#${hex.slice(0, 3).join('')}${c[3] === 255 ? '' : hex[3]}`;
}

/**
 * Morph entre dos listas de vértices con la misma cantidad: anclas y tangentes se interpolan. El resultado no trae
 * `bone`: el enlace por punto es del montaje (lo pone `aplicarPose`), como en Moho.
 */
export function mezclarVertices(a, b, w) {
  if (a.length !== b.length) return sinHueso(w >= 0.5 ? b : a);
  const lerp = (p, q) => [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w];
  return a.map((va, i) => {
    const vb = b[i];
    const [ta, tb] = [tangentes(va), tangentes(vb)];
    const [x, y] = lerp([va.x, va.y], [vb.x, vb.y]);
    const radio = (va.radius ?? 0) + ((vb.radius ?? 0) - (va.radius ?? 0)) * w;
    return verticeDesdeTangentes(x, y, lerp(ta.entrada, tb.entrada), lerp(ta.salida, tb.salida), radio ? { radius: Math.round(radio * 100) / 100 } : {});
  });
}

/**
 * La pose que resulta de mezclar todas las poses según los drivers y los valores de los params. Es un objeto pose
 * (sin id real) que se dibuja igual que una pose con nombre. `base` ({ objeto: { propiedad: valor } }, lo que fija
 * un clip en un tiempo) reemplaza al montaje como punto de partida: las poses se suman encima de lo animado.
 */
export function mezclarPoses(doc, esquema, pedidos = {}, base = {}) {
  const params = valoresDeParams(doc, esquema, pedidos);
  const acumulado = new Map(); // "objeto\u0000propiedad" → { id, prop, tipo, base, valor }
  for (const driver of doc.objects.filter((o) => o.type === 'driver')) {
    const pose = buscar(doc, driver.pose);
    if (!pose || !(driver.param in params)) continue;
    const w = pesoDeDriver(doc, esquema, driver, params[driver.param]);
    if (w <= 0) continue;
    for (const [id, campos] of Object.entries(pose.values ?? {})) {
      const obj = buscar(doc, id);
      const definiciones = obj && esquema.tipos.get(obj.type)?.properties;
      if (!definiciones) continue;
      for (const [prop, objetivo] of Object.entries(campos)) {
        const p = definiciones[prop];
        if (!p) continue;
        // Lo que no se suma (colores, vértices, el hijo de un switch, booleanos) lo decide la pista del clip, si la
        // tiene: un param enum siempre tiene una opción activa y, si no, su driver taparía el keyframe (ver
        // docs/decision-animacion.md §4).
        if (p.type !== 'number' && base[id]?.[prop] !== undefined) continue;
        const clave = `${id}\u0000${prop}`;
        // El valor del montaje es el que se ve: el propio, el del estilo o el por defecto. Las diferencias de los
        // números se miden contra él (como siempre) y se suman a lo animado; colores y vértices parten de lo animado.
        const montaje = valorEfectivo(esquema, doc, obj, prop);
        const desde = base[id]?.[prop] !== undefined ? base[id][prop] : montaje;
        if (!acumulado.has(clave)) acumulado.set(clave, { id, prop, tipo: p.type, base: montaje, desde, suma: 0, valor: desde });
        const a = acumulado.get(clave);
        if (p.type === 'number') a.suma += w * (objetivo - a.base);
        else if (p.type === 'color') a.valor = mezclarColor(a.valor, objetivo, w);
        else if (p.type === 'vertices') a.valor = mezclarVertices(a.valor, objetivo, w);
        else if (w >= 0.5) a.valor = objetivo;
      }
    }
  }
  const values = structuredClone(base);
  for (const a of acumulado.values()) {
    (values[a.id] ??= {})[a.prop] = a.tipo === 'number' ? a.desde + a.suma : a.valor;
  }
  return { id: null, type: 'pose', values, params };
}

/**
 * El documento con los valores de una pose aplicados a los objetos que no son huesos (los huesos se mueven por el
 * esqueleto, con su delta). Sirve para dibujar y para que el editor lea lo que se ve. Los vértices de la pose
 * conservan el enlace por punto del montaje.
 */
export function aplicarPose(doc, esquema, pose) {
  if (!pose?.values || !Object.keys(pose.values).length) return doc;
  return {
    ...doc,
    objects: doc.objects.map((o) => {
      const campos = pose.values[o.id];
      if (!campos || o.type === 'bone') return o;
      const posado = { ...o, ...campos };
      for (const [prop, p] of Object.entries(esquema.tipos.get(o.type)?.properties ?? {})) {
        if (p.type === 'vertices' && Array.isArray(campos[prop])) posado[prop] = conEnlaceDelMontaje(campos[prop], o[prop]);
      }
      return posado;
    }),
  };
}

// ---------- Escribir en una pose ----------
// Lo usan los dos lados: el editor (cada cambio a mano dentro de una pose) y el MCP (set_pose).

/**
 * Los valores nuevos de una pose. Por defecto se suman a los que ya tenía (por objeto, propiedad a propiedad); un
 * objeto con {} sale de la pose entero; con `replace`, la pose queda solo con estos. Un "d" nuevo reemplaza los
 * vértices que la pose ya tenía para ese path. Una propiedad en undefined sale de la pose (y el objeto, si queda
 * vacío). `quitar` (["mouth.active", "brow_l"]) saca de la pose una sola propiedad de un objeto, o el objeto entero;
 * se aplica antes que `values`.
 * @param {Record<string, Record<string, any>>} [existentes] @param {Record<string, Record<string, any>>} [values]
 * @param {boolean} [replace] @param {string[]} [quitar]
 */
export function fusionarPose(existentes, values = {}, replace = false, quitar = []) {
  const valores = replace ? {} : structuredClone(existentes ?? {});
  for (const nombre of quitar) {
    const [objeto, prop, ...sobra] = String(nombre).split('.');
    if (!objeto || sobra.length || prop === '') throw new Error(`remove: "${nombre}" should be "object.property" (for example "mouth.active") or an object id`);
    if (prop === undefined) delete valores[objeto];
    else if (valores[objeto]) {
      delete valores[objeto][prop === 'd' ? 'vertices' : prop];
      if (!Object.keys(valores[objeto]).length) delete valores[objeto];
    }
  }
  for (const [objeto, campos] of Object.entries(values)) {
    const previos = campos.d !== undefined ? (({ vertices, ...resto }) => resto)(valores[objeto] ?? {}) : valores[objeto];
    if (!Object.keys(campos).length) {
      delete valores[objeto];
      continue;
    }
    const juntos = { ...previos, ...campos };
    for (const [k, v] of Object.entries(juntos)) if (v === undefined) delete juntos[k];
    if (Object.keys(juntos).length) valores[objeto] = juntos;
    else delete valores[objeto];
  }
  return valores;
}

/**
 * El lote que escribe `values` en la pose `pose` (ver fusionarPose): la crea si no existe y no pisa un objeto que no
 * es pose.
 * @param {import('./tipos.js').Documento} doc @param {string} pose @param {Record<string, Record<string, any>>} values
 * @param {boolean} [replace] @param {string[]} [quitar] @returns {import('./tipos.js').Operacion[]}
 */
export function opsParaFijarPose(doc, pose, values, replace = false, quitar = []) {
  const existente = buscar(doc, pose);
  if (existente && existente.type !== 'pose') throw new Error(`"${pose}" already exists and is a ${existente.type}; pick another id for the pose`);
  const valores = fusionarPose(existente?.values, values, replace, quitar);
  return existente ? [{ op: 'set', target: pose, props: { values: valores } }] : [{ op: 'create', type: 'pose', id: pose, props: { values: valores } }];
}
