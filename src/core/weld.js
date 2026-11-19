// Welding and the other changes to named and shared points, as batches of plain operations (decision 6). The editor
// (point editing, the Pen) and the `aia` commands use the same functions, so a weld ends up the same whoever made it.
// They work on a resolved document (resolveDoc in points.js: shared vertices with x, y) and say why when something
// cannot be done (a WeldError with the reason).
//
// A point is { part, index }: the vertex at `index` of `part`. A weld target is a point, or a place on the line of a
// part: { part, segment, t } (the stretch from vertex `segment` to the next, t from 0 to 1).

import { findObject, idFromName } from './document.js';
import { closeOutline, endOf, insertVertex, joinOutlines, roundVertex, verticesOf } from './geometry.js';
import { followsOthers, nextPointName, passIndex, pointIdOf, pointOf, splitRef } from './points.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Vertex} Vertex
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {{ part: string, index: number }} PointAt
 * @typedef {PointAt | { part: string, segment: number, t: number }} WeldTarget
 * @typedef {{ ops: Operation[], keep: string, pick: PointAt[], note: string }} Weld
 */

export class WeldError extends Error {}

/** @param {Doc} doc @param {string} id */
function needPart(doc, id) {
  const part = findObject(doc, id);
  if (!part || part.type !== 'path') throw new WeldError(`there is no part "${id}"`);
  return part;
}

/** @param {Doc} doc @param {PointAt} at */
function needVertex(doc, at) {
  const part = needPart(doc, at.part);
  const vertex = verticesOf(part)[at.index];
  if (!vertex) throw new WeldError(`${at.part} has no vertex ${at.index}`);
  return { part, vertex };
}

/** @param {Map<string, Vertex[]>} changes @returns {Operation[]} */
export const vertexOps = (changes) => [...changes].map(([id, vertices]) => ({ op: 'set', target: id, props: { vertices: vertices.map(roundVertex) } }));

/**
 * After a point stops being "old" (it now shares "next", or was renamed to it): the vertices that shared it and the
 * point groups that had it name "next" instead (null: the vertices keep their place as their own points, and the
 * groups drop it). Adds the new vertices to `changes` and returns the groups op, if any.
 * @param {Doc} doc @param {string} layer @param {string} old @param {string | null} next
 * @param {Map<string, Vertex[]>} changes
 * @returns {Operation[]}
 */
export function redirect(doc, layer, old, next, changes) {
  for (const o of doc.objects) {
    if (o.parent !== layer) continue;
    const vertices = changes.get(o.id) ?? verticesOf(o);
    if (!vertices.some((v) => v.ref === old)) continue;
    changes.set(
      o.id,
      vertices.map((v) => {
        if (v.ref !== old) return v;
        if (next) return { ...v, ref: next };
        const { ref: _ref, ...own } = v;
        return own;
      }),
    );
  }
  const groups = /** @type {Record<string, string[]> | undefined} */ (findObject(doc, layer)?.groups);
  if (!groups || !Object.values(groups).some((members) => members.includes(old))) return [];
  const renamed = Object.fromEntries(
    Object.entries(groups).map(([g, members]) => [g, [...new Set(members.flatMap((m) => (m !== old ? [m] : next ? [next] : [])))]]),
  );
  return [{ op: 'set', target: layer, props: { groups: renamed } }];
}

/** Whether a named point of a part is shared by another. @param {Doc} doc @param {DocObject} part @param {Vertex} v */
export const isShared = (doc, part, v) => !!v.name && doc.objects.some((o) => verticesOf(o).some((w) => w.ref === `${part.id}.${v.name}`));

/**
 * The point `a` of part `a.part` shares the point `bi` of part `b` (whose vertices are `bVertices`: one may have
 * just been added), named first if it has no name. Whoever shared a's point shares b's.
 * @param {Doc} doc @param {PointAt} a @param {DocObject} b @param {Vertex[]} bVertices @param {number} bi
 * @returns {Weld}
 */
