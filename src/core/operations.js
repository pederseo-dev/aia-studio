// Motor de operaciones: la única forma de modificar un documento, igual para la IA y para el editor.
//
//   { op: 'create', type: 'rect', id: 'eye_l', parent: 'head', index?: 0, props?: { width: 20 } }
//   { op: 'set',    target: 'eye_l' | 'meta', props: { x: 10, fill: '#ffffff' } }
//   { op: 'unset',  target: 'eye_l' | 'meta', props: ['x'] }            ← vuelve al valor por defecto
//   { op: 'delete', target: 'head' }                                     ← borra también los hijos y suelta
//                                                                          las referencias a lo borrado
//   { op: 'move',   target: 'eye_l', parent?: 'face' | null, index?: 0, keepPosition?: true }
//                                                     ← reparentar y/o reordenar; keepPosition deja el x/y que
//                                                       conserva su lugar en pantalla
//   { op: 'rename', target: 'eye_l', id: 'left_eye' }                    ← actualiza las referencias (y las poses)
//   { op: 'duplicate', target: 'arm_l', id?: 'arm_r', suffix?: 'copy', parent?, index?, props? }
//                                                     ← copia con sus hijos; los hijos reciben el sufijo
//
// `index` es la posición entre los hermanos en orden de dibujo: 0 = al fondo; sin index = al frente.

import { expandFromTo } from './skeleton.js';
import { read, suggest } from './schema.js';
import { apply, invert, worldMatrix } from './geometry.js';
import { parseD } from './paths.js';
import { ValidationError, ID, findObject, idError, children, subtree, validate } from './document.js';

const STRUCTURE = new Set(['id', 'type', 'parent']);

/**
 * Aplica un lote de forma atómica: si una operación falla o el resultado no es válido, no cambia nada y lanza.
 * Devuelve el documento nuevo, las operaciones inversas (para deshacer) y los avisos nuevos.
 */
export function applyOperations(doc, ops, schema) {
  if (!Array.isArray(ops) || !ops.length) throw new Error('Se necesita una lista de operaciones no vacía');
  const next = structuredClone(doc);
  const inversas = [];
  ops.forEach((op, i) => {
    try {
      inversas.unshift(...applyOne(next, op, schema));
    } catch (e) {
      throw new Error(`Operación ${i + 1} (${op?.op}): ${e.message}`);
    }
  });
  const { errors, warnings } = validate(next, schema);
  if (errors.length) throw new ValidationError(errors);
  const previous = new Set(validate(doc, schema).warnings);
  return { doc: next, inversas, warnings: warnings.filter((a) => !previous.has(a)) };
}

/** Junta los `set` seguidos sobre el mismo objetivo en uno solo (el último valor gana). */
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

/** Resumen corto de un lote para mostrar: "head.x, head.rotation, crear eye_l". */
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
 * El x/y que deja a un objeto en el mismo lugar de la pantalla al pasar a otro padre (en el montaje). Lo usan
 * `move` con keepPosition y el editor al arrastrar en Layers.
 */
export function keptPosition(doc, schema, obj, newParent) {
  const world = apply(worldMatrix(doc, schema, obj.parent ?? null), read(schema, obj, 'x'), read(schema, obj, 'y'));
  const [x, y] = apply(invert(worldMatrix(doc, schema, newParent)), ...world);
  return { x: Math.round(x * 10) / 10 || 0, y: Math.round(y * 10) / 10 || 0 };
}

/** Inserta obj en la lista plana para que quede en la posición `index` entre los hijos de `padre`. */
function insert(doc, obj, parent, index) {
  const siblings = children(doc, parent);
  const i = Math.max(0, Math.min(index ?? siblings.length, siblings.length));
  let pos;
  if (i < siblings.length) pos = doc.objects.indexOf(siblings[i]);
  // Al frente: después de todo el subárbol del último hermano, para que la lista plana siga ordenada por ramas.
  else if (siblings.length) pos = Math.max(...subtree(doc, siblings.at(-1).id).map((id) => doc.objects.findIndex((o) => o.id === id))) + 1;
  else pos = parent == null ? doc.objects.length : doc.objects.indexOf(findObject(doc, parent)) + 1;
  doc.objects.splice(pos, 0, obj);
}

