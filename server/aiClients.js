// "Connect your AI": the entry that launches aia-studio's MCP server, and how it gets into each AI client.
// Claude Desktop reads a JSON file with { mcpServers: { name: { command, args, env } } }; we only ever add, update or
// remove our own entry and keep everything else (other servers, preferences) exactly as it was.

import fs from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVER_NAME = 'aia-studio';
const CONFIG_FILE = 'claude_desktop_config.json';

/** @typedef {{ command: string, args: string[], env?: Record<string, string> }} McpEntry */

/**
 * Where Claude Desktop keeps its config, most likely first. On Windows it depends on how it was installed: the
 * classic installer uses %APPDATA%\Claude, the Microsoft Store (MSIX) build a virtualized copy of it under
 * %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude, and newer builds %LOCALAPPDATA%\Claude-Data\<package>.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, home?: string, list?: (dir: string) => string[] }} [system]
 * @returns {string[]}
 */
export function claudeDesktopCandidates({ platform = process.platform, env = process.env, home = os.homedir(), list = safeList } = {}) {
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude', CONFIG_FILE)];
  if (platform !== 'win32') return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', CONFIG_FILE)];
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const packages = list(path.join(local, 'Packages')).filter((d) => /^Claude_/i.test(d));
  const data = list(path.join(local, 'Claude-Data')).filter((d) => /^claude_/i.test(d));
  return [
    ...data.map((d) => path.win32.join(local, 'Claude-Data', d, CONFIG_FILE)),
    ...packages.map((d) => path.win32.join(local, 'Packages', d, 'LocalCache', 'Roaming', 'Claude', CONFIG_FILE)),
    path.win32.join(roaming, 'Claude', CONFIG_FILE),
  ];
}

function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The Claude Desktop config this machine uses, or null if Claude Desktop does not seem to be installed. An existing
 * config file wins (the most recently written one); otherwise the first candidate whose folder exists.
 * @param {Parameters<typeof claudeDesktopCandidates>[0] & { exists?: (p: string) => boolean, modified?: (p: string) => number }} [system]
 * @returns {string | null}
 */
export function findClaudeDesktopConfig(system = {}) {
  const { exists = existsSync, modified = (p) => statSync(p).mtimeMs } = system;
  const candidates = claudeDesktopCandidates(system);
  const files = candidates.filter((c) => exists(c));
  if (files.length) return files.sort((a, b) => modified(b) - modified(a))[0];
  return candidates.find((c) => exists(path.dirname(c))) ?? null;
}

/** @param {string | null | undefined} text @returns {Record<string, any>} */
function parseConfig(text) {
  if (!text?.trim()) return {};
  let config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    throw new Error(`The Claude Desktop config is not valid JSON (${e.message}); fix it or move it away first. It was not changed.`);
  }
  if (config == null || typeof config !== 'object' || Array.isArray(config)) throw new Error('The Claude Desktop config is not a JSON object; it was not changed.');
  if (config.mcpServers != null && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
    throw new Error('"mcpServers" in the Claude Desktop config is not an object; it was not changed.');
  }
  return config;
}

// Key order does not matter (Claude Desktop may rewrite the file with its own order).
const canonical = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : Array.isArray(v) ? v.map(canonical) : v);
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const format = (config) => JSON.stringify(config, null, 2) + '\n';

/**
 * Our entry in a config text: 'missing', 'current' (exactly `entry`) or 'outdated' (there, but for example pointing
 * at an older location of the app).
 * @param {string | null | undefined} text @param {McpEntry} entry
 * @returns {'missing' | 'current' | 'outdated'}
 */
export function entryStatus(text, entry, name = SERVER_NAME) {
  const ours = parseConfig(text).mcpServers?.[name];
  if (!ours) return 'missing';
  return same(ours, entry) ? 'current' : 'outdated';
}

/**
 * The config text with our entry added or replaced; nothing else changes.
 * @param {string | null | undefined} text @param {McpEntry} entry
 * @returns {{ text: string, changed: boolean }}
 */
export function addEntry(text, entry, name = SERVER_NAME) {
  const config = parseConfig(text);
  if (same(config.mcpServers?.[name], entry)) return { text: text ?? format(config), changed: false };
  config.mcpServers = { ...(config.mcpServers ?? {}), [name]: entry };
  return { text: format(config), changed: true };
}

/**
 * The config text without our entry; nothing else changes.
 * @param {string | null | undefined} text
 * @returns {{ text: string, changed: boolean }}
 */
export function removeEntry(text, name = SERVER_NAME) {
  const config = parseConfig(text);
  if (!config.mcpServers?.[name]) return { text: text ?? '', changed: false };
  const { [name]: _removed, ...rest } = config.mcpServers;
  config.mcpServers = rest;
  return { text: format(config), changed: true };
}

const readText = (file) => fs.readFile(file, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));

/** Writes `text` to `file`, keeping what was there in `<file>.aia-backup` first, and through a temp file. */
async function writeWithBackup(file, before, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (before != null) await fs.writeFile(`${file}.aia-backup`, before);
  await fs.writeFile(`${file}.tmp`, text);
  await fs.rename(`${file}.tmp`, file);
}

/**
 * Applies `change` to the config file at `file` (a missing file counts as empty).
 * @param {string} file @param {(text: string | null) => { text: string, changed: boolean }} change
 * @returns {Promise<{ changed: boolean, backup: string | null }>}
 */
async function updateConfig(file, change) {
  const before = await readText(file);
  const { text, changed } = change(before);
  if (changed) await writeWithBackup(file, before, text);
  return { changed, backup: changed && before != null ? `${file}.aia-backup` : null };
}

/** @param {string} file @param {McpEntry} entry */
export const connectClaudeDesktop = (file, entry) => updateConfig(file, (text) => addEntry(text, entry));
/** @param {string} file */
export const disconnectClaudeDesktop = (file) => updateConfig(file, (text) => removeEntry(text));

/**
 * At each launch: if our entry is there but points somewhere else (the app moved or was updated to another folder),
 * it is pointed at this app again. A missing entry stays missing (the user disconnected, or never connected).
 * @param {string} file @param {McpEntry} entry
 * @returns {Promise<boolean>} whether it was repaired
 */
export async function repairClaudeDesktop(file, entry) {
  const text = await readText(file);
  if (text == null || entryStatus(text, entry) !== 'outdated') return false;
  await writeWithBackup(file, text, addEntry(text, entry).text);
  return true;
}

/** @param {string} file @param {McpEntry} entry */
export async function claudeDesktopStatus(file, entry) {
  try {
    return entryStatus(await readText(file), entry);
  } catch (e) {
    return /** @type {const} */ ('invalid');
  }
}

// Paths with backslashes are quoted too, so the command works the same in PowerShell, cmd and Git Bash.
const quote = (s) => (/^[\w./:=-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** The command that adds the entry to Claude Code (for every project of this user). @param {McpEntry} entry */
export function claudeCodeCommand(entry, name = SERVER_NAME) {
  const env = Object.entries(entry.env ?? {}).flatMap(([k, v]) => ['-e', quote(`${k}=${v}`)]);
  return ['claude', 'mcp', 'add', '--scope', 'user', name, ...env, '--', quote(entry.command), ...entry.args.map(quote)].join(' ');
}

/** Cursor's one-click install link. @param {McpEntry} entry */
export function cursorLink(entry, name = SERVER_NAME) {
  const config = Buffer.from(JSON.stringify(entry)).toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`;
}

/** VS Code's one-click install link. @param {McpEntry} entry */
export function vscodeLink(entry, name = SERVER_NAME) {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, ...entry }))}`;
}
