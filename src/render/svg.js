// Proyección de un documento a SVG. El documento es la fuente de verdad; el SVG es solo una vista.

import { buscar, hijos } from '../core/documento.js';
import { leerMeta } from '../core/esquema.js';
import { valorEfectivo } from '../core/estilos.js';
import { evaluarEnPose, evaluarEsqueleto } from '../core/esqueleto.js';
import { poseDeClip } from '../core/animacion.js';
import { aplicarPose, mezclarPoses } from '../core/mezcla.js';
import { IDENTIDAD, invertir, matrizLocal, matrizMundo, multiplicar } from '../core/geometria.js';
import { transformarVertices, verticesAD } from '../core/trazado.js';

const n = (v) => +v.toFixed(3);
const atributo = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const idDeRecurso = (id) => `aia-${id}`;

// Cómo se dibuja cada tipo concreto del esquema (los recursos no se dibujan). Una prueba verifica que no falte ninguno.
// Los huesos no se dibujan en el personaje: el editor los muestra en su superposición.
export const DIBUJAR = {
  bone: null,
  group: () => '',
  switch: () => '',
  skeleton: () => '',
  rect: (v) => {
    const w = v('width');
    const h = v('height');
    const r = Math.min(v('cornerRadius'), w / 2, h / 2);
    return `<rect x="${n(-w * v('originX'))}" y="${n(-h * v('originY'))}" width="${n(w)}" height="${n(h)}"${r ? ` rx="${n(r)}"` : ''}${pintura(v)}/>`;
  },
  ellipse: (v) => {
    const [w, h] = [v('width'), v('height')];
    const cx = w * (0.5 - v('originX'));
    const cy = h * (0.5 - v('originY'));
    return `<ellipse${cx ? ` cx="${n(cx)}"` : ''}${cy ? ` cy="${n(cy)}"` : ''} rx="${n(w / 2)}" ry="${n(h / 2)}"${pintura(v)}/>`;
  },
  path: (v) => {
    const d = verticesAD(v('vertices'), v('closed'));
    return d ? `<path d="${d}"${pintura(v)} stroke-linejoin="round" stroke-linecap="round"/>` : '';
  },
  // El href lo decide la vista (`assets`): una URL del servidor en el editor; sin nada, el nombre del archivo (el MCP
  // lo cambia por los bytes al pasar a PNG). Estirada a width × height, como un rect.
  image: (v) => {
    const [w, h] = [v('width'), v('height')];
    const src = v('src');
    const href = v.assets ? v.assets(src) : src;
    const suavizado = v('pixelated') ? ' style="image-rendering:pixelated"' : '';
    return `<image href="${atributo(href)}" x="${n(-w * v('originX'))}" y="${n(-h * v('originY'))}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"${suavizado}/>`;
  },
};

// Recursos que generan algo en <defs>.
const DEFINIR = {
  linear_gradient: (o, v) => `<linearGradient id="${idDeRecurso(o.id)}" x1="${n(v('x1'))}" y1="${n(v('y1'))}" x2="${n(v('x2'))}" y2="${n(v('y2'))}">${paradas(v('stops'))}</linearGradient>`,
  radial_gradient: (o, v) => `<radialGradient id="${idDeRecurso(o.id)}" cx="${n(v('cx'))}" cy="${n(v('cy'))}" r="${n(v('r'))}">${paradas(v('stops'))}</radialGradient>`,
};

function paradas(stops) {
  return stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${atributo(s.color)}"${s.opacity != null && s.opacity !== 1 ? ` stop-opacity="${n(s.opacity)}"` : ''}/>`).join('');
}

function pintura(v) {
  const degradado = v('fillGradient');
  const fill = degradado && v.doc && buscar(v.doc, degradado) ? `url(#${idDeRecurso(degradado)})` : v('fill');
  const stroke = v('stroke');
  let s = ` fill="${fill == null ? 'none' : atributo(fill)}"`;
  if (stroke != null && v('strokeWidth') > 0) s += ` stroke="${atributo(stroke)}" stroke-width="${n(v('strokeWidth'))}"`;
  return s;
}

