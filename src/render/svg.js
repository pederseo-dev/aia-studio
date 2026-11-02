// Proyección de un documento a SVG. El documento es la fuente de verdad; el SVG es solo una vista.

import { buscar, hijos } from '../core/documento.js';
import { leerMeta } from '../core/esquema.js';
import { valorEfectivo } from '../core/estilos.js';
import { verticesAD } from '../core/trazado.js';

const n = (v) => +v.toFixed(3);
const atributo = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const idDeRecurso = (id) => `aia-${id}`;

// Cómo se dibuja cada tipo concreto del esquema (los recursos no se dibujan). Una prueba verifica que no falte ninguno.
export const DIBUJAR = {
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

function nodo(doc, esquema, obj) {
  const v = lector(doc, esquema, obj);
  const atributos = [
    ` data-id="${obj.id}"`,
    transformacion(v),
    v('opacity') !== 1 ? ` opacity="${n(v('opacity'))}"` : '',
    v('visible') ? '' : ' display="none"',
  ].join('');
  const contenido = DIBUJAR[obj.type](v) + hijos(doc, obj.id).map((h) => nodo(doc, esquema, h)).join('');
  return `<g${atributos}>${contenido}</g>`;
}

/** Contenido del SVG (definiciones + fondo + objetos), para insertar dentro de otro <svg> o <g>. */
export function contenidoSvg(doc, esquema) {
  const fondo = leerMeta(esquema, doc, 'background');
  const w = leerMeta(esquema, doc, 'width');
  const h = leerMeta(esquema, doc, 'height');
  const raiz = hijos(doc, null);
  const definiciones = raiz.filter((o) => DEFINIR[o.type]).map((o) => DEFINIR[o.type](o, lector(doc, esquema, o)));
  const defs = definiciones.length ? `<defs>${definiciones.join('')}</defs>` : '';
  const rect = fondo == null ? '' : `<rect data-fondo="" width="${w}" height="${h}" fill="${atributo(fondo)}"/>`;
  const objetos = raiz.filter((o) => !esquema.tipos.get(o.type).resource).map((o) => nodo(doc, esquema, o));
  return defs + rect + objetos.join('');
}

export function svgDocumento(doc, esquema) {
  const w = leerMeta(esquema, doc, 'width');
  const h = leerMeta(esquema, doc, 'height');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${contenidoSvg(doc, esquema)}</svg>`;
}
