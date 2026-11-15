// Params, drivers and poses: how a param's value becomes the weight of a pose, and how poses are added on top of
// the setup (like the actions of Moho's smart bones, but with the connection made explicit in a driver).
//
// - Numbers (rotation, position, opacity...): the differences from the setup are added, each one by its weight.
// - Colors and vertices: they are interpolated toward the value of each pose, in order.
// - Mesh points and curves (vector layers): the same, point by point and curve by curve; what a pose does not list
//   stays as it was.
// - What cannot be interpolated (the active child of a switch, booleans, texts): the pose with weight ≥ 0.5 wins.

import { findObject } from './document.js';
import { read } from './schema.js';
import { effectiveValue } from './styles.js';
import { blendVertices } from './paths.js';

// The vertex morph lives with the vertices (paths.js); it is re-exported here, where the other blends are.
export { blendVertices };
import { blendCurves, isMeshType, overSetup } from './mesh.js';

/** Value of each param: the requested one or, if not, its initial value. Enums hold a text; the rest, a number. */
export function paramValues(doc, schema, requested = {}) {
  const valueMap = {};
  for (const p of doc.objects.filter((o) => o.type === 'param')) {
    const kind = read(schema, p, 'kind');
    if (kind === 'enum') {
      const options = read(schema, p, 'options');
      const v = requested[p.id] ?? read(schema, p, 'initial') ?? options[0] ?? null;
      valueMap[p.id] = options.includes(v) ? v : (options[0] ?? null);
    } else {
      let v = Number(requested[p.id] ?? read(schema, p, 'default'));
      if (kind === 'boolean') v = requested[p.id] === true || v >= 0.5 ? 1 : 0;
      else v = Math.min(read(schema, p, 'max'), Math.max(read(schema, p, 'min'), Number.isFinite(v) ? v : 0));
      valueMap[p.id] = v;
    }
  }
  return valueMap;
}

/**
 * Params that choose the variant of a switch: those with drivers to poses that set the `active` of that switch.
 * It is information only (for the options bar and the AI tree).
 */
export function switchParams(doc, switchId) {
  const ids = doc.objects
    .filter((d) => d.type === 'driver' && d.param && findObject(doc, d.pose)?.values?.[switchId]?.active !== undefined)
    .map((d) => d.param)
    .filter((id) => findObject(doc, id)?.type === 'param');
  return [...new Set(ids)];
}

/** Weight (0 to 1) that a driver gives its pose with the current value of its param. */
export function driverWeight(doc, schema, driver, value) {
  const param = findObject(doc, driver.param);
  const [outMin, outMax] = [read(schema, driver, 'outMin'), read(schema, driver, 'outMax')];
  if (read(schema, param, 'kind') === 'enum') {
    const equals = read(schema, driver, 'equals');
    if (equals != null) return value === equals ? outMax : outMin;
    // Without equals, an enum moves like a number: the position of the option.
    value = read(schema, param, 'options').indexOf(value);
  }
  const [inMin, inMax] = [read(schema, driver, 'inMin'), read(schema, driver, 'inMax')];
  const t = inMax === inMin ? (value >= inMin ? 1 : 0) : Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

// ---------- Interpolation by property kind ----------

/**
 * Vertices of a pose with the setup's per-point binding: vertex i takes the `bone` of vertex i of the setup (and
 * the extra ones, none). Whatever an old pose saved in `bone` is ignored.
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
 * Mesh points add up like numbers: each pose moves each of its points by w × (its place − the setup's), so two poses
 * that move the same point combine (eyes closing while the pupils look aside) instead of pulling it in turns.
 */
function addPointDeltas(a, target, w) {
  if (!target || typeof target !== 'object') return;
  a.deltas ??= {};
  for (const [id, q] of Object.entries(target)) {
    const s = a.base?.[id];
    if (!s || typeof q?.x !== 'number' || typeof q?.y !== 'number') continue;
    const d = (a.deltas[id] ??= [0, 0]);
    d[0] += w * (q.x - s.x);
    d[1] += w * (q.y - s.y);
  }
}

/** The points of a blend: where they start (the clip's or the setup's) plus the sum of the poses' moves. */
function pointsWithDeltas(a) {
  const result = { ...(a.from ?? {}) };
  const r = (v) => Math.round(v * 100) / 100;
  for (const [id, [dx, dy]] of Object.entries(a.deltas ?? {})) {
    const start = a.from?.[id] ?? a.base?.[id];
    if (start) result[id] = { ...start, x: r(start.x + dx), y: r(start.y + dy) };
  }
  return result;
}

/**
 * The pose that results from blending all poses according to the drivers and the param values. It is a pose object
 * (with no real id) that is drawn just like a named pose. `base` ({ object: { property: value } }, what a clip sets
 * at a time) replaces the setup as the starting point: the poses are added on top of what is animated.
 */
export function blendPoses(doc, schema, requested = {}, base = {}) {
  const params = paramValues(doc, schema, requested);
  const accumulated = new Map(); // "object\u0000property" → { id, prop, kind, base, value }
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
        // What is not added (colors, vertices, the child of a switch, booleans) is decided by the clip track, if it
        // has one: an enum param always has an active option and, otherwise, its driver would hide the keyframe (see
        // docs/decision-animacion.md §4).
        if (p.type !== 'number' && base[id]?.[prop] !== undefined) continue;
        const key = `${id}\u0000${prop}`;
        // The setup value is the one seen: its own, the style's or the default. The differences of numbers are
        // measured against it (as always) and added to what is animated; colors and vertices start from the
        // animated value.
        const setup = effectiveValue(schema, doc, obj, prop);
        const from = base[id]?.[prop] !== undefined ? base[id][prop] : setup;
        if (!accumulated.has(key)) accumulated.set(key, { id, prop, kind: p.type, base: setup, from, sum: 0, value: from });
        const a = accumulated.get(key);
        if (p.type === 'number') a.sum += w * (target - a.base);
        else if (p.type === 'color') a.value = blendColor(a.value, target, w);
        else if (p.type === 'vertices') a.value = blendVertices(a.value, target, w);
        else if (p.type === 'points') addPointDeltas(a, target, w);
        else if (p.type === 'curves') a.value = blendCurves(a.value, target, w);
        else if (w >= 0.5) a.value = target;
      }
    }
  }
  const values = structuredClone(base);
  for (const a of accumulated.values()) {
    (values[a.id] ??= {})[a.prop] = a.kind === 'number' ? a.from + a.sum : a.kind === 'points' ? pointsWithDeltas(a) : a.value;
  }
  return { id: null, type: 'pose', values, params };
}

