// Projection of a document to SVG. The document is the source of truth; the SVG is only a view.

import { findObject, children } from '../core/document.js';
import { readMeta } from '../core/schema.js';
import { effectiveValue } from '../core/styles.js';
import { evaluateInPose, evaluateSkeleton } from '../core/skeleton.js';
import { clipPose } from '../core/animation.js';
import { applyPose, blendPoses } from '../core/blend.js';
import { IDENTITY, invert, localMatrix, worldMatrix, multiply } from '../core/geometry.js';
import { transformVertices, verticesAD } from '../core/paths.js';

const n = (v) => +v.toFixed(3);
const attribute = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const resourceId = (id) => `aia-${id}`;

// How each concrete type of the schema is drawn (assets are not drawn). A test checks that none is missing.
// Bones are not drawn in the character: the editor shows them in its overlay.
export const DRAW = {
  bone: null,
  group: () => '',
  switch: () => '',
  skeleton: () => '',
  rect: (v) => {
    const w = v('width');
    const h = v('height');
    const r = Math.min(v('cornerRadius'), w / 2, h / 2);
    return `<rect x="${n(-w * v('originX'))}" y="${n(-h * v('originY'))}" width="${n(w)}" height="${n(h)}"${r ? ` rx="${n(r)}"` : ''}${paint(v)}/>`;
  },
  ellipse: (v) => {
    const [w, h] = [v('width'), v('height')];
    const cx = w * (0.5 - v('originX'));
    const cy = h * (0.5 - v('originY'));
    return `<ellipse${cx ? ` cx="${n(cx)}"` : ''}${cy ? ` cy="${n(cy)}"` : ''} rx="${n(w / 2)}" ry="${n(h / 2)}"${paint(v)}/>`;
  },
  path: (v) => {
    const d = verticesAD(v('vertices'), v('closed'));
    return d ? `<path d="${d}"${paint(v)} stroke-linejoin="round" stroke-linecap="round"/>` : '';
  },
  // The href is decided by the view (`assets`): a server URL in the editor; with nothing, the file name (the MCP
  // replaces it with the bytes when converting to PNG). Stretched to width × height, like a rect.
  image: (v) => {
    const [w, h] = [v('width'), v('height')];
    const src = v('src');
    const href = v.assets ? v.assets(src) : src;
    const smoothed = v('pixelated') ? ' style="image-rendering:pixelated"' : '';
    return `<image href="${attribute(href)}" x="${n(-w * v('originX'))}" y="${n(-h * v('originY'))}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"${smoothed}/>`;
  },
};

// Assets that generate something in <defs>.
const DEFINE = {
  linear_gradient: (o, v) => `<linearGradient id="${resourceId(o.id)}" x1="${n(v('x1'))}" y1="${n(v('y1'))}" x2="${n(v('x2'))}" y2="${n(v('y2'))}">${stops(v('stops'))}</linearGradient>`,
  radial_gradient: (o, v) => `<radialGradient id="${resourceId(o.id)}" cx="${n(v('cx'))}" cy="${n(v('cy'))}" r="${n(v('r'))}">${stops(v('stops'))}</radialGradient>`,
};

function stops(stops) {
  return stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${attribute(s.color)}"${s.opacity != null && s.opacity !== 1 ? ` stop-opacity="${n(s.opacity)}"` : ''}/>`).join('');
}

function paint(v) {
  const gradient = v('fillGradient');
  const fill = gradient && v.doc && findObject(v.doc, gradient) ? `url(#${resourceId(gradient)})` : v('fill');
  const stroke = v('stroke');
  let s = ` fill="${fill == null ? 'none' : attribute(fill)}"`;
  if (stroke != null && v('strokeWidth') > 0) s += ` stroke="${attribute(stroke)}" stroke-width="${n(v('strokeWidth'))}"`;
  return s;
}

function transform(v) {
  const parts = [];
  if (v('x') || v('y')) parts.push(`translate(${n(v('x'))} ${n(v('y'))})`);
  if (v('rotation')) parts.push(`rotate(${n(v('rotation'))})`);
  if (v('scaleX') !== 1 || v('scaleY') !== 1) parts.push(`scale(${n(v('scaleX'))} ${n(v('scaleY'))})`);
  return parts.length ? ` transform="${parts.join(' ')}"` : '';
}

const reader = (doc, schema, obj, assets = null) => Object.assign((prop) => effectiveValue(schema, doc, obj, prop), { doc, assets });

/**
 * With a pose, an object that follows a different bone than its parent gets a full matrix: the one that leaves it
 * where the delta of its bone takes it, seen from the parent (which already moved with its own).
 */
