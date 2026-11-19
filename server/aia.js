// The `aia` command language (decision 9 in docs/rebuild.md): one interpreter for every way an AI reaches
// aia-studio. The CLI (bin/aia.js) passes it its arguments; the MCP (mcp/server.js) passes it one string. It knows
// nothing of either: it takes a command and gives back text, and an image for `render`.
// Everything it changes has the origin "ai", so the person's own steps are never undone by the AI.
// The commands live in server/aia/, one file per topic; this file puts them together and runs a command.

import { guide } from '../src/core/guide.js';
import { AiaError, createContext, ok, parseArgs, tokenize } from './aia/common.js';
import { documentsCommands } from './aia/documents.js';
import { pointsCommands } from './aia/points.js';
import { shapesCommands } from './aia/shapes.js';
import { outputCommands } from './aia/output.js';

export { AiaError, compactJson, tokenize } from './aia/common.js';

/**
 * @typedef {import('./aia/common.js').Result} Result
 * @typedef {import('./aia/common.js').Command} Command
 */

/**
 * @param {{ store: ReturnType<typeof import('./store.js').createStore>, schema: import('../src/core/schema.js').Schema }} options
 */
export function createAia({ store, schema }) {
  const ctx = createContext({ store, schema });

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

    ...documentsCommands(ctx),
    ...pointsCommands(ctx),
    ...shapesCommands(ctx),
    ...outputCommands(ctx),
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
