// Operations engine: the only way to modify a document, the same for the AI and for the editor.
//
//   { op: 'create', type: 'rect', id: 'eye_l', parent: 'head', index?: 0, props?: { width: 20 } }
//   { op: 'set',    target: 'eye_l' | 'meta', props: { x: 10, fill: '#ffffff' } }
//   { op: 'unset',  target: 'eye_l' | 'meta', props: ['x'] }            ← back to the default value
//   { op: 'delete', target: 'head' }                                     ← also deletes the children and releases
//                                                                          the references to what was deleted
//                                                                          (keepCurves: a shape leaves its curves)
//   { op: 'move',   target: 'eye_l', parent?: 'face' | null, index?: 0, keepPosition?: true }
//                                                     ← reparent and/or reorder; keepPosition leaves the x/y that
//                                                       keeps its place on screen
//   { op: 'rename', target: 'eye_l', id: 'left_eye' }                    ← updates the references (and the poses)
//   { op: 'duplicate', target: 'arm_l', id?: 'arm_r', suffix?: 'copy', parent?, index?, props? }
//                                                     ← copy with its children; the children get the suffix. A shape
//                                                       gets its own curves and points, also into another vector layer
//
// `index` is the position among the siblings in drawing order: 0 = at the back; no index = at the front.

import { expandFromTo } from './skeleton.js';
import { read, suggest } from './schema.js';
import { apply, invert, localMatrix, multiply, worldMatrix } from './geometry.js';
import { parseD } from './paths.js';
import { addD, dropUnused, entryOf, freeKey, loopEntryOf, mapBones, regionKey, shapeCurveIds, shiftPoints, transformMesh, withoutBones } from './mesh.js';
import { transformPointsOf } from './meshTransform.js';
import { regionAt } from './regions.js';
import { ValidationError, findObject, idError, children, subtree, validate } from './document.js';

const STRUCTURE = new Set(['id', 'type', 'parent']);

/**
 * Applies a batch atomically: if an operation fails or the result is not valid, nothing changes and it throws.
 * Returns the new document, the inverse operations (for undo) and the new warnings.
 */
export function applyOperations(doc, ops, schema) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('A non-empty list of operations is needed');
  const next = structuredClone(doc);
  const inverses = [];
  ops.forEach((op, i) => {
    try {
      inverses.unshift(...applyOne(next, op, schema));
    } catch (e) {
      throw new Error(`Operation ${i + 1} (${op?.op}): ${e.message}`);
    }
  });
  const { errors, warnings } = validate(next, schema);
  if (errors.length) throw new ValidationError(errors);
  const previous = new Set(validate(doc, schema).warnings);
  return { doc: next, inverses, warnings: warnings.filter((a) => !previous.has(a)) };
}

/**
 * Merges consecutive `set`s on the same target into one (the last value wins). A `transformPoints` is relative (each
 * one moves from where the previous left), so those are kept apart.
 */
export function compact(ops) {
  const result = [];
  for (const op of ops) {
    const previous = result.at(-1);
    const relative = (o) => o.props?.transformPoints !== undefined;
    if (op.op === 'set' && previous?.op === 'set' && previous.target === op.target && !relative(op) && !relative(previous)) {
      result[result.length - 1] = { ...previous, props: { ...previous.props, ...op.props } };
    } else {
      result.push(op);
    }
  }
  return result;
}

/** Short summary of a batch for display: "head.x, head.rotation, create eye_l". */
export function summarizeOperations(ops) {
  const parts = [];
  for (const op of ops) {
    if (op.op === 'set') parts.push(...Object.keys(op.props).map((p) => `${op.target}.${p}`));
    else if (op.op === 'unset') parts.push(...op.props.map((p) => `${op.target}.${p} (default)`));
    else if (op.op === 'create') parts.push(`create ${op.id}`);
    else if (op.op === 'rename') parts.push(`rename ${op.target} → ${op.id}`);
    else if (op.op === 'duplicate') parts.push(`duplicate ${op.target}`);
    else if (op.op === 'delete') parts.push(`delete ${op.target}`);
    else if (op.op === 'move') parts.push(`move ${op.target}`);
    else parts.push(op.op);
  }
  return [...new Set(parts)];
}

function target(doc, id) {
  const obj = findObject(doc, id);
  if (!obj) throw new Error(`object "${id}" does not exist.${suggest(id, doc.objects.map((o) => o.id))}`);
  return obj;
}

function container(doc, id, schema) {
  if (id == null) return null;
  const parent = target(doc, id);
  if (!schema.types.get(parent.type)?.container) throw new Error(`"${id}" is a ${parent.type} and cannot have children (use a group)`);
  return id;
}

/**
 * The x/y that leaves an object in the same place on screen when moving to another parent (in the setup). Used by
 * `move` with keepPosition and by the editor when dragging in Layers.
 */
export function keptPosition(doc, schema, obj, newParent) {
  const world = apply(worldMatrix(doc, schema, obj.parent ?? null), read(schema, obj, 'x'), read(schema, obj, 'y'));
  const [x, y] = apply(invert(worldMatrix(doc, schema, newParent)), ...world);
  return { x: Math.round(x * 10) / 10 || 0, y: Math.round(y * 10) / 10 || 0 };
}