/**
 * The document with the values of a pose applied to the objects that are not bones (bones are moved by the
 * skeleton, with their delta). It is used for drawing and so the editor reads what is seen. The pose's vertices
 * and mesh points keep the setup's per-point binding.
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
        // A pose lists only the points and curves it moves: the rest of the mesh is the setup's.
        if (isMeshType(p.type) && fields[prop] !== undefined) posed[prop] = overSetup(p.type, read(schema, o, prop), fields[prop]);
      }
      return posed;
    }),
  };
}

// ---------- Writing to a pose ----------
// Both sides use it: the editor (each manual change inside a pose) and the MCP (set_pose).

/**
 * The new values of a pose. By default they are added to the ones it already had (per object, property by
 * property); an object with {} leaves the pose entirely; with `replace`, the pose keeps only these. A new "d"
 * replaces the vertices the pose already had for that path. A property set to undefined leaves the pose (and the
 * object, if it ends up empty). `remove` (["mouth.active", "brow_l"]) takes a single property of an object, or the
 * whole object, out of the pose; it is applied before `values`.
 * @param {Record<string, Record<string, any>>} [existing] @param {Record<string, Record<string, any>>} [values]
 * @param {boolean} [replace] @param {string[]} [remove]
 */
/** Properties whose value is a map by id (a vector layer's points and curves): a pose merges them id by id. */
const MESH_MAPS = ['points', 'curves'];

export function mergePose(existing, values = {}, replace = false, remove = []) {
  const valueMap = replace ? {} : structuredClone(existing ?? {});
  for (const name of remove) {
    const [object, prop, key, ...extra] = String(name).split('.');
    const meshKey = MESH_MAPS.includes(prop);
    if (!object || extra.length || prop === '' || (key !== undefined && (!meshKey || !key))) throw new Error(`remove: "${name}" should be "object.property" (for example "mouth.active"), an object id, or one point or curve of a vector layer ("face.points.p3")`);
    if (prop === undefined) delete valueMap[object];
    else if (valueMap[object]) {
      if (key !== undefined && valueMap[object][prop]) {
        delete valueMap[object][prop][key];
        if (!Object.keys(valueMap[object][prop]).length) delete valueMap[object][prop];
      } else if (key === undefined) delete valueMap[object][prop === 'd' ? 'vertices' : prop];
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
    // The points and curves of a vector layer are added one by one (by id) to those the pose already had.
    for (const k of MESH_MAPS) if (fields[k] && previous?.[k] && typeof fields[k] === 'object') together[k] = { ...previous[k], ...fields[k] };
    for (const [k, v] of Object.entries(together)) if (v === undefined) delete together[k];
    if (Object.keys(together).length) valueMap[object] = together;
    else delete valueMap[object];
  }
  return valueMap;
}

/**
 * The batch that writes `values` into the pose `pose` (see mergePose): it creates it if it does not exist and does
 * not overwrite an object that is not a pose.
 * @param {import('./types.js').Document} doc @param {string} pose @param {Record<string, Record<string, any>>} values
 * @param {boolean} [replace] @param {string[]} [remove] @returns {import('./types.js').Operation[]}
 */
export function opsToSetPose(doc, pose, values, replace = false, remove = []) {
  const existing = findObject(doc, pose);
  if (existing && existing.type !== 'pose') throw new Error(`"${pose}" already exists and is a ${existing.type}; pick another id for the pose`);
  const valueMap = mergePose(existing?.values, values, replace, remove);
  return existing ? [{ op: 'set', target: pose, props: { values: valueMap } }] : [{ op: 'create', type: 'pose', id: pose, props: { values: valueMap } }];
}