function transformInPose(doc, schema, obj, v, ctx) {
  const delta = obj.bone ? (ctx.skeleton.delta.get(obj.bone) ?? IDENTITY) : ctx.parentDelta;
  if (delta === ctx.parentDelta) return { delta, attribute: transform(v) };
  const parent = worldMatrix(doc, schema, obj.parent ?? null);
  const m = multiply(multiply(multiply(invert(parent), multiply(invert(ctx.parentDelta), delta)), parent), localMatrix(schema, obj));
  return { delta, attribute: ` transform="matrix(${m.map(n).join(' ')})"` };
}

/**
 * Per-point binding: in a pose, each vertex with `bone` moves (with its tangents) according to the delta of its
 * bone, instead of the shape's. So a single path bends following a chain of bones (a tail, an arm).
 */
function verticesInPose(doc, schema, obj, vertices, delta, ctx) {
  if (!vertices.some((vt) => vt.bone)) return vertices;
  const rest = worldMatrix(doc, schema, obj.id);
  const inverse = invert(multiply(delta, rest));
  const matrices = new Map();
  return vertices.map((vt) => {
    const d = vt.bone && ctx.skeleton.delta.get(vt.bone);
    if (!d || d === delta) return vt;
    if (!matrices.has(vt.bone)) matrices.set(vt.bone, multiply(multiply(inverse, d), rest));
    return transformVertices([vt], matrices.get(vt.bone))[0];
  });
}

function node(doc, schema, obj, ctx) {
  let v = reader(doc, schema, obj, ctx.assets);
  const { delta, attribute: transformAttr } = ctx.skeleton ? transformInPose(doc, schema, obj, v, ctx) : { delta: IDENTITY, attribute: transform(v) };
  if (ctx.skeleton && obj.type === 'path') {
    const base = v;
    const deformed = verticesInPose(doc, schema, obj, base('vertices'), delta, ctx);
    v = Object.assign((prop) => (prop === 'vertices' ? deformed : base(prop)), { doc: base.doc, assets: base.assets });
  }
  const attributes = [
    ` data-id="${obj.id}"`,
    transformAttr,
    v('opacity') !== 1 ? ` opacity="${n(v('opacity'))}"` : '',
    v('visible') ? '' : ' display="none"',
  ].join('');
  const sub = { ...ctx, parentDelta: delta };
  // The bones of a skeleton are its children, but they are not drawn.
  let visible = children(doc, obj.id).filter((h) => DRAW[h.type]);
  // A switch draws a single child: the active one, or the first.
  if (obj.type === 'switch') {
    const chosen = ctx.show?.[obj.id] ?? v('active');
    visible = [visible.find((h) => h.id === chosen) ?? visible[0]].filter(Boolean);
  }
  const content = DRAW[obj.type](v) + visible.map((h) => node(doc, schema, h, sub)).join('');
  return `<g${attributes}>${content}</g>`;
}

/**
 * What is drawn: a clip at a time (with the params on top), a single pose (by id or as an object), the blend of
 * poses given by the params (an object { param_id: value }, empty = their initial values) or, with nothing, the
 * setup.
 */
export function resolvePose(doc, schema, pose, params, animation = null, time = 0) {
  if (animation) return clipPose(doc, schema, animation, time, params ?? {});
  if (pose) {
    const p = typeof pose === 'string' ? findObject(doc, pose) : pose;
    return p?.type === 'pose' ? p : null;
  }
  return params ? blendPoses(doc, schema, params) : null;
}

/**
 * SVG content (definitions + background + objects), to insert inside another <svg> or <g>.
 * `pose`: id of a pose (or the object) to draw it alone; `params`: param values to draw the blend of poses given
 * by the drivers; `animation` + `time`: a clip at that time (in seconds), with the params on top; with nothing,
 * the setup.
 */
/** @param {any} setup @param {any} schema @param {import('../core/types.js').ViewOptions} [options] */
export function svgContent(setup, schema, { pose, params, animation, time, show, assets } = {}) {
  const activePose = resolvePose(setup, schema, pose, params, animation, time);
  // What is not a bone takes the values of the pose; bones are moved by the skeleton (with their delta).
  const doc = applyPose(setup, schema, activePose);
  const background = readMeta(schema, doc, 'background');
  const w = readMeta(schema, doc, 'width');
  const h = readMeta(schema, doc, 'height');
  const root = children(doc, null);
  const definitions = root.filter((o) => DEFINE[o.type]).map((o) => DEFINE[o.type](o, reader(doc, schema, o)));
  const defs = definitions.length ? `<defs>${definitions.join('')}</defs>` : '';
  const rect = background == null ? '' : `<rect data-background="" width="${w}" height="${h}" fill="${attribute(background)}"/>`;
  // `show`: { switch_id: child_id } to see a variant without changing it (the editor, when selecting it).
  // `assets`: src → href of the image layers (the editor gives the server URL).
  const ctx = { skeleton: activePose ? evaluateSkeleton(doc, schema, activePose) : null, parentDelta: IDENTITY, show, assets };
  const objects = root.filter((o) => DRAW[o.type]).map((o) => node(doc, schema, o, ctx));
  return defs + rect + objects.join('');
}

