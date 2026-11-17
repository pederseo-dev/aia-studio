// The editor's local API, as a plain Node (req, res) handler. The Vite plugin mounts it in development and
// server/app.js in the desktop app, so both serve exactly the same routes. Everything done here has the origin "user".
//   GET    /api/status                      which app this is and where its documents live
//   GET    /api/documents                   the documents: [{ id, name }]
//   POST   /api/documents                   { name, width?, height?, background? } → a new document
//   GET    /api/documents/<id>              { document, canUndo, canRedo }
//   DELETE /api/documents/<id>
//   POST   /api/documents/<id>/ops          { ops, note? } → applies a batch
//   POST   /api/documents/<id>/undo | redo   undo takes { skip: true } to drop a step that cannot be undone
//   GET    /api/events                      live notices of changes on disk (Server-Sent Events, see events.js)

import { readFileSync } from 'node:fs';
import { StoreError } from './store.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ORIGIN = 'user';
const BODY_MAX = 4 * 1024 * 1024;

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

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  let text = '';
  for await (const piece of req) {
    text += piece;
    if (text.length > BODY_MAX) throw new StoreError('The request is too big', 413);
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new StoreError('The request body is not valid JSON', 400);
  }
}

/**
 * @param {{ store: ReturnType<typeof import('./store.js').createStore>, events?: ReturnType<typeof import('./events.js').createEvents> }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 *   true when the request was an API route and has been answered
 */
export function createApi({ store, events }) {
  /** @param {import('node:http').IncomingMessage} req @param {string[]} parts */
  async function route(req, parts) {
    const method = req.method;
    if (parts[0] === 'status' && parts.length === 1 && method === 'GET') {
      return { app: 'aia-studio', version, documents: store.folder };
    }
    if (parts[0] !== 'documents') return null;
    const [, id, action] = parts;
    if (!id) {
      if (method === 'GET') return store.list();
      if (method === 'POST') return store.create(await readBody(req));
      return null;
    }
    if (!action) {
      if (method === 'GET') return store.get(id, ORIGIN);
      if (method === 'DELETE') return store.remove(id).then(() => ({ deleted: id }));
      return null;
    }
    if (method !== 'POST' || parts.length !== 3) return null;
    if (action === 'ops') {
      const { ops, note } = await readBody(req);
      return store.apply(id, ops, { origin: ORIGIN, note: typeof note === 'string' ? note : undefined });
    }
    if (action === 'undo') return store.undo(id, ORIGIN, { skip: (await readBody(req)).skip === true });
    if (action === 'redo') return store.redo(id, ORIGIN);
    return null;
  }

  return async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (!pathname.startsWith('/api/')) return false;
    if (pathname === '/api/events' && req.method === 'GET' && events) {
      events.listen(res);
      return true;
    }
    try {
      const parts = pathname.slice('/api/'.length).split('/').filter(Boolean).map(decodeURIComponent);
      const result = await route(req, parts);
      if (result === null) respond(res, 404, { error: 'Not found' });
      else respond(res, 200, result);
    } catch (e) {
      respond(res, e instanceof StoreError ? e.status : 500, { error: e.message });
    }
    return true;
  };
}
