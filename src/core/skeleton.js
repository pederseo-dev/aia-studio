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

import { findObject, skeletonOf, children, bonesOf, subtree } from './document.js';
import { read } from './schema.js';
import { IDENTITY, apply, invert, worldMatrix, multiply } from './geometry.js';
import { applyPose } from './blend.js';
// operaciones.js también importa este archivo: el ciclo es seguro porque solo se usan funciones, al llamarlas.
import { applyOperations } from './operations.js';
import { tangents } from './paths.js';

export const POSE_FIELDS = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];

/** translate · rotate · scale a partir de valores sueltos. */
/** @param {Record<string, any>} values x, y, rotation, scaleX, scaleY */
function matrix({ x, y, rotation, scaleX, scaleY }) {
  const r = (rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * scaleX, s * scaleX, -s * scaleY, c * scaleY, x, y];
}

/** Rotación limitada por minAngle / maxAngle del hueso. */
export function limitAngle(schema, bone, rotation) {
  const min = read(schema, bone, 'minAngle');
  const max = read(schema, bone, 'maxAngle');
  if (min != null && rotation < min) return min;
  if (max != null && rotation > max) return max;
  return rotation;
}

/** Valores de un hueso: los del montaje, con lo que fije la pose encima (la rotación, dentro de sus límites). */
export function boneValues(schema, bone, pose) {
  const v = Object.fromEntries(POSE_FIELDS.map((k) => [k, read(schema, bone, k)]));
  const fixed = pose?.values?.[bone.id];
  if (fixed) {
    for (const k of POSE_FIELDS) if (fixed[k] !== undefined) v[k] = fixed[k];
    v.rotation = limitAngle(schema, bone, v.rotation);
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
export function evaluateSkeleton(doc, schema, pose = null) {
  const bones = doc.objects.filter((o) => o.type === 'bone');
  const rest = new Map();
  const posed = pose ? new Map() : rest;
  // Marco de los huesos raíz: el del skeleton (o el documento, para un hueso suelto de un documento sin migrar).
  const rootFrame = (skeleton, withPose, resolve) => {
    if (!skeleton) return IDENTITY;
    const frame = worldMatrix(doc, schema, skeleton.id);
    const external = withPose && boneOf(doc, skeleton.id);
    if (!external || findObject(doc, external)?.type !== 'bone') return frame;
    return multiply(multiply(resolve(findObject(doc, external)), invert(rest.get(external))), frame);
  };
  const compute = (world, withPose) => {
    // Padres antes que hijos, aunque la lista plana no venga en ese orden.
    const resolve = (h) => {
      if (world.has(h.id)) return world.get(h.id);
      const v = boneValues(schema, h, withPose ? pose : null);
      const parent = h.parent && findObject(doc, h.parent);
      let m;
      if (parent?.type !== 'bone') m = multiply(rootFrame(parent, withPose, resolve), matrix(v));
      else if (read(schema, h, 'independentAngle')) {
        // Ángulo independiente: toma solo la posición del padre.
        const [x, y] = apply(resolve(parent), v.x, v.y);
        m = matrix({ ...v, x, y });
      } else m = multiply(resolve(parent), matrix(v));
      world.set(h.id, m);
      return m;
    };
    bones.forEach(resolve);
  };
  compute(rest, false);
  if (pose) compute(posed, true);
  const delta = new Map(bones.map((h) => [h.id, pose ? multiply(posed.get(h.id), invert(rest.get(h.id))) : IDENTITY]));
  return { rest, posed, delta, pose };
}

/**
 * Como evaluarEsqueleto, pero con los valores de la pose aplicados también a lo que no es hueso (el skeleton o sus
 * grupos de arriba que la pose mueva): es lo que se ve. `reposo` queda en el marco posado del skeleton.
 */
export function evaluateInPose(doc, schema, pose = null) {
  return evaluateSkeleton(pose ? applyPose(doc, schema, pose) : doc, schema, pose);
}

/** Hueso que mueve a un objeto: el suyo o, si no tiene, el de su padre más cercano que tenga uno. */
export function boneOf(doc, id) {
  for (let o = findObject(doc, id); o; o = findObject(doc, o.parent)) if (o.bone) return o.bone;
  return null;
}

/** Delta que la pose le aplica a un objeto (identidad si no sigue a ningún hueso). */
export function deltaOf(doc, skeleton, id) {
  const bone = boneOf(doc, id);
  return (bone && skeleton.delta.get(bone)) || IDENTITY;
}

/** Punta de un hueso (en coordenadas del documento) según una matriz de mundo. */
export function tipOf(schema, bone, world) {
  return apply(world, read(schema, bone, 'length'), 0);
}

/** Marco en el que nacen los hijos de `padreId` (un hueso o un skeleton), en el montaje y en coordenadas del documento. */
export function childFrame(doc, schema, parentId) {
  const parent = parentId && findObject(doc, parentId);
  if (!parent) return IDENTITY;
  if (parent.type === 'bone') return evaluateSkeleton(doc, schema).rest.get(parent.id);
  return worldMatrix(doc, schema, parent.id);
}

/** Distancia de un punto al segmento de un hueso (origen → punta), en coordenadas del documento. */
function distanceToBone([px, py], [ax, ay], [bx, by]) {
  const [dx, dy] = [bx - ax, by - ay];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

const segment = (schema, h, world) => ({ id: h.id, a: apply(world.get(h.id), 0, 0), b: tipOf(schema, h, world.get(h.id)) });

/** El segmento (hueso) más cercano a un punto. */
const nearest = (segments, p) =>
  segments.reduce(
    (best, s) => {
      const d = distanceToBone(p, s.a, s.b);
      return d < best.d ? { id: s.id, d } : best;
    },
    { id: null, d: Infinity },
  );

/**
 * Enlace por punto automático: cada vértice del path pasa a seguir al hueso más cercano (en el montaje) de los
 * indicados, o de todos los de su skeleton. Devuelve los vértices nuevos.
 */
export function distributeBetweenBones(doc, schema, pathId, ids = null) {
  const path = findObject(doc, pathId);
  const skeleton = skeletonOf(doc, pathId);
  if (!skeleton) throw new Error(`"${pathId}" no está dentro de un skeleton: el enlace por punto usa los huesos del skeleton que lo contiene`);
  const own = bonesOf(doc, skeleton);
  if (ids) {
    const foreign = ids.filter((id) => !own.some((h) => h.id === id));
    if (foreign.length) throw new Error(`${foreign.join(', ')} no ${foreign.length > 1 ? 'son huesos' : 'es un hueso'} del skeleton "${skeleton}". Sus huesos: ${own.map((h) => h.id).join(', ') || 'ninguno'}`);
  }
  const bones = ids ? own.filter((h) => ids.includes(h.id)) : own;
  if (!bones.length) throw new Error(`el skeleton "${skeleton}" no tiene huesos`);
  const { rest } = evaluateSkeleton(doc, schema);
  const segments = bones.map((h) => segment(schema, h, rest));
  const world = worldMatrix(doc, schema, pathId);
  return read(schema, path, 'vertices').map((v) => ({ ...v, bone: nearest(segments, apply(world, v.x, v.y)).id }));
}

/**
 * Caja (en coordenadas del documento, en el montaje) de un objeto de dibujo y sus hijos: [minX, minY, maxX, maxY], o
 * null si no dibuja nada. Es aproximada para las curvas (usa anclas y tangentes), que alcanza para elegir un hueso.
 */
export function boxOf(doc, schema, id) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (m, x, y) => {
    const [px, py] = apply(m, x, y);
    box[0] = Math.min(box[0], px);
    box[1] = Math.min(box[1], py);
    box[2] = Math.max(box[2], px);
    box[3] = Math.max(box[3], py);
  };
  const walk = (o) => {
    if (o.type === 'bone' || schema.types.get(o.type)?.resource) return;
    const m = worldMatrix(doc, schema, o.id);
    if (o.type === 'rect' || o.type === 'ellipse' || o.type === 'image') {
      const [w, h] = [read(schema, o, 'width'), read(schema, o, 'height')];
      const [x0, y0] = [-w * read(schema, o, 'originX'), -h * read(schema, o, 'originY')];
      for (const [x, y] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]]) add(m, x, y);
    } else if (o.type === 'path') {
      for (const v of read(schema, o, 'vertices')) {
        const { in: entry, out: output } = tangents(v);
        add(m, v.x, v.y);
        add(m, v.x + entry[0], v.y + entry[1]);
        add(m, v.x + output[0], v.y + output[1]);
      }
    }
    children(doc, o.id).forEach(walk);
  };
  walk(findObject(doc, id));
  return box[0] <= box[2] ? box : null;
}