function share(doc, a, b, bVertices, bi) {
  const { part, vertex: moving } = needVertex(doc, a);
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  const target = bVertices[bi];
  let owner = target.ref;
  if (!owner) {
    const name = target.name ?? nextPointName(b);
    owner = `${b.id}.${name}`;
    if (!target.name) bVertices = bVertices.map((v, i) => (i === bi ? { ...v, name } : v));
    if (bVertices !== verticesOf(b)) changes.set(b.id, bVertices);
  }
  const shared = owner;
  if (splitRef(shared)[0] === part.id) throw new WeldError(`${part.id} cannot share its own point ${shared}`);
  if (b.parent !== part.parent) throw new WeldError(`${part.id} and ${b.id} are in different layers: only parts of the same layer share points`);
  changes.set(
    part.id,
    verticesOf(part).map((v, i) => (i === a.index ? { ref: shared, x: target.x, y: target.y, ...(v.in ? { in: v.in } : {}), ...(v.out ? { out: v.out } : {}) } : v)),
  );
  const groupOps = moving.name ? redirect(doc, String(part.parent), `${part.id}.${moving.name}`, shared, changes) : [];
  return { ops: [...vertexOps(changes), ...groupOps], keep: part.id, pick: [a], note: `Weld ${part.id}.${moving.name ?? a.index} to ${shared}` };
}

/**
 * Welds a point to a target. The two ends of one line close it. With `merge`, an open end on an open end of another
 * line joins the two lines into the target's part (the other is deleted). Otherwise the point shares the target
 * point, or a point added on the target's line.
 * @param {Doc} doc resolved @param {PointAt} moving @param {WeldTarget} target @param {{ merge?: boolean }} [options]
 * @returns {Weld}
 */
export function weld(doc, moving, target, { merge = false } = {}) {
  const { part: a } = needVertex(doc, moving);
  if (!('index' in target)) {
    const b = needPart(doc, target.part);
    if (b.id === a.id) throw new WeldError(`${a.id} cannot weld to its own line`);
    if (verticesOf(b)[target.segment]?.follow) throw new WeldError(`that stretch of ${b.id} follows ${verticesOf(b)[target.segment].follow}: weld to that part instead`);
    const { vertices, index } = insertVertex(b, target.segment, target.t);
    return share(doc, moving, b, vertices, index);
  }
  const { part: b } = needVertex(doc, target);
  const aEnd = endOf(a, moving.index);
  const bEnd = endOf(b, target.index);
  if (a.id === b.id) {
    if (!aEnd || !bEnd || aEnd === bEnd) throw new WeldError(`within ${a.id}, only its two open ends weld (and that closes it)`);
    return { ops: [{ op: 'set', target: b.id, props: closeOutline(b, bEnd) }], keep: b.id, pick: [], note: `Weld: close ${b.id}` };
  }
  if (merge) {
    if (!aEnd || !bEnd) throw new WeldError('joining into one line needs two open ends of two lines');
    return {
      ops: [
        { op: 'set', target: b.id, props: { vertices: joinOutlines(a, aEnd, b, bEnd) } },
        { op: 'delete', target: a.id },
      ],
      keep: b.id,
      pick: [],
      note: `Weld ${a.id} into ${b.id}`,
    };
  }
  return share(doc, moving, b, verticesOf(b), target.index);
}

/**
 * Unweld: the points stop sharing; each vertex keeps its place as a point of its own. A point that others share is
 * unwelded from all of them.
 * @param {Doc} doc resolved @param {PointAt[]} points
 * @returns {Operation[]}
 */
export function unweld(doc, points) {
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  /** @type {Operation[]} */
  const groupOps = [];
  for (const at of points) {
    const { part, vertex } = needVertex(doc, at);
    const vertices = changes.get(part.id) ?? verticesOf(part);
    if (vertex.ref) {
      const { ref: _ref, follow: _follow, way: _way, ...own } = vertices[at.index];
      changes.set(part.id, vertices.map((v, i) => (i === at.index ? own : v)));
    } else if (vertex.name && isShared(doc, part, vertex)) groupOps.push(...redirect(doc, String(part.parent), `${part.id}.${vertex.name}`, null, changes));
  }
  if (!changes.size) throw new WeldError('none of these points is welded');
  return [...vertexOps(changes), ...groupOps];
}

