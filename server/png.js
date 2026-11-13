// SVG → PNG in Node, so the AI can see what it did.

import { Resvg } from '@resvg/resvg-js';
import { assetMime } from '../src/core/images.js';

/** Formats resvg cannot draw: in the preview they show as a gray box with a cross, in their place. */
export const NO_PREVIEW = new Set(['image/webp']);

/**
 * Image layers name their file by their src (see DRAW.image): here they become data: URIs with the bytes from
 * `images` (src → bytes); the missing ones are removed (resvg does not read loose files).
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

/** @param {string} svg @param {number} width @param {Map<string, Uint8Array>} [images] the files of the image layers */
export function svgToPng(svg, width, images = new Map()) {
  svg = embedImages(svg, images);
  // System fonts are only needed for bone names; loading them is costly, so only if there is text.
  const withText = svg.includes('<text');
  const font = withText ? { loadSystemFonts: true, defaultFontFamily: 'Arial' } : { loadSystemFonts: false };
  return new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(width) }, font }).render().asPng();
}
