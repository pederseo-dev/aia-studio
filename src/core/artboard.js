// Resize the canvas (artboard) with the drawing anchored at the center, like in Moho: the canvas grows or shrinks
// equally on each side and what is drawn stays in the same place relative to the center.
//
// The document origin is the top-left corner, so keeping the center means moving everything at the root by half
// the size difference. The x/y values of those objects in poses and in clip tracks are absolute, so they move the
// same. What is inside a container moves with it.

import { children } from './document.js';
import { read, readMeta } from './schema.js';

const round = (v) => Math.round(v * 1000) / 1000;

/**
 * Operations to bring the canvas to `width` × `height` with the drawing centered. Without a size change, it only
 * sets width/height (nothing to move). `offset` ([dx, dy]) moves the drawing by that amount instead of centering it
 * (Fit to content uses it to bring the content to the middle of the new canvas).
 */
export function artboardOps(doc, schema, width, height, offset = null) {
  const [dx, dy] = (offset ?? [(width - readMeta(schema, doc, 'width')) / 2, (height - readMeta(schema, doc, 'height')) / 2]).map(round);
  /** @type {import('./types.js').Operation[]} */
  const ops = [{ op: 'set', target: 'meta', props: { width: width, height: height } }];
  if (!dx && !dy) return ops;

  // What has to move: the root objects with a position (assets and params have none).
  const root = children(doc, null).filter((o) => {
    const props = schema.types.get(o.type)?.properties;
    return props?.x?.type === 'number' && props?.y?.type === 'number';
  });
  if (!root.length) return ops;
  const move = new Set(root.map((o) => o.id));
  const shifted = (prop, v) => (typeof v !== 'number' ? v : round(v + (prop === 'x' ? dx : dy)));

  for (const o of root) ops.push({ op: 'set', target: o.id, props: { x: shifted('x', read(schema, o, 'x')), y: shifted('y', read(schema, o, 'y')) } });

  // Poses and clips: the saved x/y of those objects (absolute values, as in the setup).
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
