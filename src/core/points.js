// Named points, shared points and point groups (decision 6 in docs/rebuild.md).
//
// - A vertex may have a name, unique in its part: { x, y, name: 'chin' }. Elsewhere it is called "jaw.chin".
// - A vertex may share a point of another part of the same layer: { ref: 'jaw.chin', in?, out? }. It has no x, y of
//   its own: it is where jaw.chin is (its handles are its own, the curve on its outline). This is how parts are
//   welded, as in Moho: moving the point moves both outlines.
// - A vector layer may have point groups: groups: { upper_lid: ['lid.top', 'brow.mid'] }, named points of its parts.
// - A stretch of an outline may follow another part's curve: { ref: 'jaw.ear_l', follow: 'jaw' }, { ref: 'jaw.chin' }
//   draws from ear_l to chin along jaw's own outline (its points and curves in between), so it changes when jaw
//   does. Both ends share points of jaw; on a closed jaw it goes the short way, or the other with way: 'long'.
//
// The stored document keeps references as they are; resolveDoc fills in where each shared vertex is, for drawing and
// for the editor. settleOps turns a batch written against the resolved document (shared vertices with x, y) into one
// for the stored document: a moved shared vertex moves the point it shares, and a shared vertex whose point is gone
// stays where it was as a point of its own.

import { ID, findObject } from './document.js';
import { OUTLINE } from './geometry.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Vertex} Vertex
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {Record<string, string[]>} PointGroups
 * @typedef {import('./geometry.js').Point} Point
 */

/** "jaw.chin": a named point of a part. */
export const POINT_REF = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

/** @param {string} ref @returns {[string, string]} the part and the point name */
export const splitRef = (ref) => /** @type {[string, string]} */ (ref.split('.'));

/** @param {DocObject} part @returns {Vertex[]} */
const verticesOf = (part) => /** @type {Vertex[]} */ (part.vertices ?? []);

/**
 * The vertex a reference names, and where it is.
 * @param {Doc} doc @param {string} ref
 * @returns {{ part: DocObject, index: number, vertex: Vertex } | null}
 */
export function pointOf(doc, ref) {
  const match = POINT_REF.exec(ref);
  const part = match ? findObject(doc, match[1]) : undefined;
  if (!match || !part) return null;
  const index = verticesOf(part).findIndex((v) => v.name === match[2]);
  return index < 0 ? null : { part, index, vertex: verticesOf(part)[index] };
}

/** Whether a document has any shared vertex. @param {Doc} doc */
const hasRefs = (doc) => doc.objects.some((o) => verticesOf(o).some((v) => v.ref));

/**
 * The document with every shared vertex at the place of the point it shares (its `ref` kept), and, for the parts
 * with followed stretches, where their outline really goes (part[OUTLINE]). The same object when nothing is shared.
 * @param {Doc} doc
 * @returns {Doc}
 */
export function resolveDoc(doc) {
  if (!hasRefs(doc)) return doc;
  const placed = {
    ...doc,
    objects: doc.objects.map((o) => {
      if (!verticesOf(o).some((v) => v.ref)) return o;
      return {
        ...o,
        vertices: verticesOf(o).map((v) => {
          if (!v.ref) return v;
          const shared = pointOf(doc, v.ref)?.vertex;
          return shared && !shared.ref ? { ...v, x: shared.x, y: shared.y } : v;
        }),
      };
    }),
  };
  for (const o of placed.objects) {
    if (verticesOf(o).some((v) => v.follow)) /** @type {any} */ (o)[OUTLINE] = followedOutline(placed, o);
  }
  return placed;
}

/** @param {Vertex} v @returns {Vertex} the vertex with its handles swapped (walked the other way) */
const flipped = (v) => ({ x: v.x, y: v.y, ...(v.out ? { in: v.out } : {}), ...(v.in ? { out: v.in } : {}) });

/**
 * The stretch from vertex `i` of a part to the next one along the part it follows, or why it cannot be.
 * @param {Doc} doc resolved @param {DocObject} part @param {number} i
 * @returns {{ error: string } | { startOut?: Point, inner: Vertex[], endIn?: Point }}
 */
