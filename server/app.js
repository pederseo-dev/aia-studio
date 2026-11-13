// The editor without Vite: serves the `vite build` output (dist/) and the local API on 127.0.0.1. The desktop app
// starts it (electron/main.js); `node server/app.js` runs it on its own after `npm run build`.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, respond } from './api.js';
import { liveNotices } from './events.js';
import { createStore } from './store.js';
import { loadSchema } from './schema.js';
import { resolveDocumentsFolder } from './folder.js';

export const DIST_FOLDER = fileURLToPath(new URL('../dist/', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Whether the Host header names this machine. A web page that points its own domain at 127.0.0.1 (DNS rebinding)
 * sends its domain as Host, so it is refused.
 * @param {string | undefined} host
 */
export function isLocalHost(host) {
  const name = (host ?? '').replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

async function serveFile(res, root, pathname) {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^([\\/]|\.\.)+/, '');
  let file = path.join(root, relative);
  if (!file.startsWith(root)) return respond(res, 404, { error: 'Not found' });
  const stat = await fs.stat(file).catch(() => null);
  // Unknown paths without an extension are the editor itself (for example /?doc=robot).
  if (!stat?.isFile()) {
    if (path.extname(relative)) return respond(res, 404, { error: 'Not found' });
    file = path.join(root, 'index.html');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Built files carry a hash in their name; index.html does not, so it is always asked for again.
  res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.end(await fs.readFile(file));
}

/**
 * @param {{
 *   folder?: string, dist?: string, port?: number, host?: string,
 *   ai?: Parameters<typeof createApi>[0]['ai'],
 * }} [options] port 0 = any free port
 * @returns {Promise<{ url: string, port: number, folder: string, close(): Promise<void> }>}
 */
export async function startServer({ folder = resolveDocumentsFolder(), dist = DIST_FOLDER, port = 0, host = '127.0.0.1', ai } = {}) {
  const root = path.resolve(dist);
  const store = createStore({ schema: loadSchema(), folder });
  const live = liveNotices(folder);
  const api = createApi({ store, events: live, ai });
  const server = http.createServer(async (req, res) => {
    if (!isLocalHost(req.headers.host)) return respond(res, 403, { error: 'Only local requests are allowed' });
    try {
      if (await api(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, { error: 'Method not allowed' });
      await serveFile(res, root, (req.url ?? '/').split('?')[0]);
    } catch (e) {
      if (!res.headersSent) respond(res, 500, { error: e.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://${host}:${actual}/`,
    port: actual,
    folder,
    close: () =>
      new Promise((resolve) => {
        live.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// node server/app.js [--port 4000] [--documents <folder>]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const { url, folder } = await startServer({ port: i >= 0 ? Number(process.argv[i + 1]) : 4173 });
  console.log(`aia-studio: ${url} (documents in ${folder})`);
}
