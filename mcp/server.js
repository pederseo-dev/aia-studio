// The thin MCP server (stdio), for AI clients without a terminal (the Claude Desktop chat). Two tools over the same
// interpreter as the CLI, in process and without a shell: only `aia` commands exist here.
//   aia(command)   any command, as one line: "guide start", "ops face [ ... ]", "render face"
//   render(doc)    the document as an image, to check the work by eye
// --documents <folder> or AIA_DOCUMENTS choose the documents folder (as for the app and the CLI).

import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAia } from '../server/aia.js';
import { resolveDocumentsFolder } from '../server/folder.js';
import { loadSchema } from '../server/schema.js';
import { createStore } from '../server/store.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const folder = resolveDocumentsFolder();
fs.mkdirSync(folder, { recursive: true });
const schema = loadSchema();
const aia = createAia({ store: createStore({ folder, schema }), schema });

const server = new McpServer(
  { name: 'aia-studio', version },
  {
    instructions:
      'aia-studio is a 2D vector drawing and animation tool. Everything is done with `aia` commands through the aia tool: ' +
      'start with "help" and "guide start". Before changing a document, look at "history <doc>": steps by "user" are the ' +
      'person’s own touch-ups and must be kept. After a visible change, look at it with the render tool.',
  },
);

/** @param {import('../server/aia.js').Result} result */
function reply(result) {
  /** @type {any[]} */
  const content = [{ type: 'text', text: result.text }];
  if (result.image) content.push({ type: 'image', data: result.image.toString('base64'), mimeType: 'image/png' });
  return { content, ...(result.ok ? {} : { isError: true }) };
}

server.registerTool(
  'aia',
  {
    description:
      'Runs one aia command, written as on the command line without the leading "aia". Examples: "help", "guide start", ' +
      '"list", "show face", "ops face [{\\"op\\":\\"create\\",\\"type\\":\\"vector\\",\\"id\\":\\"face\\"}]" (a JSON batch ' +
      'needs no quoting), "undo face", "history face".',
    inputSchema: { command: z.string().describe('the command line, for example: guide ops') },
  },
  async ({ command }) => reply(await aia.run(command)),
);

server.registerTool(
  'render',
  {
    description: 'The document as a PNG image (the artboard as the editor draws it), to check the work by eye.',
    inputSchema: {
      doc: z.string().describe('document id'),
      width: z.number().int().positive().max(2000).optional().describe('width in px; the artboard width by default'),
    },
  },
  async ({ doc, width }) => reply(await aia.run(['render', doc, ...(width ? ['--width', String(width)] : [])])),
);

await server.connect(new StdioServerTransport());