export function followStretch(doc, part, i) {
  const vertices = verticesOf(part);
  const v = vertices[i];
  const closed = part.closed !== false;
  const nextIndex = i + 1 < vertices.length ? i + 1 : closed ? 0 : -1;
  const where = `point ${i} of ${part.id} follows "${v.follow}"`;
  if (nextIndex < 0) return { error: `${where}, but it is the last point of an open line: there is no stretch after it` };
  const other = findObject(doc, String(v.follow));
  if (!other || other.type !== 'path') return { error: `${where}, but there is no such part` };
  if (other.id === part.id) return { error: `${where}: a part cannot follow itself` };
  if (other.parent !== part.parent) return { error: `${where}, which is in another layer` };
  const next = vertices[nextIndex];
  const a = v.ref ? pointOf(doc, v.ref) : null;
  const b = next.ref ? pointOf(doc, next.ref) : null;
  if (!a || !b || a.part.id !== other.id || b.part.id !== other.id) {
    return { error: `${where}: this point and the next one must both share points of ${other.id} (ref "${other.id}.…")` };
  }
  if (a.index === b.index) return { error: `${where}: this point and the next one share the same point of ${other.id}` };
  const path = verticesOf(other);
  const n = path.length;
  const otherClosed = other.closed !== false;
  let forward;
  if (!otherClosed) forward = b.index > a.index;
  else {
    const ahead = (b.index - a.index + n) % n;
    const behind = (a.index - b.index + n) % n;
    const short = ahead <= behind;
    forward = v.way === 'long' ? !short : short;
  }
  /** @type {Vertex[]} */
  const walked = [];
  for (let k = a.index; ; k = (k + (forward ? 1 : -1) + n) % n) {
    walked.push(forward ? path[k] : flipped(path[k]));
    if (k === b.index) break;
  }
  const first = walked[0];
  const last = walked[walked.length - 1];
  return { startOut: first.out, inner: walked.slice(1, -1).map((w) => ({ x: w.x, y: w.y, ...(w.in ? { in: w.in } : {}), ...(w.out ? { out: w.out } : {}) })), endIn: last.in };
}

/**
 * Where an outline with followed stretches goes: its own vertices with the other part's points in between, and the
 * handles at the ends of each stretch taken from that part.
 * @param {Doc} doc resolved @param {DocObject} part
 * @returns {Vertex[]}
 */
function followedOutline(doc, part) {
  const vertices = verticesOf(part);
  const closed = part.closed !== false;
  const stretches = vertices.map((v, i) => {
    if (!v.follow) return null;
    const s = followStretch(doc, part, i);
    return 'error' in s ? null : s;
  });
  /** @type {Vertex[]} */
  const outline = [];
  for (const [i, v] of vertices.entries()) {
    const before = stretches[i > 0 ? i - 1 : closed ? vertices.length - 1 : -1];
    const after = stretches[i];
    const inHandle = before ? before.endIn : v.in;
    const outHandle = after ? after.startOut : v.out;
    outline.push({ x: v.x, y: v.y, ...(inHandle ? { in: inHandle } : {}), ...(outHandle ? { out: outHandle } : {}) });
    if (after) outline.push(...after.inner);
  }
  return outline;
}

/**
 * What is wrong with the named points, shared points and point groups of a document, or null.
 * @param {Doc} doc
 */
export function pointsError(doc) {
  for (const object of doc.objects) {
    const vertices = verticesOf(object);
    /** @type {Set<string>} */
    const names = new Set();
    for (const [i, v] of vertices.entries()) {
      if (v.name) {
        if (names.has(v.name)) return `${object.id} has two points named "${v.name}"`;
        names.add(v.name);
      }
      if (v.follow) {
        const stretch = followStretch(resolveDoc(doc), object, i);
        if ('error' in stretch) return stretch.error;
      }
      if (!v.ref) continue;
      const [partId] = splitRef(v.ref);
      const shared = pointOf(doc, v.ref);
      const where = `point ${i} of ${object.id} shares "${v.ref}"`;
      if (!shared) return `${where}, but there is no such point (name the point in its part first)`;
      if (partId === object.id) return `${where}: a part cannot share a point with itself`;
      if (shared.part.parent !== object.parent) return `${where}, which is in another layer (only parts of the same layer share points)`;
      if (shared.vertex.ref) return `${where}, which itself shares "${shared.vertex.ref}": share that one instead`;
    }
    const groups = /** @type {PointGroups | undefined} */ (object.groups);
    for (const [group, members] of Object.entries(groups ?? {})) {
      for (const member of members) {
        const point = pointOf(doc, member);
        if (!point) return `the group "${group}" of ${object.id} has "${member}", but there is no such point`;
        if (point.part.parent !== object.id) return `the group "${group}" of ${object.id} has "${member}", which is not in this layer`;
      }
    }
  }
  return null;
}

