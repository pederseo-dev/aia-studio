// Local editor API (origin "user") and live notice when a document changes on disk, for example because the AI
// edited it over MCP.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { DOCUMENTS_FOLDER, createStore } from './store.js';
import { loadSchema } from './schema.js';
import { IMAGE_MAX } from '../src/core/images.js';

const ORIGIN = 'user';

function respond(res, state, data) {
  res.statusCode = state;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
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

async function readBody(req) {
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

export function aiaDocuments() {
  return {
    name: 'aia-documentos',
    configureServer(server) {
      const store = createStore({ schema: loadSchema() });

      server.middlewares.use('/api/documents', async (req, res) => {
        try {
          const [id, action, ...rest] = req.url.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
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
          if (id && !action && method === 'DELETE') return respond(res, 200, await store.delete(id) ?? { ok: true });
          if (action === 'history' && method === 'GET') return respond(res, 200, await store.history(id));
          if (action === 'ops' && method === 'POST') {
            const { ops, note } = await readBody(req);
            return respond(res, 200, await store.applyOps(id, ops, { origin: ORIGIN, note }));
          }
          if (action === 'undo' && method === 'POST') return respond(res, 200, await store.undo(id, ORIGIN));
          if (action === 'redo' && method === 'POST') return respond(res, 200, await store.redo(id, ORIGIN));
          respond(res, 404, { error: 'Unknown route' });
        } catch (e) {
          respond(res, 400, { error: e.message });
        }
      });

      server.watcher.add(DOCUMENTS_FOLDER);
      // The history is written after the document, so it is also notified separately.
      const EVENTS = { 'document.json': 'aia:document', 'history.jsonl': 'aia:history' };
      const notify = (file) => {
        const event = EVENTS[path.basename(file)];
        if (event) server.ws.send({ type: 'custom', event: event, data: { id: path.basename(path.dirname(file)) } });
      };
      server.watcher.on('change', notify);
      server.watcher.on('add', notify);
      // A deleted document (for example, with delete_document from the MCP): the editor closes its tab. Writing
      // uses a temp file and rename, so an unlink of document.json is confirmed a moment later.
      const root = path.resolve(DOCUMENTS_FOLDER);
      const deleted = (id) => server.ws.send({ type: 'custom', event: 'aia:deleted', data: { id } });
      server.watcher.on('unlinkDir', (folder) => path.dirname(path.resolve(folder)) === root && deleted(path.basename(folder)));
      server.watcher.on('unlink', (file) => {
        if (path.basename(file) !== 'document.json' || path.dirname(path.dirname(path.resolve(file))) !== root) return;
        setTimeout(() => !existsSync(file) && deleted(path.basename(path.dirname(file))), 200);
      });
    },
  };
}