/** Azúcar para la IA: un path acepta `d` (trazado SVG de un solo subtrazado) y se guarda como vértices. */
function expandD(tipo, props) {
  if (props?.d === undefined) return props;
  if (!tipo?.properties.vertices) throw new Error(`"d" solo sirve en tipos con vértices (path), no en ${tipo?.name ?? 'meta'}`);
  const subpaths = parseD(props.d);
  if (subpaths.length !== 1) throw new Error(`d tiene ${subpaths.length} subtrazados; crea un path por cada uno`);
  const { d, ...rest } = props;
  return { closed: subpaths[0].closed, ...rest, vertices: subpaths[0].vertices };
}

/**
 * Rehace los valores de una pose cambiando ids: los de los objetos (claves) y los que son referencias (el hijo
 * activo de un switch). `cambiar(id)` devuelve el id nuevo, o null para quitarlo.
 */
function mapPose(doc, schema, values, change) {
  const result = {};
  for (const [id, fields] of Object.entries(values)) {
    const created = change(id);
    if (created == null) continue;
    const tipo = schema.types.get(findObject(doc, created)?.type ?? findObject(doc, id)?.type);
    const clean = {};
    for (const [k, v] of Object.entries(fields)) {
      if (tipo?.properties[k]?.type !== 'ref' || v == null) clean[k] = v;
      else if (change(v) != null) clean[k] = change(v);
    }
    if (Object.keys(clean).length) result[created] = clean;
  }
  return result;
}

/**
 * Azúcar para la IA: dentro de una pose, un path también acepta `d` (se guarda como vértices, para el morph). Los
 * vértices de una pose no guardan `bone`: el enlace por punto es del montaje, como en Moho (ver aplicarPose).
 */
function expandPose(doc, schema, tipo, props) {
  if (tipo !== 'pose' || !props?.values || typeof props.values !== 'object' || Array.isArray(props.values)) return props;
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
      rest = withoutD; // si es cerrado o abierto lo decide el montaje
    }
    for (const [k, p] of Object.entries(targetType.properties)) {
      if (p.type === 'vertices' && Array.isArray(rest[k]) && rest[k].some((v) => v?.bone !== undefined)) rest = { ...rest, [k]: rest[k].map(({ bone, ...v }) => v) };
    }
    values[id] = rest;
  }
  return { ...props, values };
}

/**
 * Lo mismo para las pistas de un clip: rehace las pistas cambiando ids de objetos y los valores que son referencias.
 * Un keyframe que apuntaba a algo quitado sale de la pista; una pista vacía sale entera.
 */
function mapTracks(doc, schema, tracks, change) {
  const result = {};
  for (const [id, fields] of Object.entries(tracks)) {
    const created = change(id);
    if (created == null) continue;
    const tipo = schema.types.get(findObject(doc, created)?.type ?? findObject(doc, id)?.type);
    const clean = {};
    for (const [k, keys] of Object.entries(fields)) {
      const isRef = tipo?.properties[k]?.type === 'ref';
      const created = !isRef || !Array.isArray(keys) ? keys : keys.filter((c) => c.value == null || change(c.value) != null).map((c) => (c.value == null ? c : { ...c, value: change(c.value) }));
      if (!Array.isArray(created) || created.length) clean[k] = created;
    }
    if (Object.keys(clean).length) result[created] = clean;
  }
  return result;
}

/**
 * Azúcar para la IA en las pistas de un clip: un path acepta una pista `d` (cada value, un trazado SVG) que se guarda
 * como pista de `vertices` (para el morph). Como en las poses, los vértices no guardan `bone`.
 */