/**
 * After a part is renamed: references and group members that named its points name it by its new id. Changes the
 * document in place.
 * @param {Doc} doc @param {string} from @param {string} to
 */
export function renamePointRefs(doc, from, to) {
  /** @param {string} ref */
  const rename = (ref) => {
    const [part, name] = splitRef(ref);
    return part === from ? `${to}.${name}` : ref;
  };
  for (const o of doc.objects) {
    if (verticesOf(o).some((v) => v.ref || v.follow)) {
      o.vertices = verticesOf(o).map((v) => ({
        ...v,
        ...(v.ref ? { ref: rename(v.ref) } : {}),
        ...(v.follow === from ? { follow: to } : {}),
      }));
    }
    const groups = /** @type {PointGroups | undefined} */ (o.groups);
    if (groups) o.groups = Object.fromEntries(Object.entries(groups).map(([g, members]) => [g, members.map(rename)]));
  }
}

/**
 * A free point name in a part: its id and a number (jaw_1, jaw_2…).
 * @param {DocObject} part @param {Set<string>} [taken] names already given in the same step
 */
export function nextPointName(part, taken = new Set()) {
  const names = new Set([...verticesOf(part).map((v) => v.name), ...taken]);
  for (let n = 1; ; n++) if (!names.has(`${part.id}_${n}`)) return `${part.id}_${n}`;
}

/** Takes x, y off a shared vertex (where it is comes from the point it shares). @param {Vertex} v @returns {Vertex} */
export function storedVertex(v) {
  if (!v.ref) return v;
  const { x: _x, y: _y, ...rest } = v;
  return /** @type {Vertex} */ (rest);
}

/** Keeps a shared vertex where it is, as a point of its own. @param {Vertex} v @returns {Vertex} */
function ownVertex(v) {
  const { ref: _ref, ...rest } = v;
  return rest;
}

const MOVED = 0.005;

/**
 * A document seen while a tool drags (shared vertices with x, y), with what it shares kept together: a shared
 * vertex that moved from where it is in `base` moves the point it shares, then every shared vertex goes to its point.
 * @param {Doc} doc @param {Doc} base resolved
 * @returns {Doc}
 */
export function syncShared(doc, base) {
  if (!hasRefs(doc)) return doc;
  /** @type {Map<string, { x: number, y: number }>} where moved points go, by "part.name" */
  const moves = new Map();
  for (const o of doc.objects) {
    const before = findObject(base, o.id);
    if (!before || before.vertices === o.vertices) continue;
    for (const [i, v] of verticesOf(o).entries()) {
      const was = verticesOf(before)[i];
      if (!v.ref || !was || was.ref !== v.ref) continue;
      if (Math.abs(v.x - was.x) > MOVED || Math.abs(v.y - was.y) > MOVED) moves.set(v.ref, { x: v.x, y: v.y });
    }
  }
  if (!moves.size) return resolveDoc(doc);
  const moved = {
    ...doc,
    objects: doc.objects.map((o) => {
      if (!verticesOf(o).some((v) => v.name && moves.has(`${o.id}.${v.name}`))) return o;
      return { ...o, vertices: verticesOf(o).map((v) => (v.name && moves.has(`${o.id}.${v.name}`) ? { ...v, ...moves.get(`${o.id}.${v.name}`) } : v)) };
    }),
  };
  return resolveDoc(moved);
}

