// The desktop app: starts the editor server (server/app.js) on 127.0.0.1 and opens it in a window. Documents live in
// the user's data folder (on Windows %APPDATA%\aia-studio\documents). The AI clients launch this same executable as
// Node (ELECTRON_RUN_AS_NODE=1) with mcp/server.js, so nobody needs Node installed and the MCP server is always the
// same version as the editor (see server/aiRoutes.js and the "Connect your AI" dialog).

import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

if (!app.requestSingleInstanceLock()) app.exit(0);

const userData = app.getPath('userData');
// A GUI app has no console on Windows: what the main process reports goes to <userData>/main.log too.
const logFile = path.join(userData, 'main.log');
/** @param {string} message */
const log = (message) => {
  console.log(message);
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}
`);
  } catch {}
};
// Installed: the documents go to the user's data folder. Run from the repo (`npm run app`): the repo's documents/,
// as with `npm run dev`. Set before the server modules load, since they resolve the folder from it.
if (app.isPackaged) process.env.AIA_DOCUMENTS ||= path.join(userData, 'documents');
const { resolveDocumentsFolder } = await import('../server/folder.js');
const documents = resolveDocumentsFolder({ argv: [] });

const { startServer } = await import('../server/app.js');
const { createAiRoutes } = await import('../server/aiRoutes.js');
const { findClaudeDesktopConfig, repairClaudeDesktop } = await import('../server/aiClients.js');

/** What an AI client runs to start our MCP server: this executable, as Node, with the MCP entry. */
const entry = {
  command: process.execPath,
  args: [path.join(app.getAppPath(), 'mcp', 'server.js')],
  env: { ELECTRON_RUN_AS_NODE: '1', AIA_DOCUMENTS: documents },
};

// The editor keeps per-site things (open tabs, folded panels) in localStorage, so the address must not change from
// one launch to the next: the port that worked last time is tried first.
const settingsFile = path.join(userData, 'settings.json');
const readSettings = () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
};
const DEFAULT_PORT = 47613;

async function start() {
  const settings = readSettings();
  const ai = createAiRoutes({ documents, entry, app: true });
  let server;
  try {
    server = await startServer({ folder: documents, port: settings.port ?? DEFAULT_PORT, ai });
  } catch {
    server = await startServer({ folder: documents, port: 0, ai });
  }
  if (server.port !== settings.port) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, port: server.port }, null, 2));
  }
  log(`Editor at ${server.url}, documents in ${documents}`);
  return server;
}

/** If Claude Desktop has our entry but for another location of the app (moved or reinstalled elsewhere), fix it. */
async function repairConnections() {
  try {
    const config = findClaudeDesktopConfig();
    log(`Claude Desktop config: ${config ?? 'not found'}`);
    if (config && (await repairClaudeDesktop(config, entry))) log(`Updated the aia-studio entry in ${config} to ${entry.command}`);
  } catch (e) {
    log(`Could not check Claude Desktop's config: ${e.message}`);
  }
}

/** @param {string} url */
function createWindow(url) {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#353330',
    title: 'aia-studio',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const origin = new URL(url).origin;
  // Links (claude.ai/download, "Add to Cursor", "Add to VS Code") open outside, in the browser or the app they name.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^(https?:|cursor:|vscode:)/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === origin) return;
    event.preventDefault();
    if (/^https?:/.test(target)) shell.openExternal(target);
  });
  window.once('ready-to-show', () => window.show());
  window.loadURL(url);
  return window;
}

// Not `await app.whenReady()` at the top level: with an ES module as main, Electron emits `ready` only after the module
// has finished evaluating, so awaiting it here would never return.
const server = await start();
/** @type {BrowserWindow} */
let window;
app.whenReady().then(() => {
  window = createWindow(server.url);
  repairConnections();
});

app.on('second-instance', () => {
  if (!window || window.isDestroyed()) window = createWindow(server.url);
  if (window.isMinimized()) window.restore();
  window.focus();
});
app.on('activate', () => BrowserWindow.getAllWindows().length || (window = createWindow(server.url)));
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('will-quit', () => server.close());
