// The `aia` commands of one topic. Shapes: rectangles and ellipses, copies, Create Shape (shape, fill, crossings),
// order and transform.

import { childrenOf, findObject } from '../../src/core/document.js';
import { around, bounds, ellipsePoints, ellipseVertices, IDENTITY, multiply, originOf, rectVertices, rotate, scale, transformPart, translate } from '../../src/core/geometry.js';
import { copyOps } from '../../src/core/copy.js';
import { ORDER_MOVES, orderOps } from '../../src/core/order.js';
import { fillOps, nodeKeys, shapeFromPointsOps } from '../../src/core/fill.js';
import { partsToMove } from '../../src/core/shapes.js';
import { crossingsOf, weldCrossingOps } from '../../src/core/crossings.js';
import { applyTransformOps, isLayer as isLayerObject, transformOf, transformProps } from '../../src/core/transform.js';
import { followedLines, resolveDoc, settleOps } from '../../src/core/points.js';
import { applyOps } from '../../src/core/operations.js';
import { AiaError, ok } from './common.js';

/**
 * @typedef {import('./common.js').Command} Command
 * @typedef {import('./common.js').Context} Context
 * @typedef {import('../../src/core/operations.js').Operation} Operation
 */

const WHERE = { up: 'up one place', down: 'down one place', top: 'to the top', bottom: 'to the bottom' };
/** What `aia shape` and `aia fill` make, for their help. */
const SHAPE_PARTS =
  'A shape is made of two\n' +
  'parts that follow those lines (bend a line and they bend with it), just under the lowest of them: <line>_fill (only\n' +
  'the fill) and <line>_stroke (only the stroke; none without --stroke), named after the line it goes along most, or\n' +
  '--id name (name_fill, name_stroke). Each has its own place in the order (aia order). Shapes add up, as in Moho: a\n' +
  'second one on the same gap is <line>_fill_2; change its colors with a set op (aia ops). Renaming the line renames\n' +
  'its shapes. Example: aia fill face ink --at 120,80 --fill #f0c040 --stroke #8a5a3c';