/**
 * Turns a batch the editor wrote against the resolved document into one for the stored document (see the top of
 * this file). `apply` applies a batch without checking points (the operations engine), so the result can be looked
 * at before it is fixed.
 * @param {Doc} doc the stored document
 * @param {Operation[]} ops
 * @param {(doc: Doc, ops: Operation[]) => Doc} apply
 * @returns {Operation[]}
 */
export function settleOps(doc, ops, apply) {
  const resolved = resolveDoc(doc);
  /** @param {Operation} op */
  const stripped = (op) =>
    op.props?.vertices ? { ...op, props: { ...op.props, vertices: op.props.vertices.map(storedVertex) } } : op;
  const first = ops.map(stripped);
  // What the editor meant: shared vertices where it put them.
  /** @type {Map<string, Vertex[]>} */
  const placed = new Map();
  for (const op of ops) if (op.props?.vertices) placed.set(op.op === 'create' ? op.id : op.target, op.props.vertices);
  const applied = apply(resolved, first);
  const wanted = { ...applied, objects: applied.objects.map((o) => (placed.has(o.id) ? { ...o, vertices: placed.get(o.id) } : o)) };
  const synced = syncShared(wanted, resolved);
  let after = apply(doc, first);
  /** @type {Map<string, Record<string, unknown>>} */
  const fixes = new Map();
  /** @param {DocObject} o @param {Record<string, unknown>} props */
  const fix = (o, props) => fixes.set(o.id, { ...fixes.get(o.id), ...props });
  // Points that a moved shared vertex dragged along.
  for (const o of after.objects) {
    const now = findObject(synced, o.id);
    if (!now || !verticesOf(o).some((v) => v.name)) continue;
    const vertices = verticesOf(o).map((v, i) => {
      const there = verticesOf(now)[i];
      return v.name && !v.ref && there && there.name === v.name && (there.x !== v.x || there.y !== v.y) ? { ...v, x: there.x, y: there.y } : v;
    });
    if (vertices.some((v, i) => v !== verticesOf(o)[i])) fix(o, { vertices });
  }
  if (fixes.size) after = apply(after, [...fixes].map(([target, props]) => ({ op: 'set', target, props })));
  // Shared vertices whose point is gone stay where they were, as points of their own.
  for (const o of after.objects) {
    if (!verticesOf(o).some((v) => v.ref && !pointOf(after, v.ref))) continue;
    const there = findObject(wanted, o.id);
    const vertices = verticesOf(o).map((v, i) => {
      if (!v.ref || pointOf(after, v.ref)) return v;
      const at = verticesOf(there ?? o)[i] ?? pointOf(resolved, v.ref)?.vertex;
      return ownVertex({ ...v, x: at?.x ?? 0, y: at?.y ?? 0 });
    });
    fix(o, { vertices });
  }
  // Group members whose point is gone leave the group.
  for (const o of after.objects) {
    const groups = /** @type {PointGroups | undefined} */ (o.groups);
    if (!groups || Object.values(groups).every((members) => members.every((m) => pointOf(after, m)))) continue;
    fix(o, { groups: Object.fromEntries(Object.entries(groups).map(([g, members]) => [g, members.filter((m) => pointOf(after, m))])) });
  }
  // Followed stretches whose ends no longer share points of the part they follow (or whose part is gone) become
  // plain stretches.
  const final = fixes.size ? apply(after, [...fixes].map(([target, props]) => ({ op: 'set', target, props }))) : after;
  const shown = resolveDoc(final);
  for (const o of final.objects) {
    const vertices = verticesOf(o);
    const broken = vertices.map((v, i) => !!v.follow && 'error' in followStretch(shown, o, i));
    if (!broken.some(Boolean)) continue;
    fix(o, {
      vertices: vertices.map((v, i) => {
        if (!broken[i]) return v;
        const { follow: _follow, way: _way, ...rest } = v;
        return rest;
      }),
    });
  }
  return [...first, ...[...fixes].map(([target, props]) => ({ op: 'set', target, props }))];
}

/** @param {unknown} value */
const isName = (value) => typeof value === 'string' && ID.test(value);

/**
 * Why a value is not a list of point groups, or null. @param {unknown} value
 */
