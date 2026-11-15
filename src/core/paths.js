// Paths: vertices with polar tangents (angle + distance, like Rive), their conversion to an SVG `d` and from an
// SVG `d`. A vertex:
//
//   { x, y }                                                        straight
//   { x, y, radius }                                                straight with the corner rounded
//   { x, y, mode: 'mirrored',   angle, dist }                       symmetric curve
//   { x, y, mode: 'asymmetric', angle, inDist, outDist }            same direction, different lengths
//   { x, y, mode: 'detached',   inAngle, inDist, outAngle, outDist } independent tangents (cusp)
//
// `angle` / `outAngle` is the direction of the out tangent (toward the next vertex), in degrees with Y pointing
// down (0 = right, 90 = down). The in tangent points toward the previous vertex: in mirrored and asymmetric it is
// angle + 180; in detached, inAngle.

export const MODES = ['straight', 'mirrored', 'asymmetric', 'detached'];
export const VERTEX_FIELDS = {
  straight: ['x', 'y', 'mode', 'radius'],
  mirrored: ['x', 'y', 'mode', 'angle', 'dist'],
  asymmetric: ['x', 'y', 'mode', 'angle', 'inDist', 'outDist'],
  detached: ['x', 'y', 'mode', 'inAngle', 'inDist', 'outAngle', 'outDist'],
};

const RAD = Math.PI / 180;
const KAPPA = 0.5523; // control point of a cubic that approximates a quarter circle
const r2 = (v) => Math.round(v * 100) / 100 || 0;
const n = (v) => +v.toFixed(3);
const polar = (angle, dist) => [Math.cos(angle * RAD) * dist, Math.sin(angle * RAD) * dist];
/** @param {number[]} v */
const length = ([x, y]) => Math.hypot(x, y);
/** @param {number[]} v */
const angleOf = ([x, y]) => r2(Math.atan2(y, x) / RAD);
const normalizeAngle = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** A rebuilt vertex keeps the bone the original followed (per-point binding). */
export const withBone = (original, created) => (original?.bone ? { ...created, bone: original.bone } : created);

/** Tangents of a vertex as vectors relative to the anchor. */
export function tangents(v) {
  switch (v.mode ?? 'straight') {
    case 'mirrored': {
      const output = polar(v.angle, v.dist);
      return { in: [-output[0], -output[1]], out: output };
    }
    case 'asymmetric':
      return { in: polar(v.angle + 180, v.inDist), out: polar(v.angle, v.outDist) };
    case 'detached':
      return { in: polar(v.inAngle, v.inDist), out: polar(v.outAngle, v.outDist) };
    default:
      return { in: [0, 0], out: [0, 0] };
  }
}

/** Builds a vertex from the anchor and its tangents, choosing the simplest mode that describes it. */
export function vertexFromTangents(x, y, entry, output, extra = {}) {
  const li = length(entry);
  const lo = length(output);
  const base = { x: r2(x), y: r2(y) };
  if (li < 0.01 && lo < 0.01) return { ...base, ...extra };
  if (li >= 0.01 && lo >= 0.01) {
    const ao = Math.atan2(output[1], output[0]) / RAD;
    const ai = Math.atan2(entry[1], entry[0]) / RAD;
    if (Math.abs(normalizeAngle(ai - (ao + 180))) < 0.5) {
      if (Math.abs(li - lo) <= 0.01 * Math.max(li, lo)) return { ...base, mode: 'mirrored', angle: angleOf(output), dist: r2((li + lo) / 2) };
      return { ...base, mode: 'asymmetric', angle: angleOf(output), inDist: r2(li), outDist: r2(lo) };
    }
  }
  return {
    ...base,
    mode: 'detached',
    inAngle: li < 0.01 ? normalizeAngle(angleOf(output) + 180) : angleOf(entry),
    inDist: r2(li),
    outAngle: lo < 0.01 ? normalizeAngle(angleOf(entry) + 180) : angleOf(output),
    outDist: r2(lo),
  };
}

// ---------- Vertices → d ----------

