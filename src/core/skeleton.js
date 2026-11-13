// Skeleton: where each bone is in the setup and in a pose, and how much the pose moves what is bound to it.
//
// As in Moho, bones live in a `skeleton` (the bone layer), which also contains the drawing they move. Root bones
// are born in the skeleton's frame: if the skeleton moves, rotates or scales, the whole skeleton goes with it.
// The drawing is only bound to bones of its skeleton.
//
// The setup (the values saved in each `bone`) is the rest pose, like Moho's frame 0. A `pose` replaces some values
// of some bones. An object with `bone` follows the bone according to its "delta": the matrix that takes the bone
// from its place in the setup to its place in the pose. In the setup the delta is the identity, so binding moves
// nothing; only when posing does the drawing follow.

import { findObject, skeletonOf, children, bonesOf, subtree } from './document.js';
import { read } from './schema.js';
import { IDENTITY, apply, invert, worldMatrix, multiply } from './geometry.js';
import { applyPose } from './blend.js';
// operations.js also imports this file: the cycle is safe because only functions are used, when called.
import { applyOperations } from './operations.js';
import { tangents } from './paths.js';

export const POSE_FIELDS = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];

/** translate · rotate · scale from separate values. */
/** @param {Record<string, any>} values x, y, rotation, scaleX, scaleY */
function matrix({ x, y, rotation, scaleX, scaleY }) {
  const r = (rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * scaleX, s * scaleX, -s * scaleY, c * scaleY, x, y];
}

/** Rotation limited by the bone's minAngle / maxAngle. */
export function limitAngle(schema, bone, rotation) {
  const min = read(schema, bone, 'minAngle');
  const max = read(schema, bone, 'maxAngle');
  if (min != null && rotation < min) return min;
  if (max != null && rotation > max) return max;
  return rotation;
}

/** Values of a bone: the setup ones, with what the pose sets on top (the rotation, within its limits). */
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
 * Evaluates all the skeletons of the document. `pose` is a pose object (or null = the setup). Returns, by bone id,
 * its world matrix (in document coordinates) in the setup (`rest`), in the pose (`posed`) and the `delta` between
 * the two.
 *
 * The frame of a root bone is that of its skeleton. If the skeleton is bound to a bone of another skeleton that
 * contains it, in the pose that frame also moves with the delta of that bone.
 */
