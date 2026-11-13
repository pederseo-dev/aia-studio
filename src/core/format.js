// Constants and conventions of the document format. The core does not use the DOM: it runs the same in Node and in
// the browser.

export const FORMAT = 'aia/0.1';

/**
 * Conventions common to the whole format:
 * - Coordinates as in SVG: origin at the top left, Y grows downward.
 * - Angles in degrees; positive ones rotate clockwise.
 * - Time in seconds. The document fps only serve to show frames and for snapping.
 */
export const CONVENTIONS = {
  axisY: 'abajo',
  angles: 'grados-horario',
  time: 'segundos',
};