/** Inserts obj into the flat list so it ends up at position `index` among the children of `parent`. */
function insert(doc, obj, parent, index) {
  const siblings = children(doc, parent);
  const i = Math.max(0, Math.min(index ?? siblings.length, siblings.length));
  let pos;
  if (i < siblings.length) pos = doc.objects.indexOf(siblings[i]);
  // At the front: after the whole subtree of the last sibling, so the flat list stays ordered by branches.
  else if (siblings.length) pos = Math.max(...subtree(doc, siblings.at(-1).id).map((id) => doc.objects.findIndex((o) => o.id === id))) + 1;
  else pos = parent == null ? doc.objects.length : doc.objects.indexOf(findObject(doc, parent)) + 1;
  doc.objects.splice(pos, 0, obj);
}

/**
 * Sugar for the AI, as the editor's Fill, Stroke and Both (Moho's Paint Bucket): a new shape accepts `at: [x, y]` (in
 * its layer's coordinates) instead of `curves` or `d`, and fills the region there: the smallest area its curves close
 * around the point (a closed curve, or segments of curves welded at their points), with the closed curves inside it
 * as holes. Returns the props with `curves` and, for an area of segments, `loops` (see src/core/regions.js).
 */
function expandShapeAt(doc, schema, props, parentId) {
  if (props?.at === undefined) return props;
  const { at, ...rest } = props;
  if (!Array.isArray(at) || at.length !== 2 || !at.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('at must be [x, y], a point in the layer’s coordinates');
  if (rest.curves !== undefined || rest.d !== undefined || rest.loops !== undefined) throw new Error('pass at, curves (and loops) or d, only one: at finds the curves itself');
  const layer = parentId != null ? findObject(doc, parentId) : null;
  if (layer?.type !== 'vector') throw new Error(`a shape goes inside a vector layer${layer ? ` (its parent "${layer.id}" is a ${layer.type})` : ''}: create a vector and pass it as parent`);
  const curves = read(schema, layer, 'curves') ?? {};
  const found = regionAt(read(schema, layer, 'points') ?? {}, curves, at);
  if (!found) {
    const closed = Object.keys(curves).filter((id) => curves[id].closed);
    throw new Error(`no region of ${layer.id} is around (${at.join(', ')}) (in the layer’s coordinates; a region is closed by a closed curve or by curves welded at their points; its closed curves: ${closed.join(', ') || 'none'}). Pick a point inside one, or add the curves first with set and d`);
  }
  const key = regionKey(curves, found);
  const same = children(doc, layer.id).find((o) => o.type === 'shape' && regionKey(curves, o) === key);
  if (same) throw new Error(`shape ${same.id} already covers that region: set its fill or stroke instead of creating another`);
  return { ...rest, curves: found.curves, ...(found.loops.length ? { loops: found.loops } : {}) };
}

/**
 * Sugar for the AI and the editor: a vector layer accepts `d` (an SVG path, any number of subpaths) and its subpaths
 * are added to its mesh as curves no shape uses yet (welded where a point falls on an existing one), as drawing with
 * Auto fill and Auto stroke off. Shapes are created over them later with `curves`.
 */
function expandLayerD(schema, type, layer, props) {
  if (type !== 'vector' || props?.d === undefined) return props;
  if (typeof props.d !== 'string') throw new Error('d must be an SVG path (text)');
  if (props.points !== undefined || props.curves !== undefined) throw new Error('"d" adds curves to the layer’s mesh itself: do not pass points or curves in the same set');
  const { d, ...rest } = props;
  const added = addD(layer ? (read(schema, layer, 'points') ?? {}) : {}, layer ? (read(schema, layer, 'curves') ?? {}) : {}, d);
  return { ...rest, points: added.points, curves: added.curves };
}

/** Sugar for the AI: a path accepts `d` (SVG path data with a single subpath) and is saved as vertices. */
function expandD(kind, props) {
  if (props?.d === undefined) return props;
  if (kind?.name === 'shape') throw new Error('a shape is changed by moving the points of its layer: in a pose or keyframe, give the layer’s "points" ({ p3: { x, y } }) instead of "d"');
  if (!kind?.properties.vertices) throw new Error(`"d" only works on types with vertices (path), on shapes of a vector layer and on vector layers (curves only), not on ${kind?.name ?? 'meta'}`);
  const subpaths = parseD(props.d);
  if (subpaths.length !== 1) throw new Error(`d has ${subpaths.length} subpaths; create one path for each`);
  const { d, ...rest } = props;
  return { closed: subpaths[0].closed, ...rest, vertices: subpaths[0].vertices };
}

/**
 * Rebuilds the values of a pose changing ids: those of the objects (keys) and those that are references (the
 * active child of a switch). `change(id)` returns the new id, or null to remove it.
 */
function mapPose(doc, schema, values, change) {
  const result = {};
  for (const [id, fields] of Object.entries(values)) {
    const created = change(id);
    if (created == null) continue;
    const kind = schema.types.get(findObject(doc, created)?.type ?? findObject(doc, id)?.type);
    const clean = {};
    for (const [k, v] of Object.entries(fields)) {
      if (kind?.properties[k]?.type !== 'ref' || v == null) clean[k] = v;
      else if (change(v) != null) clean[k] = change(v);
    }
    if (Object.keys(clean).length) result[created] = clean;
  }
  return result;
}

/**
 * Sugar for the AI: inside a pose, a path also accepts `d` (saved as vertices, for the morph). The vertices of a
 * pose do not keep `bone`: the per-point binding belongs to the setup, like in Moho (see applyPose).
 */
function expandPose(doc, schema, kind, props) {
  if (kind !== 'pose' || !props?.values || typeof props.values !== 'object' || Array.isArray(props.values)) return props;
  const values = {};
  for (const [id, fields] of Object.entries(props.values)) {
    const target = findObject(doc, id);
    const targetType = target && schema.types.get(target.type);
    if (!targetType || !fields || typeof fields !== 'object') {
      values[id] = fields;
      continue;
    }
    let rest = fields;
    if (fields.d !== undefined) {
      const { d, closed, ...withoutD } = expandD(targetType, fields);
      rest = withoutD; // whether it is closed or open is decided by the setup
    }
    for (const [k, p] of Object.entries(targetType.properties)) {
      if (rest[k] !== undefined && withoutBones(p, rest[k]) !== rest[k]) rest = { ...rest, [k]: withoutBones(p, rest[k]) };
    }
    values[id] = rest;
  }
  return { ...props, values };
}

/**
 * The same for the tracks of a clip: rebuilds the tracks changing object ids and the values that are references.
 * A keyframe that pointed to something removed leaves the track; an empty track leaves entirely.
 */
function mapTracks(doc, schema, tracks, change) {
  const result = {};
  for (const [id, fields] of Object.entries(tracks)) {
    const created = change(id);
    if (created == null) continue;
    const kind = schema.types.get(findObject(doc, created)?.type ?? findObject(doc, id)?.type);
    const clean = {};
    for (const [k, keys] of Object.entries(fields)) {
      const isRef = kind?.properties[k]?.type === 'ref';
      const created = !isRef || !Array.isArray(keys) ? keys : keys.filter((c) => c.value == null || change(c.value) != null).map((c) => (c.value == null ? c : { ...c, value: change(c.value) }));
      if (!Array.isArray(created) || created.length) clean[k] = created;
    }
    if (Object.keys(clean).length) result[created] = clean;
  }
  return result;
}

/**
 * Sugar for the AI in the tracks of a clip: a path accepts a `d` track (each value, an SVG path data) that is saved
 * as a `vertices` track (for the morph). As in poses, the vertices do not keep `bone`.
 */
function expandTracks(doc, schema, kind, props) {
  if (!props?.tracks || typeof props.tracks !== 'object' || Array.isArray(props.tracks)) return props;
  if (!Object.values(schema.types.get(kind)?.properties ?? {}).some((p) => p.type === 'tracks')) return props;
  const tracks = {};
  for (const [id, fields] of Object.entries(props.tracks)) {
    const targetType = schema.types.get(findObject(doc, id)?.type);
    if (targetType?.properties.points && fields && typeof fields === 'object' && Array.isArray(fields.points)) {
      // As in poses, the points of a keyframe do not keep `bone`.
      tracks[id] = { ...fields, points: fields.points.map((c) => (c && typeof c === 'object' && c.value ? { ...c, value: withoutBones(targetType.properties.points, c.value) } : c)) };
      continue;
    }
    if (!targetType?.properties.vertices || !fields || typeof fields !== 'object') {
      tracks[id] = fields;
      continue;
    }
    let { d, ...rest } = fields;
    if (Array.isArray(d)) {
      rest.vertices = d.map((c) => {
        if (typeof c?.value !== 'string') return c;
        const subpaths = parseD(c.value);
        if (subpaths.length !== 1) throw new Error(`${id}.d at t ${c.t}: the path has ${subpaths.length} subpaths; a keyframe needs exactly one`);
        return { ...c, value: subpaths[0].vertices };
      });
    } else if (d !== undefined) rest.d = d;
    if (Array.isArray(rest.vertices)) rest.vertices = rest.vertices.map((c) => (Array.isArray(c?.value) ? { ...c, value: c.value.map(({ bone, ...v }) => v) } : c));
    tracks[id] = rest;
  }
  return { ...props, tracks };
}

/**
 * Copies the curves of `shape` (and the points they go through) into the vector layer `parentId` with new ids, and
 * returns the copy's { curves, loops } (its loops follow the copied curves). Points shared by those curves stay shared in the copy; nothing is welded to the
 * original. Into another layer the copy keeps its place on screen (the points and tangents are taken through both
 * layers' matrices), and per-point bones are dropped (they belong to the source layer's binding). Mutates the layer.
 */
function copyShapeMesh(doc, schema, shape, parentId) {
  const source = findObject(doc, shape.parent);
  const layer = findObject(doc, parentId);
  if (layer?.type !== 'vector') throw new Error(`a shape can only be copied into a vector layer, and ${parentId ?? 'the root'} is ${layer ? `a ${layer.type}` : 'not a layer'}`);
  const fromPoints = read(schema, source, 'points') ?? {};
  const fromCurves = read(schema, source, 'curves') ?? {};
  const points = { ...(read(schema, layer, 'points') ?? {}) };
  const curves = { ...(read(schema, layer, 'curves') ?? {}) };
  const sameLayer = source.id === layer.id;
  const pointIds = new Map();
  const created = [];
  const curveIds = new Map();
  for (const curveId of shapeCurveIds(fromCurves, shape)) {
    const curve = fromCurves[curveId];
    if (!curve) continue;
    const entries = curve.points.map((e) => {
      const { p, ...tangent } = entryOf(e);
      if (!pointIds.has(p)) {
        const id = freeKey(points, 'p');
        const { bone, ...pt } = fromPoints[p] ?? { x: 0, y: 0 };
        points[id] = sameLayer && bone ? { ...pt, bone } : pt;
        pointIds.set(p, id);
      }
      return Object.keys(tangent).length ? { p: pointIds.get(p), ...tangent } : pointIds.get(p);
    });
    const id = freeKey(curves, 'c');
    curves[id] = { ...curve, points: entries };
    curveIds.set(curveId, id);
  }
  for (const curveId of shape.curves ?? []) if (curveIds.has(curveId)) created.push(curveIds.get(curveId));
  const loops = (shape.loops ?? []).map((loop) =>
    loop.map((e) => {
      const { p, via } = loopEntryOf(e);
      return via === undefined ? pointIds.get(p) ?? p : { p: pointIds.get(p) ?? p, via: curveIds.get(via) ?? via };
    }),
  );
  let mesh = { points, curves };
  if (!sameLayer) mesh = transformMesh(points, curves, [...pointIds.values()], multiply(invert(worldMatrix(doc, schema, layer.id)), worldMatrix(doc, schema, source.id)));
  layer.points = mesh.points;
  layer.curves = mesh.curves;
  return { curves: created, loops };
}

/** Sugar for the AI: a bone accepts `from` and `to` ([x, y] in the document) instead of x, y, rotation and length. */
function expandBone(doc, schema, kind, parent, props, current) {
  if (props?.from === undefined && props?.to === undefined) return props;
  if (kind !== 'bone') throw new Error(`"from"/"to" only work on bones (bone), not on ${kind}`);
  return expandFromTo(doc, schema, parent, props, current);
}

/**
 * Removes from a vector layer the curves among `candidates` that no shape in `keep` uses, and the points no curve
 * uses any more; and takes those points and curves out of the poses and keyframes that moved them, so nothing
 * points to them. Mutates `doc`; returns the inverses of the poses and clips it touched (the caller restores the
 * layer itself).
 */
function pruneLayer(doc, schema, layer, candidates, keep) {
  const before = { points: read(schema, layer, 'points') ?? {}, curves: read(schema, layer, 'curves') ?? {} };
  const mesh = dropUnused(before.points, before.curves, candidates, keep);
  const gone = { points: Object.keys(before.points).filter((id) => !(id in mesh.points)), curves: Object.keys(before.curves).filter((id) => !(id in mesh.curves)) };
  if (!gone.points.length && !gone.curves.length) return [];
  layer.points = mesh.points;
  layer.curves = mesh.curves;
  const without = (map, ids) => Object.fromEntries(Object.entries(map ?? {}).filter(([id]) => !ids.includes(id)));
  const clean = (fields) => {
    const out = { ...fields };
    for (const k of ['points', 'curves']) {
      if (!out[k]) continue;
      out[k] = without(out[k], gone[k]);
      if (!Object.keys(out[k]).length) delete out[k];
    }
    return out;
  };
  const inverses = [];
  for (const o of doc.objects) {
    const f = o.type === 'pose' ? o.values?.[layer.id] : null;
    if (f && (f.points || f.curves)) {
      const cleaned = clean(f);
      if (JSON.stringify(cleaned) === JSON.stringify(f)) continue;
      inverses.push({ op: 'set', target: o.id, props: { values: structuredClone(o.values) } });
      const values = { ...o.values, [layer.id]: cleaned };
      if (!Object.keys(cleaned).length) delete values[layer.id];
      o.values = values;
    }
    const track = o.type === 'animation' ? o.tracks?.[layer.id] : null;
    if (track && (Array.isArray(track.points) || Array.isArray(track.curves))) {
      const cleaned = { ...track };
      for (const k of ['points', 'curves']) {
        if (!Array.isArray(track[k])) continue;
        const keys = track[k].map((c) => ({ ...c, value: without(c.value, gone[k]) })).filter((c) => Object.keys(c.value).length);
        if (keys.length) cleaned[k] = keys;
        else delete cleaned[k];
      }
      if (JSON.stringify(cleaned) === JSON.stringify(track)) continue;
      inverses.push({ op: 'set', target: o.id, props: { tracks: structuredClone(o.tracks) } });
      const tracks = { ...o.tracks, [layer.id]: cleaned };
      if (!Object.keys(cleaned).length) delete tracks[layer.id];
      o.tracks = tracks;
    }
  }
  return inverses;
}

/**
 * Sugar for the AI: a shape accepts `d` (an SVG path, any number of subpaths). Its subpaths are added to the mesh
 * of its vector layer as new curves (welded where a point falls on an existing one) and the shape fills them. On a
 * `set`, they replace the shape's curves, and the old ones no other shape uses leave the layer. Returns the props
 * without `d` and the inverse that restores the layer.
 */
function expandShapeD(doc, schema, props, parentId, shapeId, current = null) {
  if (props?.d === undefined) return { props, inverses: [] };
  const layer = parentId != null ? findObject(doc, parentId) : null;
  if (layer?.type !== 'vector') throw new Error(`a shape goes inside a vector layer${layer ? ` (its parent "${layer.id}" is a ${layer.type})` : ''}: create a vector and pass it as parent`);
  if (typeof props.d !== 'string') throw new Error('d must be an SVG path (text)');
  const { d, ...rest } = props;
  const before = { points: read(schema, layer, 'points') ?? {}, curves: read(schema, layer, 'curves') ?? {} };
  const added = addD(before.points, before.curves, d);
  const inverses = restoreLayer(layer);
  layer.points = added.points;
  layer.curves = added.curves;
  if (current) {
    // The old curves (its own and the ones its loops follow) no other shape uses leave the layer (and the poses and
    // keyframes that moved them).
    const others = new Set(children(doc, layer.id).filter((o) => o.id !== shapeId).flatMap((o) => shapeCurveIds(layer.curves, o)));
    inverses.push(...pruneLayer(doc, schema, layer, shapeCurveIds(before.curves, current), others));
  }
  // `d` replaces what the shape filled: its curves and its loops.
  const loops = current?.loops?.length ? { loops: [] } : {};
  return { props: { ...rest, ...loops, curves: [...(current ? [] : (rest.curves ?? [])), ...added.ids] }, inverses };
}

/**
 * Sugar for the AI and the editor: a vector layer accepts `pivot: [x, y]` (in its parent's coordinates, like x/y). It
 * moves the pivot without moving the drawing: x/y change and its points shift the other way, in the setup and in
 * the poses and keyframes that move them (they are absolute, in the layer's coordinates). Returns the props without
 * `pivot` and the inverses of the poses and clips it touched.
 */
function expandPivot(doc, schema, obj, props) {
  if (props?.pivot === undefined) return { props, inverses: [] };
  if (obj.type !== 'vector') throw new Error(`"pivot" only works on vector layers (vector), not on ${obj.type}`);
  const p = props.pivot;
  if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('pivot must be [x, y] (numbers, in the parent\'s coordinates)');
  const { pivot, ...rest } = props;
  const [x0, y0] = [read(schema, obj, 'x'), read(schema, obj, 'y')];
  // The move of the pivot measured in the layer's own frame (it may be rotated or scaled).
  const [dx, dy] = apply(invert([...localMatrix(schema, obj).slice(0, 4), 0, 0]), p[0] - x0, p[1] - y0);
  const shifted = { ...rest, x: Math.round(p[0] * 100) / 100 || 0, y: Math.round(p[1] * 100) / 100 || 0 };
  if (rest.points === undefined) shifted.points = shiftPoints(read(schema, obj, 'points'), -dx, -dy);
  // Poses and clips: their points shift like the setup's, and their x/y of the layer (absolute, in the parent's
  // coordinates) move with the pivot.
  const [px, py] = [p[0] - x0, p[1] - y0];
  const r = (v) => Math.round(v * 100) / 100 || 0;
  const fields = (f) => {
    const out = { ...f };
    if (f.points) out.points = shiftPoints(f.points, -dx, -dy);
    if (typeof f.x === 'number') out.x = r(f.x + px);
    if (typeof f.y === 'number') out.y = r(f.y + py);
    return out;
  };
  const touches = (f) => f && (f.points || typeof f.x === 'number' || typeof f.y === 'number');
  const inverses = [];
  for (const o of doc.objects) {
    if (o.type === 'pose' && touches(o.values?.[obj.id])) {
      inverses.push({ op: 'set', target: o.id, props: { values: structuredClone(o.values) } });
      o.values = { ...o.values, [obj.id]: fields(o.values[obj.id]) };
    }
    const track = o.type === 'animation' ? o.tracks?.[obj.id] : null;
    if (track && ['points', 'x', 'y'].some((k) => Array.isArray(track[k]))) {
      inverses.push({ op: 'set', target: o.id, props: { tracks: structuredClone(o.tracks) } });
      const shiftedTrack = { ...track };
      if (Array.isArray(track.points)) shiftedTrack.points = track.points.map((k) => ({ ...k, value: shiftPoints(k.value, -dx, -dy) }));
      if (Array.isArray(track.x)) shiftedTrack.x = track.x.map((k) => (typeof k.value === 'number' ? { ...k, value: r(k.value + px) } : k));
      if (Array.isArray(track.y)) shiftedTrack.y = track.y.map((k) => (typeof k.value === 'number' ? { ...k, value: r(k.value + py) } : k));
      o.tracks = { ...o.tracks, [obj.id]: shiftedTrack };
    }
  }
  return { props: shifted, inverses };
}

/** The inverse that brings a layer's mesh back to how it is now. */
function restoreLayer(layer) {
  const previous = {};
  const created = [];
  for (const k of ['points', 'curves']) {
    if (k in layer) previous[k] = structuredClone(layer[k]);
    else created.push(k);
  }
  const inverses = [];
  if (Object.keys(previous).length) inverses.push({ op: 'set', target: layer.id, props: previous });
  if (created.length) inverses.push({ op: 'unset', target: layer.id, props: created });
  return inverses;
}

/**
 * Sugar for the AI and the editor, as Moho's Transform Points: a vector layer accepts
 * `transformPoints: { shape | points, translate, rotate, scale, origin }`. It moves, rotates (degrees) and scales
 * the points of a shape (or a list of point ids) around `origin` (default: the center of their box), in the layer's
 * coordinates, with their tangents. It changes the setup; welded points move the other shapes too.
 */
function expandTransformPoints(doc, schema, obj, props) {
  if (props?.transformPoints === undefined) return props;
  if (obj.type === 'shape') throw new Error(`"transformPoints" goes on the shape's layer: { "op": "set", "target": "${obj.parent}", "props": { "transformPoints": { "shape": "${obj.id}", ... } } }`);
  if (obj.type !== 'vector') throw new Error(`"transformPoints" only works on vector layers (vector), not on ${obj.type}`);
  if (props.pivot !== undefined) throw new Error('pivot and transformPoints go in separate operations (two sets in the same batch)');
  if (props.points !== undefined || props.curves !== undefined) throw new Error('transformPoints changes points and curves itself: do not pass them in the same set');
  const { transformPoints, ...rest } = props;
  const setup = { points: read(schema, obj, 'points') ?? {}, curves: read(schema, obj, 'curves') ?? {} };
  return { ...rest, ...transformPointsOf(doc, obj, transformPoints, setup) };
}

function checkProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('props must be an object { property: value }');
  for (const [k, v] of Object.entries(props)) {
    if (STRUCTURE.has(k)) throw new Error(`"${k}" cannot be changed with props (use ${k === 'parent' ? 'move' : k === 'id' ? 'rename' : 'delete and create'})`);
    if (v === undefined) throw new Error(`the value of "${k}" is missing`);
  }
}

