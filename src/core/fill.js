// Create Shape (part 4 of docs/rebuild.md), as Moho's: the shape that picked points of a vector layer's lines close, or
// the gap around a place, and the batch that makes it, for the editor's Create Shape tool and `aia shape` / `aia
// fill`. A shape is two parts that follow those lines, under them: line_fill (only the fill) and line_stroke (only
// the stroke), each with its own place in the order. Groups of lines inside a gap that do not touch it (the middle of
// a donut) are its holes, each following its outside. Where lines cross without a point: crossings.js.
//
// The lines of a layer (its parts that do not follow others) make a graph: a node at each of their vertices (the
// same node where two lines share a point), an edge along each stretch between two vertices. Only shared points join
// lines: two lines that cross without a weld do not close a gap. The faces of that graph are the gaps; the one
// around the place is the smallest face that holds it. A gap's outline is cut into stretches, each along one line,
// and a shape's part has one vertex per stretch: a reference to the point where the stretch starts, following that
// line to the next one (unnamed points of the lines get a name in the same batch).

import { childrenOf, findObject, idFromName } from './document.js';
import { holesOf, pointOnStretch, verticesOf } from './geometry.js';
import { followsOthers, nextPointName, pointIdOf } from './points.js';
import { freeShapeSuffix, shapePartName } from './shapes.js';

/**
 * @typedef {import('./document.js').Doc} Doc
 * @typedef {import('./document.js').DocObject} DocObject
 * @typedef {import('./geometry.js').Point} Point
 * @typedef {import('./geometry.js').Vertex} Vertex
 * @typedef {import('./operations.js').Operation} Operation
 * @typedef {{ part: string, from: number, to: number, forward: boolean, a: string, b: string, points: Point[], twin: number }} HalfEdge
 *   one way along the stretch of `part` from vertex `from` to vertex `to` (forward: in the order of its vertices),
 *   between the nodes `a` and `b`
 * @typedef {{ part: string, from: number, to: number, a: string, b: string, forward: boolean, length: number }} Stretch
 *   length: how long it is (to name a fill after the line it goes along most)
 * @typedef {{ stretches: Stretch[], polygon: Point[], area: number, holes: Stretch[][], holePolygons: Point[][], nodes: string[] }} Gap
 *   area: inside its outline (its holes not taken away); nodes: the points around it and its holes
 * @typedef {{ fill?: string | null, stroke?: string | null, strokeWidth?: number, fillOpacity?: number, strokeOpacity?: number }} FillStyle
 */

const SAMPLES = 12; // points along each curved stretch, to find the gaps
export const TINY = 1e-6;


/** The node of a vertex: the point it is ("part.point"), or a key of its own for an unnamed one. @param {DocObject} part @param {Vertex} v @param {number} i */
const nodeOf = (part, v, i) => pointIdOf(part, v) ?? `${part.id}#${i}`;

/**
 * The stretch from a to b as points (both ends included): its two ends when straight, else SAMPLES + 1 points at even
 * steps of the curve's parameter.
 * @param {Vertex} a @param {Vertex} b @returns {Point[]}
 */
function sample(a, b) {
  if (!a.out && !b.in) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  return Array.from({ length: SAMPLES + 1 }, (_, k) => pointOnStretch(a, b, k / SAMPLES));
}

/** The angle a half-edge leaves its node at (the first sample far enough from it). @param {HalfEdge} h */
function leaving(h) {
  const [p] = h.points;
  const q = h.points.find((s) => Math.hypot(s.x - p.x, s.y - p.y) > TINY) ?? h.points[h.points.length - 1];
  return Math.atan2(q.y - p.y, q.x - p.x);
}

/** Signed area of a polygon (shoelace). @param {Point[]} polygon */
function signedArea(polygon) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

/** Whether a place is inside a polygon (even-odd). @param {Point[]} polygon @param {Point} at */
export function insidePolygon(polygon, at) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const p = polygon[i];
    const q = polygon[j];
    if (p.y > at.y !== q.y > at.y && at.x < ((q.x - p.x) * (at.y - p.y)) / (q.y - p.y) + p.x) inside = !inside;
  }
  return inside;
}

