// The editor's local API (origin "user"), as a plain Node (req, res) handler. The Vite plugin mounts it in
// development and server/app.js in the desktop app, so both serve exactly the same routes:
//   /api/documents/...   documents, history, undo/redo and image assets
//   /api/events          live notices over Server-Sent Events (see server/events.js)
//   /api/ai/...          "Connect your AI" (see server/aiRoutes.js), when the host passes `ai`

import { IMAGE_MAX } from '../src/core/images.js';

const ORIGIN = 'user';

export function respond(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

async function readBytes(req) {
  const pieces = [];
  let total = 0;
  for await (const piece of req) {
    total += piece.length;
    if (total > IMAGE_MAX) throw new Error(`The image is too big (at most ${IMAGE_MAX / 1048576} MB)`);
    pieces.push(piece);
  }
  return new Uint8Array(Buffer.concat(pieces));
}

export async function readBody(req) {
  let text = '';
  for await (const piece of req) text += piece;
  return JSON.parse(text || '{}');
}

function serveAsset(res, { bytes, mime }) {
  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  // An SVG opened on its own cannot run scripts or load anything from outside (inside <image> it already can't).
  if (mime === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.end(bytes);
}

/**
 * Whether a request comes from a page of another site. Browsers send `Origin` on cross-site requests (and on every
 * POST/DELETE), so a page on the internet cannot change documents through the user's browser: only pages served by
 * this same server (same host and port) or tools without a browser (no Origin) get through.
 * @param {import('node:http').IncomingMessage} req
 */
export function isCrossSite(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'cross-site';
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   events?: { connect(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void },
 *   ai?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, route: string[]) => Promise<boolean>,
 * }} context
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 *   resolves to false when the URL is not an API route (the caller serves it some other way)
 */
export function createApi({ store, events, ai }) {
  async function documents(req, res, route) {
    const [id, action, ...rest] = route;
    const method = req.method;
    // Images: GET /api/documents/<id>/assets/<file> serves it; POST /api/documents/<id>/assets?name=<original>
    // with the bytes in the body saves it and returns { src, naturalWidth, naturalHeight, format, reused }.
    if (action === 'assets' && method === 'GET' && rest.length === 1) return serveAsset(res, await store.readAsset(id, rest[0]));
    if (action === 'assets' && method === 'POST' && !rest.length) {
      const original = new URL(req.url, 'http://x').searchParams.get('name') ?? 'image';
      return respond(res, 200, await store.saveAsset(id, original, await readBytes(req)));
    }
    if (rest.length) return respond(res, 404, { error: 'Unknown route' });

    if (!id && method === 'GET') return respond(res, 200, await store.list());
    if (!id && method === 'POST') {
      const { id: created, meta, copyFrom } = await readBody(req);
      return respond(res, 200, await store.create(created, meta ?? {}, { origin: ORIGIN, copyFrom }));
    }
    if (id && !action && method === 'GET') return respond(res, 200, await store.read(id));
    if (id && !action && method === 'DELETE') return respond(res, 200, (await store.delete(id)) ?? { ok: true });
    if (action === 'history' && method === 'GET') return respond(res, 200, await store.history(id));
    if (action === 'ops' && method === 'POST') {
      const { ops, note } = await readBody(req);
      return respond(res, 200, await store.applyOps(id, ops, { origin: ORIGIN, note }));
    }
    if (action === 'undo' && method === 'POST') return respond(res, 200, await store.undo(id, ORIGIN));
    if (action === 'redo' && method === 'POST') return respond(res, 200, await store.redo(id, ORIGIN));
    respond(res, 404, { error: 'Unknown route' });
  }

  return async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return false;
    if (isCrossSite(req)) {
      respond(res, 403, { error: 'Requests from other sites are not allowed' });
      return true;
    }
    try {
      const [area, ...route] = pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
      if (area === 'documents') await documents(req, res, route);
      else if (area === 'events' && events && !route.length && req.method === 'GET') events.connect(req, res);
      else if (!(area === 'ai' && ai && (await ai(req, res, route)))) respond(res, 404, { error: 'Unknown route' });
    } catch (e) {
      if (!res.headersSent) respond(res, 400, { error: e.message });
      else res.end();
    }
    return true;
  };
}
