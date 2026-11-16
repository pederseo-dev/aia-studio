// The desktop app: starts the editor server (server/app.js) on 127.0.0.1 and opens it in a window.
// Documents: `--documents <folder>` or AIA_DOCUMENTS if given; otherwise the user's data folder when installed
// (on Windows %APPDATA%\aia-studio\documents) and the repo's documents/ when run from source (`npm run app`).

import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDocumentsFolder } from '../server/folder.js';
import { startServer } from '../server/app.js';

if (!app.requestSingleInstanceLock()) app.exit(0);

const userData = app.getPath('userData');

// A GUI app has no console on Windows: what the main process reports goes to <userData>/main.log too.
/** @param {string} message */
function log(message) {
  console.log(message);
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.appendFileSync(path.join(userData, 'main.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

if (app.isPackaged) process.env.AIA_DOCUMENTS ||= path.join(userData, 'documents');
const documents = resolveDocumentsFolder();

// The editor keeps per-site things (open tabs, folded panels) in localStorage, so the address must not change from
// one launch to the next: the port that worked last time is tried first.
const settingsFile = path.join(userData, 'settings.json');
const DEFAULT_PORT = 47613;

/** @returns {{ port?: number }} */
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

async function start() {
  const settings = readSettings();
  let server;
  try {
    server = await startServer({ documents, port: settings.port ?? DEFAULT_PORT });
  } catch {
    server = await startServer({ documents, port: 0 });
  }
  if (server.port !== settings.port) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, port: server.port }, null, 2));
  }
  log(`Editor at ${server.url}, documents in ${documents}`);
  return server;
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
  // Links to other places open outside, in the browser; the window itself only ever shows the editor.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
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
/** @type {BrowserWindow | undefined} */
let window;
app.whenReady().then(() => {
  window = createWindow(server.url);
});

app.on('second-instance', () => {
  if (!window || window.isDestroyed()) window = createWindow(server.url);
  if (window.isMinimized()) window.restore();
  window.focus();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) window = createWindow(server.url);
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
app.on('will-quit', () => server.close());
