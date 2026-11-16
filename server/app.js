// The editor without Vite: serves the `vite build` output (dist/) and the local API on 127.0.0.1. The desktop app
// starts it (electron/main.js); `npm start` runs it on its own after `npm run build`.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, respond } from './api.js';
import { refusal } from './guard.js';
import { resolveDocumentsFolder } from './folder.js';

export const DIST_FOLDER = fileURLToPath(new URL('../dist/', import.meta.url));

/** @type {Record<string, string>} */
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
 * @param {import('node:http').ServerResponse} res
 * @param {string} root absolute
 * @param {string} pathname
 */
async function serveFile(res, root, pathname) {
  let relative;
  try {
    relative = path.normalize(decodeURIComponent(pathname)).replace(/^([\\/]|\.\.)+/, '');
  } catch {
    return respond(res, 400, { error: 'Bad path' });
  }
  let file = path.join(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) return respond(res, 404, { error: 'Not found' });
  const stat = await fs.stat(file).catch(() => null);
  // Unknown paths without an extension are the editor itself (for example /?doc=robot).
  if (!stat?.isFile()) {
    if (path.extname(relative)) return respond(res, 404, { error: 'Not found' });
    file = path.join(root, 'index.html');
  }
  const body = await fs.readFile(file).catch(() => null);
  if (!body) return respond(res, 404, { error: 'Not found (run `npm run build` first)' });
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Built files carry a hash in their name; index.html does not, so it is always asked for again.
  res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.end(body);
}

/**
 * @param {{ documents?: string, dist?: string, port?: number }} [options] port 0 = any free port
 * @returns {Promise<{ url: string, port: number, documents: string, close(): Promise<void> }>}
 */
export async function startServer({ documents = resolveDocumentsFolder(), dist = DIST_FOLDER, port = 0 } = {}) {
  const host = '127.0.0.1';
  const root = path.resolve(dist);
  await fs.mkdir(documents, { recursive: true });
  const api = createApi({ documents });
  const server = http.createServer(async (req, res) => {
    const refused = refusal(req);
    if (refused) return respond(res, 403, { error: refused });
    try {
      if (api(req, res)) return;
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
    documents,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// npm start [-- --port 4173] [--documents <folder>]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const { url, documents } = await startServer({ port: i >= 0 ? Number(process.argv[i + 1]) : 4173 });
  console.log(`aia-studio: ${url} (documents in ${documents})`);
}