export function evaluateSkeleton(doc, schema, pose = null) {
  const bones = doc.objects.filter((o) => o.type === 'bone');
  const rest = new Map();
  const posed = pose ? new Map() : rest;
  // Frame of the root bones: the skeleton's (or the document, for a loose bone of an unmigrated document).
  const rootFrame = (skeleton, withPose, resolve) => {
    if (!skeleton) return IDENTITY;
    const frame = worldMatrix(doc, schema, skeleton.id);
    const external = withPose && boneOf(doc, skeleton.id);
    if (!external || findObject(doc, external)?.type !== 'bone') return frame;
    return multiply(multiply(resolve(findObject(doc, external)), invert(rest.get(external))), frame);
  };
  const compute = (world, withPose) => {
    // Parents before children, even if the flat list does not come in that order.
    const resolve = (h) => {
      if (world.has(h.id)) return world.get(h.id);
      const v = boneValues(schema, h, withPose ? pose : null);
      const parent = h.parent && findObject(doc, h.parent);
      let m;
      if (parent?.type !== 'bone') m = multiply(rootFrame(parent, withPose, resolve), matrix(v));
      else if (read(schema, h, 'independentAngle')) {
        // Independent angle: it takes only the parent's position.
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
 * Like evaluateSkeleton, but with the pose values also applied to what is not a bone (the skeleton or its groups
 * above that the pose moves): it is what is seen. `rest` stays in the skeleton's posed frame.
 */
export function evaluateInPose(doc, schema, pose = null) {
  return evaluateSkeleton(pose ? applyPose(doc, schema, pose) : doc, schema, pose);
}

/** Bone that moves an object: its own or, if it has none, that of its nearest parent that has one. */
export function boneOf(doc, id) {
  for (let o = findObject(doc, id); o; o = findObject(doc, o.parent)) if (o.bone) return o.bone;
  return null;
}

/** Delta the pose applies to an object (identity if it does not follow any bone). */
export function deltaOf(doc, skeleton, id) {
  const bone = boneOf(doc, id);
  return (bone && skeleton.delta.get(bone)) || IDENTITY;
}

/** Tip of a bone (in document coordinates) according to a world matrix. */
export function tipOf(schema, bone, world) {
  return apply(world, read(schema, bone, 'length'), 0);
}

/** Frame where the children of `parentId` (a bone or a skeleton) are born, in the setup and in document coordinates. */
export function childFrame(doc, schema, parentId) {
  const parent = parentId && findObject(doc, parentId);
  if (!parent) return IDENTITY;
  if (parent.type === 'bone') return evaluateSkeleton(doc, schema).rest.get(parent.id);
  return worldMatrix(doc, schema, parent.id);
}

/** Distance from a point to the segment of a bone (origin → tip), in document coordinates. */
function distanceToBone([px, py], [ax, ay], [bx, by]) {
  const [dx, dy] = [bx - ax, by - ay];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

const segment = (schema, h, world) => ({ id: h.id, a: apply(world.get(h.id), 0, 0), b: tipOf(schema, h, world.get(h.id)) });

/** The segment (bone) nearest to a point. */
const nearest = (segments, p) =>
  segments.reduce(
    (best, s) => {
      const d = distanceToBone(p, s.a, s.b);
      return d < best.d ? { id: s.id, d } : best;
    },
    { id: null, d: Infinity },
  );

/**
 * Automatic per-point binding: each vertex of the path follows the nearest bone (in the setup) among the given ones,
 * or among all those of its skeleton. Returns the new vertices.
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
 * Box (in document coordinates, in the setup) of a drawing object and its children: [minX, minY, maxX, maxY], or
 * null if it draws nothing. It is approximate for curves (it uses anchors and tangents), which is enough to choose a
 * bone.
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

/** Does `ancestor` contain `id` (at any depth)? */
function insideOf(doc, id, ancestor) {
  for (let o = findObject(doc, findObject(doc, id)?.parent); o; o = findObject(doc, o.parent)) if (o.id === ancestor) return true;
  return false;
}

/**
 * «Bind all by proximity»: the skeleton's drawing that does not follow any bone yet is bound (per layer) to the bone
 * nearest to the center of its box. The largest possible pieces are bound: a group (or switch, or nested skeleton)
 * with nothing bound inside goes whole; if there is already something bound inside, it goes down to its children so
 * as not to change what was already decided. What already has its own bone and paths bound per point are not
 * touched. Returns [{ id, bone }] in list order.
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
 * Bindings that stopped being valid because the object changed skeleton (for example, when taking a drawing out of
 * the skeleton): the batch that releases them (an unset of bone, or the vertices without that bone).
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

/** World matrix of a bone with these values, hanging from `frame` (with independent angle, only the position). */
function worldFromValues(v, frame, independent) {
  const local = matrix(v);
  if (!independent) return multiply(frame, local);
  const [x, y] = apply(frame, v.x, v.y);
  return [...local.slice(0, 4), x, y];
}

/** Values (x, y, rotation, scaleX, scaleY) that leave the bone with that world matrix, hanging from `frame`. */
function valuesFromWorld(world, frame, independent) {
  const [x, y] = apply(invert(frame), world[4], world[5]);
  const [a, b, c, d] = independent ? world : multiply(invert([...frame.slice(0, 4), 0, 0]), [...world.slice(0, 4), 0, 0]);
  const scaleX = Math.hypot(a, b);
  const scaleY = (a * d - b * c) / (scaleX || 1);
  // With a distorting frame (unequal scale and rotation), the bone cannot be expressed without twisting it.
  if (Math.abs(a * c + b * d) > 1e-6 * Math.max(1, scaleX * Math.abs(scaleY))) return null;
  return { x: r4(x), y: r4(y), rotation: r4((Math.atan2(b, a) * 180) / Math.PI), scaleX: r4(scaleX), scaleY: r4(scaleY) };
}

/**
 * Batch to change the parent of a bone (another bone of the same skeleton, or the skeleton to make it a root) without
 * it moving in the setup: its values are recomputed in the new frame, and those set by the poses too (with the same
 * frame change as the setup). Its children follow it as always.
 *
 * In a pose that moves the old parent (or an ancestor the new parent does not share), or the new parent, the bone
 * does change place: it now follows another one. `reparentBone` says in which poses that happens and can compensate
 * them.
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
  // The angle limits use the same reference as rotation.
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
 * Sugar for creating or moving bones with document coordinates: `from` (origin) and `to` (tip), as [x, y].
 * Returns the props with x, y, rotation and length computed in the parent's frame (the parent bone or, for a root
 * bone, the skeleton).
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
  // Current origin in the document, if only `to` is given.
  /** @type {import('./types.js').Point} */
  const localOrigin = from !== undefined ? apply(invert(parent), ...point('from')) : [values.x ?? 0, values.y ?? 0];
  if (from !== undefined) [output.x, output.y] = localOrigin.map(r1);
  if (to !== undefined) {
    const origin = apply(parent, ...localOrigin);
    const [tx, ty] = point('to');
    // The angle is measured against the parent, except with independent angle (which does not count in a root bone).
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
 * Changes the parent of a bone like opsToReparent and also checks the poses. Returns { ops, moved }:
 * `moved` are the poses in which, after the batch, the bone (and what follows it) ends up in a different place
 * than before. With `keepInPoses`, the batch also sets in those poses the bone values that leave it where it was
 * (like in Moho, which keeps the animation when changing the parent); `moved` keeps those that could not be
 * compensated (because of minAngle/maxAngle or a distorting frame).
 */
/**
 * Several parent changes in a row ([[bone, parent], ...]), each on the document as the previous one left it
 * (what the editor's Reparent Bone does with several bones selected). Returns { ops, moved } like reparentBone,
 * with the poses of all the steps.
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
    // Frame of the new parent in the pose: the parent bone or, for a root bone, the skeleton's (world · local⁻¹).
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

// ---------- Plans used by the editor and the MCP ----------

/** Why an object cannot follow a bone (text for the user), or null if it can. */
export function reasonNotToBind(doc, id, bone) {
  const own = skeletonOf(doc, id);
  const fromBone = skeletonOf(doc, bone);
  if (own === fromBone) return null;
  return own ? `${id} is in skeleton ${own}; it can only follow bones of that skeleton` : `${id} is not in skeleton ${fromBone}: move it inside (Layers) to bind it to its bones`;
}

/**
 * Before moving `id` to `parent`: what releases the bindings that would stop being valid (drawing leaving the
 * skeleton of its bone, or bones going to another skeleton). It goes in the same batch, before the move.
 */
export function opsToReleaseOnMove(doc, schema, id, parent) {
  const copy = structuredClone(doc);
  findObject(copy, id).parent = parent;
  return releaseForeignBindings(copy, schema);
}

/**
 * The editor's «Bind all by proximity» and the MCP's bind_by_proximity: the skeleton's drawing that does not follow
 * any bone goes to the nearest one. Returns the batch and the bindings ([{ id, bone }]).
 */
export function planProximityBinding(doc, schema, skeletonId) {
  const bindings = bindingsByProximity(doc, schema, skeletonId);
  return { ops: bindings.map(({ id, bone }) => ({ op: 'set', target: id, props: { bone } })), bindings };
}

/**
 * Reparent several bones at once (the editor's options bar): `ids` are the selected ones and `main`, the one that
 * will be the parent. Returns the batch to hang them from the main one (`ops`), the one that also compensates the
 * poses (`keepingOps()`), why it cannot be done (`problem`), and the same to release them to the skeleton root
 * (`loose`, `releaseOps`, `releaseKeepingOps()`). Each batch carries `moved`: the poses in which some bone ends up
 * in a different place.
 * @param {import('./types.js').Document} doc @param {any} schema @param {string[]} ids @param {string | null} main
 */
export function planReparentBones(doc, schema, ids, main) {
  const chosen = ids.map((id) => findObject(doc, id)).filter((o) => o?.type === 'bone');
  const parent = chosen.find((h) => h.id === main) ?? null;
  const chosenChildren = chosen.filter((h) => h !== parent);
  // It is built step by step: each bone is hung on the document as the previous one left it. `moved`: poses in which
  // some bone ends up in a different place (it now follows another parent); with `keep`, those poses are compensated.
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
