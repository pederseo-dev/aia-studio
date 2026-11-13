// Which MCP servers are running right now, so the editor can say "Claude connected". Each MCP server leaves a marker
// file in <documents>/.aia/mcp/<pid>.json while it runs (with the AI client that launched it) and removes it on exit;
// a marker whose process is gone (a crash) is ignored and cleaned up.

import fs from 'node:fs/promises';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stateFolder } from './folder.js';

const markers = (documents) => path.join(stateFolder(documents), 'mcp');

/** Friendly names for the clientInfo.name AI clients send. */
const CLIENTS = { 'claude-ai': 'Claude Desktop', 'claude-code': 'Claude Code', cursor: 'Cursor', 'cursor-vscode': 'Cursor', 'Visual Studio Code': 'VS Code' };
export const clientLabel = (name) => (name ? (CLIENTS[name] ?? name) : 'an AI client');

/**
 * Leaves this process's marker. Returns a function to fill in the client once the AI client says who it is.
 * @param {string} documents @param {{ version: string, pid?: number }} info
 */
export function markRunning(documents, { version, pid = process.pid }) {
  const file = path.join(markers(documents), `${pid}.json`);
  const marker = { pid, version, started: new Date().toISOString(), client: null };
  const write = () => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(marker));
    } catch (e) {
      console.error(`aia-studio: could not write the MCP status marker (${e.message})`);
    }
  };
  write();
  const remove = () => {
    try {
      unlinkSync(file);
    } catch {}
  };
  process.once('exit', remove);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => process.exit(0));
  return {
    /** @param {{ name?: string, version?: string } | undefined} client */
    setClient(client) {
      marker.client = client ? { name: client.name, version: client.version } : null;
      write();
    },
    remove,
  };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * The MCP servers running on this documents folder, oldest first.
 * @param {string} documents @param {{ isAlive?: (pid: number) => boolean }} [options]
 * @returns {Promise<{ pid: number, version: string, started: string, client: { name?: string, version?: string } | null, label: string }[]>}
 */
export async function runningServers(documents, { isAlive = alive } = {}) {
  const folder = markers(documents);
  const names = await fs.readdir(folder).catch(() => []);
  const running = [];
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const file = path.join(folder, name);
    try {
      const marker = JSON.parse(await fs.readFile(file, 'utf8'));
      if (isAlive(marker.pid)) running.push({ ...marker, label: clientLabel(marker.client?.name) });
      else await fs.rm(file, { force: true });
    } catch {
      // half written: read again on the next check
    }
  }
  return running.sort((a, b) => a.started.localeCompare(b.started));
}