export function groupsError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be an object of groups: { "upper_lid": ["lid.top", "brow.mid"] }';
  for (const [name, members] of Object.entries(value)) {
    if (!isName(name)) return `group "${name}": a group name is lowercase letters, digits and _, starting with a letter`;
    if (!Array.isArray(members) || members.some((m) => typeof m !== 'string' || !POINT_REF.test(m))) {
      return `group "${name}" must be a list of named points like "lid.top"`;
    }
    if (new Set(members).size !== members.length) return `group "${name}" has a point twice`;
  }
  return null;
}

/**
 * The points a list of names stands for, each as the vertex that has its own x, y (a shared vertex stands for the
 * point it shares). A name is "part.point" (a named point), "part.3" (the vertex at index 3) or "layer.group" (the
 * points of a point group). Throws an Error that says what is wrong with a name.
 * @param {Doc} doc @param {string[]} names
 * @returns {{ part: string, index: number }[]} without repeats
 */
export function pointsNamed(doc, names) {
  /** @type {Map<string, { part: string, index: number }>} */
  const found = new Map();
  /** @param {DocObject} part @param {number} index @param {string} name */
  const add = (part, index, name) => {
    const v = verticesOf(part)[index];
    if (v.ref) {
      const shared = pointOf(doc, v.ref);
      if (!shared) throw new Error(`${name} shares "${v.ref}", which does not exist`);
      part = shared.part;
      index = shared.index;
    }
    found.set(`${part.id}:${index}`, { part: part.id, index });
  };
  for (const name of names) {
    const match = /^([a-z][a-z0-9_]*)\.([a-z0-9_]+)$/.exec(name);
    if (!match) throw new Error(`"${name}" is not a point: use part.point (head.chin), part.index (head.3) or layer.group (face.upper_lid)`);
    const [, owner, key] = match;
    const object = findObject(doc, owner);
    if (!object) throw new Error(`there is no object "${owner}" (in "${name}")`);
    const groups = /** @type {PointGroups | undefined} */ (object.groups);
    if (object.vertices === undefined && object.type !== 'path') {
      const members = groups?.[key];
      if (!members) {
        const known = Object.keys(groups ?? {});
        throw new Error(`${owner} has no point group "${key}" (${known.length ? `groups: ${known.join(', ')}` : 'it has no groups'})`);
      }
      for (const member of members) {
        const point = pointOf(doc, member);
        if (point) add(point.part, point.index, member);
      }
      continue;
    }
    const vertices = verticesOf(object);
    if (/^\d+$/.test(key)) {
      const index = Number(key);
      if (index >= vertices.length) throw new Error(`${owner} has ${vertices.length} vertices (0 to ${vertices.length - 1}), so there is no "${name}"`);
      add(object, index, name);
      continue;
    }
    const index = vertices.findIndex((v) => v.name === key);
    if (index < 0) {
      const known = vertices.flatMap((v) => (v.name ? [v.name] : []));
      throw new Error(`${owner} has no point named "${key}" (${known.length ? `named points: ${known.join(', ')}` : 'it has no named points; use its index, as ' + owner + '.0'})`);
    }
    add(object, index, name);
  }
  return [...found.values()];
}

/**
 * The batch that moves points: by an offset, or one point to a place. Their handles go along; the vertices that
 * share them follow by themselves.
 * @param {Doc} doc @param {{ part: string, index: number }[]} points from pointsNamed
 * @param {{ by?: { x: number, y: number }, to?: { x: number, y: number } }} where
 * @returns {Operation[]}
 */
export function movePointsOps(doc, points, { by, to }) {
  if (to && points.length !== 1) throw new Error(`--to places one point, and these are ${points.length}: use --by to move them together`);
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  const round = (/** @type {number} */ n) => Math.round(n * 100) / 100 || 0;
  for (const { part, index } of points) {
    const object = /** @type {DocObject} */ (findObject(doc, part));
    const vertices = changes.get(part) ?? verticesOf(object).map((v) => ({ ...v }));
    const v = vertices[index];
    if (to) Object.assign(v, { x: round(to.x), y: round(to.y) });
    else if (by) Object.assign(v, { x: round(v.x + by.x), y: round(v.y + by.y) });
    changes.set(part, vertices);
  }
  return [...changes].map(([target, vertices]) => ({ op: 'set', target, props: { vertices } }));
}
