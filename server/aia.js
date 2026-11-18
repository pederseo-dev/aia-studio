// The `aia` command language (decision 9 in docs/rebuild.md): one interpreter for every way an AI reaches
// aia-studio. The CLI (bin/aia.js) passes it its arguments; the MCP (mcp/server.js) passes it one string. It knows
// nothing of either: it takes a command and gives back text, and an image for `render`.
// Everything it changes has the origin "ai", so the person's own steps are never undone by the AI.

import fs from 'node:fs/promises';
import path from 'node:path';
import { findObject, subtree } from '../src/core/document.js';
import { toSvg } from '../src/core/draw.js';
import { guide } from '../src/core/guide.js';
import {
  IDENTITY,
  apply as applyMatrix,
  around,
  bounds,
  ellipsePoints,
  ellipseVertices,
  insertVertex,
  multiply,
  nearestOnOutline,
  originOf,
  rectVertices,
  rotate,
  roundVertex,
  scale,
  shapePoint,
  transformPart,
  translate,
  verticesOf,
} from '../src/core/geometry.js';
import { copyOps } from '../src/core/copy.js';
import { addImageOps, replaceImageOps } from '../src/core/images.js';
import { applyTransformOps, isLayer as isLayerObject, transformOf, transformProps, worldOf } from '../src/core/transform.js';
import { movePointsOps, pointsNamed, resolveDoc } from '../src/core/points.js';
import { deletePointsOps, followOps, groupOps, namePoint, unweld, weld } from '../src/core/weld.js';
import { svgToPng } from './png.js';
import { bundleRuntime } from './bundle.js';

/**
 * @typedef {import('../src/core/operations.js').Operation} Operation
 * @typedef {{ ok: boolean, text: string, image?: Buffer, name?: string, file?: { name: string, data: string } }} Result
 *   image: a PNG to look at; file: something to save (the CLI writes it, the MCP returns it)
 * @typedef {{ positional: string[], flags: Record<string, string | true> }} Args
 * @typedef {{ usage: string, summary: string, details?: string, run: (args: Args) => Promise<Result> }} Command
 */

export class AiaError extends Error {}

const BOOLEAN_FLAGS = new Set(['yes', 'all', 'join', 'long', 'off', 'none', 'add', 'remove', 'delete', 'resolved', 'apply', 'skip', 'labels']);
const RENDER_MAX = 2000;

/**
 * Splits one command line as a shell would (quotes group words), except that an unquoted [ or { starts a JSON value
 * that takes the rest of the line, so a batch needs no quoting: `ops face [{"op":"delete","target":"x"}]`.
 * A leading "aia" is dropped.
 * @param {string} line
 */
export function tokenize(line) {
  /** @type {string[]} */
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const c = line[i];
    if (c === '[' || c === '{') {
      tokens.push(line.slice(i).trim());
      break;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let out = '';
      while (j < line.length && line[j] !== c) {
        if (c === '"' && line[j] === '\\' && j + 1 < line.length) {
          out += line[j + 1];
          j += 2;
          continue;
        }
        out += line[j++];
      }
      if (j >= line.length) throw new AiaError(`A ${c} quote is not closed`);
      tokens.push(out);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && !/\s/.test(line[j])) j++;
    tokens.push(line.slice(i, j));
    i = j;
  }
  if (tokens[0] === 'aia') tokens.shift();
  return tokens;
}

/** @param {string[]} words @returns {Args} */
function parseArgs(words) {
  /** @type {Args} */
  const args = { positional: [], flags: {} };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith('--') && word.length > 2) {
      const name = word.slice(2);
      if (BOOLEAN_FLAGS.has(name)) args.flags[name] = true;
      else {
        if (i + 1 >= words.length) throw new AiaError(`--${name} needs a value`);
        args.flags[name] = words[++i];
      }
    } else args.positional.push(word);
  }
  return args;
}

/** @param {string} text @returns {Result} */
const ok = (text) => ({ ok: true, text });

const LINE = 100;

/**
 * JSON with each small object or list on one line (a vertex is one line, not seven), so a document reads short.
 * @param {unknown} value @param {string} [indent]
 * @returns {string}
 */
export function compactJson(value, indent = '') {
  const flat = JSON.stringify(value);
  if (value === null || typeof value !== 'object' || flat.length + indent.length <= LINE) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + compactJson(v, inner)).join(',\n')}\n${indent}]`;
  const entries = Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${compactJson(v, inner)}`);
  return `{\n${entries.join(',\n')}\n${indent}}`;
}

/**
 * @param {{ store: ReturnType<typeof import('./store.js').createStore>, schema: import('../src/core/schema.js').Schema }} options
 */
