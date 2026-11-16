// The `aia` command language (decision 9 in docs/rebuild.md): one interpreter for every way an AI reaches
// aia-studio. The CLI (bin/aia.js) passes it its arguments; the MCP (mcp/server.js) passes it one string. It knows
// nothing of either: it takes a command and gives back text, and an image for `render`.
// Everything it changes has the origin "ai", so the person's own steps are never undone by the AI.

import fs from 'node:fs/promises';
import { findObject, subtree } from '../src/core/document.js';
import { toSvg } from '../src/core/draw.js';
import { guide } from '../src/core/guide.js';
import { insertVertex, nearestOnOutline, verticesOf } from '../src/core/geometry.js';
import { movePointsOps, pointsNamed, resolveDoc } from '../src/core/points.js';
import { followOps, groupOps, namePoint, unweld, weld } from '../src/core/weld.js';
import { svgToPng } from './png.js';

/**
 * @typedef {import('../src/core/operations.js').Operation} Operation
 * @typedef {{ ok: boolean, text: string, image?: Buffer, name?: string }} Result
 * @typedef {{ positional: string[], flags: Record<string, string | true> }} Args
 * @typedef {{ usage: string, summary: string, details?: string, run: (args: Args) => Promise<Result> }} Command
 */

export class AiaError extends Error {}

const BOOLEAN_FLAGS = new Set(['yes', 'all', 'join', 'long', 'off', 'none', 'add', 'remove', 'delete', 'resolved']);
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
      usage: 'aia undo <doc>',
      summary: 'Undoes your last step (never the person’s)',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const { canUndo } = await store.undo(id, ORIGIN);
        return ok(`Undid your last step on ${id}.${canUndo ? '' : ' Nothing more of yours to undo.'}`);
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

    render: {
      usage: 'aia render <doc> [--width N] [--out file.png]',
      summary: 'A PNG of the document, to check your work by eye',
      details:
        'The image is the artboard as the editor and the export draw it, --width px wide (its own width by default).\n' +
        'From the CLI it is saved to --out, or to aia-<doc>.png in the temp folder (the path is printed); over MCP it\n' +
        'comes back as an image.',
      run: async (args) => {
        const id = need(args, 0, 'the document id');
        const { document } = await store.get(id, ORIGIN);
        const docWidth = Number(document.meta.width ?? 800);
        const docHeight = Number(document.meta.height ?? 600);
        const width = Math.min(RENDER_MAX, number(args, 'width') ?? docWidth);
        const image = svgToPng(toSvg(document), width);
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