/**
 * The skeleton drawn on top, with the id of each bone: to check where they ended up (in the editor they are seen
 * in its overlay; this is for the AI previews).
 */
/** @param {any} doc @param {any} schema @param {import('../core/types.js').ViewOptions} options */
function svgBones(doc, schema, { pose, params, animation, time }) {
  const bones = doc.objects.filter((o) => o.type === 'bone');
  if (!bones.length) return '';
  // On top of what is seen: if the pose moves the skeleton (or a group above), the bones go with it.
  const { posed } = evaluateInPose(doc, schema, resolvePose(doc, schema, pose, params, animation, time));
  const parts = bones.map((h) => {
    const m = posed.get(h.id);
    const length = effectiveValue(schema, doc, h, 'length');
    const width = Math.min(9, Math.max(3, length * 0.12));
    const points = [[0, 0], [length * 0.2, width], [length, 0], [length * 0.2, -width]].map((p) => p.map(n).join(',')).join(' ');
    const [ox, oy] = [m[4], m[5]];
    const shape = `<g transform="matrix(${m.map(n).join(' ')})"><polygon points="${points}" fill="#ff3d7f55" stroke="#ff3d7f" stroke-width="1.5" vector-effect="non-scaling-stroke"/></g>`;
    const name = `<text x="${n(ox + 6)}" y="${n(oy - 6)}" font-family="sans-serif" font-size="12" fill="#ff3d7f" stroke="#ffffff" stroke-width="3" paint-order="stroke">${attribute(h.id)}</text>`;
    return shape + `<circle cx="${n(ox)}" cy="${n(oy)}" r="3" fill="#ff3d7f"/>` + name;
  });
  return `<g data-bones="">${parts.join('')}</g>`;
}

/**
 * Full SVG. `region` ({ x, y, width, height }) crops a part of the document; `bones: true` draws the skeleton
 * on top.
 */
/** @param {any} doc @param {any} schema @param {import('../core/types.js').ViewOptions} [options] */
export function svgDocument(doc, schema, { region, bones, ...options } = {}) {
  const r = region ?? { x: 0, y: 0, width: readMeta(schema, doc, 'width'), height: readMeta(schema, doc, 'height') };
  const above = bones ? svgBones(doc, schema, options) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(r.x)} ${n(r.y)} ${n(r.width)} ${n(r.height)}" width="${n(r.width)}" height="${n(r.height)}">${svgContent(doc, schema, options)}${above}</svg>`;
}

/**
 * Frame strip of a clip: one frame per time, in rows of up to `columns`, with the time below each one.
 * It serves to see the motion in a single image (the AI preview). Accepts the same options as
 * svgDocument (`region`, `bones`, `params`) plus `animation` and `times`, or `times` with `poses` (one per frame).
 */
/** @param {any} doc @param {any} schema @param {import('../core/types.js').ViewOptions} [options] */
export function svgStrip(doc, schema, { times, poses, columns = 4, region, bones, ...options } = {}) {
  const r = region ?? { x: 0, y: 0, width: readMeta(schema, doc, 'width'), height: readMeta(schema, doc, 'height') };
  const cols = Math.min(columns, times.length);
  const rows = Math.ceil(times.length / cols);
  const margin = r.width * 0.03;
  const label = Math.max(14, r.width * 0.07);
  const [width, height] = [r.width + margin, r.height + label + margin];
  const frames = times.map((time, i) => {
    const [x, y] = [(i % cols) * width, Math.floor(i / cols) * height];
    // `poses`: an already resolved pose per frame (the live runtime), instead of a clip at that time.
    const o = poses ? { ...options, pose: poses[i] } : { ...options, time };
    const above = bones ? svgBones(doc, schema, o) : '';
    const view = `<svg x="${n(x)}" y="${n(y)}" width="${n(r.width)}" height="${n(r.height)}" viewBox="${n(r.x)} ${n(r.y)} ${n(r.width)} ${n(r.height)}" overflow="hidden">${svgContent(doc, schema, o)}${above}</svg>`;
    const frame = `<rect x="${n(x)}" y="${n(y)}" width="${n(r.width)}" height="${n(r.height)}" fill="none" stroke="#999999" stroke-width="${n(r.width / 300)}"/>`;
    const text = `<text x="${n(x + r.width / 2)}" y="${n(y + r.height + label * 0.8)}" text-anchor="middle" font-family="sans-serif" font-size="${n(label * 0.7)}" fill="#333333">t = ${+time.toFixed(3)} s</text>`;
    return view + frame + text;
  });
  const [w, h] = [cols * width - margin, rows * height - margin];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}"><rect width="${n(w)}" height="${n(h)}" fill="#ffffff"/>${frames.join('')}</svg>`;
}
