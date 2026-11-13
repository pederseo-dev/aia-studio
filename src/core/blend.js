// Params, drivers y poses: cómo el valor de un param se convierte en el peso de una pose, y cómo se suman las poses
// sobre el montaje (como las acciones de los smart bones de Moho, pero con la conexión explícita en un driver).
//
// - Números (rotación, posición, opacidad...): se suman las diferencias con el montaje, cada una por su peso.
// - Colores y vértices: se interpolan hacia el valor de cada pose, en orden.
// - Lo que no se puede interpolar (el hijo activo de un switch, booleanos, textos): gana la pose con peso ≥ 0.5.

import { findObject } from './document.js';
import { read } from './schema.js';
import { effectiveValue } from './styles.js';
import { tangents, vertexFromTangents } from './paths.js';

/** Valor de cada param: el pedido o, si no, su valor inicial. Los enum valen un texto; los demás, un número. */
export function paramValues(doc, schema, requested = {}) {
  const valueMap = {};
  for (const p of doc.objects.filter((o) => o.type === 'param')) {
    const tipo = read(schema, p, 'kind');
    if (tipo === 'enum') {
      const options = read(schema, p, 'options');
      const v = requested[p.id] ?? read(schema, p, 'initial') ?? options[0] ?? null;
      valueMap[p.id] = options.includes(v) ? v : (options[0] ?? null);
    } else {
      let v = Number(requested[p.id] ?? read(schema, p, 'default'));
      if (tipo === 'boolean') v = requested[p.id] === true || v >= 0.5 ? 1 : 0;
      else v = Math.min(read(schema, p, 'max'), Math.max(read(schema, p, 'min'), Number.isFinite(v) ? v : 0));
      valueMap[p.id] = v;
    }
  }
  return valueMap;
}

/**
 * Params que eligen la variante de un switch: los que tienen drivers hacia poses que fijan el `active` de ese
 * switch. Es solo información (para la barra de opciones y el árbol de la IA).
 */
export function switchParams(doc, switchId) {
  const ids = doc.objects
    .filter((d) => d.type === 'driver' && d.param && findObject(doc, d.pose)?.values?.[switchId]?.active !== undefined)
    .map((d) => d.param)
    .filter((id) => findObject(doc, id)?.type === 'param');
  return [...new Set(ids)];
}

/** Peso (0 a 1) que un driver le da a su pose con el valor actual de su param. */
export function driverWeight(doc, schema, driver, value) {
  const param = findObject(doc, driver.param);
  const [outMin, outMax] = [read(schema, driver, 'outMin'), read(schema, driver, 'outMax')];
  if (read(schema, param, 'kind') === 'enum') {
    const equals = read(schema, driver, 'equals');
    if (equals != null) return value === equals ? outMax : outMin;
    // Sin equals, un enum se mueve como un número: la posición de la opción.
    value = read(schema, param, 'options').indexOf(value);
  }
  const [inMin, inMax] = [read(schema, driver, 'inMin'), read(schema, driver, 'inMax')];
  const t = inMax === inMin ? (value >= inMin ? 1 : 0) : Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

// ---------- Interpolación por tipo de propiedad ----------

const withoutBone = (vertices) => vertices.map(({ bone, ...v }) => v);

/**
 * Vértices de una pose con el enlace por punto del montaje: el vértice i toma el `bone` del vértice i del montaje (y
 * los que sobran, ninguno). Lo que una pose vieja haya guardado en `bone` se ignora.
 */
export function withSetupBinding(vertices, setup) {
  return vertices.map(({ bone, ...v }, i) => (setup?.[i]?.bone ? { ...v, bone: setup[i].bone } : v));
}

function toRgba(color) {
  let h = color.slice(1);
  if (h.length === 3) h = [...h].map((d) => d + d).join('');
  return [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
}

export function blendColor(a, b, w) {
  if (a == null || b == null) return w >= 0.5 ? b : a;
  const [ca, cb] = [toRgba(a), toRgba(b)];
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * w));
  const hex = c.map((v) => v.toString(16).padStart(2, '0'));
  return `#${hex.slice(0, 3).join('')}${c[3] === 255 ? '' : hex[3]}`;
}

/**
 * Morph entre dos listas de vértices con la misma cantidad: anclas y tangentes se interpolan. El resultado no trae
 * `bone`: el enlace por punto es del montaje (lo pone `aplicarPose`), como en Moho.
 */
export function blendVertices(a, b, w) {
  if (a.length !== b.length) return withoutBone(w >= 0.5 ? b : a);
  const lerp = (p, q) => [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w];
  return a.map((goes, i) => {
    const vb = b[i];
    const [ta, tb] = [tangents(goes), tangents(vb)];
    const [x, y] = lerp([goes.x, goes.y], [vb.x, vb.y]);
    const radius = (goes.radius ?? 0) + ((vb.radius ?? 0) - (goes.radius ?? 0)) * w;
    return vertexFromTangents(x, y, lerp(ta.entrada, tb.entrada), lerp(ta.salida, tb.salida), radius ? { radius: Math.round(radius * 100) / 100 } : {});
  });
}

/**
 * La pose que resulta de mezclar todas las poses según los drivers y los valores de los params. Es un objeto pose
 * (sin id real) que se dibuja igual que una pose con nombre. `base` ({ objeto: { propiedad: valor } }, lo que fija
 * un clip en un tiempo) reemplaza al montaje como punto de partida: las poses se suman encima de lo animado.
 */