/**
 * Names a point (an empty name takes it away, if nothing uses it). Shared points and groups follow the new name.
 * @param {Doc} doc resolved @param {PointAt} at @param {string} typed
 * @returns {{ ops: Operation[], name: string | undefined }}
 */
export function namePoint(doc, at, typed) {
  const { part, vertex } = needVertex(doc, at);
  if (vertex.ref) throw new WeldError(`this point shares ${vertex.ref}: name it there`);
  const old = vertex.name;
  const taken = new Set(verticesOf(part).filter((_, i) => i !== at.index).map((v) => v.name));
  const name = typed.trim() ? idFromName(typed, (x) => taken.has(x)) : undefined;
  if (name === old) return { ops: [], name };
  const oldRef = old ? `${part.id}.${old}` : '';
  const groups = /** @type {Record<string, string[]>} */ (findObject(doc, String(part.parent))?.groups ?? {});
  const used = !!old && (isShared(doc, part, vertex) || Object.values(groups).some((m) => m.includes(oldRef)));
  if (!name && used) throw new WeldError(`${oldRef} is shared or in a group, so it keeps a name`);
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  changes.set(
    part.id,
    verticesOf(part).map((v, i) => {
      if (i !== at.index) return v;
      const { name: _name, ...rest } = v;
      return name ? { ...rest, name } : rest;
    }),
  );
  const groupOps = old && name ? redirect(doc, String(part.parent), oldRef, `${part.id}.${name}`, changes) : [];
  return { ops: [...vertexOps(changes), ...groupOps], name };
}

/**
 * Points as named points ("part.point"), naming the ones without a name (part_1, part_2…); a shared vertex stands for
 * the point it shares.
 * @param {Doc} doc resolved @param {PointAt[]} points
 * @returns {{ refs: string[], changes: Map<string, Vertex[]> }}
 */
export function namedRefs(doc, points) {
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  /** @type {string[]} */
  const refs = [];
  /** @type {Map<string, Set<string>>} */
  const given = new Map();
  for (const at of points) {
    const { part, vertex } = needVertex(doc, at);
    if (vertex.ref) {
      refs.push(vertex.ref);
      continue;
    }
    let name = vertex.name;
    if (!name) {
      const taken = given.get(part.id) ?? new Set();
      name = nextPointName(part, taken);
      taken.add(name);
      given.set(part.id, taken);
      const named = name;
      const vertices = changes.get(part.id) ?? verticesOf(part);
      changes.set(part.id, vertices.map((v, i) => (i === at.index ? { ...v, name: named } : v)));
    }
    refs.push(`${part.id}.${name}`);
  }
  return { refs: [...new Set(refs)], changes };
}

/**
 * Changes the point groups of a vector layer with some points: set a group to exactly them (a new group, or
 * replaced), add them, take them out, or delete the group.
 * @param {Doc} doc resolved @param {string} layer @param {'set' | 'add' | 'remove' | 'delete'} action @param {string} group
 * @param {PointAt[]} points
 * @returns {{ ops: Operation[], name: string }}
 */
export function groupOps(doc, layer, action, group, points) {
  const holder = findObject(doc, layer);
  if (!holder || holder.type !== 'vector') throw new WeldError(`there is no vector layer "${layer}" (point groups belong to a vector layer)`);
  const groups = { .../** @type {Record<string, string[]>} */ (holder.groups ?? {}) };
  const { refs, changes } = action === 'delete' ? { refs: [], changes: new Map() } : namedRefs(doc, points);
  for (const at of points) if (findObject(doc, at.part)?.parent !== layer) throw new WeldError(`${at.part} is not in ${layer}`);
  if ((action === 'set' || action === 'add') && !refs.length) throw new WeldError('a group needs points');
  if (action !== 'set' && !(group in groups)) throw new WeldError(`${layer} has no group "${group}" (groups: ${Object.keys(groups).join(', ') || 'none'})`);
  const name = action === 'set' && !(group in groups) ? idFromName(group || 'group', (x) => x in groups) : group;
  if (action === 'set') groups[name] = refs;
  else if (action === 'add') groups[name] = [...new Set([...groups[name], ...refs])];
  else if (action === 'remove') groups[name] = groups[name].filter((m) => !refs.includes(m));
  else delete groups[name];
  // Taking points out names nothing new.
  const named = action === 'remove' ? [] : vertexOps(changes);
  return { ops: [...named, { op: 'set', target: layer, props: { groups: Object.keys(groups).length ? groups : null } }], name };
}