/**
 * @typedef {{ face: number[], polygon: Point[], area: number, component: number }} Face a face without its spurs
 * @typedef {{ edges: HalfEdge[], faces: Face[], outer: Map<number, Face> }} Graph outer: the outside of each
 *   connected group of lines (its biggest face), which is a hole of the gap it lies in
 */

/** @type {WeakMap<Doc, Map<string, Graph>>} the graph of each layer, per document */
const graphs = new WeakMap();

/**
 * The stretches of a layer's lines, each once (in the order of its line's vertices), as points.
 * @param {Doc} doc resolved @param {string} layer
 * @returns {HalfEdge[]}
 */
export const lineStretches = (doc, layer) => graphOf(doc, layer).edges.filter((h) => h.forward);

/**
 * The half-edges of a layer's lines and the faces they make (each a cycle of half-edge indices).
 * @param {Doc} doc resolved @param {string} layer
 * @returns {Graph}
 */
function graphOf(doc, layer) {
  let byLayer = graphs.get(doc);
  if (!byLayer) graphs.set(doc, (byLayer = new Map()));
  const known = byLayer.get(layer);
  if (known) return known;
  /** @type {HalfEdge[]} */
  const edges = [];
  for (const part of linesOf(doc, layer)) {
    const vertices = verticesOf(part);
    const n = vertices.length;
    const count = part.closed !== false && n > 2 ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % n;
      const a = nodeOf(part, vertices[i], i);
      const b = nodeOf(part, vertices[j], j);
      if (a === b) continue;
      const points = sample(vertices[i], vertices[j]);
      const k = edges.length;
      edges.push({ part: part.id, from: i, to: j, forward: true, a, b, points, twin: k + 1 });
      edges.push({ part: part.id, from: j, to: i, forward: false, a: b, b: a, points: [...points].reverse(), twin: k });
    }
  }
  const graph = { edges, ...facesOf(edges) };
  byLayer.set(layer, graph);
  return graph;
}

/** The lines of a layer: its shown parts that do not follow others. @param {Doc} doc @param {string} layer */
const linesOf = (doc, layer) => childrenOf(doc, layer).filter((part) => part.type === 'path' && part.visible !== false && !followsOthers(part));

/**
 * The faces some half-edges make (each half-edge's twin must be among them), without spurs, and the outside of each
 * group of joined lines.
 * @param {HalfEdge[]} edges
 * @returns {{ faces: Face[], outer: Map<number, Face> }}
 */
function facesOf(edges) {
  // Around each node, the half-edges leaving it by angle; a face goes on, at the end of each half-edge, along the
  // one that leaves that node next clockwise from where it came in (so each face is walked with itself on one side).
  /** @type {Map<string, number[]>} */
  const around = new Map();
  const angle = edges.map(leaving);
  edges.forEach((h, k) => around.set(h.a, [...(around.get(h.a) ?? []), k]));
  for (const list of around.values()) list.sort((x, y) => angle[x] - angle[y]);
  /** @type {number[]} */
  const next = edges.map((h) => {
    const list = /** @type {number[]} */ (around.get(h.b));
    const at = list.indexOf(h.twin);
    return list[(at - 1 + list.length) % list.length];
  });
  // Lines joined by shared points are one group (union-find over the nodes).
  /** @type {Map<string, string>} */
  const root = new Map();
  /** @param {string} x @returns {string} */
  const find = (x) => {
    const up = root.get(x) ?? x;
    if (up === x) return x;
    const top = find(up);
    root.set(x, top);
    return top;
  };
  for (const h of edges) root.set(find(h.a), find(h.b));
  /** @type {Map<string, number>} */
  const groups = new Map();
  /** @type {Face[]} */
  const faces = [];
  /** @type {Map<number, Face>} */
  const outer = new Map();
  const seen = new Set();
  for (let k = 0; k < edges.length; k++) {
    if (seen.has(k)) continue;
    /** @type {number[]} */
    const raw = [];
    for (let h = k; !seen.has(h); h = next[h]) {
      seen.add(h);
      raw.push(h);
    }
    const face = withoutSpurs(raw, edges);
    if (face.length < 2) continue;
    const polygon = polygonOf(face, edges);
    const area = Math.abs(signedArea(polygon));
    if (area < TINY) continue;
    const key = find(edges[k].a);
    if (!groups.has(key)) groups.set(key, groups.size);
    const component = /** @type {number} */ (groups.get(key));
    const f = { face, polygon, area, component };
    faces.push(f);
    if (!outer.has(component) || /** @type {Face} */ (outer.get(component)).area < area) outer.set(component, f);
  }
  return { faces, outer };
}

