// Constantes y convenciones del formato de documento. El núcleo no usa el DOM: corre igual en Node y en el navegador.

export const FORMATO = 'aia/0.1';

/**
 * Convenciones comunes a todo el formato:
 * - Coordenadas como en SVG: origen arriba a la izquierda, Y crece hacia abajo.
 * - Ángulos en grados; los positivos giran en sentido horario.
 * - Tiempo en segundos. Los fps del documento solo sirven para mostrar frames y para el snapping.
 */
export const CONVENCIONES = {
  ejeY: 'abajo',
  angulos: 'grados-horario',
  tiempo: 'segundos',
};