/**
 * The stretch between two points, if it can follow another part: both in one part and next to each other, both
 * sharing points of one other part. `from` is the one the stretch starts at.
 * @param {Doc} doc resolved @param {PointAt} a @param {PointAt} b
 */
export function stretchBetween(doc, a, b) {
  const first = needVertex(doc, a);
  const second = needVertex(doc, b);
  if (a.part !== b.part) throw new WeldError('a followed stretch is between two points of the same part');
  const n = verticesOf(first.part).length;
  const closed = first.part.closed !== false;
  /** @param {PointAt} x @param {PointAt} y */
  const before = (x, y) => (x.index + 1 < n ? x.index + 1 === y.index : closed && y.index === 0);
  const [from, fromVertex, toVertex] = before(a, b) ? [a, first.vertex, second.vertex] : before(b, a) ? [b, second.vertex, first.vertex] : [null, null, null];
  if (!from || !fromVertex || !toVertex) throw new WeldError('the two points must be next to each other in their part');
  const part = first.part;
  const [idA, idB] = [pointIdOf(part, fromVertex), pointIdOf(part, toVertex)];
  if (!idA || !idB) throw new WeldError('both points must be welded to the part to follow (weld them first)');
  // The parts that pass through both points (own them or share them): of those that do not follow others, the one
  // followed now first, then the owner of the first point, then any other.
  const through = doc.objects.filter(
    (o) => o.type === 'path' && o.id !== part.id && o.parent === part.parent && passIndex(o, idA) >= 0 && passIndex(o, idB) >= 0,
  );
  const lines = through.filter((o) => !followsOthers(o));
  const owner = fromVertex.ref ? splitRef(fromVertex.ref)[0] : null;
  const rank = (/** @type {DocObject} */ o) => (o.id === fromVertex.follow ? 0 : o.id === owner ? 1 : 2);
  const other = lines.sort((x, y) => rank(x) - rank(y))[0]?.id ?? (fromVertex.follow ? String(fromVertex.follow) : null);
  if (!other) {
    const follower = through.length > 0;
    throw new WeldError(
      follower
        ? 'the only part through both points follows other parts itself: follow lines, not parts that follow'
        : 'no other part passes through both points (weld them to the same line first)',
    );
  }
  return { part, index: from.index, other, follows: fromVertex.follow === other, long: fromVertex.way === 'long' };
}

/**
 * Makes the stretch between two points follow the part they share points with, the short way or the long way, or
 * stop following it (off).
 * @param {Doc} doc resolved @param {PointAt} a @param {PointAt} b @param {'short' | 'long' | 'off'} how
 * @returns {{ ops: Operation[], note: string }}
 */
export function followOps(doc, a, b, how) {
  const s = stretchBetween(doc, a, b);
  const vertices = verticesOf(s.part).map((v, i) => {
    if (i !== s.index) return v;
    const { follow: _follow, way: _way, ...rest } = v;
    if (how === 'off') return rest;
    return { ...rest, follow: s.other, ...(how === 'long' ? { way: 'long' } : {}) };
  });
  const note = how === 'off' ? `${s.part.id} stops following ${s.other}` : `${s.part.id} follows ${s.other}${how === 'long' ? ' the long way' : ''}`;
  return { ops: [{ op: 'set', target: s.part.id, props: { vertices: vertices.map(roundVertex) } }], note };
}