/** A face without the spurs it walks out and back along (an open end inside a gap). @param {number[]} face @param {HalfEdge[]} edges */
function withoutSpurs(face, edges) {
  /** @type {number[]} */
  const stack = [];
  for (const h of face) {
    if (stack.length && edges[stack[stack.length - 1]].twin === h) stack.pop();
    else stack.push(h);
  }
  while (stack.length > 1 && edges[stack[0]].twin === stack[stack.length - 1]) {
    stack.shift();
    stack.pop();
  }
  return stack;
}

/** @param {number[]} face @param {HalfEdge[]} edges @returns {Point[]} */
const polygonOf = (face, edges) => face.flatMap((h) => edges[h].points.slice(0, -1));

/**
 * Joins the half-edges of a gap into stretches, one per run along the same line, keeping at least two stretches
 * and never one from a point back to itself.
 * @param {number[]} face @param {HalfEdge[]} edges @returns {Stretch[]}
 */
function stretchesOf(face, edges) {
  /** @type {HalfEdge[][]} */
  let runs = [];
  for (const k of face) {
    const h = edges[k];
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (last && last.part === h.part && last.to === h.from && last.forward === h.forward) run.push(h);
    else runs.push([h]);
  }
  // The last run and the first may be one.
  if (runs.length > 1) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    const a = last[last.length - 1];
    const b = first[0];
    if (a.part === b.part && a.to === b.from && a.forward === b.forward) runs = [[...last, ...first], ...runs.slice(1, -1)];
  }
  // A run that comes back to where it started (all around one shape) is cut in two.
  runs = runs.flatMap((run) => (run.length > 1 && run[0].a === run[run.length - 1].b ? [run.slice(0, run.length >> 1), run.slice(run.length >> 1)] : [run]));
  if (runs.length === 1 && runs[0].length > 1) runs = [runs[0].slice(0, runs[0].length >> 1), runs[0].slice(runs[0].length >> 1)];
  return runs.map((run) => {
    const first = run[0];
    const last = run[run.length - 1];
    const length = run.reduce((sum, h) => sum + h.points.reduce((s, p, i) => (i ? s + Math.hypot(p.x - h.points[i - 1].x, p.y - h.points[i - 1].y) : 0), 0), 0);
    return { part: first.part, from: first.from, to: last.to, a: first.a, b: last.b, forward: first.forward, length };
  });
}

/**
 * The gap of a layer around a place (in the layer's coordinates): the smallest closed outline of its lines that holds
 * it, or why there is none.
 * @param {Doc} doc resolved @param {string} layer @param {Point} at
 * @returns {Gap | { error: string }}
 */
export function gapAt(doc, layer, at) {
  const object = findObject(doc, layer);
  if (!object || object.type !== 'vector') return { error: `there is no vector layer "${layer}"` };
  const { edges, faces, outer } = graphOf(doc, layer);
  /** @type {Face | null} */
  let best = null;
  for (const f of faces) {
    if (!insidePolygon(f.polygon, at)) continue;
    if (!best || f.area < best.area) best = f;
  }
  if (!best) return { error: `no lines of ${layer} close a gap around ${round(at.x)}, ${round(at.y)} (lines that cross must be welded where they meet)` };
  return gapOf(best, outer, edges, `${layer} around ${round(at.x)}, ${round(at.y)}`);
}