/** @param {Context} ctx @returns {Record<string, Command>} */
export function shapesCommands(ctx) {
  const { store, schema, ORIGIN, need, number, resolved, points, transformParts, round, boxFlag, shapeName, madeShape, styleFlags, drawShape, pair } = ctx;
  return {
    rect: {
      usage: 'aia rect <doc> <layer> <id> --box x,y,w,h [--radius r] [--names a,b,c,d] [--fill c|none] [--stroke c|none] [--stroke-width n] [--fill-opacity 0-1] [--stroke-opacity 0-1] [--stroke-cap round|square|butt] [--stroke-join round|miter|bevel]',
      summary: 'Draws a rectangle (a path of 4 corners, or 8 points with rounded corners) into a vector layer',
      details:
        'The layer is made if there is none with that id. The box is in the layer’s coordinates. --names names its\n' +
        'points in order, clockwise from the top-left one. Without --fill or --stroke it gets the schema’s defaults.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const box = boxFlag(args);
        const radius = args.flags.radius === undefined ? 0 : Number(args.flags.radius);
        if (!Number.isFinite(radius) || radius < 0) throw new AiaError('--radius must be a number, 0 or more');
        return drawShape(args, id, rectVertices(box, radius), 'rectangle');
      },
    },

    ellipse: {
      usage: 'aia ellipse <doc> <layer> <id> --box x,y,w,h [--points n] [--names a,b,…] [--fill c|none] [--stroke c|none] [--stroke-width n] [--fill-opacity 0-1] [--stroke-opacity 0-1] [--stroke-cap round|square|butt] [--stroke-join round|miter|bevel]',
      summary: 'Draws an ellipse (a path of evenly round points, 4 by default) into a vector layer',
      details:
        'The layer is made if there is none with that id. The box is in the layer’s coordinates. --points gives more\n' +
        'points to weld or bind to (8, 12…); the first is at the top, then clockwise. --names names them in that order.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const box = boxFlag(args);
        const count = args.flags.points === undefined ? 4 : Number(args.flags.points);
        if (!Number.isInteger(count) || count < 3 || count > 64) throw new AiaError('--points must be a whole number from 3 to 64');
        return drawShape(args, id, count === 4 ? ellipseVertices(box) : ellipsePoints(box, count), 'ellipse');
      },
    },

    copy: {
      usage: 'aia copy <doc> <part>... [--to <layer>] [--move dx,dy]',
      summary: 'Copies parts (into their layer, or another), moved by an offset; each copy gets a free name',
      details: 'A copy does not share the original’s points: its shared vertices stay where they are, as its own.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const names = args.positional.slice(1);
        if (!names.length) throw new AiaError('Missing the parts to copy');
        const parts = names.map((n) => {
          const part = findObject(doc, n);
          if (!part || part.type !== 'path') throw new AiaError(`there is no part "${n}"`);
          return part;
        });
        const to = typeof args.flags.to === 'string' ? args.flags.to : undefined;
        if (to && findObject(doc, to)?.type !== 'vector') throw new AiaError(`there is no vector layer "${to}"`);
        const move = pair(args, 'move') ?? { x: 0, y: 0 };
        const { ops, ids } = copyOps(doc, parts, move.x || move.y ? translate(move.x, move.y) : IDENTITY, to);
        await store.apply(id, ops, { origin: ORIGIN, note: `Copy ${names.join(', ')}` });
        return ok(`Made ${ids.join(', ')}.`);
      },
    },

    shape: {
      usage: 'aia shape <doc> <layer> <point>... [--id name] [--fill c|none] [--stroke c|none] [--stroke-width n] [--fill-opacity 0-1] [--stroke-opacity 0-1] [--stroke-cap round|square|butt] [--stroke-join round|miter|bevel]',
      summary: 'Creates a shape from the points around it, as Moho’s Create Shape (the editor’s Create Shape tool)',
      details:
        'Name every point around the shape (part.point, part.index or layer.group), and the points around its holes\n' +
        'too. The stretches between two named points make the outline; points on dead ends are left out. ' + SHAPE_PARTS,
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const layer = need(args, 1, 'the vector layer');
        const doc = await resolved(id);
        const keys = nodeKeys(doc, layer);
        const nodes = points(doc, args.positional.slice(2)).map((p) => {
          const key = keys.get(`${p.part}:${p.index}`);
          if (!key) throw new AiaError(`${p.part}.${p.index} is not a point of a line of ${layer}`);
          return key.node;
        });
        if (!nodes.length) throw new AiaError('Name the points around the shape');
        let result;
        try {
          result = shapeFromPointsOps(doc, layer, nodes, { stroke: null, ...styleFlags(args) }, shapeName(args));
        } catch (e) {
          throw new AiaError(e.message);
        }
        await store.apply(id, result.ops, { origin: ORIGIN, note: result.note });
        return ok(madeShape(result.ids));
      },
    },

    crossings: {
      usage: 'aia crossings <doc> <layer> [--weld n | --weld all]',
      summary: 'Where lines of a layer cross without a point, and welds them there (a point on each, shared)',
      details:
        'A shape turns from one line onto another only at a point (as in Moho), so where two lines cross without one\n' +
        'nothing can be filled on either side. Without --weld it lists the crossings, numbered; --weld n welds one,\n' +
        '--weld all welds them all. Both lines keep their shape; from then on they are welded there.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const layer = need(args, 1, 'the vector layer');
        let doc = await resolved(id);
        if (findObject(doc, layer)?.type !== 'vector') throw new AiaError(`there is no vector layer "${layer}"`);
        const list = crossingsOf(doc, layer);
        const which = args.flags.weld;
        if (which === undefined) {
          if (!list.length) return ok(`The lines of ${layer} cross nowhere without a point.`);
          return ok(list.map((c, i) => `${i + 1}. ${c.a.part} × ${c.b.part} at ${round(c.x)}, ${round(c.y)}`).join('\n'));
        }
        const count = which === 'all' ? list.length : 1;
        if (!list.length) throw new AiaError(`The lines of ${layer} cross nowhere without a point: there is nothing to weld`);
        if (which !== 'all' && !(Number(which) >= 1 && Number(which) <= list.length)) throw new AiaError(`--weld is a number from 1 to ${list.length}, or all`);
        /** @type {Operation[]} */
        const ops = [];
        // One at a time on a copy, since each weld adds points (the next crossings move to other stretches).
        let stored = (await store.get(id, ORIGIN)).document;
        for (let k = 0; k < count; k++) {
          const crossing = which === 'all' ? crossingsOf(doc, layer)[0] : list[Number(which) - 1];
          if (!crossing) break;
          const step = settleOps(stored, weldCrossingOps(doc, crossing).ops, (d, o) => applyOps(schema, d, o, { checkPoints: false }).document);
          stored = applyOps(schema, stored, step).document;
          doc = resolveDoc(stored);
          ops.push(...step);
        }
        await store.apply(id, ops, { origin: ORIGIN, note: `Weld ${count === 1 ? 'a crossing' : `${count} crossings`} of ${layer}` });
        return ok(`Welded ${count === 1 ? 'the crossing' : `${count} crossings`}; the shapes on each side can be made now.`);
      },
    },

    fill: {
      usage: 'aia fill <doc> <layer> --at x,y [--id name] [--fill c|none] [--stroke c|none] [--stroke-width n] [--fill-opacity 0-1] [--stroke-opacity 0-1] [--stroke-cap round|square|butt] [--stroke-join round|miter|bevel]',
      summary: 'Creates a shape in the gap around x,y that the lines of a vector layer close (a click inside it in Create Shape)',
      details:
        'x,y is in the layer’s coordinates (after moving a layer, they move with it). Shapes inside the gap that do not\n' +
        'touch its lines (the middle of a donut) become holes, each following its shape. Only welded points join lines:\n' +
        'two lines that cross without a point do not close a gap (aia crossings). ' + SHAPE_PARTS,
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const layer = need(args, 1, 'the vector layer');
        const at = pair(args, 'at');
        if (!at) throw new AiaError('Say where: --at x,y (in the layer’s coordinates)');
        const doc = await resolved(id);
        let result;
        try {
          result = fillOps(doc, layer, at, { stroke: null, ...styleFlags(args) }, shapeName(args));
        } catch (e) {
          throw new AiaError(e.message);
        }
        await store.apply(id, result.ops, { origin: ORIGIN, note: result.note });
        const part = findObject((await store.get(id, ORIGIN)).document, result.id);
        const lines = [...followedLines(/** @type {any} */ (part))].join(', ');
        const holes = (/** @type {any[][]} */ (part?.holes ?? [])).length;
        return ok(`${madeShape(result.ids)} It follows ${lines}${holes ? `, with ${holes === 1 ? 'a hole' : `${holes} holes`}` : ''}.`);
      },
    },

    order: {
      usage: 'aia order <doc> <id>... --up | --down | --top | --bottom',
      summary: 'Raises or lowers parts (or layers) among their siblings: one place, or to the top or bottom',
      details:
        'Inside a layer, a part higher in the order is drawn over the ones below it. Several move together and keep\n' +
        'their order among themselves; each moves inside its own layer. Example: aia order face mouth --top',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const names = args.positional.slice(1);
        if (!names.length) throw new AiaError('Missing the parts or layers to raise or lower');
        const hows = ORDER_MOVES.filter((how) => args.flags[how] === true);
        if (hows.length !== 1) throw new AiaError('Say one of --up, --down, --top or --bottom');
        const [how] = hows;
        let ops;
        try {
          ops = orderOps(doc, names, how);
        } catch (e) {
          throw new AiaError(e.message);
        }
        const where = WHERE[how];
        if (!ops.length) return ok(`${names.join(', ')}: already ${how === 'up' || how === 'top' ? 'on top' : 'at the bottom'}, nothing changed.`);
        await store.apply(id, ops, { origin: ORIGIN, note: `Order ${names.join(', ')} ${where}` });
        const after = (await store.get(id, ORIGIN)).document;
        const parents = [...new Set(names.map((n) => findObject(after, n)?.parent ?? null))];
        const lines = parents.map((p) => `${p ?? 'the document'}, bottom to top: ${childrenOf(after, p).map((o) => o.id).join(', ')}`);
        return ok(`Moved ${names.join(', ')} ${where}.\n${lines.join('\n')}`);
      },
    },

    transform: {
      usage: 'aia transform <doc> <id>... [--move dx,dy] [--rotate deg] [--scale s | sx,sy] [--around x,y] | --apply',
      summary: 'Moves, turns and scales a layer (its own transform) or a part (its vertices), around its origin',
      details:
        'A layer (vector, image or group) keeps its drawing and changes its x, y, rotation, scaleX, scaleY; the first time,\n' +
        'its origin is fixed where its center is, so it stays put when its content changes. A part is only geometry:\n' +
        'its vertices are rewritten. --move is in the coordinates the object lives in (a part: its layer’s).\n' +
        'Several parts of one layer turn and scale together around the center of their box, or --around x,y.\n' +
        '--apply puts a vector layer’s transform into its parts’ vertices and leaves it without one.\n' +
        '--scale -1,1 flips horizontally and --scale 1,-1 vertically (the editor’s Flip). Example: aia transform robot arm_l --rotate -20',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const target = need(args, 1, 'the layer or part');
        const doc = await resolved(id);
        const many = args.positional.slice(1);
        if (many.length > 1 || args.flags.around !== undefined) return transformParts(args, id, doc, many);
        const object = findObject(doc, target);
        if (!object) throw new AiaError(`${id} has no object "${target}"`);
        const isLayer = isLayerObject(object);
        if (args.flags.apply === true) {
          let ops;
          try {
            ops = applyTransformOps(doc, object);
          } catch (e) {
            throw new AiaError(e.message);
          }
          if (!ops.length) return ok(`${target} has no transform to apply.`);
          await store.apply(id, ops, { origin: ORIGIN, note: `Apply the transform of ${target}` });
          return ok(`Applied the transform of ${target} to its parts' vertices.`);
        }
        const move = pair(args, 'move') ?? { x: 0, y: 0 };
        const degrees = args.flags.rotate === undefined ? 0 : Number(args.flags.rotate);
        if (!Number.isFinite(degrees)) throw new AiaError('--rotate must be a number of degrees');
        const scaleText = args.flags.scale;
        const [sx, sy = sx] = typeof scaleText === 'string' ? scaleText.split(',').map(Number) : [1, 1];
        if (!Number.isFinite(sx) || !Number.isFinite(sy) || !sx || !sy) throw new AiaError('--scale must be a number (or sx,sy), not 0');
        if (!move.x && !move.y && !degrees && sx === 1 && sy === 1) throw new AiaError('Say what to do: --move dx,dy, --rotate deg, --scale s (or --apply)');
        /** @type {import('../../src/core/operations.js').Operation[]} */
        let ops;
        if (isLayer) {
          const t = transformOf(object);
          const next = { x: t.x + move.x, y: t.y + move.y, rotation: t.rotation + degrees, scaleX: t.scaleX * sx, scaleY: t.scaleY * sy };
          ops = [{ op: 'set', target, props: transformProps(doc, object, next) }];
        } else if (object.type === 'path') {
          const box = bounds([object]);
          const pivot = originOf(object) ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 });
          const m = multiply(translate(move.x, move.y), around(pivot, multiply(rotate(degrees), scale(sx, sy))));
          // A fill moves the lines it follows.
          ops = partsToMove(doc, [object]).map((part) => ({ op: 'set', target: part.id, props: transformPart(part, m) }));
        } else throw new AiaError(`${target} is a ${object.type}: only layers and parts transform`);
        await store.apply(id, ops, { origin: ORIGIN, note: `Transform ${target}` });
        const after = (await store.get(id, ORIGIN)).document;
        const now = findObject(after, target);
        if (isLayer && now) {
          const t = transformOf(now);
          return ok(`${target}: x ${t.x}, y ${t.y}, rotation ${t.rotation}, scale ${t.scaleX}, ${t.scaleY} (its vertices are unchanged).`);
        }
        return ok(`Transformed ${target}'s vertices.`);
      },
    },
  };
}
