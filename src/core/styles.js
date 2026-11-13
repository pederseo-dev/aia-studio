// Estilos compartidos (de Moho): una forma toma de su estilo las propiedades de apariencia que no tiene propias.
// Orden: valor propio → valor del estilo → valor por defecto del esquema.

import { buscar } from './document.js';
import { leer } from './schema.js';

export function valorEfectivo(esquema, doc, obj, prop) {
  if (obj[prop] !== undefined) return obj[prop];
  const estilo = obj.style ? buscar(doc, obj.style) : null;
  if (estilo?.type === 'style' && estilo[prop] !== undefined) return estilo[prop];
  return leer(esquema, obj, prop);
}

/** De dónde sale el valor: 'propio', 'estilo' o 'defecto' (para mostrarlo en el inspector). */
export function origenDelValor(doc, obj, prop) {
  if (obj[prop] !== undefined) return 'propio';
  const estilo = obj.style ? buscar(doc, obj.style) : null;
  return estilo?.type === 'style' && estilo[prop] !== undefined ? 'estilo' : 'defecto';
}
