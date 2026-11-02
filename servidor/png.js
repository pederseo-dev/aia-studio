// SVG → PNG en Node, para que la IA pueda ver lo que hizo.

import { Resvg } from '@resvg/resvg-js';

export function svgAPng(svg, ancho) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(ancho) }, font: { loadSystemFonts: false } }).render().asPng();
}
