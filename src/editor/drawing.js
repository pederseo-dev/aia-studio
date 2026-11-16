// Drawing tools (Pen, Rectangle, Ellipse) on vector layers, as in Moho: what is drawn becomes a shape of the active
// vector layer. With none active, the tool creates the layer, with its pivot at the center of the first shape.
//
// The editor writes exactly what the AI writes: `create shape` with `d` (see src/core/operations.js), so the points
// are added and welded by the same code on both sides. With Auto fill and Auto stroke off, only the curves are added
// to the layer (`set` of the layer with `d`, also the AI's), to be filled later with Fill, Stroke or Both.

import { invert, multiply, worldMatrix } from '../core/geometry.js';
import { transformVertices, verticesAD } from '../core/paths.js';
import { drawingLayer, execute, freeId, parentForNew, schema, select, setState, state } from './state.js';

/** The stroke the drawing tools and Stroke / Both give a new shape. */
export const NEW_STROKE = { stroke: '#2b2135', strokeWidth: 3 };

/**
 * What a drawing tool gives its new shape, by the Auto fill / Auto stroke options (as in Moho): props of the shape, or
 * null for only the curves. An open line cannot be filled, so it gets the stroke when either option is on.
 * @param {boolean} closed
 */
export function autoProps(closed) {
  const fill = closed && state.autoFill;
  const stroke = state.autoStroke || (!closed && state.autoFill);
  if (!fill && !stroke) return null;
  return { ...(fill ? {} : { fill: null }), ...(stroke ? NEW_STROKE : {}) };
}

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
 * selects it and goes back to the selection tool. With props null, only the curves go into the layer (and it is
 * selected).
 * @param {ReturnType<typeof drawingTarget>} target @param {{ vertices: any[], closed: boolean }[]} subpaths
 * @param {Record<string, any> | null} [props] fill, stroke… of the shape
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
  const d = shown.map((s) => verticesAD(s.vertices, s.closed)).join('');
  if (!props) {
    ops.push({ op: 'set', target: layer, props: { d } });
    execute(ops, `draw curves in ${target.layer ? layer : `a new layer ${layer}`}`);
    setState({ tool: 'select' });
    return select(layer);
  }
  const id = freeId('shape');
  ops.push({ op: 'create', type: 'shape', id, parent: layer, props: { d, ...props } });
  execute(ops, target.layer ? `draw ${id} in ${layer}` : `draw ${id} in a new layer ${layer}`);
  setState({ tool: 'select' });
  select(id);
}
