// SVG → PNG en Node, para que la IA pueda ver lo que hizo.

import { Resvg } from '@resvg/resvg-js';
import { assetMime } from '../src/core/images.js';

/** Formatos que resvg no sabe dibujar: en la vista previa van como un recuadro gris con una cruz, en su lugar. */
export const NO_PREVIEW = new Set(['image/webp']);

/**
 * Las capas image nombran su archivo por su src (ver DIBUJAR.image): aquí pasan a data: URI con los bytes de
 * `imagenes` (src → bytes); las que no están se quitan (resvg no lee archivos sueltos).
 * @param {string} svg @param {Map<string, Uint8Array>} images
 */
export function embedImages(svg, images) {
  return svg.replace(/<image href="([^"]*)"[^>]*\/>/g, (label, href) => {
    const src = href.replace(/&amp;/g, '&');
    const bytes = images.get(src);
    const mime = assetMime(src);
    if (!bytes || !mime) return '';
    if (NO_PREVIEW.has(mime)) {
      const a = (k) => Number(new RegExp(` ${k}="([^"]*)"`).exec(label)?.[1] ?? 0);
      const [x, y, w, h] = [a('x'), a('y'), a('width'), a('height')];
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#99999966" stroke="#666666" stroke-width="1" stroke-dasharray="4 3"/><path d="M${x} ${y}L${x + w} ${y + h}M${x + w} ${y}L${x} ${y + h}" stroke="#666666" stroke-width="1"/>`;
    }
    return label.replace(`href="${href}"`, `href="data:${mime};base64,${Buffer.from(bytes).toString('base64')}"`);
  });
}

/** @param {string} svg @param {number} width @param {Map<string, Uint8Array>} [images] los archivos de las capas image */
export function svgToPng(svg, width, images = new Map()) {
  svg = embedImages(svg, images);
  // Las fuentes del sistema solo hacen falta para los nombres de los huesos; cargarlas cuesta, así que solo si hay texto.
  const withText = svg.includes('<text');
  const font = withText ? { loadSystemFonts: true, defaultFontFamily: 'Arial' } : { loadSystemFonts: false };
  return new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(width) }, font }).render().asPng();
}