/** ¿`ancestro` contiene a `id` (a cualquier profundidad)? */
function insideOf(doc, id, ancestor) {
  for (let o = findObject(doc, findObject(doc, id)?.parent); o; o = findObject(doc, o.parent)) if (o.id === ancestor) return true;
  return false;
}

/**
 * «Bind all by proximity»: el dibujo del skeleton que todavía no sigue a ningún hueso se enlaza (por capa) al hueso
 * más cercano al centro de su caja. Se enlazan las piezas más grandes que se pueda: un grupo (o switch, o skeleton
 * anidado) sin nada enlazado adentro va entero; si adentro ya hay algo enlazado, se baja a sus hijos para no cambiar
 * lo que ya estaba decidido. No se tocan lo que ya tiene hueso propio ni los paths enlazados por punto.
 * Devuelve [{ id, bone }] en orden de la lista.
 */
export function bindingsByProximity(doc, schema, skeletonId) {
  const skeleton = findObject(doc, skeletonId);
  if (skeleton?.type !== 'skeleton') throw new Error(`"${skeletonId}" no es un skeleton`);
  const bones = bonesOf(doc, skeletonId);
  if (!bones.length) throw new Error(`el skeleton "${skeletonId}" no tiene huesos: créalos antes de enlazar`);
  const { rest } = evaluateSkeleton(doc, schema);
  const segments = bones.map((h) => segment(schema, h, rest));
  const byPoint = (o) => o.vertices?.some((v) => v.bone);
  const boundInside = (id) => doc.objects.some((o) => (o.bone || byPoint(o)) && insideOf(doc, o.id, id));
  const bindings = [];
  const walk = (parentId) => {
    for (const o of children(doc, parentId)) {
      const kind = schema.types.get(o.type);
      if (!kind || !('bone' in kind.properties) || o.bone || byPoint(o)) continue;
      if (kind.container && o.type !== 'skeleton' && boundInside(o.id)) {
        walk(o.id);
        continue;
      }
      const box = boxOf(doc, schema, o.id);
      if (box) bindings.push({ id: o.id, bone: nearest(segments, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]).id });
    }
  };
  walk(skeletonId);
  return bindings;
}

