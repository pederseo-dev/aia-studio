// Proyección de un documento a SVG. El documento es la fuente de verdad; el SVG es solo una vista.

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

// Cómo se dibuja cada tipo concreto del esquema (los recursos no se dibujan). Una prueba verifica que no falte ninguno.
// Los huesos no se dibujan en el personaje: el editor los muestra en su superposición.
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
  // El href lo decide la vista (`assets`): una URL del servidor en el editor; sin nada, el nombre del archivo (el MCP
  // lo cambia por los bytes al pasar a PNG). Estirada a width × height, como un rect.
  image: (v) => {
    const [w, h] = [v('width'), v('height')];
    const src = v('src');
    const href = v.assets ? v.assets(src) : src;
    const smoothed = v('pixelated') ? ' style="image-rendering:pixelated"' : '';
    return `<image href="${attribute(href)}" x="${n(-w * v('originX'))}" y="${n(-h * v('originY'))}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"${smoothed}/>`;
  },
};

// Recursos que generan algo en <defs>.
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
 * Con una pose, un objeto que sigue a otro hueso que su padre recibe una matriz completa: la que lo deja donde el
 * delta de su hueso lo lleva, vista desde el padre (que ya se movió con el suyo).
 */
function transformInPose(doc, schema, obj, v, ctx) {
  const delta = obj.bone ? (ctx.esqueleto.delta.get(obj.bone) ?? IDENTITY) : ctx.parentDelta;
  if (delta === ctx.parentDelta) return { delta, attribute: transform(v) };
  const parent = worldMatrix(doc, schema, obj.parent ?? null);
  const m = multiply(multiply(multiply(invert(parent), multiply(invert(ctx.parentDelta), delta)), parent), localMatrix(schema, obj));
  return { delta, attribute: ` transform="matrix(${m.map(n).join(' ')})"` };
}

/**
 * Enlace por punto: en una pose, cada vértice con `bone` se mueve (con sus tangentes) según el delta de su hueso, en
 * vez del de la forma. Así un solo path se dobla siguiendo una cadena de huesos (una cola, un brazo).
 */
function verticesInPose(doc, schema, obj, vertices, delta, ctx) {
  if (!vertices.some((vt) => vt.bone)) return vertices;
  const rest = worldMatrix(doc, schema, obj.id);
  const inverse = invert(multiply(delta, rest));
  const matrices = new Map();
  return vertices.map((vt) => {
    const d = vt.bone && ctx.esqueleto.delta.get(vt.bone);
    if (!d || d === delta) return vt;
    if (!matrices.has(vt.bone)) matrices.set(vt.bone, multiply(multiply(inverse, d), rest));
    return transformVertices([vt], matrices.get(vt.bone))[0];
  });
}

function node(doc, schema, obj, ctx) {
  let v = reader(doc, schema, obj, ctx.assets);
  const { delta, attribute: transformAttr } = ctx.esqueleto ? transformInPose(doc, schema, obj, v, ctx) : { delta: IDENTITY, attribute: transform(v) };
  if (ctx.esqueleto && obj.type === 'path') {
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
  // Los huesos de un skeleton son sus hijos, pero no se dibujan.
  let visible = children(doc, obj.id).filter((h) => DRAW[h.type]);
  // Un switch dibuja un solo hijo: el activo, o el primero.
  if (obj.type === 'switch') {
    const chosen = ctx.show?.[obj.id] ?? v('active');
    visible = [visible.find((h) => h.id === chosen) ?? visible[0]].filter(Boolean);
  }
  const content = DRAW[obj.type](v) + visible.map((h) => node(doc, schema, h, sub)).join('');
  return `<g${attributes}>${content}</g>`;
}

/**
 * Qué se dibuja: un clip en un tiempo (con los params encima), una pose sola (por id o como objeto), la mezcla de
 * poses que dan los params (un objeto { id_de_param: valor }, vacío = sus valores iniciales) o, sin nada, el montaje.
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
 * Contenido del SVG (definiciones + fondo + objetos), para insertar dentro de otro <svg> o <g>.
 * `pose`: id de una pose (o el objeto) para dibujarla sola; `params`: valores de params para dibujar la mezcla de
 * poses que dan los drivers; `animation` + `time`: un clip en ese tiempo (en segundos), con los params encima; sin
 * nada, el montaje.
 */
/** @param {any} setup @param {any} schema @param {import('../core/types.js').ViewOptions} [options] */
export function svgContent(setup, schema, { pose, params, animation, time, show, assets } = {}) {
  const activePose = resolvePose(setup, schema, pose, params, animation, time);
  // Lo que no es hueso toma los valores de la pose; los huesos se mueven por el esqueleto (con su delta).
  const doc = applyPose(setup, schema, activePose);
  const background = readMeta(schema, doc, 'background');
  const w = readMeta(schema, doc, 'width');
  const h = readMeta(schema, doc, 'height');
  const root = children(doc, null);
  const definitions = root.filter((o) => DEFINE[o.type]).map((o) => DEFINE[o.type](o, reader(doc, schema, o)));
  const defs = definitions.length ? `<defs>${definitions.join('')}</defs>` : '';
  const rect = background == null ? '' : `<rect data-fondo="" width="${w}" height="${h}" fill="${attribute(background)}"/>`;
  // `mostrar`: { id_de_switch: id_de_hijo } para ver una variante sin cambiarla (el editor, al seleccionarla).
  // `assets`: src → href de las capas image (el editor da la URL del servidor).
  const ctx = { esqueleto: activePose ? evaluateSkeleton(doc, schema, activePose) : null, parentDelta: IDENTITY, show, assets };
  const objects = root.filter((o) => DRAW[o.type]).map((o) => node(doc, schema, o, ctx));
  return defs + rect + objects.join('');
}

/**
 * El esqueleto dibujado encima, con el id de cada hueso: para revisar dónde quedaron (en el editor se ven en su
 * superposición; esto es para las vistas previas de la IA).
 */
/** @param {any} doc @param {any} schema @param {import('../core/types.js').ViewOptions} options */
function svgBones(doc, schema, { pose, params, animation, time }) {
  const bones = doc.objects.filter((o) => o.type === 'bone');
  if (!bones.length) return '';
  // Sobre lo que se ve: si la pose mueve el skeleton (o un grupo de arriba), los huesos van con él.
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
  return `<g data-huesos="">${parts.join('')}</g>`;
}

/**
 * SVG completo. `region` ({ x, y, width, height }) recorta una parte del documento; `huesos: true` dibuja el
 * esqueleto encima.
 */
/** @param {any} doc @param {any} schema @param {import('../core/types.js').ViewOptions} [options] */
export function svgDocument(doc, schema, { region, bones, ...options } = {}) {
  const r = region ?? { x: 0, y: 0, width: readMeta(schema, doc, 'width'), height: readMeta(schema, doc, 'height') };
  const above = bones ? svgBones(doc, schema, options) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(r.x)} ${n(r.y)} ${n(r.width)} ${n(r.height)}" width="${n(r.width)}" height="${n(r.height)}">${svgContent(doc, schema, options)}${above}</svg>`;
}

/**
 * Tira de cuadros de un clip: un cuadro por tiempo, en filas de hasta `columnas`, con el tiempo debajo de cada uno.
 * Sirve para ver el movimiento en una sola imagen (la vista previa de la IA). Acepta las mismas opciones que
 * svgDocumento (`region`, `huesos`, `params`) más `animation` y `times`, o `times` con `poses` (una por cuadro).
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
    // `poses`: una pose ya resuelta por cuadro (el runtime en vivo), en lugar de un clip en ese tiempo.
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
