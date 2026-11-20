// Named points, shared points and point groups (decision 6 in docs/rebuild.md).
//
// - A vertex may have a name, unique in its part: { x, y, name: 'chin' }. Elsewhere it is called "jaw.chin".
// - A vertex may share a point of another part of the same layer: { ref: 'jaw.chin', in?, out? }. It has no x, y of
//   its own: it is where jaw.chin is (its handles are its own, the curve on its outline). This is how parts are
//   welded, as in Moho: moving the point moves both outlines.
// - A vector layer may have point groups: groups: { upper_lid: ['lid.top', 'brow.mid'] }, named points of its parts.
// - A stretch of an outline may follow another part's curve: { ref: 'jaw.ear_l', follow: 'jaw' }, { ref: 'jaw.chin' }
//   draws from ear_l to chin along jaw's own outline (its points and curves in between), so it changes when jaw
//   does. Both ends are points jaw passes through: points jaw owns, or points of a third part that jaw shares too
//   (a junction where two lines were welded). On a closed jaw it goes the short way, or the other with way: 'long'.
//   The followed part must not follow others itself (a fill follows lines, not other fills).
// - A part may hide stretches of its stroke: hiddenEdges: [['head.p2', 'head.p3']], each the two points at the ends of
//   one stretch it draws (for a part that follows a line, a piece of that line between two of its points). The fill
//   is not changed. Drawing knows the point at each drawn vertex (strokedOutlines).
//
// The stored document keeps references as they are; resolveDoc fills in where each shared vertex is, for drawing and
// for the editor. settleOps turns a batch written against the resolved document (shared vertices with x, y) into one
// for the stored document: a moved shared vertex moves the point it shares, and a shared vertex whose point is gone
// stays where it was as a point of its own.

import { ID, findObject } from './document.js';
import { HOLES, OUTLINE, holeOutlinesOf, holesOf, outlineOf, round2, stretchesIn, verticesOf } from './geometry.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Vertex} Vertex
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {Record<string, string[]>} PointGroups
 * @typedef {import('./geometry.js').Point} Point
 * @typedef {[string, string]} Edge the two points at the ends of a drawn stretch, "part.point" each
 * @typedef {{ id: string | null, at: { part: string, index: number } | null }} DrawnPoint what a drawn vertex is: its
 *   point ("part.point", null when it has no name) and the vertex it comes from (null for a hole's own vertex)
 * @typedef {{ vertices: Vertex[], points: DrawnPoint[], closed: boolean, hole: number }} StrokedOutline an
 *   outline a part strokes (hole: which hole, or -1 for its own) and what each of its vertices is
 */

/** What each vertex a part draws through is (parallel to outlineOf), set by resolveDoc; never saved. */
const OUTLINE_POINTS = Symbol('outlinePoints');
/** The same for its holes (parallel to holeOutlinesOf). */
const HOLE_POINTS = Symbol('holePoints');

/** "jaw.chin": a named point of a part. */
export const POINT_REF = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

/** @param {string} ref @returns {[string, string]} the part and the point name */
export const splitRef = (ref) => /** @type {[string, string]} */ (ref.split('.'));

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

/** Every vertex of a part: its outline's and its holes'. @param {DocObject} o */
const allVertices = (o) => [...verticesOf(o), ...holesOf(o).flat()];

/** The parts a part follows, in its outline and its holes (a shape follows lines; a line follows none). @param {DocObject} part */
export const followedLines = (part) => new Set(allVertices(part).flatMap((v) => (v.follow ? [String(v.follow)] : [])));

/** Whether a part follows others (a shape): those are not lines, so they close no gap and are not followed. @param {DocObject} part */
export const followsOthers = (part) => allVertices(part).some((v) => v.follow);

/** Whether a document has any shared vertex. @param {Doc} doc */
const hasRefs = (doc) => doc.objects.some((o) => allVertices(o).some((v) => v.ref));

/**
 * A hole seen as a part of its own (a closed outline of the same part, in the same layer), so the rules for shared
 * points and followed stretches apply to it as they do to the outline.
 * @param {DocObject} part @param {Vertex[]} hole
 * @returns {DocObject}
 */
export const holeAsPart = (part, hole) => ({ ...part, vertices: hole, closed: true, holes: undefined });

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
      if (!allVertices(o).some((v) => v.ref)) return o;
      /** @param {Vertex} v */
      const place = (v) => {
        if (!v.ref) return v;
        const shared = pointOf(doc, v.ref)?.vertex;
        return shared && !shared.ref ? { ...v, x: shared.x, y: shared.y } : v;
      };
      const holes = holesOf(o);
      return { ...o, vertices: verticesOf(o).map(place), ...(holes.length ? { holes: holes.map((hole) => hole.map(place)) } : {}) };
    }),
  };
  for (const o of placed.objects) {
    if (verticesOf(o).some((v) => v.follow)) {
      const { outline, points } = followedOutline(placed, o);
      Object.assign(o, { [OUTLINE]: outline, [OUTLINE_POINTS]: points });
    }
    const holes = holesOf(o);
    if (holes.some((hole) => hole.some((v) => v.follow))) {
      const followed = holes.map((hole) => followedOutline(placed, holeAsPart(o, hole), true));
      Object.assign(o, { [HOLES]: followed.map((f) => f.outline), [HOLE_POINTS]: followed.map((f) => f.points) });
    }
  }
  return placed;
}

