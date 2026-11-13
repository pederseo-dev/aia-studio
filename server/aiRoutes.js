// /api/ai/...: what the editor's "Connect your AI" panel needs.
//   GET  /api/ai                       status: Claude Desktop config, running MCP servers, commands and links
//   POST /api/ai/claude-desktop        adds (or updates) our entry in Claude Desktop's config
//   DELETE /api/ai/claude-desktop      removes it

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { respond } from './api.js';
import { claudeCodeCommand, claudeDesktopStatus, connectClaudeDesktop, cursorLink, disconnectClaudeDesktop, findClaudeDesktopConfig, vscodeLink } from './aiClients.js';
import { runningServers } from './mcpStatus.js';

export const MCP_ENTRY = fileURLToPath(new URL('../mcp/server.js', import.meta.url));

/**
 * The entry for development: this same Node running the repo's MCP server on this documents folder.
 * @param {string} documents @returns {import('./aiClients.js').McpEntry}
 */
export const devEntry = (documents) => ({ command: process.execPath, args: [MCP_ENTRY], env: { AIA_DOCUMENTS: path.resolve(documents) } });

/**
 * @param {{
 *   documents: string,
 *   entry: import('./aiClients.js').McpEntry,
 *   app?: boolean,
 *   findConfig?: () => string | null,
 * }} options `app`: running in the desktop app (otherwise `npm run dev`); `findConfig` for tests
 */
export function createAiRoutes({ documents, entry, app = false, findConfig = () => findClaudeDesktopConfig() }) {
  async function status() {
    const config = findConfig();
    return {
      app,
      entry,
      claudeDesktop: config ? { config, status: await claudeDesktopStatus(config, entry) } : null,
      servers: await runningServers(documents),
      claudeCode: claudeCodeCommand(entry),
      cursor: cursorLink(entry),
      vscode: vscodeLink(entry),
    };
  }

  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, route: string[]) => Promise<boolean>} */
  return async (req, res, route) => {
    const [target, ...rest] = route;
    if (rest.length) return false;
    if (!target && req.method === 'GET') {
      respond(res, 200, await status());
      return true;
    }
    if (target === 'claude-desktop' && (req.method === 'POST' || req.method === 'DELETE')) {
      const config = findConfig();
      if (!config) throw new Error('Claude Desktop was not found on this computer. Install it from claude.ai/download and open it once.');
      const result = req.method === 'POST' ? await connectClaudeDesktop(config, entry) : await disconnectClaudeDesktop(config);
      respond(res, 200, { ...result, ...(await status()) });
      return true;
    }
    return false;
  };
}