/** Points with absolute tangents, with the rounded corners already expanded into two points. */
function expand(vertices, closed) {
  const points = [];
  vertices.forEach((v, i) => {
    const { in: entry, out: output } = tangents(v);
    const radius = (v.mode ?? 'straight') === 'straight' ? (v.radius ?? 0) : 0;
    const previous = vertices[i - 1] ?? (closed ? vertices.at(-1) : null);
    const next = vertices[i + 1] ?? (closed ? vertices[0] : null);
    if (radius > 0 && previous && next && vertices.length > 2) {
      const a = [previous.x - v.x, previous.y - v.y];
      const b = [next.x - v.x, next.y - v.y];
      const r = Math.min(radius, length(a) / 2, length(b) / 2);
      if (r > 0) {
        const ua = [a[0] / length(a), a[1] / length(a)];
        const ub = [b[0] / length(b), b[1] / length(b)];
        const start = [v.x + ua[0] * r, v.y + ua[1] * r];
        const end = [v.x + ub[0] * r, v.y + ub[1] * r];
        points.push({ p: start, in: [0, 0], out: [-ua[0] * r * KAPPA, -ua[1] * r * KAPPA] });
        points.push({ p: end, in: [-ub[0] * r * KAPPA, -ub[1] * r * KAPPA], out: [0, 0] });
        return;
      }
    }
    points.push({ p: [v.x, v.y], in: entry, out: output });
  });
  return points;
}

export function verticesAD(vertices, closed) {
  if (!vertices?.length) return '';
  const points = expand(vertices, closed);
  const span = (a, b) => {
    if (length(a.out) < 1e-9 && length(b.in) < 1e-9) return `L${n(b.p[0])} ${n(b.p[1])}`;
    return `C${n(a.p[0] + a.out[0])} ${n(a.p[1] + a.out[1])} ${n(b.p[0] + b.in[0])} ${n(b.p[1] + b.in[1])} ${n(b.p[0])} ${n(b.p[1])}`;
  };
  let d = `M${n(points[0].p[0])} ${n(points[0].p[1])}`;
  for (let i = 1; i < points.length; i++) d += span(points[i - 1], points[i]);
  if (closed && points.length > 1) d += span(points.at(-1), points[0]) + 'Z';
  return d;
}

// ---------- d → vertices ----------

/**
 * Converts an SVG `d` into subpaths [{ closed, vertices }]. Accepts all commands (M L H V C S Q T A Z), absolute
 * and relative. Quadratics and arcs are converted to cubics.
 */