/**
 * The point a vertex is, as "part.point": the point it shares, or its own when it has a name; null otherwise.
 * @param {DocObject} part @param {Vertex} v
 */
export const pointIdOf = (part, v) => (v.ref ? String(v.ref) : v.name ? `${part.id}.${v.name}` : null);

/**
 * Where a part passes through a point ("part.point"): the index of its vertex that owns it or shares it, or -1.
 * @param {DocObject} part @param {string} id
 */
export const passIndex = (part, id) => verticesOf(part).findIndex((v) => pointIdOf(part, v) === id);

/** @param {Vertex} v @returns {Vertex} the vertex with its handles swapped (walked the other way) */
const flipped = (v) => ({ x: v.x, y: v.y, ...(v.out ? { in: v.out } : {}), ...(v.in ? { out: v.in } : {}) });

/**
 * The stretch from vertex `i` of a part to the next one along the part it follows, or why it cannot be.
 * @param {Doc} doc resolved @param {DocObject} part @param {number} i
 * @returns {{ error: string } | { startOut?: Point, inner: Vertex[], innerPoints: DrawnPoint[], endIn?: Point }}
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
  if (followsOthers(other)) return { error: `${where}, which follows other parts itself: follow lines, not parts that follow` };
  const next = vertices[nextIndex];
  const idA = pointIdOf(part, v);
  const idB = pointIdOf(part, next);
  const a = { index: idA ? passIndex(other, idA) : -1 };
  const b = { index: idB ? passIndex(other, idB) : -1 };
  if (a.index < 0 || b.index < 0) {
    return { error: `${where}: this point and the next one must both be points ${other.id} passes through (weld them to it first)` };
  }
  if (a.index === b.index) return { error: `${where}: this point and the next one are the same point of ${other.id}` };
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
  /** @type {DrawnPoint[]} */
  const ids = [];
  for (let k = a.index; ; k = (k + (forward ? 1 : -1) + n) % n) {
    walked.push(forward ? path[k] : flipped(path[k]));
    ids.push({ id: pointIdOf(other, path[k]), at: { part: other.id, index: k } });
    if (k === b.index) break;
  }
  const first = walked[0];
  const last = walked[walked.length - 1];
  return {
    startOut: first.out,
    inner: walked.slice(1, -1).map((w) => ({ x: w.x, y: w.y, ...(w.in ? { in: w.in } : {}), ...(w.out ? { out: w.out } : {}) })),
    innerPoints: ids.slice(1, -1),
    endIn: last.in,
  };
}

