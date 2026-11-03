// Proyección de un documento a SVG. El documento es la fuente de verdad; el SVG es solo una vista.

import { buscar, hijos } from '../core/documento.js';
import { leerMeta } from '../core/esquema.js';
import { valorEfectivo } from '../core/estilos.js';
import { evaluarEsqueleto } from '../core/esqueleto.js';
import { IDENTIDAD, invertir, matrizLocal, matrizMundo, multiplicar } from '../core/geometria.js';
import { verticesAD } from '../core/trazado.js';

const n = (v) => +v.toFixed(3);
const atributo = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const idDeRecurso = (id) => `aia-${id}`;

// Cómo se dibuja cada tipo concreto del esquema (los recursos no se dibujan). Una prueba verifica que no falte ninguno.
// Los huesos no se dibujan en el personaje: el editor los muestra en su superposición.
export const DIBUJAR = {
  bone: null,
  group: () => '',
  rect: (v) => {
    const w = v('width');
    const h = v('height');
    const r = Math.min(v('cornerRadius'), w / 2, h / 2);
    return `<rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}"${r ? ` rx="${n(r)}"` : ''}${pintura(v)}/>`;
  },
  ellipse: (v) => `<ellipse rx="${n(v('width') / 2)}" ry="${n(v('height') / 2)}"${pintura(v)}/>`,
  path: (v) => {
    const d = verticesAD(v('vertices'), v('closed'));
    return d ? `<path d="${d}"${pintura(v)} stroke-linejoin="round" stroke-linecap="round"/>` : '';
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

const lector = (doc, esquema, obj) => Object.assign((prop) => valorEfectivo(esquema, doc, obj, prop), { doc });

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

function nodo(doc, esquema, obj, ctx) {
  const v = lector(doc, esquema, obj);
  const { delta, atributo: transformar } = ctx.esqueleto ? transformacionEnPose(doc, esquema, obj, v, ctx) : { delta: IDENTIDAD, atributo: transformacion(v) };
  const atributos = [
    ` data-id="${obj.id}"`,
    transformar,
    v('opacity') !== 1 ? ` opacity="${n(v('opacity'))}"` : '',
    v('visible') ? '' : ' display="none"',
  ].join('');
  const sub = { ...ctx, deltaPadre: delta };
  const contenido = DIBUJAR[obj.type](v) + hijos(doc, obj.id).map((h) => nodo(doc, esquema, h, sub)).join('');
  return `<g${atributos}>${contenido}</g>`;
}

/** La pose pedida (por id o como objeto), o null para el montaje. */
function resolverPose(doc, pose) {
  if (!pose) return null;
  const p = typeof pose === 'string' ? buscar(doc, pose) : pose;
  return p?.type === 'pose' ? p : null;
}

/**
 * Contenido del SVG (definiciones + fondo + objetos), para insertar dentro de otro <svg> o <g>.
 * `pose`: id de una pose del documento (o el objeto) para dibujar al personaje posado; sin ella, el montaje.
 */
export function contenidoSvg(doc, esquema, { pose } = {}) {
  const fondo = leerMeta(esquema, doc, 'background');
  const w = leerMeta(esquema, doc, 'width');
  const h = leerMeta(esquema, doc, 'height');
  const raiz = hijos(doc, null);
  const definiciones = raiz.filter((o) => DEFINIR[o.type]).map((o) => DEFINIR[o.type](o, lector(doc, esquema, o)));
  const defs = definiciones.length ? `<defs>${definiciones.join('')}</defs>` : '';
  const rect = fondo == null ? '' : `<rect data-fondo="" width="${w}" height="${h}" fill="${atributo(fondo)}"/>`;
  const poseActiva = resolverPose(doc, pose);
  const ctx = { esqueleto: poseActiva ? evaluarEsqueleto(doc, esquema, poseActiva) : null, deltaPadre: IDENTIDAD };
  const objetos = raiz.filter((o) => DIBUJAR[o.type]).map((o) => nodo(doc, esquema, o, ctx));
  return defs + rect + objetos.join('');
}

/**
 * El esqueleto dibujado encima, con el id de cada hueso: para revisar dónde quedaron (en el editor se ven en su
 * superposición; esto es para las vistas previas de la IA).
 */
function svgHuesos(doc, esquema, pose) {
  const huesos = doc.objects.filter((o) => o.type === 'bone');
  if (!huesos.length) return '';
  const { posado } = evaluarEsqueleto(doc, esquema, resolverPose(doc, pose));
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
export function svgDocumento(doc, esquema, { region, huesos, ...opciones } = {}) {
  const r = region ?? { x: 0, y: 0, width: leerMeta(esquema, doc, 'width'), height: leerMeta(esquema, doc, 'height') };
  const encima = huesos ? svgHuesos(doc, esquema, opciones.pose) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(r.x)} ${n(r.y)} ${n(r.width)} ${n(r.height)}" width="${n(r.width)}" height="${n(r.height)}">${contenidoSvg(doc, esquema, opciones)}${encima}</svg>`;
}