export function createAia({ store, schema }) {
  const ORIGIN = 'ai';

  /** @param {Args} args @param {number} index @param {string} what */
  const need = (args, index, what) => {
    const value = args.positional[index];
    if (!value) throw new AiaError(`Missing ${what}`);
    return value;
  };

  /** @param {Args} args @param {string} name */
  const number = (args, name) => {
    const value = args.flags[name];
    if (value === undefined) return undefined;
    const n = Number(value);
    if (typeof value !== 'string' || !Number.isFinite(n) || n <= 0) throw new AiaError(`--${name} must be a positive number`);
    return n;
  };

  /** The document with shared points resolved (where each shared vertex is). @param {string} id */
  const resolved = async (id) => resolveDoc((await store.get(id, ORIGIN)).document);

  /** Points by name, each a vertex of its own (a shared vertex is itself, not the point it shares). @param {any} doc @param {string[]} names */
  const points = (doc, names) => {
    try {
      return pointsNamed(doc, names, { own: true });
    } catch (e) {
      throw new AiaError(e.message);
    }
  };

  /** One point by name (part.point or part.index, not a group). @param {any} doc @param {string} name */
  const onePoint = (doc, name) => {
    const found = points(doc, [name]);
    if (found.length !== 1) throw new AiaError(`"${name}" is ${found.length} points (a group?): name one point, part.point or part.index`);
    return found[0];
  };

  /** Runs a weld function and turns its WeldError into an answer. @template T @param {() => T} task @returns {T} */
  const welding = (task) => {
    try {
      return task();
    } catch (e) {
      throw new AiaError(e.message);
    }
  };

  /**
   * Several parts of one layer moved, turned and scaled together around one point.
   * @param {Args} args @param {string} id @param {any} doc @param {string[]} names
   */
  const transformParts = async (args, id, doc, names) => {
    const parts = names.map((n) => {
      const part = findObject(doc, n);
      if (!part || part.type !== 'path') throw new AiaError(`"${n}" is not a part: layers turn one at a time, around their origin`);
      return part;
    });
    if (new Set(parts.map((p) => p.parent)).size > 1) throw new AiaError('the parts are in different layers: transform them layer by layer');
    const box = bounds(parts);
    const pivot = pair(args, 'around') ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 });
    const move = pair(args, 'move') ?? { x: 0, y: 0 };
    const degrees = args.flags.rotate === undefined ? 0 : Number(args.flags.rotate);
    const scaleText = args.flags.scale;
    const [sx, sy = sx] = typeof scaleText === 'string' ? scaleText.split(',').map(Number) : [1, 1];
    if (!Number.isFinite(degrees) || !Number.isFinite(sx) || !Number.isFinite(sy) || !sx || !sy) throw new AiaError('--rotate is degrees and --scale a number (or sx,sy), not 0');
    const m = multiply(translate(move.x, move.y), around(pivot, multiply(rotate(degrees), scale(sx, sy))));
    const ops = parts.map((part) => ({ op: 'set', target: part.id, props: transformPart(part, m) }));
    await store.apply(id, ops, { origin: ORIGIN, note: `Transform ${names.join(', ')}` });
    return ok(`Transformed ${names.join(', ')} around ${round(pivot.x)}, ${round(pivot.y)}.`);
  };

  /** @param {number} n */
  const round = (n) => Math.round(n * 100) / 100;

  /** --box x,y,w,h. @param {Args} args */
  const boxFlag = (args) => {
    const value = args.flags.box;
    const n = typeof value === 'string' ? value.split(',').map((v) => Number(v.trim())) : [];
    if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[2] <= 0 || n[3] <= 0) {
      throw new AiaError('--box must be x,y,width,height (for example 100,80,200,150)');
    }
    return { x: n[0], y: n[1], width: n[2], height: n[3] };
  };

  /** --fill, --stroke (a color or none), --stroke-width and --fill-opacity, --stroke-opacity (0 to 1), as part props. @param {Args} args */
  const styleFlags = (args) => {
    /** @type {Record<string, unknown>} */
    const props = {};
    for (const key of ['fill', 'stroke']) {
      const value = args.flags[key];
      if (typeof value === 'string') props[key] = value === 'none' ? null : value;
    }
    const width = args.flags['stroke-width'];
    if (width !== undefined) {
      const n = Number(width);
      if (!Number.isFinite(n) || n < 0) throw new AiaError('--stroke-width must be a number, 0 or more');
      props.strokeWidth = n;
    }
    for (const [flag, key] of [['fill-opacity', 'fillOpacity'], ['stroke-opacity', 'strokeOpacity']]) {
      if (args.flags[flag] === undefined) continue;
      const n = Number(args.flags[flag]);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new AiaError(`--${flag} must be a number from 0 to 1`);
      props[key] = n;
    }
    return props;
  };

  /**
   * Draws a shape's vertices as a new part of a vector layer (made if there is none).
   * @param {Args} args @param {string} id @param {import('../src/core/geometry.js').Vertex[]} vertices @param {string} kind
   */
  const drawShape = async (args, id, vertices, kind) => {
    const layer = need(args, 1, 'the vector layer');
    const partId = need(args, 2, 'the new part’s id');
    const doc = (await store.get(id, ORIGIN)).document;
    const holder = findObject(doc, layer);
    if (holder && holder.type !== 'vector') throw new AiaError(`${layer} is a ${holder.type}: shapes go into a vector layer`);
    const names = typeof args.flags.names === 'string' ? args.flags.names.split(',').map((n) => n.trim()) : [];
    if (names.length > vertices.length) throw new AiaError(`--names has ${names.length} names for ${vertices.length} points`);
    const shaped = vertices.map((v, i) => roundVertex(names[i] ? { ...v, name: names[i] } : v));
    /** @type {import('../src/core/operations.js').Operation[]} */
    const ops = [
      ...(holder ? [] : [{ op: 'create', type: 'vector', id: layer }]),
      { op: 'create', type: 'path', id: partId, parent: layer, props: { vertices: shaped, ...styleFlags(args) } },
    ];
    await store.apply(id, ops, { origin: ORIGIN, note: `Draw ${kind} ${partId}` });
    const named = names.filter(Boolean).length ? `, named ${names.filter(Boolean).map((n) => `${partId}.${n}`).join(', ')}` : '';
    return ok(`Drew the ${kind} ${partId} in ${layer}${holder ? '' : ' (a new layer)'}: ${shaped.length} points${named}.`);
  };

  /** curve / corner: reshapes points as point editing does. @param {Args} args @param {boolean} corner */
  const shapeCommand = async (args, corner) => {
    const id = need(args, 0, 'the document id');
    const doc = await resolved(id);
    const names = args.positional.slice(1);
    if (!names.length) throw new AiaError(`Missing the points to make ${corner ? 'corners' : 'curves'}`);
    /** @type {Map<string, import('../src/core/geometry.js').Vertex[]>} */
    const changes = new Map();
    for (const at of points(doc, names)) {
      const part = /** @type {any} */ (findObject(doc, at.part));
      const vertices = changes.get(at.part) ?? verticesOf(part).map((v) => ({ ...v }));
      shapePoint(vertices, at.index, part.closed !== false, corner);
      changes.set(at.part, vertices);
    }
    const ops = [...changes].map(([target, vertices]) => ({ op: 'set', target, props: { vertices: vertices.map(roundVertex) } }));
    await store.apply(id, ops, { origin: ORIGIN, note: `${corner ? 'Corner' : 'Curve'} at ${names.join(', ')}` });
    return ok(`${names.join(', ')}: ${corner ? 'corners' : 'smooth curves'} now.`);
  };

  /** A flag with two numbers, "10,-5". @param {Args} args @param {string} name */
  const pair = (args, name) => {
    const value = args.flags[name];
    if (value === undefined) return undefined;
    const [x, y, ...rest] = String(value).split(',').map((s) => Number(s.trim()));
    if (rest.length || !Number.isFinite(x) || !Number.isFinite(y)) throw new AiaError(`--${name} must be two numbers: x,y (for example 10,-5)`);
    return { x, y };
  };

  /** @type {Record<string, Command>} */
  const commands = {
    help: {
      usage: 'aia help [command]',
      summary: 'This list, or one command in detail',
      run: async (args) => {
        const name = args.positional[0];
        if (!name) {
          const lines = Object.values(commands).map((c) => `  ${c.usage}\n      ${c.summary}`);
          return ok(`aia: draw and animate with aia-studio documents.\n\n${lines.join('\n')}\n\nNew here? aia guide start`);
        }
        const command = commands[name];
        if (!command) throw new AiaError(`There is no command "${name}" (aia help lists them)`);
        return ok(`${command.usage}\n\n${command.summary}.${command.details ? `\n\n${command.details}` : ''}`);
      },
    },

    guide: {
      usage: 'aia guide [topic]',
      summary: 'How documents work: start, ops, paths, points, types, or a type',
      run: async (args) => {
        const text = guide(schema, args.positional[0]);
        if (text === null) throw new AiaError(`There is no guide topic "${args.positional[0]}" (aia guide lists them)`);
        return ok(text);
      },
    },

    list: {
      usage: 'aia list',
      summary: 'The documents: id and name',
      run: async () => {
        const docs = await store.list();
        if (!docs.length) return ok('No documents yet. Make one: aia new "<name>"');
        const width = Math.max(...docs.map((d) => d.id.length));
        return ok(docs.map((d) => `${d.id.padEnd(width)}  ${d.name}`).join('\n'));
      },
    },

    new: {
      usage: 'aia new <name> [--width 800] [--height 600] [--background #ffffff|none]',
      summary: 'A new document; its id comes from the name',
      details: 'The artboard is 800 × 600 px with a white background unless told otherwise. Prints the new id.',
      run: async (args) => {
        const name = need(args, 0, 'the name of the new document');
        /** @type {Record<string, unknown>} */
        const meta = { name };
        const width = number(args, 'width');
        const height = number(args, 'height');
        if (width) meta.width = width;
        if (height) meta.height = height;
        const background = args.flags.background;
        if (background !== undefined) meta.background = background === 'none' ? null : background;
        const { id } = await store.create(meta);
        return ok(`Created ${id}. Next: aia ops ${id} '<batch>' (aia guide ops)`);
      },
    },

    delete: {
      usage: 'aia delete <doc> --yes',
      summary: 'Deletes a document and its history, for good',
      details: 'It cannot be undone, so --yes is required. Only delete documents you made or were asked to delete.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        if (args.flags.yes !== true) throw new AiaError(`Deleting ${id} cannot be undone: add --yes if that is what is wanted`);
        await store.remove(id);
        return ok(`Deleted ${id}.`);
      },
    },

    show: {
      usage: 'aia show <doc> [id] [--resolved]',
      summary: 'The document as it is saved (JSON), or one object with what is inside it',
      details: '--resolved gives each shared vertex the x, y of the point it shares (as it is drawn), to check welds.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const saved = (await store.get(id, ORIGIN)).document;
        const document = args.flags.resolved === true ? resolveDoc(saved) : saved;
        const target = args.positional[1];
        if (!target) return ok(compactJson(document));
        if (target === 'meta') return ok(compactJson(document.meta));
        if (!findObject(document, target)) throw new AiaError(`${id} has no object "${target}"`);
        return ok(compactJson(subtree(document, target)));
      },
    },

    ops: {
      usage: "aia ops <doc> [--note \"…\"] '<batch>' | --file <batch.json>",
      summary: 'Applies a batch of operations (one step you can undo)',
      details:
        'The batch is a JSON list of operations (a single operation works too); see aia guide ops. It is atomic:\n' +
        'if one operation fails nothing changes, and the error says which one and why. --note says what the step\n' +
        'is for; it shows in the history.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const file = args.flags.file;
        const source = typeof file === 'string' ? await fs.readFile(file, 'utf8') : args.positional[1];
        if (!source) throw new AiaError('Missing the batch: a JSON list of operations (aia guide ops)');
        /** @type {unknown} */
        let batch;
        try {
          batch = JSON.parse(source);
        } catch (e) {
          throw new AiaError(`The batch is not valid JSON: ${e.message}`);
        }
        /** @type {Operation[]} */
        const ops = /** @type {Operation[]} */ (Array.isArray(batch) ? batch : [batch]);
        const note = typeof args.flags.note === 'string' ? args.flags.note : undefined;
        const before = (await store.get(id, ORIGIN)).document;
        const { document } = await store.apply(id, ops, { origin: ORIGIN, note });
        return ok(`Applied ${ops.length} operation${ops.length > 1 ? 's' : ''} to ${id}. ${changes(before, document)}`);
      },
    },

    move: {
      usage: 'aia move <doc> <point>... --by dx,dy | --to x,y',
      summary: 'Moves points by name: named points, vertices by index, or point groups',
      details:
        'A point is part.point (head.chin), part.index (head.3, from 0) or layer.group (face.upper_lid: all its\n' +
        'points). --by moves them all by an offset; --to places one point. Their curve handles go along, and the\n' +
        'vertices that share them follow (a shared vertex named here moves the point it shares). One step to undo.\n' +
        'Places and offsets are in the coordinates of the layer the points belong to (as their vertices).\n' +
        'Example: aia move face head.ear_l_top head.ear_l_bot --by -10,0',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const names = args.positional.slice(1);
        if (!names.length) throw new AiaError('Missing the points to move: part.point, part.index or layer.group');
        const by = pair(args, 'by');
        const to = pair(args, 'to');
        if (!by === !to) throw new AiaError('Say where: --by dx,dy (an offset) or --to x,y (one point)');
        const { document } = await store.get(id, ORIGIN);
        let ops;
        try {
          ops = movePointsOps(document, pointsNamed(document, names), { by, to });
        } catch (e) {
          throw new AiaError(e.message);
        }
        const note = typeof args.flags.note === 'string' ? args.flags.note : `Move ${names.join(', ')}`;
        await store.apply(id, ops, { origin: ORIGIN, note });
        const where = by ? `by ${by.x}, ${by.y}` : `to ${to?.x}, ${to?.y}`;
        return ok(`Moved ${names.join(', ')} ${where}. Changed: ${ops.map((o) => o.target).join(', ')}.`);
      },
    },

    rect: {
      usage: 'aia rect <doc> <layer> <id> --box x,y,w,h [--radius r] [--names a,b,c,d] [--fill c|none] [--stroke c|none] [--stroke-width n] [--fill-opacity 0-1] [--stroke-opacity 0-1]',
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
      usage: 'aia ellipse <doc> <layer> <id> --box x,y,w,h [--points n] [--names a,b,…] [--fill c|none] [--stroke c|none] [--stroke-width n] [--fill-opacity 0-1] [--stroke-opacity 0-1]',
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

    'delete-point': {
      usage: 'aia delete-point <doc> <point>...',
      summary: 'Deletes points of outlines, as Del in point editing (a part left with fewer than 2 points is deleted)',
      details:
        'Whoever shared a deleted point keeps its place, as a point of its own; groups drop it. A part left with fewer\n' +
        'than 2 points (an outline needs 2) is deleted with them, in the same step.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const names = args.positional.slice(1);
        if (!names.length) throw new AiaError('Missing the points to delete');
        const { ops, gone } = deletePointsOps(doc, points(doc, names));
        await store.apply(id, ops, { origin: ORIGIN, note: `Delete ${names.join(', ')}` });
        const whole = gone.length ? ` ${gone.join(', ')} kept fewer than 2 points, so ${gone.length > 1 ? 'they were' : 'it was'} deleted.` : '';
        return ok(`Deleted ${names.join(', ')} (the points after them moved down one index).${whole}`);
      },
    },

    curve: {
      usage: 'aia curve <doc> <point>...',
      summary: 'Makes points smooth curves (handles along their neighbors), as Curve in point editing',
      run: async (args) => shapeCommand(args, false),
    },

    corner: {
      usage: 'aia corner <doc> <point>...',
      summary: 'Makes points corners (no handles), as Corner in point editing',
      run: async (args) => shapeCommand(args, true),
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
        /** @type {import('../src/core/operations.js').Operation[]} */
        let ops;
        if (isLayer) {
          const t = transformOf(object);
          const next = { x: t.x + move.x, y: t.y + move.y, rotation: t.rotation + degrees, scaleX: t.scaleX * sx, scaleY: t.scaleY * sy };
          ops = [{ op: 'set', target, props: transformProps(doc, object, next) }];
        } else if (object.type === 'path') {
          const box = bounds([object]);
          const pivot = originOf(object) ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 0, y: 0 });
          const m = multiply(translate(move.x, move.y), around(pivot, multiply(rotate(degrees), scale(sx, sy))));
          ops = [{ op: 'set', target, props: transformPart(object, m) }];
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

    weld: {
      usage: 'aia weld <doc> <point> <target point> [--join] | aia weld <doc> <point> --on <part>',
      summary: 'Welds a point to a point of another part (it shares it from then on), or onto its line',
      details:
        'The first point goes to the target and shares it ({ "ref": "jaw.chin" }); the target gets a name if it has\n' +
        'none. --on <part> welds it onto that part’s line, where it is nearest, adding a point there. The two ends of\n' +
        'one line close it. --join: two open ends of two lines become one line (the first line is deleted).\n' +
        'Points: part.point or part.index. Example: aia weld face mouth.0 jaw.chin',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const moving = onePoint(doc, need(args, 1, 'the point to weld'));
        const on = args.flags.on;
        /** @type {import('../src/core/weld.js').WeldTarget} */
        let target;
        if (typeof on === 'string') {
          const part = findObject(doc, on);
          if (!part || part.type !== 'path') throw new AiaError(`there is no part "${on}"`);
          const from = verticesOf(/** @type {any} */ (findObject(doc, moving.part)))[moving.index];
          const hit = nearestOnOutline(part, from);
          if (!hit) throw new AiaError(`${on} has no line to weld onto`);
          target = { part: on, segment: hit.segment, t: hit.t };
        } else target = onePoint(doc, need(args, 2, 'the target point (or --on <part>)'));
        const w = welding(() => weld(doc, moving, target, { merge: args.flags.join === true }));
        await store.apply(id, w.ops, { origin: ORIGIN, note: w.note });
        return ok(`${w.note}.`);
      },
    },

    unweld: {
      usage: 'aia unweld <doc> <point>...',
      summary: 'The points stop sharing: each keeps its place as a point of its own',
      details: 'A shared vertex stops sharing; a point that others share is unwelded from all of them.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const names = args.positional.slice(1);
        if (!names.length) throw new AiaError('Missing the points to unweld');
        const ops = welding(() => unweld(doc, points(doc, names)));
        await store.apply(id, ops, { origin: ORIGIN, note: `Unweld ${names.join(', ')}` });
        return ok(`Unwelded ${names.join(', ')}.`);
      },
    },

    name: {
      usage: 'aia name <doc> <point> <name> | --none',
      summary: 'Names a point (part.index or its old name), so it can be shared, grouped and moved by name',
      details: 'Shared points and groups follow a new name. --none takes the name away, if nothing uses it.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const at = onePoint(doc, need(args, 1, 'the point'));
        const typed = args.flags.none === true ? '' : need(args, 2, 'the new name (or --none)');
        const { ops, name } = welding(() => namePoint(doc, at, typed));
        if (!ops.length) return ok('It already has that name.');
        await store.apply(id, ops, { origin: ORIGIN, note: name ? `Name ${at.part}.${name}` : `Unname a point of ${at.part}` });
        return ok(name ? `Named ${at.part}.${name}.` : `${at.part} vertex ${at.index} has no name now.`);
      },
    },

    'add-point': {
      usage: 'aia add-point <doc> <part> --at x,y [--name <name>]',
      summary: 'Adds a point on a part’s line where it is nearest to x,y, without changing its shape',
      details: 'x,y is in the coordinates of the part’s layer (as its vertices).',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const partId = need(args, 1, 'the part');
        const part = findObject(doc, partId);
        if (!part || part.type !== 'path') throw new AiaError(`there is no part "${partId}"`);
        const at = pair(args, 'at');
        if (!at) throw new AiaError('Say where: --at x,y (the point goes on the line, where it is nearest)');
        const hit = nearestOnOutline(part, at);
        if (!hit) throw new AiaError(`${partId} has no line to add a point on (or it only follows other parts)`);
        const { vertices, index } = insertVertex(part, hit.segment, hit.t);
        const name = typeof args.flags.name === 'string' ? args.flags.name : undefined;
        if (name) {
          if (vertices.some((v) => v.name === name)) throw new AiaError(`${partId} has a point named "${name}" already`);
          vertices[index] = { ...vertices[index], name };
        }
        await store.apply(id, [{ op: 'set', target: partId, props: { vertices } }], { origin: ORIGIN, note: `Add a point to ${partId}` });
        const p = vertices[index];
        return ok(`Added ${partId}.${name ?? index} at ${p.x}, ${p.y} (vertex ${index}; the ones after it moved up one).`);
      },
    },

    follow: {
      usage: 'aia follow <doc> <point> <point> [--long | --off]',
      summary: 'The stretch between two neighbor points follows the curve of the part they share points with',
      details:
        'Both points are in one part, next to each other, and share points of another part (weld them first). The\n' +
        'stretch then goes along that part’s outline: the short way, or --long the other. --off stops it.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const a = onePoint(doc, need(args, 1, 'the first point'));
        const b = onePoint(doc, need(args, 2, 'the second point'));
        const how = args.flags.off === true ? 'off' : args.flags.long === true ? 'long' : 'short';
        const { ops, note } = welding(() => followOps(doc, a, b, how));
        await store.apply(id, ops, { origin: ORIGIN, note });
        return ok(`${note}.`);
      },
    },

    group: {
      usage: 'aia group <doc> <layer>.<group> <point>... [--add | --remove | --delete]',
      summary: 'Point groups of a vector layer: set a group to these points, add or take them out, or delete it',
      details:
        'Without a flag the group becomes exactly these points (made if new). Points without a name get one\n' +
        '(part_1…). Example: aia group face face.upper_lid lid.0 lid.1 brow.mid',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const doc = await resolved(id);
        const full = need(args, 1, 'the group, as layer.group');
        const match = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(full);
        if (!match) throw new AiaError(`"${full}" is not a group: write it as layer.group (face.upper_lid)`);
        const flags = args.flags;
        const action = flags.delete === true ? 'delete' : flags.add === true ? 'add' : flags.remove === true ? 'remove' : 'set';
        const names = args.positional.slice(2);
        const { ops, name } = welding(() => groupOps(doc, match[1], action, match[2], action === 'delete' ? [] : points(doc, names)));
        await store.apply(id, ops, { origin: ORIGIN, note: `Group ${match[1]}.${match[2]}: ${action}` });
        return ok(action === 'delete' ? `Deleted the group ${match[1]}.${name}.` : `${match[1]}.${name}: ${action === 'set' ? 'set' : action === 'add' ? 'added to' : 'taken out of'}.`);
      },
    },

    undo: {
      usage: 'aia undo <doc> [--skip]',
      summary: 'Undoes your last step (never the person’s)',
      details:
        'It is refused, with the reason, when it would take away or overwrite what the person did after that step.\n' +
        '--skip then drops that step from your undo (nothing changes), so you can undo older ones.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const skip = args.flags.skip === true;
        const { canUndo } = await store.undo(id, ORIGIN, { skip });
        const done = skip ? `Skipped your last step on ${id} (it stays as it is).` : `Undid your last step on ${id}.`;
        return ok(`${done}${canUndo ? '' : ' Nothing more of yours to undo.'}`);
      },
    },

    redo: {
      usage: 'aia redo <doc>',
      summary: 'Redoes the step you undid last',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        await store.redo(id, ORIGIN);
        return ok(`Redid your step on ${id}.`);
      },
    },

    history: {
      usage: 'aia history <doc> [--all]',
      summary: 'The steps, newest last; the person’s ("user") are theirs to keep',
      details: 'Shows the last 20 steps unless --all. Each line: number, who (ai or user), what (batch, undo, redo), the note.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        await store.get(id, ORIGIN);
        const entries = await store.history(id);
        if (!entries.length) return ok(`${id} has no steps yet.`);
        const shown = args.flags.all ? entries : entries.slice(-20);
        const lines = shown.map((e) => {
          const what = e.kind === 'batch' ? `${e.ops.length} op${e.ops.length > 1 ? 's' : ''}` : `${e.kind} of #${e.of}`;
          return `#${e.n} ${e.origin.padEnd(4)} ${what}${e.note ? ` — ${e.note}` : ''}`;
        });
        const skipped = entries.length - shown.length;
        return ok(`${skipped ? `(${skipped} older steps: --all)\n` : ''}${lines.join('\n')}`);
      },
    },

    image: {
      usage: 'aia image <doc> <file> [--id name] [--in group] [--at x,y] [--width N | --height N] [--opacity 0.5] | --replace <layer>',
      summary: 'Adds an image layer from a picture file (PNG, JPEG, WebP or SVG), for example a reference to draw over',
      details:
        'The file is copied into the document’s assets folder; <file> is a path on this computer (relative to where\n' +
        'aia runs, or absolute). The layer goes on top of the root (--in: of a group), as big as the picture made\n' +
        'smaller to fit the artboard, centered (--at: on that point of the artboard). The picture is drawn from (0, 0)\n' +
        'in the layer’s coordinates: x, y place it, and aia transform moves, turns and scales it as any layer.\n' +
        'A reference to trace: --opacity 0.5, then lock it (set locked: true) so it is not picked by mistake.\n' +
        '--replace changes the picture of an image layer (keeps its width, takes the new proportion).\n' +
        'Example: aia image robot C:/refs/robot_front.png --id ref --opacity 0.4',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const file = need(args, 1, 'the picture file');
        let bytes;
        try {
          bytes = new Uint8Array(await fs.readFile(path.resolve(file)));
        } catch {
          throw new AiaError(`Can't read the file "${file}"`);
        }
        const { src, naturalWidth, naturalHeight, reused } = await store.saveAsset(id, path.basename(file), bytes);
        const { document } = await store.get(id, ORIGIN);
        const replace = args.flags.replace;
        const opacity = args.flags.opacity === undefined ? undefined : Number(args.flags.opacity);
        if (opacity !== undefined && !(opacity >= 0 && opacity <= 1)) throw new AiaError('--opacity is a number from 0 to 1');
        /** @type {{ id: string, ops: Operation[] }} */
        let plan;
        try {
          if (typeof replace === 'string') plan = { id: replace, ops: replaceImageOps(document, replace, { src, naturalWidth, naturalHeight }) };
          else {
            const parent = typeof args.flags.in === 'string' ? args.flags.in : null;
            if (parent !== null && findObject(document, parent)?.type !== 'group') throw new AiaError(`${id} has no group "${parent}"`);
            plan = addImageOps(document, {
              src,
              naturalWidth,
              naturalHeight,
              id: typeof args.flags.id === 'string' ? args.flags.id : undefined,
              parent,
              at: pair(args, 'at'),
              width: number(args, 'width'),
              height: number(args, 'height'),
            });
          }
        } catch (e) {
          throw new AiaError(e.message);
        }
        if (opacity !== undefined) plan.ops.push({ op: 'set', target: plan.id, props: { opacity } });
        const note = typeof replace === 'string' ? `${plan.id}: picture ${src}` : `Image layer ${plan.id}`;
        await store.apply(id, plan.ops, { origin: ORIGIN, note });
        const layer = findObject((await store.get(id, ORIGIN)).document, plan.id);
        const size = `${naturalWidth} × ${naturalHeight} px${reused ? ', already in assets' : ''}`;
        return ok(
          `${typeof replace === 'string' ? 'Changed the picture of' : 'Added the image layer'} ${plan.id}: ${src} (${size}), ` +
            `drawn ${layer?.width} × ${layer?.height} at ${layer?.x ?? 0}, ${layer?.y ?? 0}.`,
        );
      },
    },

    export: {
      usage: 'aia export <doc> --format svg|html [--out file]',
      summary: 'The document as a file to use outside aia-studio: a still SVG, or a web page that plays it',
      details:
        'svg: the drawing as it looks now. html: one page with the document and the runtime inside, which plays it in\n' +
        'any browser with no server and nothing else (the runtime is the same drawing code as the editor). From the\n' +
        'CLI the file goes to --out, or to the temp folder (the path is printed).',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const format = args.flags.format ?? 'svg';
        if (format !== 'svg' && format !== 'html') throw new AiaError('--format is svg or html');
        const { document } = await store.get(id, ORIGIN);
        const assets = await store.assetUrls(id, document);
        const data = format === 'svg' ? toSvg(document, { assetUrl: (src) => assets[src] ?? null }) : htmlPage(document, assets);
        return { ok: true, text: `${id}.${format}: ${Math.round(data.length / 102.4) / 10} KB`, file: { name: `${id}.${format}`, data } };
      },
    },

    render: {
      usage: 'aia render <doc> [--width N] [--labels] [--out file.png]',
      summary: 'A PNG of the document, to check your work by eye',
      details:
        'The image is the artboard as the editor and the export draw it, --width px wide (its own width by default).\n' +
        'From the CLI it is saved to --out, or to aia-<doc>.png in the temp folder (the path is printed); over MCP it\n' +
        'comes back as an image. --labels marks the named points (labeled) and the shared ones (rings) where they\n' +
        'are on the artboard, to check welds and names.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const { document } = await store.get(id, ORIGIN);
        const docWidth = Number(document.meta.width ?? 800);
        const docHeight = Number(document.meta.height ?? 600);
        const width = Math.min(RENDER_MAX, number(args, 'width') ?? docWidth);
        const assets = await store.assetUrls(id, document);
        const drawn = toSvg(document, { assetUrl: (src) => assets[src] ?? null });
        const svg = args.flags.labels === true ? withPoints(document, drawn, docWidth / width) : drawn;
        const image = svgToPng(svg, width, { text: args.flags.labels === true });
        const height = Math.round((width * docHeight) / docWidth);
        return { ok: true, text: `${id}: ${width} × ${height} px`, image, name: `${id}.png` };
      },
    },
  };

  /**
   * Runs one command: a line (the MCP) or its words (the CLI). Failures come back as a result with ok false and the
   * reason, so the AI reads it and tries again.
   * @param {string | string[]} input
   * @returns {Promise<Result>}
   */
  async function run(input) {
    try {
      const words = typeof input === 'string' ? tokenize(input) : input;
      const [name = 'help', ...rest] = words;
      const command = commands[name];
      if (!command) throw new AiaError(`There is no command "${name}" (aia help lists them)`);
      return await command.run(parseArgs(rest));
    } catch (e) {
      return { ok: false, text: e.message };
    }
  }

  return { run, commands };
}

