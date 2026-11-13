// Operations engine: the only way to modify a document, the same for the AI and for the editor.
//
//   { op: 'create', type: 'rect', id: 'eye_l', parent: 'head', index?: 0, props?: { width: 20 } }
//   { op: 'set',    target: 'eye_l' | 'meta', props: { x: 10, fill: '#ffffff' } }
//   { op: 'unset',  target: 'eye_l' | 'meta', props: ['x'] }            ← back to the default value
//   { op: 'delete', target: 'head' }                                     ← also deletes the children and releases
//                                                                          the references to what was deleted
//   { op: 'move',   target: 'eye_l', parent?: 'face' | null, index?: 0, keepPosition?: true }
//                                                     ← reparent and/or reorder; keepPosition leaves the x/y that
//                                                       keeps its place on screen
//   { op: 'rename', target: 'eye_l', id: 'left_eye' }                    ← updates the references (and the poses)
//   { op: 'duplicate', target: 'arm_l', id?: 'arm_r', suffix?: 'copy', parent?, index?, props? }
//                                                     ← copy with its children; the children get the suffix
//
// `index` is the position among the siblings in drawing order: 0 = at the back; no index = at the front.

import { expandFromTo } from './skeleton.js';
import { read, suggest } from './schema.js';
import { apply, invert, worldMatrix } from './geometry.js';
import { parseD } from './paths.js';
import { ValidationError, ID, findObject, idError, children, subtree, validate } from './document.js';

const STRUCTURE = new Set(['id', 'type', 'parent']);

/**
 * Applies a batch atomically: if an operation fails or the result is not valid, nothing changes and it throws.
 * Returns the new document, the inverse operations (for undo) and the new warnings.
 */
export function applyOperations(doc, ops, schema) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('Se necesita una lista de operaciones no vacía');
  const next = structuredClone(doc);
  const inverses = [];
  ops.forEach((op, i) => {
    try {
      inverses.unshift(...applyOne(next, op, schema));
    } catch (e) {
      throw new Error(`Operación ${i + 1} (${op?.op}): ${e.message}`);
    }
  });
  const { errors, warnings } = validate(next, schema);
  if (errors.length) throw new ValidationError(errors);
  const previous = new Set(validate(doc, schema).warnings);
  return { doc: next, inverses, warnings: warnings.filter((a) => !previous.has(a)) };
}

/** Merges consecutive `set`s on the same target into one (the last value wins). */
export function compact(ops) {
  const result = [];
  for (const op of ops) {
    const previous = result.at(-1);
    if (op.op === 'set' && previous?.op === 'set' && previous.target === op.target) {
      result[result.length - 1] = { ...previous, props: { ...previous.props, ...op.props } };
    } else {
      result.push(op);
    }
  }
  return result;
}

/** Short summary of a batch for display: "head.x, head.rotation, crear eye_l". */
export function summarizeOperations(ops) {
  const parts = [];
  for (const op of ops) {
    if (op.op === 'set') parts.push(...Object.keys(op.props).map((p) => `${op.target}.${p}`));
    else if (op.op === 'unset') parts.push(...op.props.map((p) => `${op.target}.${p} (por defecto)`));
    else if (op.op === 'create') parts.push(`crear ${op.id}`);
    else if (op.op === 'rename') parts.push(`renombrar ${op.target} → ${op.id}`);
    else if (op.op === 'duplicate') parts.push(`duplicar ${op.target}`);
    else if (op.op === 'delete') parts.push(`borrar ${op.target}`);
    else if (op.op === 'move') parts.push(`mover ${op.target}`);
    else parts.push(op.op);
  }
  return [...new Set(parts)];
}

function target(doc, id) {
  const obj = findObject(doc, id);
  if (!obj) throw new Error(`no existe el objeto "${id}".${suggest(id, doc.objects.map((o) => o.id))}`);
  return obj;
}

