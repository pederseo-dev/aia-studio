// Proyección de un documento a SVG. El documento es la fuente de verdad; el SVG es solo una vista.

import { hijos } from '../core/documento.js';
import { leer, leerMeta } from '../core/esquema.js';

const n = (v) => +v.toFixed(3);
const atributo = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Cómo se dibuja cada tipo concreto del esquema. Una prueba verifica que no falte ninguno.
export const DIBUJAR = {
  group: () => '',
  rect: (v) => {
    const w = v('width');
    const h = v('height');
    const r = Math.min(v('cornerRadius'), w / 2, h / 2);
    return `<rect x="${n(-w / 2)}" y="${n(-h / 2)}" width="${n(w)}" height="${n(h)}"${r ? ` rx="${n(r)}"` : ''}${pintura(v)}/>`;
  },
  ellipse: (v) => `<ellipse rx="${n(v('width') / 2)}" ry="${n(v('height') / 2)}"${pintura(v)}/>`,
};

function pintura(v) {
  const fill = v('fill');
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

function nodo(doc, esquema, obj) {
  const v = (prop) => leer(esquema, obj, prop);
  const atributos = [
    ` data-id="${obj.id}"`,
    transformacion(v),
    v('opacity') !== 1 ? ` opacity="${n(v('opacity'))}"` : '',
    v('visible') ? '' : ' display="none"',
  ].join('');
  const contenido = DIBUJAR[obj.type](v) + hijos(doc, obj.id).map((h) => nodo(doc, esquema, h)).join('');
  return `<g${atributos}>${contenido}</g>`;
}

/** Contenido del SVG (fondo + objetos), para insertar dentro de otro <svg> o <g>. */
export function contenidoSvg(doc, esquema) {
  const fondo = leerMeta(esquema, doc, 'background');
  const w = leerMeta(esquema, doc, 'width');
  const h = leerMeta(esquema, doc, 'height');
  const rect = fondo == null ? '' : `<rect data-fondo="" width="${w}" height="${h}" fill="${atributo(fondo)}"/>`;
  return rect + hijos(doc, null).map((o) => nodo(doc, esquema, o)).join('');
}

export function svgDocumento(doc, esquema) {
  const w = leerMeta(esquema, doc, 'width');
  const h = leerMeta(esquema, doc, 'height');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${contenidoSvg(doc, esquema)}</svg>`;
}