/**
 * Where an outline with followed stretches goes: its own vertices with the other part's points in between, and the
 * handles at the ends of each stretch taken from that part; and what each of those vertices is.
 * @param {Doc} doc resolved @param {DocObject} part @param {boolean} [hole] whether it is a hole (holeAsPart)
 * @returns {{ outline: Vertex[], points: DrawnPoint[] }}
 */
function followedOutline(doc, part, hole = false) {
  const vertices = verticesOf(part);
  const closed = part.closed !== false;
  const stretches = vertices.map((v, i) => {
    if (!v.follow) return null;
    const s = followStretch(doc, part, i);
    return 'error' in s ? null : s;
  });
  /** @type {Vertex[]} */
  const outline = [];
  /** @type {DrawnPoint[]} */
  const points = [];
  for (const [i, v] of vertices.entries()) {
    const before = stretches[i > 0 ? i - 1 : closed ? vertices.length - 1 : -1];
    const after = stretches[i];
    const inHandle = before ? before.endIn : v.in;
    const outHandle = after ? after.startOut : v.out;
    outline.push({ x: v.x, y: v.y, ...(inHandle ? { in: inHandle } : {}), ...(outHandle ? { out: outHandle } : {}) });
    points.push({ id: pointIdOf(part, v), at: hole ? null : { part: part.id, index: i } });
    if (after) {
      outline.push(...after.inner);
      points.push(...after.innerPoints);
    }
  }
  return { outline, points };
}

/**
 * The outlines a part strokes: its own and its holes', with what each of their vertices is. Parts that follow others
 * need a resolved document.
 * @param {DocObject} part
 * @returns {StrokedOutline[]}
 */
export function strokedOutlines(part) {
  const closed = part.closed !== false;
  const own = /** @type {DrawnPoint[]} */ (/** @type {any} */ (part)[OUTLINE_POINTS] ?? verticesOf(part).map((v, index) => ({ id: pointIdOf(part, v), at: { part: part.id, index } })));
  const holePoints = /** @type {DrawnPoint[][]} */ (/** @type {any} */ (part)[HOLE_POINTS] ?? holesOf(part).map((hole) => hole.map((v) => ({ id: pointIdOf(part, v), at: null }))));
  return [
    { vertices: outlineOf(part), points: own, closed, hole: -1 },
    ...(closed ? holeOutlinesOf(part).map((vertices, h) => ({ vertices, points: holePoints[h] ?? [], closed: true, hole: h })) : []),
  ];
}

/** The same pair of points, whichever way it is written. @param {string} a @param {string} b */
export const edgeKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** The hidden edges of a part, as written. @param {DocObject} part @returns {Edge[]} */
export const hiddenEdgesOf = (part) => /** @type {Edge[]} */ (Array.isArray(part.hiddenEdges) ? part.hiddenEdges : []);

/**
 * The pair of points at the ends of each stretch of an outline (null where an end is no named point).
 * @param {{ points: DrawnPoint[], closed: boolean }} outline
 * @returns {(Edge | null)[]}
 */
export function stretchEnds({ points, closed }) {
  const n = points.length;
  return Array.from({ length: stretchesIn(n, closed) }, (_, k) => {
    const a = points[k].id;
    const b = points[(k + 1) % n].id;
    return a && b && a !== b ? /** @type {Edge} */ ([a, b]) : null;
  });
}

/** The keys of every stretch a part draws. @param {DocObject} part resolved */
const drawnEdgeKeys = (part) => new Set(strokedOutlines(part).flatMap((o) => stretchEnds(o).flatMap((e) => (e ? [edgeKey(...e)] : []))));

/**
 * What is wrong with the named points, shared points and point groups of a document, or null.
 * @param {Doc} doc
 */
