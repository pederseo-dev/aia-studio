// Drawing tools (Pen, Rectangle, Ellipse) on vector layers, as in Moho: what is drawn becomes a shape of the active
// vector layer. With none active, the tool creates the layer, with its pivot at the center of the first shape.
//
// The editor writes exactly what the AI writes: `create shape` with `d` (see src/core/operations.js), so the points
// are added and welded by the same code on both sides.

import { invert, multiply, worldMatrix } from '../core/geometry.js';
import { transformVertices, verticesAD } from '../core/paths.js';
import { drawingLayer, execute, freeId, parentForNew, schema, select, setState, state } from './state.js';

/**
 * Where the next shape goes: into the active layer (`layer`) or into a new layer under `parent`. `toLocal` takes a
 * screen point to the coordinates the vertices are given in (the layer's, or the parent's for a new layer).
 * @param {{ cameraMatrix: () => number[] }} ctx
 */
export function drawingTarget(ctx) {
  const layer = drawingLayer();
  const parent = layer ? null : parentForNew();
  const space = layer ?? parent;
  return { layer, parent, toLocal: invert(multiply(ctx.cameraMatrix(), worldMatrix(state.doc, schema, space))) };
}

/**
 * Creates the shape (and, if needed, its layer) from subpaths [{ vertices, closed }] in the target's coordinates,
 * selects it and goes back to the selection tool.
 * @param {ReturnType<typeof drawingTarget>} target @param {{ vertices: any[], closed: boolean }[]} subpaths
 * @param {Record<string, any>} [props] fill, stroke… of the shape
 */
export function commitShape(target, subpaths, props = {}) {
  const ops = [];
  let layer = target.layer;
  let shown = subpaths;
  if (!layer) {
    // New layer: its pivot at the center of the shape, so it rotates and scales around it.
    const xs = subpaths.flatMap((s) => s.vertices.map((v) => v.x));
    const ys = subpaths.flatMap((s) => s.vertices.map((v) => v.y));
    const [cx, cy] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2].map((v) => Math.round(v * 10) / 10);
    layer = freeId('layer');
    ops.push({ op: 'create', type: 'vector', id: layer, parent: target.parent, props: { x: cx, y: cy } });
    shown = subpaths.map((s) => ({ ...s, vertices: transformVertices(s.vertices, [1, 0, 0, 1, -cx, -cy]) }));
  }
  const id = freeId('shape');
  const d = shown.map((s) => verticesAD(s.vertices, s.closed)).join('');
  ops.push({ op: 'create', type: 'shape', id, parent: layer, props: { d, ...props } });
  execute(ops, target.layer ? `draw ${id} in ${layer}` : `draw ${id} in a new layer ${layer}`);
  setState({ tool: 'select' });
  select(id);
}