/**
 * Enlaces que dejaron de valer porque el objeto cambió de skeleton (por ejemplo, al sacar un dibujo del skeleton):
 * el lote que los suelta (un unset de bone, o los vértices sin ese bone).
 */
export function releaseForeignBindings(doc, schema) {
  const ops = [];
  for (const o of doc.objects) {
    const props = schema.types.get(o.type)?.properties ?? {};
    const own = skeletonOf(doc, o.id);
    const foreign = (bone) => findObject(doc, bone)?.type === 'bone' && skeletonOf(doc, bone) !== own;
    if ('bone' in props && o.bone && foreign(o.bone)) ops.push({ op: 'unset', target: o.id, props: ['bone'] });
    for (const [prop, p] of Object.entries(props)) {
      if (p.type !== 'vertices' || !o[prop]?.some((v) => v.bone && foreign(v.bone))) continue;
      ops.push({ op: 'set', target: o.id, props: { [prop]: o[prop].map(({ bone, ...v }) => (bone && !foreign(bone) ? { ...v, bone } : v)) } });
    }
  }
  return ops;
}

const r4 = (v) => Math.round(v * 1e4) / 1e4 || 0;

/** Matriz de mundo de un hueso con estos valores, colgado de `marco` (con ángulo independiente, solo la posición). */
function worldFromValues(v, frame, independent) {
  const local = matrix(v);
  if (!independent) return multiply(frame, local);
  const [x, y] = apply(frame, v.x, v.y);
  return [...local.slice(0, 4), x, y];
}

