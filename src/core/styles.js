// Estilos compartidos (de Moho): una forma toma de su estilo las propiedades de apariencia que no tiene propias.
// Orden: valor propio → valor del estilo → valor por defecto del esquema.

import { findObject } from './document.js';
import { read } from './schema.js';

export function effectiveValue(schema, doc, obj, prop) {
  if (obj[prop] !== undefined) return obj[prop];
  const style = obj.style ? findObject(doc, obj.style) : null;
  if (style?.type === 'style' && style[prop] !== undefined) return style[prop];
  return read(schema, obj, prop);
}

/** De dónde sale el valor: 'propio', 'estilo' o 'defecto' (para mostrarlo en el inspector). */
export function valueOrigin(doc, obj, prop) {
  if (obj[prop] !== undefined) return 'propio';
  const style = obj.style ? findObject(doc, obj.style) : null;
  return style?.type === 'style' && style[prop] !== undefined ? 'estilo' : 'defecto';
}