export function blendPoses(doc, schema, requested = {}, base = {}) {
  const params = paramValues(doc, schema, requested);
  const accumulated = new Map(); // "objeto\u0000propiedad" → { id, prop, tipo, base, valor }
  for (const driver of doc.objects.filter((o) => o.type === 'driver')) {
    const pose = findObject(doc, driver.pose);
    if (!pose || !(driver.param in params)) continue;
    const w = driverWeight(doc, schema, driver, params[driver.param]);
    if (w <= 0) continue;
    for (const [id, fields] of Object.entries(pose.values ?? {})) {
      const obj = findObject(doc, id);
      const definitions = obj && schema.types.get(obj.type)?.properties;
      if (!definitions) continue;
      for (const [prop, target] of Object.entries(fields)) {
        const p = definitions[prop];
        if (!p) continue;
        // Lo que no se suma (colores, vértices, el hijo de un switch, booleanos) lo decide la pista del clip, si la
        // tiene: un param enum siempre tiene una opción activa y, si no, su driver taparía el keyframe (ver
        // docs/decision-animacion.md §4).
        if (p.type !== 'number' && base[id]?.[prop] !== undefined) continue;
        const key = `${id}\u0000${prop}`;
        // El valor del montaje es el que se ve: el propio, el del estilo o el por defecto. Las diferencias de los
        // números se miden contra él (como siempre) y se suman a lo animado; colores y vértices parten de lo animado.
        const setup = effectiveValue(schema, doc, obj, prop);
        const from = base[id]?.[prop] !== undefined ? base[id][prop] : setup;
        if (!accumulated.has(key)) accumulated.set(key, { id, prop, tipo: p.type, base: setup, from, sum: 0, value: from });
        const a = accumulated.get(key);
        if (p.type === 'number') a.sum += w * (target - a.base);
        else if (p.type === 'color') a.value = blendColor(a.value, target, w);
        else if (p.type === 'vertices') a.value = blendVertices(a.value, target, w);
        else if (w >= 0.5) a.value = target;
      }
    }
  }
  const values = structuredClone(base);
  for (const a of accumulated.values()) {
    (values[a.id] ??= {})[a.prop] = a.tipo === 'number' ? a.from + a.sum : a.value;
  }
  return { id: null, type: 'pose', values, params };
}

/**
 * El documento con los valores de una pose aplicados a los objetos que no son huesos (los huesos se mueven por el
 * esqueleto, con su delta). Sirve para dibujar y para que el editor lea lo que se ve. Los vértices de la pose
 * conservan el enlace por punto del montaje.
 */
export function applyPose(doc, schema, pose) {
  if (!pose?.values || !Object.keys(pose.values).length) return doc;
  return {
    ...doc,
    objects: doc.objects.map((o) => {
      const fields = pose.values[o.id];
      if (!fields || o.type === 'bone') return o;
      const posed = { ...o, ...fields };
      for (const [prop, p] of Object.entries(schema.types.get(o.type)?.properties ?? {})) {
        if (p.type === 'vertices' && Array.isArray(fields[prop])) posed[prop] = withSetupBinding(fields[prop], o[prop]);
      }
      return posed;
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
 * @param {Record<string, Record<string, any>>} [existing] @param {Record<string, Record<string, any>>} [values]
 * @param {boolean} [replace] @param {string[]} [remove]
 */
export function mergePose(existing, values = {}, replace = false, remove = []) {
  const valueMap = replace ? {} : structuredClone(existing ?? {});
  for (const name of remove) {
    const [object, prop, ...extra] = String(name).split('.');
    if (!object || extra.length || prop === '') throw new Error(`remove: "${name}" should be "object.property" (for example "mouth.active") or an object id`);
    if (prop === undefined) delete valueMap[object];
    else if (valueMap[object]) {
      delete valueMap[object][prop === 'd' ? 'vertices' : prop];
      if (!Object.keys(valueMap[object]).length) delete valueMap[object];
    }
  }
  for (const [object, fields] of Object.entries(values)) {
    const previous = fields.d !== undefined ? (({ vertices, ...rest }) => rest)(valueMap[object] ?? {}) : valueMap[object];
    if (!Object.keys(fields).length) {
      delete valueMap[object];
      continue;
    }
    const together = { ...previous, ...fields };
    for (const [k, v] of Object.entries(together)) if (v === undefined) delete together[k];
    if (Object.keys(together).length) valueMap[object] = together;
    else delete valueMap[object];
  }
  return valueMap;
}

/**
 * El lote que escribe `values` en la pose `pose` (ver fusionarPose): la crea si no existe y no pisa un objeto que no
 * es pose.
 * @param {import('./types.js').Document} doc @param {string} pose @param {Record<string, Record<string, any>>} values
 * @param {boolean} [replace] @param {string[]} [remove] @returns {import('./types.js').Operation[]}
 */
export function opsToSetPose(doc, pose, values, replace = false, remove = []) {
  const existing = findObject(doc, pose);
  if (existing && existing.type !== 'pose') throw new Error(`"${pose}" already exists and is a ${existing.type}; pick another id for the pose`);
  const valueMap = mergePose(existing?.values, values, replace, remove);
  return existing ? [{ op: 'set', target: pose, props: { values: valueMap } }] : [{ op: 'create', type: 'pose', id: pose, props: { values: valueMap } }];
}
