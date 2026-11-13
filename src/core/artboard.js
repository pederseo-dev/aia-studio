// Cambiar el tamaño del lienzo (artboard) con el dibujo anclado al centro, como en Moho: el lienzo crece o se achica
// por igual a cada lado y lo dibujado queda en el mismo lugar respecto del centro.
//
// El origen del documento es la esquina de arriba a la izquierda, así que mantener el centro es mover todo lo que
// está en la raíz media diferencia de tamaño. Los valores de x/y de esos objetos en las poses y en las pistas de los
// clips son absolutos, así que se mueven igual. Lo que está dentro de un contenedor se mueve con él.

import { hijos } from './document.js';
import { leer, leerMeta } from './schema.js';

const redondear = (v) => Math.round(v * 1000) / 1000;

/**
 * Operaciones para llevar el lienzo a `ancho` × `alto` con el dibujo centrado. Sin cambio de tamaño, solo fija
 * width/height (nada que mover). `corrimiento` ([dx, dy]) mueve el dibujo esa cantidad en vez de centrarlo (Fit to
 * content lo usa para llevar el contenido al medio del lienzo nuevo).
 */
export function opsDeTamano(doc, esquema, ancho, alto, corrimiento = null) {
  const [dx, dy] = (corrimiento ?? [(ancho - leerMeta(esquema, doc, 'width')) / 2, (alto - leerMeta(esquema, doc, 'height')) / 2]).map(redondear);
  /** @type {import('./types.js').Operacion[]} */
  const ops = [{ op: 'set', target: 'meta', props: { width: ancho, height: alto } }];
  if (!dx && !dy) return ops;

  // Lo que hay que mover: los objetos de la raíz con posición (los recursos y los params no tienen).
  const raiz = hijos(doc, null).filter((o) => {
    const props = esquema.tipos.get(o.type)?.properties;
    return props?.x?.type === 'number' && props?.y?.type === 'number';
  });
  if (!raiz.length) return ops;
  const mover = new Set(raiz.map((o) => o.id));
  const corrido = (prop, v) => (typeof v !== 'number' ? v : redondear(v + (prop === 'x' ? dx : dy)));

  for (const o of raiz) ops.push({ op: 'set', target: o.id, props: { x: corrido('x', leer(esquema, o, 'x')), y: corrido('y', leer(esquema, o, 'y')) } });

  // Poses y clips: los x/y guardados de esos objetos (valores absolutos, como en el montaje).
  for (const o of doc.objects) {
    for (const [prop, p] of Object.entries(esquema.tipos.get(o.type)?.properties ?? {})) {
      const valor = o[prop];
      if (!valor || typeof valor !== 'object') continue;
      if (p.type === 'pose') {
        let cambio = false;
        const nuevo = structuredClone(valor);
        for (const [id, campos] of Object.entries(nuevo)) {
          if (!mover.has(id)) continue;
          for (const k of ['x', 'y']) if (typeof campos[k] === 'number') (campos[k] = corrido(k, campos[k])), (cambio = true);
        }
        if (cambio) ops.push({ op: 'set', target: o.id, props: { [prop]: nuevo } });
      } else if (p.type === 'tracks') {
        let cambio = false;
        const nuevo = structuredClone(valor);
        for (const [id, pistas] of Object.entries(nuevo)) {
          if (!mover.has(id)) continue;
          for (const k of ['x', 'y']) {
            if (!Array.isArray(pistas[k])) continue;
            for (const clave of pistas[k]) if (typeof clave.value === 'number') (clave.value = corrido(k, clave.value)), (cambio = true);
          }
        }
        if (cambio) ops.push({ op: 'set', target: o.id, props: { [prop]: nuevo } });
      }
    }
  }
  return ops;
}
