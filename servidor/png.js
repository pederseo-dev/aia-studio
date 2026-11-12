// SVG → PNG en Node, para que la IA pueda ver lo que hizo.

import { Resvg } from '@resvg/resvg-js';
import { mimeDeAsset } from '../src/core/imagenes.js';

/** Formatos que resvg no sabe dibujar: en la vista previa van como un recuadro gris con una cruz, en su lugar. */
export const SIN_VISTA_PREVIA = new Set(['image/webp']);

/**
 * Las capas image nombran su archivo por su src (ver DIBUJAR.image): aquí pasan a data: URI con los bytes de
 * `imagenes` (src → bytes); las que no están se quitan (resvg no lee archivos sueltos).
 * @param {string} svg @param {Map<string, Uint8Array>} imagenes
 */
export function incrustarImagenes(svg, imagenes) {
  return svg.replace(/<image href="([^"]*)"[^>]*\/>/g, (etiqueta, href) => {
    const src = href.replace(/&amp;/g, '&');
    const bytes = imagenes.get(src);
    const mime = mimeDeAsset(src);
    if (!bytes || !mime) return '';
    if (SIN_VISTA_PREVIA.has(mime)) {
      const a = (k) => Number(new RegExp(` ${k}="([^"]*)"`).exec(etiqueta)?.[1] ?? 0);
      const [x, y, w, h] = [a('x'), a('y'), a('width'), a('height')];
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#99999966" stroke="#666666" stroke-width="1" stroke-dasharray="4 3"/><path d="M${x} ${y}L${x + w} ${y + h}M${x + w} ${y}L${x} ${y + h}" stroke="#666666" stroke-width="1"/>`;
    }
    return etiqueta.replace(`href="${href}"`, `href="data:${mime};base64,${Buffer.from(bytes).toString('base64')}"`);
  });
}

/** @param {string} svg @param {number} ancho @param {Map<string, Uint8Array>} [imagenes] los archivos de las capas image */
export function svgAPng(svg, ancho, imagenes = new Map()) {
  svg = incrustarImagenes(svg, imagenes);
  // Las fuentes del sistema solo hacen falta para los nombres de los huesos; cargarlas cuesta, así que solo si hay texto.
  const conTexto = svg.includes('<text');
  const font = conTexto ? { loadSystemFonts: true, defaultFontFamily: 'Arial' } : { loadSystemFonts: false };
  return new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(ancho) }, font }).render().asPng();
}