export function parseD(d) {
  const text = String(d);
  let i = 0;
  const skip = () => {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
  };
  const number = () => {
    skip();
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) throw new Error(`invalid d: expected a number at position ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = () => {
    skip();
    const c = text[i++];
    if (c !== '0' && c !== '1') throw new Error(`invalid d: arc flag "${c}" at position ${i - 1} (must be 0 or 1)`);
    return c === '1';
  };
  const subpaths = [];
  /** @type {any} */
  let current = null;
  let pos = [0, 0];
  let start = [0, 0];
  let lastControl = null;
  let lastCommand = '';

  const startSubpath = (p) => {
    current = { closed: false, points: [{ p, in: [0, 0], out: [0, 0] }] };
    subpaths.push(current);
    start = p;
  };
  const ensure = () => current ?? startSubpath(pos);
  const cubic = (c1, c2, p) => {
    ensure();
    const last = current.points.at(-1);
    last.out = [c1[0] - last.p[0], c1[1] - last.p[1]];
    current.points.push({ p, in: [c2[0] - p[0], c2[1] - p[1]], out: [0, 0] });
    pos = p;
  };
  const line = (p) => {
    ensure();
    current.points.push({ p, in: [0, 0], out: [0, 0] });
    pos = p;
  };

  while (true) {
    skip();
    if (i >= text.length) break;
    let command = text[i];
    if (/[a-zA-Z]/.test(command)) i++;
    else if (lastCommand && lastCommand.toUpperCase() !== 'Z') command = lastCommand === 'M' ? 'L' : lastCommand === 'm' ? 'l' : lastCommand;
    else throw new Error(`invalid d: expected a command at position ${i}`);
    const rel = command === command.toLowerCase();
    const C = command.toUpperCase();
    const abs = (x, y) => (rel ? [pos[0] + x, pos[1] + y] : [x, y]);
    let control = null;

    switch (C) {
      case 'M': {
        const p = abs(number(), number());
        pos = p;
        startSubpath(p);
        break;
      }
      case 'L':
        line(abs(number(), number()));
        break;
      case 'H': {
        const x = number();
        line([rel ? pos[0] + x : x, pos[1]]);
        break;
      }
      case 'V': {
        const y = number();
        line([pos[0], rel ? pos[1] + y : y]);
        break;
      }
      case 'C': {
        const c1 = abs(number(), number());
        const c2 = abs(number(), number());
        const p = abs(number(), number());
        cubic(c1, c2, p);
        control = c2;
        break;
      }
      case 'S': {
        const c1 = lastControl && 'CS'.includes(lastCommand.toUpperCase()) ? [2 * pos[0] - lastControl[0], 2 * pos[1] - lastControl[1]] : pos;
        const c2 = abs(number(), number());
        const p = abs(number(), number());
        cubic(c1, c2, p);
        control = c2;
        break;
      }
      case 'Q':
      case 'T': {
        const q = C === 'Q' ? abs(number(), number()) : lastControl && 'QT'.includes(lastCommand.toUpperCase()) ? [2 * pos[0] - lastControl[0], 2 * pos[1] - lastControl[1]] : pos;
        const p = abs(number(), number());
        const p0 = pos;
        cubic([p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])], [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])], p);
        control = q;
        break;
      }
      case 'A': {
        const rx = number();
        const ry = number();
        const rot = number();
        const large = flag();
        const clockwise = flag();
        const p = abs(number(), number());
        for (const [c1, c2, end] of arcToCubics(pos, rx, ry, rot, large, clockwise, p)) cubic(c1, c2, end);
        pos = p;
        break;
      }
      case 'Z': {
        if (current) {
          const first = current.points[0];
          const last = current.points.at(-1);
          if (current.points.length > 1 && Math.hypot(last.p[0] - first.p[0], last.p[1] - first.p[1]) < 1e-6) {
            first.in = last.in;
            current.points.pop();
          }
          current.closed = true;
          current = null;
        }
        pos = start;
        break;
      }
      default:
        throw new Error(`invalid d: unknown command "${command}"`);
    }
    lastControl = control;
    // If numbers follow without a letter, this command repeats (a repeated M is L).
    lastCommand = command;
  }

  return subpaths
    .filter((s) => s.points.length > 1 || s.closed)
    .map((s) => ({ closed: s.closed, vertices: s.points.map((pt) => vertexFromTangents(pt.p[0], pt.p[1], pt.in, pt.out)) }));
}

/** SVG elliptical arc → list of cubics [c1, c2, end] (algorithm from the SVG specification, appendix F.6). */
function arcToCubics(p0, rx, ry, rotation, large, clockwise, p) {
  if (Math.hypot(p[0] - p0[0], p[1] - p0[1]) < 1e-9) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return [[p0, p, p]];
  const fi = rotation * RAD;
  const cos = Math.cos(fi);
  const sin = Math.sin(fi);
  const dx = (p0[0] - p[0]) / 2;
  const dy = (p0[1] - p[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === clockwise ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const coef = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p[1]) / 2;
  const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!clockwise && dt > 0) dt -= 2 * Math.PI;
  if (clockwise && dt < 0) dt += 2 * Math.PI;

  const parts = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const step = dt / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const derivative = (t) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const cubics = [];
  for (let j = 0; j < parts; j++) {
    const a = t1 + j * step;
    const b = a + step;
    const pa = point(a);
    const pb = j === parts - 1 ? p : point(b);
    const da = derivative(a);
    const db = derivative(b);
    cubics.push([[pa[0] + k * da[0], pa[1] + k * da[1]], [pb[0] - k * db[0], pb[1] - k * db[1]], pb]);
  }
  return cubics;
}

// ---------- Transform and edit ----------

/** Applies an affine matrix [a b c d e f] to the vertices (anchors and tangents). */
export function transformVertices(vertices, m) {
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  return vertices.map((v) => {
    const { in: entry, out: output } = tangents(v);
    /** @param {number[]} p */
    const linear = ([x, y]) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
    const extra = v.radius ? { radius: r2(v.radius * scale) } : {};
    return withBone(v, vertexFromTangents(m[0] * v.x + m[2] * v.y + m[4], m[1] * v.x + m[3] * v.y + m[5], linear(entry), linear(output), extra));
  });
}

/** Anchors and tangent ends in absolute coordinates (to draw the editor's handles). */
export function handles(vertices) {
  return vertices.map((v) => {
    const { in: entry, out: output } = tangents(v);
    return {
      anchor: [v.x, v.y],
      in: length(entry) > 0.01 ? [v.x + entry[0], v.y + entry[1]] : null,
      out: length(output) > 0.01 ? [v.x + output[0], v.y + output[1]] : null,
    };
  });
}

function cubicSpan(vertices, i) {
  const a = vertices[i];
  const b = vertices[(i + 1) % vertices.length];
  const ta = tangents(a).out;
  const tb = tangents(b).in;
  return [[a.x, a.y], [a.x + ta[0], a.y + ta[1]], [b.x + tb[0], b.y + tb[1]], [b.x, b.y]];
}

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/** Points along span i (from vertex i to the next), to find where the user clicked. */
export function sampleSpan(vertices, i, steps = 24) {
  const [p0, p1, p2, p3] = cubicSpan(vertices, i);
  return Array.from({ length: steps + 1 }, (_, k) => {
    const t = k / steps;
    const a = lerp(lerp(p0, p1, t), lerp(p1, p2, t), t);
    const b = lerp(lerp(p1, p2, t), lerp(p2, p3, t), t);
    return { t, p: lerp(a, b, t) };
  });
}

/** Inserts a vertex in span i, at parameter t, without changing the shape (de Casteljau). */
export function splitSpan(vertices, i, t) {
  const [p0, p1, p2, p3] = cubicSpan(vertices, i);
  // Straight span: the new vertex is straight too.
  if (p1[0] === p0[0] && p1[1] === p0[1] && p2[0] === p3[0] && p2[1] === p3[1]) {
    const p = lerp(p0, p3, t);
    return [...vertices.slice(0, i + 1), withBone(vertices[i], { x: r2(p[0]), y: r2(p[1]) }), ...vertices.slice(i + 1)];
  }
  const a = lerp(p0, p1, t);
  const b = lerp(p1, p2, t);
  const c = lerp(p2, p3, t);
  const ab = lerp(a, b, t);
  const bc = lerp(b, c, t);
  const half = lerp(ab, bc, t);
  const j = (i + 1) % vertices.length;
  const result = [...vertices];
  const withTangent = (v, which, point) => {
    const t2 = tangents(v);
    t2[which] = [point[0] - v.x, point[1] - v.y];
    return withBone(v, vertexFromTangents(v.x, v.y, t2.in, t2.out));
  };
  result[i] = withTangent(vertices[i], 'out', a);
  result[j] = withTangent(vertices[j], 'in', c);
  const created = withBone(vertices[i], vertexFromTangents(half[0], half[1], [ab[0] - half[0], ab[1] - half[1]], [bc[0] - half[0], bc[1] - half[1]]));
  result.splice(i + 1, 0, created);
  return result;
}

/**
 * Welds the end points of an open path (Auto-weld): end point `i` (0 or the last) was dropped on the other end. The
 * point that stayed keeps its data and the path closes; index 0 stays the first point, so the other indices don't
 * shift. Returns null if `i` is not an end point or there are fewer than 3 points.
 */
export function weldEnds(vertices, i) {
  const last = vertices.length - 1;
  if (vertices.length < 3 || (i !== 0 && i !== last)) return null;
  return i === last ? vertices.slice(0, last) : [vertices[last], ...vertices.slice(1, last)];
}

/** Poses and clips that store the points of a path (a morph): changing its point count would break them. */
export function vertexMorphs(doc, id) {
  return doc.objects.filter((o) => (o.type === 'pose' && o.values?.[id]?.vertices) || (o.type === 'animation' && o.tracks?.[id]?.vertices?.length)).map((o) => o.id);
}

/** Errors of a vertex (empty list if it is fine). */
export function vertexErrors(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['must be an object { x, y, ... }'];
  const mode = v.mode ?? 'straight';
  if (!MODES.includes(mode)) return [`mode must be ${MODES.join(', ')}`];
  const errors = [];
  const fields = VERTEX_FIELDS[mode];
  // `bone` (per-point binding) is valid in any mode; whether the bone exists is checked by the document.
  for (const k of Object.keys(v)) if (k !== 'bone' && !fields.includes(k)) errors.push(`field "${k}" does not belong in a ${mode} vertex (fields: ${fields.join(', ')}, and bone)`);
  if (v.bone !== undefined && (typeof v.bone !== 'string' || !v.bone)) errors.push('bone must be the id of a bone');
  for (const k of fields) {
    if (k === 'mode' || (k === 'radius' && v.radius === undefined)) continue;
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) errors.push(`${k} is missing (number)`);
    else if (/Dist$|^dist$|^radius$/.test(k) && v[k] < 0) errors.push(`${k} cannot be negative`);
  }
  return errors;
}

/**
 * Morph between two vertex lists of the same length: anchors and tangents are interpolated. The result has no
 * `bone`: the per-point binding belongs to the setup (`applyPose` sets it), like in Moho.
 */
export function blendVertices(a, b, w) {
  if (a.length !== b.length) return (w >= 0.5 ? b : a).map(({ bone, ...v }) => v);
  const lerp = (p, q) => [p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w];
  return a.map((goes, i) => {
    const vb = b[i];
    const [ta, tb] = [tangents(goes), tangents(vb)];
    const [x, y] = lerp([goes.x, goes.y], [vb.x, vb.y]);
    const radius = (goes.radius ?? 0) + ((vb.radius ?? 0) - (goes.radius ?? 0)) * w;
    return vertexFromTangents(x, y, lerp(ta.in, tb.in), lerp(ta.out, tb.out), radius ? { radius: Math.round(radius * 100) / 100 } : {});
  });
}
