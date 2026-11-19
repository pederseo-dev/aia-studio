// Geometry of parts: affine matrices, the vertices of the shapes the tools draw, bounds, and how a part or some of its
// points change under a transform (move, scale, rotate). The editor and, later, the `aia` commands use the same
// functions, so a part ends up the same whoever changed it. Every part is a path (decision 8 in docs/rebuild.md).
//
// Matrices are [a, b, c, d, e, f], the ones SVG uses in matrix(...): (x, y) → (a·x + c·y + e, b·x + d·y + f).

/**
 * @typedef {[number, number, number, number, number, number]} Matrix
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ x: number, y: number, in?: Point, out?: Point, name?: string, ref?: string, follow?: string, way?: string }} Vertex
 *   name: a named point ("chin"); ref: a point shared with another part ("jaw.chin"); follow: the stretch to the next
 *   vertex follows that part's outline (way "long": the long way round); see points.js
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 */

const KAPPA = 0.5523; // handle length (× radius) that makes a quarter circle

/** @type {Matrix} */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

/** @param {Matrix} m @param {Matrix} n @returns {Matrix} m after n */
export const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** @param {number} x @param {number} y @returns {Matrix} */
export const translate = (x, y) => [1, 0, 0, 1, x, y];
/** @param {number} sx @param {number} sy @returns {Matrix} */
export const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
/** @param {number} degrees @returns {Matrix} */
export function rotate(degrees) {
  const r = (degrees * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
}
/** A matrix applied around a point. @param {Point} p @param {Matrix} m */
export const around = (p, m) => multiply(translate(p.x, p.y), multiply(m, translate(-p.x, -p.y)));

/**
 * The mirror of some points across the middle of their box: horizontal swaps left and right, vertical top and bottom.
 * @param {Point[]} points @param {boolean} horizontal
 * @returns {Matrix}
 */
export function flipAcross(points, horizontal) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const middle = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  return around(middle, horizontal ? scale(-1, 1) : scale(1, -1));
}

/** @param {Matrix} m @param {Point} p @returns {Point} */
export const apply =(m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
/** Without the translation: for handles, which are relative. @param {Matrix} m @param {Point} v @returns {Point} */
export const applyVector = (m, v) => ({ x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y });

/** The name or the shared point of a vertex (what survives a transform, and what two welded vertices keep). @param {Vertex} v */
const pointOnly = (v) => (v.ref ? { ref: v.ref } : v.name ? { name: v.name } : {});

/** What a vertex keeps through a transform besides its place: its name or shared point, and what it follows. @param {Vertex} v */
const extrasOf = (v) => ({ ...pointOnly(v), ...(v.follow ? { follow: v.follow } : {}), ...(v.way ? { way: v.way } : {}) });

/**
 * Where a part's outline really goes, when some of its stretches follow another part (set by resolveDoc in
 * points.js; never saved). Drawing, bounds and the editor's outlines use it; editing uses the part's own vertices.
 */
export const OUTLINE = Symbol('outline');

/** The vertices a part draws through: its outline with followed stretches, or its own vertices. @param {DocObject} part @returns {Vertex[]} */
export const outlineOf = (part) => /** @type {Vertex[]} */ (/** @type {any} */ (part)[OUTLINE] ?? part.vertices ?? []);

/** The holes of a part as saved: closed outlines cut out of its fill. @param {DocObject} part @returns {Vertex[][]} */
export const holesOf = (part) => /** @type {Vertex[][]} */ (part.holes ?? []);

/** Where a part's holes really go, with their followed stretches (set by resolveDoc; never saved). */
export const HOLES = Symbol('holes');

/** The holes a part draws: with followed stretches, or as saved. @param {DocObject} part @returns {Vertex[][]} */
export const holeOutlinesOf = (part) => /** @type {Vertex[][]} */ (/** @type {any} */ (part)[HOLES] ?? holesOf(part));

/** @param {number} n */
export const round2 = (n) => Math.round(n * 100) / 100 || 0;

/** A vertex with its numbers rounded to 2 decimals (what is saved). @param {Vertex} v @returns {Vertex} */
export function roundVertex(v) {
  return {
    ...extrasOf(v),
    x: round2(v.x),
    y: round2(v.y),
    ...(v.in ? { in: { x: round2(v.in.x), y: round2(v.in.y) } } : {}),
    ...(v.out ? { out: { x: round2(v.out.x), y: round2(v.out.y) } } : {}),
  };
}

/** @param {Vertex} v @param {Matrix} m @returns {Vertex} */
export function transformVertex(v, m) {
  const p = apply(m, v);
  /** @type {Vertex} */
  const out = { ...extrasOf(v), x: p.x, y: p.y };
  if (v.in) out.in = applyVector(m, v.in);
  if (v.out) out.out = applyVector(m, v.out);
  return out;
}

/**
 * The vertices of a rectangle, clockwise from the top-left corner; with a radius, its corners are rounded.
 * @param {Box} box @param {number} [radius]
 * @returns {Vertex[]}
 */
export function rectVertices({ x, y, width: w, height: h }, radius = 0) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0) return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const k = r * KAPPA;
  return [
    { x: x + r, y, in: { x: -k, y: 0 } },
    { x: x + w - r, y, out: { x: k, y: 0 } },
    { x: x + w, y: y + r, in: { x: 0, y: -k } },
    { x: x + w, y: y + h - r, out: { x: 0, y: k } },
    { x: x + w - r, y: y + h, in: { x: k, y: 0 } },
    { x: x + r, y: y + h, out: { x: -k, y: 0 } },
    { x, y: y + h - r, in: { x: 0, y: k } },
    { x, y: y + r, out: { x: 0, y: -k } },
  ];
}