function transformacion(v) {
  const partes = [];
  if (v('x') || v('y')) partes.push(`translate(${n(v('x'))} ${n(v('y'))})`);
  if (v('rotation')) partes.push(`rotate(${n(v('rotation'))})`);
  if (v('scaleX') !== 1 || v('scaleY') !== 1) partes.push(`scale(${n(v('scaleX'))} ${n(v('scaleY'))})`);
  return partes.length ? ` transform="${partes.join(' ')}"` : '';
}

const lector = (doc, esquema, obj, assets = null) => Object.assign((prop) => valorEfectivo(esquema, doc, obj, prop), { doc, assets });

/**
 * Con una pose, un objeto que sigue a otro hueso que su padre recibe una matriz completa: la que lo deja donde el
 * delta de su hueso lo lleva, vista desde el padre (que ya se movió con el suyo).
 */
function transformacionEnPose(doc, esquema, obj, v, ctx) {
  const delta = obj.bone ? (ctx.esqueleto.delta.get(obj.bone) ?? IDENTIDAD) : ctx.deltaPadre;
  if (delta === ctx.deltaPadre) return { delta, atributo: transformacion(v) };
  const padre = matrizMundo(doc, esquema, obj.parent ?? null);
  const m = multiplicar(multiplicar(multiplicar(invertir(padre), multiplicar(invertir(ctx.deltaPadre), delta)), padre), matrizLocal(esquema, obj));
  return { delta, atributo: ` transform="matrix(${m.map(n).join(' ')})"` };
}

/**
 * Enlace por punto: en una pose, cada vértice con `bone` se mueve (con sus tangentes) según el delta de su hueso, en
 * vez del de la forma. Así un solo path se dobla siguiendo una cadena de huesos (una cola, un brazo).
 */
function verticesEnPose(doc, esquema, obj, vertices, delta, ctx) {
  if (!vertices.some((vt) => vt.bone)) return vertices;
  const reposo = matrizMundo(doc, esquema, obj.id);
  const inversa = invertir(multiplicar(delta, reposo));
  const matrices = new Map();
  return vertices.map((vt) => {
    const d = vt.bone && ctx.esqueleto.delta.get(vt.bone);
    if (!d || d === delta) return vt;
    if (!matrices.has(vt.bone)) matrices.set(vt.bone, multiplicar(multiplicar(inversa, d), reposo));
    return transformarVertices([vt], matrices.get(vt.bone))[0];
  });
}

function nodo(doc, esquema, obj, ctx) {
  let v = lector(doc, esquema, obj, ctx.assets);
  const { delta, atributo: transformar } = ctx.esqueleto ? transformacionEnPose(doc, esquema, obj, v, ctx) : { delta: IDENTIDAD, atributo: transformacion(v) };
  if (ctx.esqueleto && obj.type === 'path') {
    const base = v;
    const deformados = verticesEnPose(doc, esquema, obj, base('vertices'), delta, ctx);
    v = Object.assign((prop) => (prop === 'vertices' ? deformados : base(prop)), { doc: base.doc, assets: base.assets });
  }
  const atributos = [
    ` data-id="${obj.id}"`,
    transformar,
    v('opacity') !== 1 ? ` opacity="${n(v('opacity'))}"` : '',
    v('visible') ? '' : ' display="none"',
  ].join('');
  const sub = { ...ctx, deltaPadre: delta };
  // Los huesos de un skeleton son sus hijos, pero no se dibujan.
  let visibles = hijos(doc, obj.id).filter((h) => DIBUJAR[h.type]);
  // Un switch dibuja un solo hijo: el activo, o el primero.
  if (obj.type === 'switch') {
    const elegido = ctx.mostrar?.[obj.id] ?? v('active');
    visibles = [visibles.find((h) => h.id === elegido) ?? visibles[0]].filter(Boolean);
  }
  const contenido = DIBUJAR[obj.type](v) + visibles.map((h) => nodo(doc, esquema, h, sub)).join('');
  return `<g${atributos}>${contenido}</g>`;
}