function container(doc, id, schema) {
  if (id == null) return null;
  const parent = target(doc, id);
  if (!schema.types.get(parent.type)?.container) throw new Error(`"${id}" es un ${parent.type} y no puede tener hijos (usa un group)`);
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

/** Sugar for the AI: a path accepts `d` (SVG path data with a single subpath) and is saved as vertices. */
function expandD(kind, props) {
  if (props?.d === undefined) return props;
  if (!kind?.properties.vertices) throw new Error(`"d" solo sirve en tipos con vértices (path), no en ${kind?.name ?? 'meta'}`);
  const subpaths = parseD(props.d);
  if (subpaths.length !== 1) throw new Error(`d tiene ${subpaths.length} subtrazados; crea un path por cada uno`);
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
      if (p.type === 'vertices' && Array.isArray(rest[k]) && rest[k].some((v) => v?.bone !== undefined)) rest = { ...rest, [k]: rest[k].map(({ bone, ...v }) => v) };
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

/** Sugar for the AI: a bone accepts `from` and `to` ([x, y] in the document) instead of x, y, rotation and length. */
function expandBone(doc, schema, kind, parent, props, current) {
  if (props?.from === undefined && props?.to === undefined) return props;
  if (kind !== 'bone') throw new Error(`"from"/"to" solo sirven en huesos (bone), no en ${kind}`);
  return expandFromTo(doc, schema, parent, props, current);
}

function checkProps(props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('props debe ser un objeto { propiedad: valor }');
  for (const [k, v] of Object.entries(props)) {
    if (STRUCTURE.has(k)) throw new Error(`"${k}" no se cambia con props (usa ${k === 'parent' ? 'move' : k === 'id' ? 'rename' : 'delete y create'})`);
    if (v === undefined) throw new Error(`falta el valor de "${k}"`);
  }
}

function applyOne(doc, op, schema) {
  switch (op?.op) {
    case 'create': {
      const kind = schema.types.get(op.type);
      if (!kind) throw new Error(`tipo desconocido "${op.type}".${suggest(op.type, schema.types.keys())} Tipos: ${[...schema.types.keys()].join(', ')}`);
      if (idError(op.id)) throw new Error(idError(op.id));
      const repeated = findObject(doc, op.id);
      if (repeated) {
        // Ids are unique across the whole document: drawing, bones and assets share the namespace.
        const track = op.type === 'bone' && repeated.type !== 'bone' ? ` Para huesos conviene el sufijo _bone: "${op.id}_bone".` : '';
        throw new Error(`ya existe un objeto "${op.id}" (${repeated.type}).${track}`);
      }
      const parent = container(doc, op.parent, schema);
      if (op.props !== undefined) checkProps(op.props);
      const props = expandTracks(doc, schema, op.type, expandPose(doc, schema, op.type, expandBone(doc, schema, op.type, parent, expandD(kind, op.props)))) ?? {};
      insert(doc, { id: op.id, type: op.type, parent: parent, ...structuredClone(props) }, parent, op.index);
      return [{ op: 'delete', target: op.id }];
    }

    case 'set': {
      checkProps(op.props);
      const obj = op.target === 'meta' ? doc.meta : target(doc, op.target);
      const props = op.target === 'meta' ? op.props : expandTracks(doc, schema, obj.type, expandPose(doc, schema, obj.type, expandBone(doc, schema, obj.type, obj.parent ?? null, expandD(schema.types.get(obj.type), op.props), obj)));
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
      return inverses;
    }

    case 'unset': {
      if (!Array.isArray(op.props)) throw new Error('props debe ser una lista de nombres de propiedad');
      const obj = op.target === 'meta' ? doc.meta : target(doc, op.target);
      const previous = {};
      for (const k of op.props) {
        if (STRUCTURE.has(k)) throw new Error(`"${k}" no se puede quitar`);
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
      // What pointed to something deleted (a style, a bone) is released; undo binds it again.
      const rebind = [];
      for (const o of doc.objects) {
        const previous = {};
        for (const [prop, p] of Object.entries(schema.types.get(o.type)?.properties ?? {})) {
          if (p.type === 'ref' && ids.has(o[prop])) {
            previous[prop] = o[prop];
            delete o[prop];
          } else if (p.type === 'vertices' && o[prop]?.some((v) => ids.has(v.bone))) {
            previous[prop] = structuredClone(o[prop]);
            o[prop] = o[prop].map(({ bone, ...v }) => (bone === undefined || ids.has(bone) ? v : { ...v, bone }));
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
      return [{ op: '_restore', root: op.target, entries: removed }, ...rebind];
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
      if (parent != null && subtree(doc, obj.id).includes(parent)) throw new Error(`"${obj.id}" no puede quedar dentro de sí mismo o de un descendiente`);
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
      if (findObject(doc, op.id)) throw new Error(`ya existe un objeto "${op.id}"`);
      const previous = obj.id;
      obj.id = op.id;
      for (const o of doc.objects) {
        if (o.parent === previous) o.parent = op.id;
        const kind = schema.types.get(o.type);
        for (const [prop, p] of Object.entries(kind?.properties ?? {})) {
          if (p.type === 'ref' && o[prop] === previous) o[prop] = op.id;
          if (p.type === 'pose' && o[prop]) o[prop] = mapPose(doc, schema, o[prop], (id) => (id === previous ? op.id : id));
          if (p.type === 'tracks' && o[prop]) o[prop] = mapTracks(doc, schema, o[prop], (id) => (id === previous ? op.id : id));
          if (p.type === 'vertices' && o[prop]?.some((v) => v.bone === previous)) o[prop] = o[prop].map((v) => (v.bone === previous ? { ...v, bone: op.id } : v));
        }
      }
      return [{ op: 'rename', target: op.id, id: previous }];
    }

    case 'duplicate': {
      const original = target(doc, op.target);
      const suffix = op.suffix ?? 'copy';
      if (!/^[a-z0-9_]+$/.test(suffix)) throw new Error(`suffix inválido "${suffix}": minúsculas, números y _`);
      const ids = subtree(doc, original.id);
      const map = new Map(ids.map((id) => [id, id === original.id && op.id ? op.id : `${id}_${suffix}`]));
      for (const created of map.values()) {
        if (idError(created)) throw new Error(idError(created));
        if (findObject(doc, created)) throw new Error(`ya existe un objeto "${created}"; elige otro id o suffix`);
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
            if (p.type === 'vertices' && c[prop]?.some((v) => map.has(v.bone))) c[prop] = c[prop].map((v) => (map.has(v.bone) ? { ...v, bone: map.get(v.bone) } : v));
          }
          return c;
        });
      const root = copies.find((c) => c.id === map.get(original.id));
      Object.assign(root, structuredClone(op.props ?? {}));
      // By default it ends up right in front of the original.
      const index = op.index ?? (parent === originalParent ? children(doc, parent).indexOf(original) + 1 : undefined);
      insert(doc, root, parent, index);
      let pos = doc.objects.indexOf(root) + 1;
      for (const c of copies) if (c !== root) doc.objects.splice(pos++, 0, c);
      return [{ op: 'delete', target: root.id }];
    }

    default:
      throw new Error(`operación desconocida "${op?.op}". Usa create, set, unset, delete, move, rename o duplicate`);
  }
}
