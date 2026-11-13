// Cambiar el tamaño del lienzo (artboard) con el dibujo anclado al centro, como en Moho: el lienzo crece o se achica
// por igual a cada lado y lo dibujado queda en el mismo lugar respecto del centro.
//
// El origen del documento es la esquina de arriba a la izquierda, así que mantener el centro es mover todo lo que
// está en la raíz media diferencia de tamaño. Los valores de x/y de esos objetos en las poses y en las pistas de los
// clips son absolutos, así que se mueven igual. Lo que está dentro de un contenedor se mueve con él.

import { children } from './document.js';
import { read, readMeta } from './schema.js';

const round = (v) => Math.round(v * 1000) / 1000;

/**
 * Operaciones para llevar el lienzo a `ancho` × `alto` con el dibujo centrado. Sin cambio de tamaño, solo fija
 * width/height (nada que mover). `corrimiento` ([dx, dy]) mueve el dibujo esa cantidad en vez de centrarlo (Fit to
 * content lo usa para llevar el contenido al medio del lienzo nuevo).
 */
export function artboardOps(doc, schema, width, height, offset = null) {
  const [dx, dy] = (offset ?? [(width - readMeta(schema, doc, 'width')) / 2, (height - readMeta(schema, doc, 'height')) / 2]).map(round);
  /** @type {import('./types.js').Operation[]} */
  const ops = [{ op: 'set', target: 'meta', props: { width: width, height: height } }];
  if (!dx && !dy) return ops;

  // Lo que hay que mover: los objetos de la raíz con posición (los recursos y los params no tienen).
  const root = children(doc, null).filter((o) => {
    const props = schema.types.get(o.type)?.properties;
    return props?.x?.type === 'number' && props?.y?.type === 'number';
  });
  if (!root.length) return ops;
  const move = new Set(root.map((o) => o.id));
  const shifted = (prop, v) => (typeof v !== 'number' ? v : round(v + (prop === 'x' ? dx : dy)));

  for (const o of root) ops.push({ op: 'set', target: o.id, props: { x: shifted('x', read(schema, o, 'x')), y: shifted('y', read(schema, o, 'y')) } });

  // Poses y clips: los x/y guardados de esos objetos (valores absolutos, como en el montaje).
  for (const o of doc.objects) {
    for (const [prop, p] of Object.entries(schema.types.get(o.type)?.properties ?? {})) {
      const value = o[prop];
      if (!value || typeof value !== 'object') continue;
      if (p.type === 'pose') {
        let change = false;
        const created = structuredClone(value);
        for (const [id, fields] of Object.entries(created)) {
          if (!move.has(id)) continue;
          for (const k of ['x', 'y']) if (typeof fields[k] === 'number') (fields[k] = shifted(k, fields[k])), (change = true);
        }
        if (change) ops.push({ op: 'set', target: o.id, props: { [prop]: created } });
      } else if (p.type === 'tracks') {
        let change = false;
        const created = structuredClone(value);
        for (const [id, tracks] of Object.entries(created)) {
          if (!move.has(id)) continue;
          for (const k of ['x', 'y']) {
            if (!Array.isArray(tracks[k])) continue;
            for (const key of tracks[k]) if (typeof key.value === 'number') (key.value = shifted(k, key.value)), (change = true);
          }
        }
        if (change) ops.push({ op: 'set', target: o.id, props: { [prop]: created } });
      }
    }
  }
  return ops;
}