/**
 * Qué se dibuja: un clip en un tiempo (con los params encima), una pose sola (por id o como objeto), la mezcla de
 * poses que dan los params (un objeto { id_de_param: valor }, vacío = sus valores iniciales) o, sin nada, el montaje.
 */
export function resolverPose(doc, esquema, pose, params, animation = null, time = 0) {
  if (animation) return poseDeClip(doc, esquema, animation, time, params ?? {});
  if (pose) {
    const p = typeof pose === 'string' ? buscar(doc, pose) : pose;
    return p?.type === 'pose' ? p : null;
  }
  return params ? mezclarPoses(doc, esquema, params) : null;
}

/**
 * Contenido del SVG (definiciones + fondo + objetos), para insertar dentro de otro <svg> o <g>.
 * `pose`: id de una pose (o el objeto) para dibujarla sola; `params`: valores de params para dibujar la mezcla de
 * poses que dan los drivers; `animation` + `time`: un clip en ese tiempo (en segundos), con los params encima; sin
 * nada, el montaje.
 */
/** @param {any} montaje @param {any} esquema @param {import('../core/tipos.js').OpcionesDeVista} [opciones] */
export function contenidoSvg(montaje, esquema, { pose, params, animation, time, mostrar, assets } = {}) {
  const poseActiva = resolverPose(montaje, esquema, pose, params, animation, time);
  // Lo que no es hueso toma los valores de la pose; los huesos se mueven por el esqueleto (con su delta).
  const doc = aplicarPose(montaje, esquema, poseActiva);
  const fondo = leerMeta(esquema, doc, 'background');
  const w = leerMeta(esquema, doc, 'width');
  const h = leerMeta(esquema, doc, 'height');
  const raiz = hijos(doc, null);
  const definiciones = raiz.filter((o) => DEFINIR[o.type]).map((o) => DEFINIR[o.type](o, lector(doc, esquema, o)));
  const defs = definiciones.length ? `<defs>${definiciones.join('')}</defs>` : '';
  const rect = fondo == null ? '' : `<rect data-fondo="" width="${w}" height="${h}" fill="${atributo(fondo)}"/>`;
  // `mostrar`: { id_de_switch: id_de_hijo } para ver una variante sin cambiarla (el editor, al seleccionarla).
  // `assets`: src → href de las capas image (el editor da la URL del servidor).
  const ctx = { esqueleto: poseActiva ? evaluarEsqueleto(doc, esquema, poseActiva) : null, deltaPadre: IDENTIDAD, mostrar, assets };
  const objetos = raiz.filter((o) => DIBUJAR[o.type]).map((o) => nodo(doc, esquema, o, ctx));
  return defs + rect + objetos.join('');
}

/**
 * El esqueleto dibujado encima, con el id de cada hueso: para revisar dónde quedaron (en el editor se ven en su
 * superposición; esto es para las vistas previas de la IA).
 */
/** @param {any} doc @param {any} esquema @param {import('../core/tipos.js').OpcionesDeVista} opciones */
function svgHuesos(doc, esquema, { pose, params, animation, time }) {
  const huesos = doc.objects.filter((o) => o.type === 'bone');
  if (!huesos.length) return '';
  // Sobre lo que se ve: si la pose mueve el skeleton (o un grupo de arriba), los huesos van con él.
  const { posado } = evaluarEnPose(doc, esquema, resolverPose(doc, esquema, pose, params, animation, time));
  const partes = huesos.map((h) => {
    const m = posado.get(h.id);
    const largo = valorEfectivo(esquema, doc, h, 'length');
    const ancho = Math.min(9, Math.max(3, largo * 0.12));
    const puntos = [[0, 0], [largo * 0.2, ancho], [largo, 0], [largo * 0.2, -ancho]].map((p) => p.map(n).join(',')).join(' ');
    const [ox, oy] = [m[4], m[5]];
    const forma = `<g transform="matrix(${m.map(n).join(' ')})"><polygon points="${puntos}" fill="#ff3d7f55" stroke="#ff3d7f" stroke-width="1.5" vector-effect="non-scaling-stroke"/></g>`;
    const nombre = `<text x="${n(ox + 6)}" y="${n(oy - 6)}" font-family="sans-serif" font-size="12" fill="#ff3d7f" stroke="#ffffff" stroke-width="3" paint-order="stroke">${atributo(h.id)}</text>`;
    return forma + `<circle cx="${n(ox)}" cy="${n(oy)}" r="3" fill="#ff3d7f"/>` + nombre;
  });
  return `<g data-huesos="">${partes.join('')}</g>`;
}

