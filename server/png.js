// SVG → PNG in Node, so the AI can see what it did (aia render). The SVG is the core's own drawing (toSvg), the same
// the editor shows.

import { Resvg } from '@resvg/resvg-js';

/** @param {string} svg @param {number} width in px */
export function svgToPng(svg, width) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(width) }, font: { loadSystemFonts: false } }).render().asPng();
}