/**
 * A gap from the face that is its outline: the outsides of the other groups of lines that lie inside it, but not
 * inside one another (a shape inside a hole is in another gap), are its holes.
 * @param {Face} found @param {Map<number, Face>} outer @param {HalfEdge[]} edges @param {string} where for the error
 * @returns {Gap | { error: string }}
 */
function gapOf(found, outer, edges, where) {
  const inside = [...outer.values()].filter((o) => o.component !== found.component && o.area < found.area && o.polygon.some((p) => insidePolygon(found.polygon, p)));
  const holes = inside.filter((o) => !inside.some((other) => other !== o && other.area > o.area && o.polygon.every((p) => insidePolygon(other.polygon, p))));
  // Lines that cross without a weld leave no clean gap: say so instead of filling something odd.
  const crossing = holes.find((o, i) => crosses(o.polygon, found.polygon) || holes.some((other, j) => j > i && crosses(o.polygon, other.polygon)));
  if (crossing) return { error: `lines of ${where} cross without a weld: weld them where they cross (${partsOf(crossing.face, edges)})` };
  return {
    stretches: stretchesOf(found.face, edges),
    polygon: found.polygon,
    area: found.area,
    holes: holes.map((o) => stretchesOf(o.face, edges)),
    holePolygons: holes.map((o) => o.polygon),
    nodes: [...new Set([found, ...holes].flatMap((f) => f.face.map((h) => edges[h].a)))],
  };
}

/**
 * The shape some points of a layer's lines make, as Moho's Create Shape sees it: the stretches between two picked
 * points (dead ends left out); the outside of the biggest group they make is the outline, and the outsides of the
 * other groups inside it are holes. When they close nothing, the error says so, and `shown` has the picked
 * stretches as points, to show them.
 * @param {Doc} doc resolved @param {string} layer @param {Iterable<string>} nodes points as nodeKeys gives them
 * @returns {Gap | { error: string, shown: Point[][] }}
 */
export function shapeOf(doc, layer, nodes) {
  const picked = new Set(nodes);
  const { edges } = graphOf(doc, layer);
  /** @type {Map<number, number>} */
  const index = new Map();
  /** @type {HalfEdge[]} */
  const chosen = [];
  edges.forEach((h, k) => {
    if (!picked.has(h.a) || !picked.has(h.b)) return;
    index.set(k, chosen.length);
    chosen.push(h);
  });
  const sub = chosen.map((h) => ({ ...h, twin: /** @type {number} */ (index.get(h.twin)) }));
  const { outer } = facesOf(sub);
  const outline = [...outer.values()].sort((x, y) => y.area - x.area)[0];
  const shown = sub.filter((h) => h.forward).map((h) => h.points);
  if (!outline) {
    if (!picked.size) return { error: 'pick the points around a shape', shown };
    // Where the picked stretches stop: picked points with fewer than two picked stretches.
    /** @type {Map<string, number>} */
    const degree = new Map([...picked].map((n) => [n, 0]));
    for (const h of sub) degree.set(h.a, (degree.get(h.a) ?? 0) + 1);
    const ends = [...degree].filter(([, d]) => d < 2).map(([n]) => n.replace('#', '.'));
    const where = ends.length ? `: the picked stretches stop at ${ends.slice(0, 6).join(', ')}${ends.length > 6 ? '…' : ''}` : '';
    return { error: `the picked points do not close a shape${where} (pick the points that join them all around)`, shown };
  }
  const gap = gapOf(outline, outer, sub, layer);
  return 'error' in gap ? { ...gap, shown } : gap;
}

/** The node of every vertex of a layer's lines, by "part:index" (what the editor picks). @param {Doc} doc @param {string} layer */
export function nodeKeys(doc, layer) {
  /** @type {Map<string, { node: string, at: Point }>} */
  const keys = new Map();
  for (const part of linesOf(doc, layer)) {
    verticesOf(part).forEach((v, i) => keys.set(`${part.id}:${i}`, { node: nodeOf(part, v, i), at: { x: v.x, y: v.y } }));
  }
  return keys;
}

