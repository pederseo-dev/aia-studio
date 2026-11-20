// What every group of `aia` commands shares: the errors, reading a command line, the answers, and the helpers
// that work on the store (a context made once per interpreter).

import { findObject } from '../../src/core/document.js';
import { around, bounds, multiply, rotate, roundVertex, scale, shapePoint, transformPart, translate, verticesOf } from '../../src/core/geometry.js';
import { partsToMove } from '../../src/core/shapes.js';
import { pointsNamed, resolveDoc } from '../../src/core/points.js';

/**
 * @typedef {import('../../src/core/operations.js').Operation} Operation
 * @typedef {{ ok: boolean, text: string, image?: Buffer, name?: string, file?: { name: string, data: string } }} Result
 *   image: a PNG to look at; file: something to save (the CLI writes it, the MCP returns it)
 * @typedef {{ positional: string[], flags: Record<string, string | true> }} Args
 * @typedef {{ usage: string, summary: string, details?: string, run: (args: Args) => Promise<Result> }} Command
 * @typedef {ReturnType<typeof createContext>} Context the helpers the commands share
 */

export class AiaError extends Error {}

const BOOLEAN_FLAGS = new Set(['yes', 'all', 'join', 'long', 'off', 'none', 'add', 'remove', 'delete', 'resolved', 'apply', 'skip', 'labels', 'up', 'down', 'top', 'bottom']);

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
export function parseArgs(words) {
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
export const ok = (text) => ({ ok: true, text });

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
 * What a batch changed, in a line: created, changed, deleted, renamed ids.
 * @param {import('../../src/core/document.js').Doc} before @param {import('../../src/core/document.js').Doc} after
 */
export function changes(before, after) {
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
 * The helpers the commands share, on one store.
 * @param {{ store: ReturnType<typeof import('../store.js').createStore>, schema: import('../../src/core/schema.js').Schema }} options
 */
export function createContext({ store, schema }) {
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
    const named = names.map((n) => {
      const part = findObject(doc, n);
      if (!part || part.type !== 'path') throw new AiaError(`"${n}" is not a part: layers turn one at a time, around their origin`);
      return part;
    });
    // A fill moves the lines it follows.
    const parts = partsToMove(doc, named);
    if (new Set(parts.map((p) => p.parent)).size > 1) throw new AiaError('the parts are in different layers: transform them layer by layer');
    const box = bounds(named);
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

  /** --id: what a new shape's parts are named after (name_fill, name_stroke), instead of its main line. @param {Args} args */
  const shapeName = (args) => {
    const name = args.flags.id;
    if (name === undefined) return undefined;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) throw new AiaError('--id is a name: lowercase letters, digits and _, starting with a letter');
    return name;
  };

  /** What a new shape is, for the answer. @param {string[]} ids */
  const madeShape = (ids) => `Made ${ids.join(' and ')}${ids.length > 1 ? ' (its fill and its stroke, each with its own place in the order)' : ''}.`;

  /**
   * --fill, --stroke (a color or none), --stroke-width, --fill-opacity, --stroke-opacity (0 to 1), --stroke-cap and
   * --stroke-join, as part props.
   * @param {Args} args
   */
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
    for (const [flag, key] of [['stroke-cap', 'strokeCap'], ['stroke-join', 'strokeJoin']]) {
      const value = args.flags[flag];
      if (value === undefined) continue;
      const values = /** @type {string[]} */ (schema.get('part')?.properties[key]?.values ?? []);
      if (typeof value !== 'string' || !values.includes(value)) throw new AiaError(`--${flag} is one of: ${values.join(', ')}`);
      props[key] = value;
    }
    return props;
  };

  /**
   * Draws a shape's vertices as a new part of a vector layer (made if there is none).
   * @param {Args} args @param {string} id @param {import('../../src/core/geometry.js').Vertex[]} vertices @param {string} kind
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
    /** @type {import('../../src/core/operations.js').Operation[]} */
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
    /** @type {Map<string, import('../../src/core/geometry.js').Vertex[]>} */
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


  return { store, schema, ORIGIN, need, number, resolved, points, onePoint, welding, transformParts, round, boxFlag, shapeName, madeShape, styleFlags, drawShape, shapeCommand, pair };
}