/**
 * SVG completo. `region` ({ x, y, width, height }) recorta una parte del documento; `huesos: true` dibuja el
 * esqueleto encima.
 */
/** @param {any} doc @param {any} esquema @param {import('../core/tipos.js').OpcionesDeVista} [opciones] */
export function svgDocumento(doc, esquema, { region, huesos, ...opciones } = {}) {
  const r = region ?? { x: 0, y: 0, width: leerMeta(esquema, doc, 'width'), height: leerMeta(esquema, doc, 'height') };
  const encima = huesos ? svgHuesos(doc, esquema, opciones) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(r.x)} ${n(r.y)} ${n(r.width)} ${n(r.height)}" width="${n(r.width)}" height="${n(r.height)}">${contenidoSvg(doc, esquema, opciones)}${encima}</svg>`;
}

/**
 * Tira de cuadros de un clip: un cuadro por tiempo, en filas de hasta `columnas`, con el tiempo debajo de cada uno.
 * Sirve para ver el movimiento en una sola imagen (la vista previa de la IA). Acepta las mismas opciones que
 * svgDocumento (`region`, `huesos`, `params`) más `animation` y `times`, o `times` con `poses` (una por cuadro).
 */
/** @param {any} doc @param {any} esquema @param {import('../core/tipos.js').OpcionesDeVista} [opciones] */
export function svgTira(doc, esquema, { times, poses, columnas = 4, region, huesos, ...opciones } = {}) {
  const r = region ?? { x: 0, y: 0, width: leerMeta(esquema, doc, 'width'), height: leerMeta(esquema, doc, 'height') };
  const cols = Math.min(columnas, times.length);
  const filas = Math.ceil(times.length / cols);
  const margen = r.width * 0.03;
  const rotulo = Math.max(14, r.width * 0.07);
  const [ancho, alto] = [r.width + margen, r.height + rotulo + margen];
  const cuadros = times.map((time, i) => {
    const [x, y] = [(i % cols) * ancho, Math.floor(i / cols) * alto];
    // `poses`: una pose ya resuelta por cuadro (el runtime en vivo), en lugar de un clip en ese tiempo.
    const o = poses ? { ...opciones, pose: poses[i] } : { ...opciones, time };
    const encima = huesos ? svgHuesos(doc, esquema, o) : '';
    const vista = `<svg x="${n(x)}" y="${n(y)}" width="${n(r.width)}" height="${n(r.height)}" viewBox="${n(r.x)} ${n(r.y)} ${n(r.width)} ${n(r.height)}" overflow="hidden">${contenidoSvg(doc, esquema, o)}${encima}</svg>`;
    const marco = `<rect x="${n(x)}" y="${n(y)}" width="${n(r.width)}" height="${n(r.height)}" fill="none" stroke="#999999" stroke-width="${n(r.width / 300)}"/>`;
    const texto = `<text x="${n(x + r.width / 2)}" y="${n(y + r.height + rotulo * 0.8)}" text-anchor="middle" font-family="sans-serif" font-size="${n(rotulo * 0.7)}" fill="#333333">t = ${+time.toFixed(3)} s</text>`;
    return vista + marco + texto;
  });
  const [w, h] = [cols * ancho - margen, filas * alto - margen];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}"><rect width="${n(w)}" height="${n(h)}" fill="#ffffff"/>${cuadros.join('')}</svg>`;
}