export function pointsError(doc) {
  // Resolved once, when the first followed stretch needs it (once per stretch made a batch on a layer of 1000 shapes
  // take seconds).
  /** @type {Doc | null} */
  let resolved = null;
  /**
   * What is wrong with the points of one outline (a part's, or one of its holes), or null.
   * @param {DocObject} object the part, or a hole as a part (holeAsPart)
   * @param {string} label how its points are called: the part's id, or "hole 0 of fill_1"
   * @param {number} hole which hole it is, or -1 for the part's own outline
   */
  const outlineError = (object, label, hole) => {
    /** @type {Set<string>} */
    const names = new Set();
    for (const [i, v] of verticesOf(object).entries()) {
      if (v.name) {
        if (names.has(v.name)) return `${object.id} has two points named "${v.name}"`;
        names.add(v.name);
      }
      if (v.follow) {
        resolved ??= resolveDoc(doc);
        const shown = /** @type {DocObject} */ (findObject(resolved, object.id));
        const stretch = followStretch(resolved, hole < 0 ? shown : holeAsPart(shown, holesOf(shown)[hole]), i);
        if ('error' in stretch) return hole < 0 ? stretch.error : `${label}: ${stretch.error}`;
      }
      if (!v.ref) continue;
      const [partId] = splitRef(v.ref);
      const shared = pointOf(doc, v.ref);
      const where = `point ${i} of ${label} shares "${v.ref}"`;
      if (!shared) return `${where}, but there is no such point (name the point in its part first)`;
      if (partId === object.id) return `${where}: a part cannot share a point with itself`;
      if (shared.part.parent !== object.parent) return `${where}, which is in another layer (only parts of the same layer share points)`;
      if (shared.vertex.ref) return `${where}, which itself shares "${shared.vertex.ref}": share that one instead`;
    }
    return null;
  };
  for (const object of doc.objects) {
    const problem = outlineError(object, object.id, -1);
    if (problem) return problem;
    for (const [h, hole] of holesOf(object).entries()) {
      const holeProblem = outlineError(holeAsPart(object, hole), `hole ${h} of ${object.id}`, h);
      if (holeProblem) return holeProblem;
    }
    const edges = hiddenEdgesOf(object);
    if (edges.length) {
      resolved ??= resolveDoc(doc);
      const drawn = drawnEdgeKeys(/** @type {DocObject} */ (findObject(resolved, object.id)));
      const stray = edges.find((e) => !drawn.has(edgeKey(...e)));
      if (stray) {
        return `${object.id} hides the edge ${stray[0]} – ${stray[1]}, but it draws no stretch between those two points (they must be next to each other along its stroke)`;
      }
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
  /** @param {Vertex} v */
  const renamed = (v) => ({ ...v, ...(v.ref ? { ref: rename(v.ref) } : {}), ...(v.follow === from ? { follow: to } : {}) });
  for (const o of doc.objects) {
    if (verticesOf(o).some((v) => v.ref || v.follow)) o.vertices = verticesOf(o).map(renamed);
    if (holesOf(o).length) o.holes = holesOf(o).map((hole) => hole.map(renamed));
    const groups = /** @type {PointGroups | undefined} */ (o.groups);
    if (groups) o.groups = Object.fromEntries(Object.entries(groups).map(([g, members]) => [g, members.map(rename)]));
    if (hiddenEdgesOf(o).length) o.hiddenEdges = hiddenEdgesOf(o).map(([a, b]) => [rename(a), rename(b)]);
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
  // A batch that is not well formed goes as it is: the operations engine says what is wrong with it.
  if (!wellFormed(ops)) return ops;
  const resolved = resolveDoc(doc);
  /** @param {Operation} op */
  const stripped = (op) => {
    if (!op.props?.vertices && !op.props?.holes) return op;
    const props = { ...op.props };
    if (Array.isArray(props.vertices)) props.vertices = props.vertices.map(storedVertex);
    if (Array.isArray(props.holes)) props.holes = props.holes.map((/** @type {unknown} */ hole) => (Array.isArray(hole) ? hole.map(storedVertex) : hole));
    return { ...op, props };
  };
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
  // Only what this batch took away is mended: a point that was there before and is gone now. A reference that
  // never named a point (a typo) is left as it is, so the batch is refused with the reason.
  /** @param {string} ref */
  const lost = (ref) => !!pointOf(doc, ref) && !pointOf(after, ref);
  /** @type {Set<string>} "part:index" of the vertices that stopped sharing here */
  const unshared = new Set();
  // Shared vertices whose point is gone stay where they were, as points of their own.
  for (const o of after.objects) {
    if (!verticesOf(o).some((v) => v.ref && lost(v.ref))) continue;
    const there = findObject(wanted, o.id);
    const vertices = verticesOf(o).map((v, i) => {
      if (!v.ref || !lost(v.ref)) return v;
      // Where the editor put it, else where its point was before this batch.
      const meant = verticesOf(there ?? o)[i];
      const at = meant && Number.isFinite(meant.x) && Number.isFinite(meant.y) ? meant : pointOf(resolved, v.ref)?.vertex;
      unshared.add(`${o.id}:${i}`);
      return ownVertex({ ...v, x: Number(at?.x ?? 0), y: Number(at?.y ?? 0) });
    });
    fix(o, { vertices });
  }
  // A hole that shared a point that is gone goes with it (its shape came from that line); a hole's stretch that
  // followed a part that is gone becomes a plain stretch.
  /** @param {Vertex} v */
  const followsGone = (v) => !!v.follow && !!findObject(doc, String(v.follow)) && !findObject(after, String(v.follow));
  /** @param {Vertex} v @returns {Vertex} */
  const plain = (v) => {
    const { follow: _follow, way: _way, ...rest } = v;
    return rest;
  };
  for (const o of after.objects) {
    const holes = holesOf(o);
    if (!holes.some((hole) => hole.some((v) => (v.ref && lost(v.ref)) || followsGone(v)))) continue;
    const kept = holes.filter((hole) => !hole.some((v) => v.ref && lost(v.ref))).map((hole) => hole.map((v) => (followsGone(v) ? plain(v) : v)));
    fix(o, { holes: kept });
  }
  // Group members whose point is gone leave the group.
  for (const o of after.objects) {
    const groups = /** @type {PointGroups | undefined} */ (o.groups);
    if (!groups || Object.values(groups).every((members) => members.every((m) => !lost(m)))) continue;
    fix(o, { groups: Object.fromEntries(Object.entries(groups).map(([g, members]) => [g, members.filter((m) => !lost(m))])) });
  }
  // Followed stretches broken by what this batch took away (the part they follow, the points at their ends, or the
  // followed line no longer passing through one of them, as when a junction is unwelded) become plain stretches; in
  // holes too.
  const final = fixes.size ? apply(after, [...fixes].map(([target, props]) => ({ op: 'set', target, props }))) : after;
  const shown = resolveDoc(final);
  /**
   * Which stretches of an outline broke here: it followed fine before this batch and does not now.
   * @param {DocObject} now the outline as a part, resolved after the batch @param {DocObject | undefined} was the same, before
   */
  const brokenIn = (now, was) => {
    const vertices = verticesOf(now);
    const n = vertices.length;
    return vertices.map((v, i) => {
      if (!v.follow || !('error' in followStretch(shown, now, i))) return false;
      const followed = String(v.follow);
      const next = i + 1 < n ? i + 1 : 0;
      const tookAway = !!findObject(doc, followed) && (!findObject(final, followed) || unshared.has(`${now.id}:${i}`) || unshared.has(`${now.id}:${next}`));
      const old = was && verticesOf(was)[i];
      const workedBefore = !!old && old.follow === v.follow && old.ref === v.ref && !('error' in followStretch(resolved, /** @type {DocObject} */ (was), i));
      return tookAway || workedBefore;
    });
  };
  for (const o of final.objects) {
    const now = /** @type {DocObject} */ (findObject(shown, o.id));
    const was = findObject(resolved, o.id);
    const broken = brokenIn(now, was);
    const holes = holesOf(now);
    const brokenHoles = holes.map((hole, h) => brokenIn(holeAsPart(now, hole), was && holesOf(was)[h] ? holeAsPart(was, holesOf(was)[h]) : undefined));
    if (broken.some(Boolean)) fix(o, { vertices: verticesOf(o).map((v, i) => (broken[i] ? plain(v) : v)) });
    if (brokenHoles.some((b) => b.some(Boolean))) fix(o, { holes: holesOf(o).map((hole, h) => hole.map((v, i) => (brokenHoles[h][i] ? plain(v) : v))) });
  }
  // Hidden edges this batch made stale (a point gone, or the two points no longer next to each other along the
  // stroke, as when a point is added between them) are dropped, if they were there before it. One that never named
  // a drawn stretch, or that the batch wrote itself, is left, so the batch is refused with the reason.
  const settled = fixes.size ? apply(after, [...fixes].map(([target, props]) => ({ op: 'set', target, props }))) : after;
  const drawnNow = settled.objects.some((o) => hiddenEdgesOf(o).length) ? resolveDoc(settled) : settled;
  for (const o of settled.objects) {
    const edges = hiddenEdgesOf(o);
    if (!edges.length) continue;
    const now = drawnEdgeKeys(/** @type {DocObject} */ (findObject(drawnNow, o.id)));
    const was = findObject(resolved, o.id);
    const before = was ? drawnEdgeKeys(was) : new Set();
    const had = new Set(hiddenEdgesOf(findObject(doc, o.id) ?? o).map((e) => edgeKey(...e)));
    // A pair this batch wrote is the batch's own: pointsError says what is wrong with it.
    const stale = (/** @type {Edge} */ e) => had.has(edgeKey(...e)) && !now.has(edgeKey(...e)) && (before.has(edgeKey(...e)) || e.some(lost));
    const kept = edges.filter((e) => !stale(e));
    if (kept.length !== edges.length) fix(o, { hiddenEdges: kept });
  }
  return [...first, ...[...fixes].map(([target, props]) => ({ op: 'set', target, props }))];
}

/** @param {unknown} value */
const isName = (value) => typeof value === 'string' && ID.test(value);

/** Whether a batch has the shape settleOps can look at: operations as objects, and vertices as lists of objects. @param {unknown} ops */
function wellFormed(ops) {
  if (!Array.isArray(ops)) return false;
  return ops.every((op) => {
    if (!op || typeof op !== 'object') return false;
    const props = /** @type {any} */ (op).props;
    if (props === undefined) return true;
    if (!props || typeof props !== 'object') return false;
    const vertices = props.vertices;
    return vertices === undefined || (Array.isArray(vertices) && vertices.every((v) => v && typeof v === 'object'));
  });
}

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
 * @param {{ own?: boolean }} [options] own: a shared vertex stands for itself, not for the point it shares
 * @returns {{ part: string, index: number }[]} without repeats
 */
export function pointsNamed(doc, names, { own = false } = {}) {
  /** @type {Map<string, { part: string, index: number }>} */
  const found = new Map();
  /** @param {DocObject} part @param {number} index @param {string} name */
  const add = (part, index, name) => {
    const v = verticesOf(part)[index];
    if (v.ref && !own) {
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
  for (const { part, index } of points) {
    const object = /** @type {DocObject} */ (findObject(doc, part));
    const vertices = changes.get(part) ?? verticesOf(object).map((v) => ({ ...v }));
    const v = vertices[index];
    if (to) Object.assign(v, { x: round2(to.x), y: round2(to.y) });
    else if (by) Object.assign(v, { x: round2(v.x + by.x), y: round2(v.y + by.y) });
    changes.set(part, vertices);
  }
  return [...changes].map(([target, vertices]) => ({ op: 'set', target, props: { vertices } }));
}