function applyOne(doc, op, schema) {
  switch (op?.op) {
    case 'create': {
      const kind = schema.types.get(op.type);
      if (!kind) throw new Error(`unknown type "${op.type}".${suggest(op.type, schema.types.keys())} Types: ${[...schema.types.keys()].join(', ')}`);
      if (idError(op.id)) throw new Error(idError(op.id));
      const repeated = findObject(doc, op.id);
      if (repeated) {
        // Ids are unique across the whole document: drawing, bones and assets share the namespace.
        const track = op.type === 'bone' && repeated.type !== 'bone' ? ` For bones, use the _bone suffix: "${op.id}_bone".` : '';
        throw new Error(`an object "${op.id}" already exists (${repeated.type}).${track}`);
      }
      const parent = container(doc, op.parent, schema);
      if (op.props !== undefined) checkProps(op.props);
      for (const k of ['pivot', 'transformPoints']) if (op.props?.[k] !== undefined) throw new Error(`"${k}" changes an existing layer: create ${op.id} first and use "${k}" in a later set`);
      const shape = op.type === 'shape' ? expandShapeD(doc, schema, expandShapeAt(doc, schema, op.props, parent), parent, op.id) : { props: expandLayerD(schema, op.type, null, op.props), inverses: [] };
      const props = expandTracks(doc, schema, op.type, expandPose(doc, schema, op.type, expandBone(doc, schema, op.type, parent, expandD(kind, shape.props)))) ?? {};
      insert(doc, { id: op.id, type: op.type, parent: parent, ...structuredClone(props) }, parent, op.index);
      // A shape created over curves that were already there (Fill, Stroke, Both): undoing it leaves them in the layer.
      const keep = op.type === 'shape' && op.props?.d === undefined ? { keepCurves: true } : {};
      // (with `at` the curves were there too)
      return [{ op: 'delete', target: op.id, ...keep }, ...shape.inverses];
    }

    case 'set': {
      checkProps(op.props);
      const obj = op.target === 'meta' ? doc.meta : target(doc, op.target);
      // transformPoints first: it checks the props as they were given (pivot adds points of its own).
      const given = op.target === 'meta' ? op.props : expandLayerD(schema, obj.type, obj, expandTransformPoints(doc, schema, obj, op.props));
      const shape = obj.type === 'shape' ? expandShapeD(doc, schema, given, obj.parent ?? null, obj.id, obj) : op.target === 'meta' ? { props: given, inverses: [] } : expandPivot(doc, schema, obj, given);
      const props = op.target === 'meta' ? op.props : expandTracks(doc, schema, obj.type, expandPose(doc, schema, obj.type, expandBone(doc, schema, obj.type, obj.parent ?? null, expandD(schema.types.get(obj.type), shape.props), obj)));
      const previous = {};
      const created = [];
      for (const [k, v] of Object.entries(props)) {
        if (k in obj) previous[k] = obj[k];
        else created.push(k);
        obj[k] = structuredClone(v);
      }
      const inverses = [];
      if (Object.keys(previous).length) inverses.push({ op: 'set', target: op.target, props: previous });
      if (created.length) inverses.push({ op: 'unset', target: op.target, props: created });
      return [...inverses, ...shape.inverses];
    }

    case 'unset': {
      if (!Array.isArray(op.props)) throw new Error('props must be a list of property names');
      const obj = op.target === 'meta' ? doc.meta : target(doc, op.target);
      const previous = {};
      for (const k of op.props) {
        if (STRUCTURE.has(k)) throw new Error(`"${k}" cannot be removed`);
        if (k in obj) {
          previous[k] = obj[k];
          delete obj[k];
        }
      }
      return Object.keys(previous).length ? [{ op: 'set', target: op.target, props: previous }] : [];
    }

    case 'delete': {
      target(doc, op.target);
      const ids = new Set(subtree(doc, op.target));
      const removed = [];
      doc.objects.forEach((o, pos) => ids.has(o.id) && removed.push({ pos, obj: o }));
      doc.objects = doc.objects.filter((o) => !ids.has(o.id));
      // A deleted shape takes along the curves (and points) of its layer that no other shape uses, as they would be
      // invisible and unreachable; the poses and keyframes that moved them let them go too. `keepCurves` leaves them
      // (the Clear of Fill, Stroke and Both, and the undo of a shape created over existing curves).
      const pruned = [];
      for (const { obj: shape } of op.keepCurves ? [] : removed) {
        const layer = shape.type === 'shape' && !ids.has(shape.parent) ? findObject(doc, shape.parent) : null;
        if (layer?.type !== 'vector') continue;
        const keep = new Set(children(doc, layer.id).flatMap((o) => shapeCurveIds(layer.curves, o)));
        const restore = restoreLayer(layer);
        const mesh = JSON.stringify([layer.points, layer.curves]);
        const poses = pruneLayer(doc, schema, layer, shapeCurveIds(layer.curves, shape), keep);
        if (JSON.stringify([layer.points, layer.curves]) !== mesh) pruned.push(...restore, ...poses);
      }
      // What pointed to something deleted (a style, a bone) is released; undo binds it again.
      const rebind = [];
      for (const o of doc.objects) {
        const previous = {};
        for (const [prop, p] of Object.entries(schema.types.get(o.type)?.properties ?? {})) {
          if (p.type === 'ref' && ids.has(o[prop])) {
            previous[prop] = o[prop];
            delete o[prop];
          } else if (mapBones(p, o[prop], (bone) => (ids.has(bone) ? undefined : bone)) !== o[prop]) {
            previous[prop] = structuredClone(o[prop]);
            o[prop] = mapBones(p, o[prop], (bone) => (ids.has(bone) ? undefined : bone));
          } else if ((p.type === 'pose' || p.type === 'tracks') && o[prop]) {
            const clean = (p.type === 'pose' ? mapPose : mapTracks)(doc, schema, o[prop], (id) => (ids.has(id) ? null : id));
            if (JSON.stringify(clean) !== JSON.stringify(o[prop])) {
              previous[prop] = structuredClone(o[prop]);
              o[prop] = clean;
            }
          }
        }
        if (Object.keys(previous).length) rebind.push({ op: 'set', target: o.id, props: previous });
      }
      // The pruning ran before the release of references, so its inverse goes after theirs.
      return [{ op: '_restore', root: op.target, entries: removed }, ...rebind, ...pruned];
    }

    case '_restore': {
      // Internal: inverse of delete. Puts the objects back at their exact position in the flat list.
      for (const { pos, obj } of op.entries) doc.objects.splice(pos, 0, structuredClone(obj));
      return [{ op: 'delete', target: op.root }];
    }

    case 'move': {
      const obj = target(doc, op.target);
      const previousParent = obj.parent ?? null;
      const previousIndex = children(doc, previousParent).indexOf(obj);
      const parent = 'parent' in op ? container(doc, op.parent, schema) : previousParent;
      if (parent != null && subtree(doc, obj.id).includes(parent)) throw new Error(`"${obj.id}" cannot end up inside itself or one of its descendants`);
      let position = null;
      if (op.keepPosition && parent !== previousParent) {
        if (obj.type === 'bone') throw new Error('keepPosition does not apply to bones: use reparent_bone, which keeps the bone in place');
        position = keptPosition(doc, schema, obj, parent);
      }
      const previousPos = doc.objects.indexOf(obj);
      doc.objects.splice(previousPos, 1);
      obj.parent = parent;
      insert(doc, obj, parent, op.index);
      /** @type {import('./types.js').Operation[]} */
      const inverses = [{ op: '_place', target: obj.id, parent: previousParent, pos: previousPos }];
      if (position) {
        const previous = Object.fromEntries(['x', 'y'].filter((k) => k in obj).map((k) => [k, obj[k]]));
        const created = ['x', 'y'].filter((k) => !(k in obj));
        Object.assign(obj, position);
        if (created.length) inverses.unshift({ op: 'unset', target: obj.id, props: created });
        if (Object.keys(previous).length) inverses.unshift({ op: 'set', target: obj.id, props: previous });
      }
      return inverses;
    }

    case '_place': {
      // Internal: inverse of move. Puts the object back at its exact position in the flat list.
      const obj = target(doc, op.target);
      const inverse = { op: '_place', target: obj.id, parent: obj.parent ?? null, pos: doc.objects.indexOf(obj) };
      doc.objects.splice(inverse.pos, 1);
      obj.parent = op.parent;
      doc.objects.splice(op.pos, 0, obj);
      return [inverse];
    }

    case 'rename': {
      const obj = target(doc, op.target);
      if (idError(op.id)) throw new Error(idError(op.id));
      if (findObject(doc, op.id)) throw new Error(`an object "${op.id}" already exists`);
      const previous = obj.id;
      obj.id = op.id;
      for (const o of doc.objects) {
        if (o.parent === previous) o.parent = op.id;
        const kind = schema.types.get(o.type);
        for (const [prop, p] of Object.entries(kind?.properties ?? {})) {
          if (p.type === 'ref' && o[prop] === previous) o[prop] = op.id;
          if (p.type === 'pose' && o[prop]) o[prop] = mapPose(doc, schema, o[prop], (id) => (id === previous ? op.id : id));
          if (p.type === 'tracks' && o[prop]) o[prop] = mapTracks(doc, schema, o[prop], (id) => (id === previous ? op.id : id));
          if (o[prop] !== undefined) o[prop] = mapBones(p, o[prop], (bone) => (bone === previous ? op.id : bone));
        }
      }
      return [{ op: 'rename', target: op.id, id: previous }];
    }

    case 'duplicate': {
      const original = target(doc, op.target);
      const suffix = op.suffix ?? 'copy';
      if (!/^[a-z0-9_]+$/.test(suffix)) throw new Error(`invalid suffix "${suffix}": use lowercase letters, digits and _`);
      const ids = subtree(doc, original.id);
      const map = new Map(ids.map((id) => [id, id === original.id && op.id ? op.id : `${id}_${suffix}`]));
      for (const created of map.values()) {
        if (idError(created)) throw new Error(idError(created));
        if (findObject(doc, created)) throw new Error(`an object "${created}" already exists; choose another id or suffix`);
      }
      const originalParent = original.parent ?? null;
      const parent = 'parent' in op ? container(doc, op.parent, schema) : originalParent;
      if (op.props !== undefined) checkProps(op.props);

      // Copies in the order of the flat list, with parents and references pointing to the copies.
      const copies = doc.objects
        .filter((o) => map.has(o.id))
        .map((o) => {
          const c = structuredClone(o);
          c.id = map.get(o.id);
          c.parent = o.id === original.id ? parent : map.get(o.parent);
          for (const [prop, p] of Object.entries(schema.types.get(c.type)?.properties ?? {})) {
            if (p.type === 'ref' && map.has(c[prop])) c[prop] = map.get(c[prop]);
            // When copying a whole skeleton, the vertices bound per point follow the copied bones.
            if (c[prop] !== undefined) c[prop] = mapBones(p, c[prop], (bone) => map.get(bone) ?? bone);
          }
          return c;
        });
      const root = copies.find((c) => c.id === map.get(original.id));
      Object.assign(root, structuredClone(op.props ?? {}));
      // A shape copied without its layer gets its own curves and points (else the copy and the original would share
      // them and move together), in its layer or in another vector layer, where it keeps its place on screen.
      // Undo deletes the copy and then puts the layer's mesh back exactly as it was.
      const restore = original.type === 'shape' && findObject(doc, parent) ? restoreLayer(findObject(doc, parent)) : [];
      if (original.type === 'shape') {
        const copied = copyShapeMesh(doc, schema, original, parent);
        root.curves = copied.curves;
        if (original.loops?.length) root.loops = copied.loops;
      }
      // By default it ends up right in front of the original.
      const index = op.index ?? (parent === originalParent ? children(doc, parent).indexOf(original) + 1 : undefined);
      insert(doc, root, parent, index);
      let pos = doc.objects.indexOf(root) + 1;
      for (const c of copies) if (c !== root) doc.objects.splice(pos++, 0, c);
      return [{ op: 'delete', target: root.id }, ...restore];
    }

    default:
      throw new Error(`unknown operation "${op?.op}". Use create, set, unset, delete, move, rename or duplicate`);
  }
}