function expandTracks(doc, schema, tipo, props) {
  if (!props?.tracks || typeof props.tracks !== 'object' || Array.isArray(props.tracks)) return props;
  if (!Object.values(schema.types.get(tipo)?.properties ?? {}).some((p) => p.type === 'tracks')) return props;
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

/** Azúcar para la IA: un bone acepta `from` y `to` ([x, y] en el documento) en vez de x, y, rotation y length. */
function expandBone(doc, schema, tipo, parent, props, current) {
  if (props?.from === undefined && props?.to === undefined) return props;
  if (tipo !== 'bone') throw new Error(`"from"/"to" solo sirven en huesos (bone), no en ${tipo}`);
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
      const tipo = schema.types.get(op.type);
      if (!tipo) throw new Error(`tipo desconocido "${op.type}".${suggest(op.type, schema.types.keys())} Tipos: ${[...schema.types.keys()].join(', ')}`);
      if (idError(op.id)) throw new Error(idError(op.id));
      const repeated = findObject(doc, op.id);
      if (repeated) {
        // Los ids son únicos en todo el documento: dibujo, huesos y recursos comparten el espacio de nombres.
        const track = op.type === 'bone' && repeated.type !== 'bone' ? ` Para huesos conviene el sufijo _bone: "${op.id}_bone".` : '';
        throw new Error(`ya existe un objeto "${op.id}" (${repeated.type}).${track}`);
      }
      const parent = container(doc, op.parent, schema);
      if (op.props !== undefined) checkProps(op.props);
      const props = expandTracks(doc, schema, op.type, expandPose(doc, schema, op.type, expandBone(doc, schema, op.type, parent, expandD(tipo, op.props)))) ?? {};
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
      const inversas = [];
      if (Object.keys(previous).length) inversas.push({ op: 'set', target: op.target, props: previous });
      if (created.length) inversas.push({ op: 'unset', target: op.target, props: created });
      return inversas;
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
      // Lo que apuntaba a algo borrado (un estilo, un hueso) se suelta; deshacer lo vuelve a enlazar.
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
      // Interna: inversa de delete. Devuelve los objetos a su posición exacta en la lista plana.
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
      const inversas = [{ op: '_place', target: obj.id, parent: previousParent, pos: previousPos }];
      if (position) {
        const previous = Object.fromEntries(['x', 'y'].filter((k) => k in obj).map((k) => [k, obj[k]]));
        const created = ['x', 'y'].filter((k) => !(k in obj));
        Object.assign(obj, position);
        if (created.length) inversas.unshift({ op: 'unset', target: obj.id, props: created });
        if (Object.keys(previous).length) inversas.unshift({ op: 'set', target: obj.id, props: previous });
      }
      return inversas;
    }

    case '_place': {
      // Interna: inversa de move. Devuelve el objeto a su posición exacta en la lista plana.
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
        const tipo = schema.types.get(o.type);
        for (const [prop, p] of Object.entries(tipo?.properties ?? {})) {
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

      // Copias en el orden de la lista plana, con padres y referencias apuntando a las copias.
      const copies = doc.objects
        .filter((o) => map.has(o.id))
        .map((o) => {
          const c = structuredClone(o);
          c.id = map.get(o.id);
          c.parent = o.id === original.id ? parent : map.get(o.parent);
          for (const [prop, p] of Object.entries(schema.types.get(c.type)?.properties ?? {})) {
            if (p.type === 'ref' && map.has(c[prop])) c[prop] = map.get(c[prop]);
            // Al copiar un skeleton entero, los vértices enlazados por punto siguen a los huesos copiados.
            if (p.type === 'vertices' && c[prop]?.some((v) => map.has(v.bone))) c[prop] = c[prop].map((v) => (map.has(v.bone) ? { ...v, bone: map.get(v.bone) } : v));
          }
          return c;
        });
      const root = copies.find((c) => c.id === map.get(original.id));
      Object.assign(root, structuredClone(op.props ?? {}));
      // Por defecto queda justo delante del original.
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