/**
 * The 4 vertices of an ellipse inside a box (top, right, bottom, left), with the handles that make it round.
 * @param {Box} box
 * @returns {Vertex[]}
 */
export function ellipseVertices({ x, y, width: w, height: h }) {
  const kx = (w / 2) * KAPPA;
  const ky = (h / 2) * KAPPA;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return [
    { x: cx, y, in: { x: -kx, y: 0 }, out: { x: kx, y: 0 } },
    { x: x + w, y: cy, in: { x: 0, y: -ky }, out: { x: 0, y: ky } },
    { x: cx, y: y + h, in: { x: kx, y: 0 }, out: { x: -kx, y: 0 } },
    { x, y: cy, in: { x: 0, y: ky }, out: { x: 0, y: -ky } },
  ];
}

/** @param {DocObject} part @returns {Vertex[]} */
export const verticesOf = (part) => /** @type {Vertex[]} */ (part.vertices ?? []);

/**
 * The box around some vertices (with their curve handles: a little loose on curves, never too small).
 * @param {Vertex[]} vertices
 * @returns {Box | null}
 */
export function vertexBounds(vertices) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    for (const p of [v, v.in && { x: v.x + v.in.x, y: v.y + v.in.y }, v.out && { x: v.x + v.out.x, y: v.y + v.out.y }]) {
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The box around some parts. @param {DocObject[]} parts */
export const bounds = (parts) => vertexBounds(parts.flatMap(outlineOf));

/**
 * The origin of a part or a layer, if it has one set (null: it uses the center of its box).
 * @param {DocObject | Record<string, unknown>} object
 * @returns {Point | null}
 */
export function originOf(object) {
  const x = object.originX;
  const y = object.originY;
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
}

/**
 * The origin moved by a transform, as the properties to save (nothing when it has none).
 * @param {DocObject | Record<string, unknown>} object @param {Matrix} m
 * @returns {{ originX?: number, originY?: number }}
 */
export function transformOrigin(object, m) {
  const origin = originOf(object);
  if (!origin) return {};
  const p = apply(m, origin);
  return { originX: round2(p.x), originY: round2(p.y) };
}

/**
 * The properties a part gets when a transform is applied to all of it (its origin goes along).
 * @param {DocObject} part @param {Matrix} m
 * @returns {{ vertices: Vertex[], originX?: number, originY?: number }}
 */
export function transformPart(part, m) {
  const holes = holesOf(part);
  return {
    vertices: verticesOf(part).map((v) => roundVertex(transformVertex(v, m))),
    ...(holes.length ? { holes: holes.map((hole) => hole.map((v) => roundVertex(transformVertex(v, m)))) } : {}),
    ...transformOrigin(part, m),
  };
}

/** A vertex with its handles swapped (the outline walked the other way). @param {Vertex} v @returns {Vertex} */
function flip(v) {
  const { in: before, out: after, ...rest } = v;
  return { ...rest, ...(after ? { in: after } : {}), ...(before ? { out: before } : {}) };
}

/** @param {Vertex[]} vertices */
const reversed = (vertices) => [...vertices].reverse().map(flip);

/**
 * The ends of an open outline that a point index is: 'start', 'end', or null (a middle point, or a closed outline).
 * @param {DocObject} part @param {number} index
 * @returns {'start' | 'end' | null}
 */
export function endOf(part, index) {
  const count = verticesOf(part).length;
  if (part.closed !== false || count < 2) return null;
  if (index === 0) return 'start';
  if (index === count - 1) return 'end';
  return null;
}

/**
 * Welds the two ends of one open outline: it becomes closed, the two end points one (where `at` says).
 * @param {DocObject} part @param {'start' | 'end'} at which end stays where it is
 * @returns {{ vertices: Vertex[], closed: true }}
 */
export function closeOutline(part, at) {
  const vertices = verticesOf(part);
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  const keep = at === 'start' ? first : last;
  const other = at === 'start' ? last : first;
  /** @type {Vertex} */
  const merged = { ...pointOnly(keep.name || keep.ref ? keep : other), x: keep.x, y: keep.y, ...(last.in ? { in: last.in } : {}), ...(first.out ? { out: first.out } : {}) };
  return { vertices: [merged, ...vertices.slice(1, -1)].map(roundVertex), closed: true };
}

/**
 * Welds an end of one open outline to an end of another: one outline that goes through `a` and then `b`, with the
 * two end points merged where `b`'s end is.
 * @param {DocObject} a @param {'start' | 'end'} aEnd @param {DocObject} b @param {'start' | 'end'} bEnd
 * @returns {Vertex[]}
 */
export function joinOutlines(a, aEnd, b, bEnd) {
  const first = aEnd === 'end' ? verticesOf(a) : reversed(verticesOf(a));
  const second = bEnd === 'start' ? verticesOf(b) : reversed(verticesOf(b));
  const tail = first[first.length - 1];
  const head = second[0];
  /** @type {Vertex} */
  const merged = { ...pointOnly(head.name || head.ref ? head : tail), x: head.x, y: head.y, ...(tail.in ? { in: tail.in } : {}), ...(head.out ? { out: head.out } : {}) };
  return [...first.slice(0, -1), merged, ...second.slice(1)].map(roundVertex);
}

/**
 * The vertices of a part with only some of them transformed (point editing).
 * @param {DocObject} part @param {number[]} indices @param {Matrix} m
 * @returns {{ vertices: Vertex[] }}
 */
export function transformVertices(part, indices, m) {
  const picked = new Set(indices);
  return { vertices: verticesOf(part).map((v, i) => roundVertex(picked.has(i) ? transformVertex(v, m) : v)) };
}

/** The four control points of the stretch from vertex `i` to the next one. @param {Vertex[]} vertices @param {number} i @returns {[Point, Point, Point, Point]} */
function controlsOf(vertices, i) {
  const a = vertices[i];
  const b = vertices[(i + 1) % vertices.length];
  return [
    { x: a.x, y: a.y },
    { x: a.x + (a.out?.x ?? 0), y: a.y + (a.out?.y ?? 0) },
    { x: b.x + (b.in?.x ?? 0), y: b.y + (b.in?.y ?? 0) },
    { x: b.x, y: b.y },
  ];
}

/** @param {Point} p @param {Point} q @param {number} t @returns {Point} */
const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

/** De Casteljau: the point at t and the control points of both halves. @param {[Point, Point, Point, Point]} c @param {number} t */
function splitCubic([p0, p1, p2, p3], t) {
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  return { p01, p012, at: lerp(p012, p123, t), p123, p23 };
}

/** How many stretches an outline has. @param {DocObject} part */
const stretchCount = (part) => {
  const count = verticesOf(part).length;
  return count < 2 ? 0 : part.closed !== false && count > 2 ? count : count - 1;
};

/**
 * The point of a part's outline nearest to `p`: which stretch (from vertex `segment` to the next), where along it
 * (t from 0 to 1), the point itself and how far it is.
 * @param {DocObject} part @param {Point} p
 * @returns {{ segment: number, t: number, point: Point, distance: number } | null}
 */
export function nearestOnOutline(part, p) {
  const vertices = verticesOf(part);
  /** @type {{ segment: number, t: number, point: Point, distance: number } | null} */
  let best = null;
  const STEPS = 48;
  for (let segment = 0; segment < stretchCount(part); segment++) {
    // A stretch that follows another part is that part's: points are added there, not here.
    if (vertices[segment].follow) continue;
    const c = controlsOf(vertices, segment);
    /** @param {number} t */
    const at = (t) => splitCubic(c, t).at;
    /** @param {number} t */
    const distance = (t) => {
      const q = at(t);
      return Math.hypot(q.x - p.x, q.y - p.y);
    };
    let t = 0;
    for (let i = 1; i <= STEPS; i++) if (distance(i / STEPS) < distance(t)) t = i / STEPS;
    // Narrow it down around the best sample.
    let lo = Math.max(0, t - 1 / STEPS);
    let hi = Math.min(1, t + 1 / STEPS);
    for (let i = 0; i < 30; i++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (distance(m1) < distance(m2)) hi = m2;
      else lo = m1;
    }
    t = (lo + hi) / 2;
    const d = distance(t);
    if (!best || d < best.distance) best = { segment, t, point: at(t), distance: d };
  }
  return best;
}

/**
 * Adds a vertex on a stretch of the outline without changing its shape (the curve is split in two there).
 * @param {DocObject} part @param {number} segment the stretch from vertex `segment` to the next @param {number} t
 * @returns {{ vertices: Vertex[], index: number }} the new vertices and where the new one is
 */
export function insertVertex(part, segment, t) {
  const vertices = verticesOf(part).map((v) => ({ ...v }));
  const index = segment + 1;
  const a = vertices[segment];
  const b = vertices[index % vertices.length];
  const c = controlsOf(vertices, segment);
  const { p01, p012, at, p123, p23 } = splitCubic(c, t);
  /** @type {Vertex} */
  const added = { x: at.x, y: at.y };
  if (a.out || b.in) {
    // A curve: both halves keep its shape.
    if (a.out) a.out = { x: p01.x - a.x, y: p01.y - a.y };
    if (b.in) b.in = { x: p23.x - b.x, y: p23.y - b.y };
    added.in = { x: p012.x - at.x, y: p012.y - at.y };
    added.out = { x: p123.x - at.x, y: p123.y - at.y };
  }
  vertices.splice(index, 0, added);
  return { vertices: vertices.map(roundVertex), index };
}

/**
 * Makes a vertex a smooth curve (handles along the line between its neighbors, a third of the way to each) or, with
 * corner, takes its handles away. Changes the vertices in place.
 * @param {Vertex[]} vertices @param {number} index @param {boolean} closed @param {boolean} corner
 */
export function shapePoint(vertices, index, closed, corner) {
  const v = vertices[index];
  delete v.in;
  delete v.out;
  if (corner) return;
  const prev = vertices[index - 1] ?? (closed ? vertices.at(-1) : undefined);
  const next = vertices[index + 1] ?? (closed ? vertices[0] : undefined);
  const a = prev ?? v;
  const b = next ?? v;
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const reach = (/** @type {Vertex | undefined} */ n) => (n ? Math.hypot(n.x - v.x, n.y - v.y) / 3 : 0);
  if (prev) v.in = { x: -dir.x * reach(prev), y: -dir.y * reach(prev) };
  if (next) v.out = { x: dir.x * reach(next), y: dir.y * reach(next) };
}

const SMOOTH_TOLERANCE = (3 * Math.PI) / 180; // how far from opposite two handles may point and still be smooth

/**
 * Whether a vertex is a smooth point: both handles there, pointing opposite ways (within a few degrees, as saved
 * handles are rounded). Dragging one handle of a smooth point turns the other; a broken one moves alone. Nothing is
 * stored for it: it is read from the handles.
 * @param {Vertex} v
 */
export function isSmooth(v) {
  if (!v.in || !v.out) return false;
  const a = Math.hypot(v.in.x, v.in.y);
  const b = Math.hypot(v.out.x, v.out.y);
  if (!a || !b) return false;
  return (v.in.x * v.out.x + v.in.y * v.out.y) / (a * b) <= -Math.cos(SMOOTH_TOLERANCE);
}

/**
 * Turns the other handle of a vertex to point opposite `side`'s, keeping its own length (a smooth point). Changes the
 * vertex in place; nothing happens if either handle is missing or `side`'s has no length.
 * @param {Vertex} v @param {'in' | 'out'} side the handle that leads
 */
export function alignHandle(v, side) {
  const lead = v[side];
  const other = side === 'in' ? 'out' : 'in';
  const follower = v[other];
  if (!lead || !follower) return;
  const length = Math.hypot(lead.x, lead.y);
  if (!length) return;
  const reach = Math.hypot(follower.x, follower.y);
  v[other] = { x: (-lead.x / length) * reach, y: (-lead.y / length) * reach };
}

/**
 * The vertices of an ellipse inside a box with `count` points (4 or more), evenly round, the first one at the top and
 * going clockwise, so its points can be shared by name (for example 8 or 12 for a head with ears).
 * @param {Box} box @param {number} count
 * @returns {Vertex[]}
 */
export function ellipsePoints({ x, y, width: w, height: h }, count) {
  const n = Math.max(3, Math.round(count));
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  // The handle of a circle's arc of angle a is (4/3)·tan(a/4) of the radius.
  const k = (4 / 3) * Math.tan(Math.PI / (2 * n));
  return Array.from({ length: n }, (_, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const tangent = { x: -sin * rx * k, y: cos * ry * k };
    return { x: cx + cos * rx, y: cy + sin * ry, in: { x: -tangent.x, y: -tangent.y }, out: tangent };
  });
}