/**
 * What a batch changed, in a line: created, changed, deleted, renamed ids.
 * @param {import('../src/core/document.js').Doc} before @param {import('../src/core/document.js').Doc} after
 */
function changes(before, after) {
  const was = new Map(before.objects.map((o) => [o.id, JSON.stringify(o)]));
  const now = new Set(after.objects.map((o) => o.id));
  const created = after.objects.filter((o) => !was.has(o.id)).map((o) => o.id);
  const changed = after.objects.filter((o) => was.has(o.id) && was.get(o.id) !== JSON.stringify(o)).map((o) => o.id);
  const deleted = before.objects.filter((o) => !now.has(o.id)).map((o) => o.id);
  const metaChanged = JSON.stringify(before.meta) !== JSON.stringify(after.meta) ? ['meta'] : [];
  const parts = [
    created.length ? `created: ${created.join(', ')}` : '',
    [...metaChanged, ...changed].length ? `changed: ${[...metaChanged, ...changed].join(', ')}` : '',
    deleted.length ? `gone: ${deleted.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join('; ')}.` : 'Nothing changed.';
}

/**
 * A web page that plays a document with the runtime, with nothing else to load (its pictures go inside).
 * @param {import('../src/core/document.js').Doc} doc @param {Record<string, string>} assets data URLs by name
 */
function htmlPage(doc, assets) {
  /** @param {string} text */
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const json = JSON.stringify(doc).replace(/</g, '\\u003c');
  const assetJson = JSON.stringify(assets).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(String(doc.meta.name ?? 'aia-studio'))}</title>
<style>html, body { margin: 0; height: 100%; } body { display: grid; place-items: center; background: #2b2a33; } svg { max-width: 100vw; max-height: 100vh; height: auto; }</style>
</head>
<body>
<svg id="aia" xmlns="http://www.w3.org/2000/svg"></svg>
<script type="application/json" id="aia-document">${json}</script>
<script type="application/json" id="aia-assets">${assetJson}</script>
<script>
${bundleRuntime()}</script>
<script>
const read = (id) => JSON.parse(document.getElementById(id).textContent);
aiaRuntime.createPlayer(document.getElementById('aia'), read('aia-document'), { assets: read('aia-assets') });
</script>
</body>
</html>
`;
}

/**
 * The drawing with its named and shared points marked and labeled where they are on the artboard (aia render
 * --labels), to check welds and names by eye.
 * @param {import('../src/core/document.js').Doc} doc @param {string} svg @param {number} unit document px per image px
 */
function withPoints(doc, svg, unit) {
  const shown = resolveDoc(doc);
  /** @type {string[]} */
  const marks = [];
  /** @param {string} text */
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  for (const part of shown.objects) {
    const w = worldOf(shown, part.id);
    for (const [i, v] of verticesOf(part).entries()) {
      if (!v.name && !v.ref) continue;
      const p = applyMatrix(w, v);
      const shared = !!v.ref;
      // A shared vertex sits on its point: only the point itself gets a label.
      marks.push(`<circle cx="${p.x}" cy="${p.y}" r="${4 * unit}" fill="${shared ? 'none' : '#e0306a'}" stroke="#e0306a" stroke-width="${1.5 * unit}"/>`);
      if (!shared) marks.push(`<text x="${p.x + 6 * unit}" y="${p.y - 6 * unit}" font-family="Arial" font-size="${11 * unit}" fill="#e0306a" stroke="#ffffff" stroke-width="${3 * unit}" paint-order="stroke">${escape(`${part.id}.${v.name}`)}</text>`);
      void i;
    }
  }
  return svg.replace(/<\/svg>$/, `${marks.join('')}</svg>`);
}
