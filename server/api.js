// The editor's local API, as a plain Node (req, res) handler. The Vite plugin mounts it in development and
// server/app.js in the desktop app, so both serve exactly the same routes. For now there is only:
//   GET /api/status   which app this is and where its documents live

import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} data
 */
export function respond(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

/**
 * @param {{ documents: string }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 *   true when the request was an API route and has been answered
 */
export function createApi({ documents }) {
  return (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (!pathname.startsWith('/api/')) return false;
    if (pathname === '/api/status' && req.method === 'GET') respond(res, 200, { app: 'aia-studio', version, documents });
    else respond(res, 404, { error: 'Not found' });
    return true;
  };
}