/** @param {number} n */
const round = (n) => Math.round(n * 100) / 100;

/** The lines a face goes along. @param {number[]} face @param {HalfEdge[]} edges */
const partsOf = (face, edges) => [...new Set(face.map((h) => edges[h].part))].join(', ');

/** Whether two segments cross. @param {Point} a @param {Point} b @param {Point} c @param {Point} d */
export function segmentsCross(a, b, c, d) {
  const side = (/** @type {Point} */ p, /** @type {Point} */ q, /** @type {Point} */ r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Whether two closed outlines cross each other. @param {Point[]} p @param {Point[]} q */
function crosses(p, q) {
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    for (let j = 0; j < q.length; j++) if (segmentsCross(a, b, q[j], q[(j + 1) % q.length])) return true;
  }
  return false;
}

/** The props a style gives a fill part. @param {FillStyle} style */
export function styleProps(style) {
  /** @type {Record<string, unknown>} */
  const props = {};
  if (style.fill !== undefined) props.fill = style.fill;
  if (style.stroke !== undefined) props.stroke = style.stroke;
  if (style.fill && style.fillOpacity !== undefined && style.fillOpacity !== 1) props.fillOpacity = style.fillOpacity;
  if (style.stroke) {
    if (style.strokeWidth !== undefined) props.strokeWidth = style.strokeWidth;
    if (style.strokeOpacity !== undefined && style.strokeOpacity !== 1) props.strokeOpacity = style.strokeOpacity;
  }
  return props;
}

/**
 * The batch that makes a shape in the gap around a place, as a click inside it and Create shape do in the editor: a
 * fill part and a stroke part that follow the lines around it (and its holes), just under the lowest of them. Shapes
 * add up, as in Moho; a shape's colors change with `set`.
 * @param {Doc} doc resolved @param {string} layer @param {Point} at in the layer's coordinates
 * @param {Record<string, unknown>} props its style (see styleProps) @param {string} [name] what to name it after
 *   instead of its main line (name_fill, name_stroke)
 * @returns {{ ops: Operation[], id: string, ids: string[], note: string }}
 */
export function fillOps(doc, layer, at, props, name) {
  const gap = gapAt(doc, layer, at);
  if ('error' in gap) throw new Error(gap.error);
  return shapeOps(doc, layer, gap, props, name);
}

/**
 * The batch that creates a shape from some picked points of a layer's lines (Moho's Create Shape).
 * @param {Doc} doc resolved @param {string} layer @param {Iterable<string>} nodes @param {Record<string, unknown>} props
 * @param {string} [name] what to name it after instead of its main line
 * @returns {{ ops: Operation[], id: string, ids: string[], note: string }}
 */
export function shapeFromPointsOps(doc, layer, nodes, props, name) {
  const shape = shapeOf(doc, layer, nodes);
  if ('error' in shape) throw new Error(shape.error);
  return shapeOps(doc, layer, shape, props, name);
}

/**
 * The batch that creates a shape for a gap: a fill part and a stroke part, each with one vertex per stretch, sharing
 * the point it starts at and following its line; just under the lowest line it follows.
 * @param {Doc} doc resolved @param {string} layer @param {Gap} gap @param {Record<string, unknown>} props
 * @param {string} [name] what to name its parts after (name_fill, name_stroke) instead of its main line
 * @returns {{ ops: Operation[], id: string, ids: string[], note: string }} ids: the fill part and the stroke part
 *   it made (one of them when the other is None)
 */
function shapeOps(doc, layer, gap, props, name) {
  // Unnamed points where a stretch starts get a name, so the fill can share them.
  /** @type {Map<string, Vertex[]>} */
  const renamed = new Map();
  /** @type {Map<string, string>} */
  const named = new Map();
  const pointAt = (/** @type {string} */ partId, /** @type {number} */ index, /** @type {string} */ node) => {
    if (!node.includes('#')) return node;
    const known = named.get(node);
    if (known) return known;
    const part = /** @type {DocObject} */ (findObject(doc, partId));
    const vertices = renamed.get(partId) ?? verticesOf(part).map((v) => ({ ...v }));
    const name = nextPointName({ ...part, vertices }, new Set());
    vertices[index] = { ...vertices[index], name };
    renamed.set(partId, vertices);
    named.set(node, `${partId}.${name}`);
    return `${partId}.${name}`;
  };
  /** @param {Stretch} s @returns {Record<string, string>} a vertex as saved: a shared point, without x, y */
  const vertexOf = (s) => {
    const ref = pointAt(s.part, s.from, s.a);
    const followed = /** @type {DocObject} */ (findObject(doc, s.part));
    return { ref, follow: s.part, ...(longWay(followed, s) ? { way: 'long' } : {}) };
  };
  const vertices = gap.stretches.map(vertexOf);
  const holes = gap.holes.map((hole) => hole.map(vertexOf));
  const siblings = childrenOf(doc, layer);
  const index = Math.min(...[...gap.stretches, ...gap.holes.flat()].map((s) => siblings.findIndex((o) => o.id === s.part)));
  // A shape's fill and its stroke are two parts (head_fill, head_stroke), so each has its place in the order; the
  // stroke over the fill. The same number for both: head_fill_2 goes with head_stroke_2.
  const fillProps = Object.fromEntries(Object.entries(props).filter(([k]) => k === 'fill' || k === 'fillOpacity'));
  const strokeProps = Object.fromEntries(Object.entries(props).filter(([k]) => k.startsWith('stroke')));
  const hasFill = props.fill !== null;
  const hasStroke = props.stroke !== undefined && props.stroke !== null;
  if (!hasFill && !hasStroke) throw new Error('a shape needs a fill or a stroke (both are None)');
  const base = name ?? mainLine(gap);
  const suffix = freeShapeSuffix((x) => x === 'meta' || !!findObject(doc, x), base);
  const shape = { vertices, ...(holes.length ? { holes } : {}) };
  /** @type {Operation[]} */
  const ops = [...renamed].map(([target, list]) => ({ op: 'set', target, props: { vertices: list.map(storedOnly) } }));
  /** @type {string[]} */
  const ids = [];
  if (hasFill) {
    ids.push(shapePartName(base, 'fill', suffix));
    ops.push({ op: 'create', type: 'path', id: ids[0], parent: layer, index, props: { ...shape, ...fillProps, stroke: null } });
  }
  if (hasStroke) {
    const id = shapePartName(base, 'stroke', suffix);
    ops.push({ op: 'create', type: 'path', id, parent: layer, index: index + ids.length, props: { ...shape, fill: null, ...strokeProps } });
    ids.push(id);
  }
  return { ops, id: ids[0], ids, note: `Create shape ${ids.join(' + ')}` };
}

/** The line a gap's outline goes along most: a fill is named after it (head_fill). @param {Gap} gap */
function mainLine(gap) {
  /** @type {Map<string, number>} */
  const along = new Map();
  for (const s of gap.stretches) along.set(s.part, (along.get(s.part) ?? 0) + s.length);
  return [...along].sort((a, b) => b[1] - a[1])[0][0];
}

/** A vertex as it is saved: a shared one without the x, y resolving gave it. @param {Vertex} v */
function storedOnly(v) {
  if (!v.ref) return v;
  const { x: _x, y: _y, ...rest } = v;
  return /** @type {Vertex} */ (rest);
}

/**
 * Whether a stretch goes the long way round its closed line (followStretch in points.js takes the short way unless
 * told): the same rule, so the fill goes where the gap is.
 * @param {DocObject} part @param {Stretch} s
 */
function longWay(part, s) {
  if (part.closed === false) return false;
  const n = verticesOf(part).length;
  const ahead = (s.to - s.from + n) % n;
  const behind = (s.from - s.to + n) % n;
  const short = ahead <= behind;
  return s.forward !== short;
}
