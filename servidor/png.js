// SVG → PNG en Node, para que la IA pueda ver lo que hizo.

import { Resvg } from '@resvg/resvg-js';

export function svgAPng(svg, ancho) {
  // Las fuentes del sistema solo hacen falta para los nombres de los huesos; cargarlas cuesta, así que solo si hay texto.
  const conTexto = svg.includes('<text');
  const font = conTexto ? { loadSystemFonts: true, defaultFontFamily: 'Arial' } : { loadSystemFonts: false };
  return new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(ancho) }, font }).render().asPng();
}