/**
 * What a new outline needs to weld some of its vertices as it is created: for each target, the point it shares
 * ("part.point"), naming points and adding points on lines as needed, and the ops that do that to the other parts.
 * Targets on the same part are handled together, so indices stay right.
 * @param {Doc} doc resolved @param {(WeldTarget | null)[]} targets one per vertex of the new outline
 * @returns {{ ops: Operation[], refs: (string | null)[] }}
 */
export function shareTargets(doc, targets) {
  /** @type {Map<string, Vertex[]>} */
  const changes = new Map();
  /** @type {(string | null)[]} */
  const refs = targets.map(() => null);
  /** @param {string} id */
  const verticesNow = (id) => changes.get(id) ?? verticesOf(needPart(doc, id));
  // 1. Points added on lines, the last stretch first so the earlier ones keep their index.
  /** @type {Map<string, { i: number, segment: number, t: number }[]>} */
  const onLines = new Map();
  targets.forEach((target, i) => {
    if (target && !('index' in target)) onLines.set(target.part, [...(onLines.get(target.part) ?? []), { i, segment: target.segment, t: target.t }]);
  });
  /** @type {Map<number, PointAt>} where each added point ended up */
  const added = new Map();
  /** @type {Map<string, number[]>} the stretches split in each part (to shift the indices of its other points) */
  const split = new Map();
  for (const [id, list] of onLines) {
    list.sort((a, b) => b.segment - a.segment || b.t - a.t);
    /** @type {{ segment: number, t: number } | null} */
    let previous = null;
    for (const item of list) {
      // A second point on a stretch already split falls on its first half.
      const t = previous && previous.segment === item.segment ? item.t / previous.t : item.t;
      const { vertices, index } = insertVertex({ ...needPart(doc, id), vertices: verticesNow(id) }, item.segment, t);
      for (const place of added.values()) if (place.part === id && place.index >= index) place.index++;
      added.set(item.i, { part: id, index });
      changes.set(id, vertices);
      previous = item;
    }
    split.set(id, list.map((item) => item.segment));
  }
  // 2. The points shared: named if they have no name yet.
  /** @type {Map<string, Set<string>>} */
  const given = new Map();
  targets.forEach((target, i) => {
    if (!target) return;
    let id;
    let index;
    if ('index' in target) {
      ({ part: id, index } = target);
      const at = index;
      index += (split.get(id) ?? []).filter((segment) => segment + 1 <= at).length;
    } else ({ part: id, index } = /** @type {PointAt} */ (added.get(i)));
    const vertices = verticesNow(id);
    const v = vertices[index];
    if (v.ref) {
      refs[i] = v.ref;
      return;
    }
    let name = v.name;
    if (!name) {
      const taken = given.get(id) ?? new Set();
      name = nextPointName({ ...needPart(doc, id), vertices }, taken);
      taken.add(name);
      given.set(id, taken);
      const named = name;
      changes.set(id, vertices.map((w, j) => (j === index ? { ...w, name: named } : w)));
    }
    refs[i] = `${id}.${name}`;
  });
  return { ops: vertexOps(changes), refs };
}

/**
 * Deleting points, the same for the editor (Del) and the AI (aia delete-point), in one batch: each part loses its
 * picked points, and a part left with fewer than 2 (an outline needs 2) is deleted with them. Whoever shared a deleted
 * point, or followed a deleted part, keeps its place (settleBatch mends that).
 * @param {Doc} doc resolved @param {PointAt[]} points
 * @returns {{ ops: Operation[], gone: string[] }} gone: the parts deleted whole
 */
export function deletePointsOps(doc, points) {
  /** @type {Map<string, Set<number>>} */
  const byPart = new Map();
  for (const at of points) byPart.set(at.part, new Set([...(byPart.get(at.part) ?? []), at.index]));
  /** @type {Operation[]} */
  const ops = [];
  /** @type {string[]} */
  const gone = [];
  for (const [id, indices] of byPart) {
    const kept = verticesOf(needPart(doc, id)).filter((_, i) => !indices.has(i));
    if (kept.length < 2) {
      ops.push({ op: 'delete', target: id });
      gone.push(id);
    } else ops.push({ op: 'set', target: id, props: { vertices: kept.map(roundVertex) } });
  }
  return { ops, gone };
}