/** Valores (x, y, rotation, scaleX, scaleY) que dejan al hueso con esa matriz de mundo, colgado de `marco`. */
function valuesFromWorld(world, frame, independent) {
  const [x, y] = apply(invert(frame), world[4], world[5]);
  const [a, b, c, d] = independent ? world : multiply(invert([...frame.slice(0, 4), 0, 0]), [...world.slice(0, 4), 0, 0]);
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
export function opsToReparent(doc, schema, boneId, parentId) {
  const bone = findObject(doc, boneId);
  if (bone?.type !== 'bone') throw new Error(`"${boneId}" no es un hueso`);
  const parent = findObject(doc, parentId);
  if (parent?.type !== 'bone' && parent?.type !== 'skeleton') throw new Error(`"${parentId}" no es un hueso ni un skeleton`);
  const skeleton = skeletonOf(doc, boneId);
  const target = parent.type === 'skeleton' ? parent.id : skeletonOf(doc, parent.id);
  if (target !== skeleton) throw new Error(`"${parentId}" es de otro skeleton (${target}); un hueso solo cambia de padre dentro de "${skeleton}"`);
  if (parent.type === 'bone' && insideOf(doc, parentId, boneId)) throw new Error(`"${parentId}" cuelga de "${boneId}": un hueso no puede ser hijo de su descendiente`);
  if (parentId === boneId) throw new Error('un hueso no puede ser su propio padre');
  if ((bone.parent ?? null) === parentId) return [];

  const { rest } = evaluateSkeleton(doc, schema);
  const frameOf = (id) => (findObject(doc, id)?.type === 'bone' ? rest.get(id) : childFrame(doc, schema, id));
  const independent = read(schema, bone, 'independentAngle');
  const oldFrame = frameOf(bone.parent);
  const newFrame = frameOf(parentId);
  const oldIndep = independent && findObject(doc, bone.parent)?.type === 'bone';
  const newIndep = independent && parent.type === 'bone';
  const setup = boneValues(schema, bone, null);
  const convert = (values) => {
    const created = valuesFromWorld(worldFromValues(values, oldFrame, oldIndep), newFrame, newIndep);
    if (!created) throw new Error(`no se puede colgar "${boneId}" de "${parentId}" sin deformarlo (su marco tiene escala desigual con giro)`);
    return created;
  };
  const created = convert(setup);
  const props = { x: created.x, y: created.y, rotation: created.rotation };
  for (const k of ['scaleX', 'scaleY']) if (bone[k] !== undefined || Math.abs(created[k] - 1) > 1e-4) props[k] = created[k];
  // Los límites de ángulo usan la misma referencia que rotation.
  const rotation = created.rotation - setup.rotation;
  for (const k of ['minAngle', 'maxAngle']) if (bone[k] != null && rotation) props[k] = r4(bone[k] + rotation);
  /** @type {import('./types.js').Operation[]} */
  const ops = [{ op: 'move', target: boneId, parent: parentId }, { op: 'set', target: boneId, props }];
  for (const pose of doc.objects.filter((p) => p.type === 'pose' && p.values?.[boneId])) {
    const fixed = pose.values[boneId];
    const inPose = convert({ ...setup, ...Object.fromEntries(POSE_FIELDS.filter((k) => fixed[k] !== undefined).map((k) => [k, fixed[k]])) });
    const fields = { ...fixed };
    if (fixed.x !== undefined || fixed.y !== undefined) [fields.x, fields.y] = [inPose.x, inPose.y];
    for (const k of ['rotation', 'scaleX', 'scaleY']) if (fixed[k] !== undefined) fields[k] = inPose[k];
    ops.push({ op: 'set', target: pose.id, props: { values: { ...pose.values, [boneId]: fields } } });
  }
  return ops;
}

/**
 * Azúcar para crear o mover huesos con coordenadas del documento: `from` (origen) y `to` (punta), como [x, y].
 * Devuelve las props con x, y, rotation y length calculados en el marco del padre (el hueso padre o, para un hueso
 * raíz, el skeleton).
 */
export function expandFromTo(doc, schema, parentId, props, current = {}) {
  if (props?.from === undefined && props?.to === undefined) return props;
  /** @returns {import('./types.js').Point} */
  const point = (name) => {
    const p = props[name];
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${name} debe ser [x, y] en coordenadas del documento`);
    return [p[0], p[1]];
  };
  const { from, to, ...rest } = props;
  const values = { ...current, ...rest };
  const parentObj = parentId && findObject(doc, parentId);
  if (parentObj && parentObj.type !== 'bone' && parentObj.type !== 'skeleton') throw new Error(`"${parentId}" es un ${parentObj.type}: un hueso va dentro de un skeleton o de otro bone`);
  const parent = childFrame(doc, schema, parentId);
  const root = parentObj?.type !== 'bone';
  const r1 = (v) => Math.round(v * 10) / 10 || 0;
  const output = { ...rest };
  // Origen actual en el documento, si solo se da `to`.
  /** @type {import('./types.js').Point} */
  const localOrigin = from !== undefined ? apply(invert(parent), ...point('from')) : [values.x ?? 0, values.y ?? 0];
  if (from !== undefined) [output.x, output.y] = localOrigin.map(r1);
  if (to !== undefined) {
    const origin = apply(parent, ...localOrigin);
    const [tx, ty] = point('to');
    // El ángulo se mide contra el padre, salvo con ángulo independiente (que no cuenta en un hueso raíz).
    const rotation = values.independentAngle && !root ? IDENTITY : parent;
    const linear = invert([...rotation.slice(0, 4), 0, 0]);
    const [dx, dy] = apply(linear, tx - origin[0], ty - origin[1]);
    output.rotation = r1((Math.atan2(dy, dx) * 180) / Math.PI);
    output.length = r1(Math.hypot(dx, dy) / (values.scaleX ?? 1));
  }
  return output;
}

const almostEqual = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

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
export function reparentSeveral(doc, schema, steps, options = {}) {
  let current = doc;
  const ops = [];
  const moved = new Set();
  for (const [bone, parent] of steps) {
    const step = reparentBone(current, schema, bone, parent, options);
    if (!step.ops.length) continue;
    current = applyOperations(current, step.ops, schema).doc;
    ops.push(...step.ops);
    step.moved.forEach((p) => moved.add(p));
  }
  return { ops, moved: [...moved] };
}

export function reparentBone(doc, schema, boneId, parentId, { keepInPoses = false } = {}) {
  const ops = opsToReparent(doc, schema, boneId, parentId);
  if (!ops.length) return { ops, moved: [] };
  const after = (lote) => applyOperations(doc, lote, schema).doc;
  const poses = doc.objects.filter((o) => o.type === 'pose');
  const worldIn = (d, pose) => evaluateInPose(d, schema, pose).posed.get(boneId);
  const before = new Map(poses.map((p) => [p.id, worldIn(doc, p)]));
  const movingIn = (d) => poses.filter((p) => !almostEqual(before.get(p.id), worldIn(d, findObject(d, p.id)))).map((p) => p.id);

  let final = after(ops);
  let moved = movingIn(final);
  if (!keepInPoses || !moved.length) return { ops, moved };

  const independent = read(schema, findObject(final, boneId), 'independentAngle') && findObject(final, parentId).type === 'bone';
  const compensate = [];
  for (const poseId of moved) {
    const pose = findObject(final, poseId);
    const posed = evaluateInPose(final, schema, pose).posed;
    const bone = findObject(final, boneId);
    // Marco del padre nuevo en la pose: el hueso padre o, para un hueso raíz, el del skeleton (mundo · local⁻¹).
    const frame = findObject(final, parentId).type === 'bone' ? posed.get(parentId) : multiply(posed.get(boneId), invert(matrix(boneValues(schema, bone, pose))));
    const values = valuesFromWorld(before.get(poseId), frame, independent);
    if (!values) continue;
    const fields = { ...pose.values?.[boneId], x: values.x, y: values.y, rotation: values.rotation };
    for (const k of ['scaleX', 'scaleY']) if (fields[k] !== undefined || Math.abs(values[k] - read(schema, bone, k)) > 1e-4) fields[k] = values[k];
    compensate.push({ op: 'set', target: poseId, props: { values: { ...pose.values, [boneId]: fields } } });
  }
  if (!compensate.length) return { ops, moved };
  final = after([...ops, ...compensate]);
  return { ops: [...ops, ...compensate], moved: movingIn(final) };
}

// ---------- Planes que usan el editor y el MCP ----------

/** Por qué un objeto no puede seguir a un hueso (texto para el usuario), o null si puede. */
export function reasonNotToBind(doc, id, bone) {
  const own = skeletonOf(doc, id);
  const fromBone = skeletonOf(doc, bone);
  if (own === fromBone) return null;
  return own ? `${id} is in skeleton ${own}; it can only follow bones of that skeleton` : `${id} is not in skeleton ${fromBone}: move it inside (Layers) to bind it to its bones`;
}

/**
 * Antes de mover `id` a `padre`: lo que suelta los enlaces que dejarían de valer (dibujo que sale del skeleton de su
 * hueso, o huesos que se van a otro skeleton). Va en el mismo lote, antes del move.
 */
export function opsToReleaseOnMove(doc, schema, id, parent) {
  const copy = structuredClone(doc);
  findObject(copy, id).parent = parent;
  return releaseForeignBindings(copy, schema);
}

/**
 * «Bind all by proximity» del editor y bind_by_proximity del MCP: el dibujo del skeleton que no sigue a ningún hueso
 * va al más cercano. Devuelve el lote y los enlaces ([{ id, bone }]).
 */
export function planProximityBinding(doc, schema, skeletonId) {
  const bindings = bindingsByProximity(doc, schema, skeletonId);
  return { ops: bindings.map(({ id, bone }) => ({ op: 'set', target: id, props: { bone } })), bindings };
}

/**
 * Reparentar varios huesos a la vez (la barra de opciones del editor): `ids` son los elegidos y `principal`, el que
 * será el padre. Devuelve el lote para colgarlos del principal (`ops`), el que además compensa las poses
 * (`opsConservando()`), por qué no se puede (`problema`), y lo mismo para soltarlos a la raíz del skeleton (`sueltos`,
 * `opsSoltar`, `opsSoltarConservando()`). Cada lote trae `movidas`: las poses en que algún hueso queda en otro lugar.
 * @param {import('./types.js').Document} doc @param {any} schema @param {string[]} ids @param {string | null} main
 */
export function planReparentBones(doc, schema, ids, main) {
  const chosen = ids.map((id) => findObject(doc, id)).filter((o) => o?.type === 'bone');
  const parent = chosen.find((h) => h.id === main) ?? null;
  const chosenChildren = chosen.filter((h) => h !== parent);
  // Se arma paso a paso: cada hueso se cuelga sobre el documento como quedó con el anterior. `movidas`: poses en las
  // que algún hueso queda en otro lugar (ahora sigue a otro padre); con `conservar`, esas poses se compensan.
  const chain = (steps, keep = false) => {
    const { ops, moved } = reparentSeveral(doc, schema, steps, { keepInPoses: keep });
    return Object.assign(ops, { moved });
  };
  let problem = null;
  if (parent) {
    for (const h of chosenChildren) {
      if (skeletonOf(doc, h.id) !== skeletonOf(doc, parent.id)) problem = `${h.id} is in another skeleton than ${parent.id}`;
      else if (subtree(doc, h.id).includes(parent.id)) problem = `${parent.id} hangs from ${h.id}: pick a parent outside its chain`;
    }
  }
  /** @type {any} */
  let ops = [];
  let keepingOps = () => [];
  if (parent && chosenChildren.length && !problem) {
    try {
      ops = chain(chosenChildren.map((h) => [h.id, parent.id]));
      keepingOps = () => chain(chosenChildren.map((h) => [h.id, parent.id]), true);
    } catch {
      problem = `can’t hang them from ${parent.id} without distorting them`;
    }
  }
  const loose = chosen.filter((h) => findObject(doc, h.parent)?.type === 'bone');
  /** @type {any} */
  let releaseOps = [];
  const releaseSteps = loose.map((h) => [h.id, skeletonOf(doc, h.id)]);
  const releaseKeepingOps = () => chain(releaseSteps, true);
  try {
    releaseOps = chain(releaseSteps);
  } catch {
    releaseOps = [];
  }
  return { parent, children: chosenChildren, ops, keepingOps, problem, loose, releaseOps, releaseKeepingOps };
}
