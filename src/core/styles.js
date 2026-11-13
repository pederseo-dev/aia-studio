// Shared styles (from Moho): a shape takes from its style the appearance properties it does not have of its own.
// Order: own value → style value → schema default value.

import { findObject } from './document.js';
import { read } from './schema.js';

export function effectiveValue(schema, doc, obj, prop) {
  if (obj[prop] !== undefined) return obj[prop];
  const style = obj.style ? findObject(doc, obj.style) : null;
  if (style?.type === 'style' && style[prop] !== undefined) return style[prop];
  return read(schema, obj, prop);
}

/** Where the value comes from: 'own', 'style' or 'defecto' (to show it in the inspector). */
export function valueOrigin(doc, obj, prop) {
  if (obj[prop] !== undefined) return 'own';
  const style = obj.style ? findObject(doc, obj.style) : null;
  return style?.type === 'style' && style[prop] !== undefined ? 'style' : 'defecto';
}
