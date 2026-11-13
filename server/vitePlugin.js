// API local del editor (origen "user") y aviso en vivo cuando un documento cambia en disco, por ejemplo porque lo
// editó la IA por MCP.

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
  // Un SVG abierto suelto no puede correr scripts ni cargar nada de afuera (dentro de <image> ya no puede).
  if (mime === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.end(bytes);
}

export function aiaDocuments() {
  return {
    name: 'aia-documentos',
    configureServer(server) {
      const store = createStore({ schema: loadSchema() });

      server.middlewares.use('/api/documentos', async (req, res) => {
        try {
          const [id, action, ...rest] = req.url.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
          const method = req.method;
          // Imágenes: GET /api/documentos/<id>/assets/<archivo> lo sirve; POST /api/documentos/<id>/assets?name=<original>
          // con los bytes en el cuerpo lo guarda y devuelve { src, ancho, alto, formato, reusado }.
          if (action === 'assets' && method === 'GET' && rest.length === 1) return serveAsset(res, await store.readAsset(id, rest[0]));
          if (action === 'assets' && method === 'POST' && !rest.length) {
            const original = new URL(req.url, 'http://x').searchParams.get('name') ?? 'image';
            return respond(res, 200, await store.saveAsset(id, original, await readBytes(req)));
          }
          if (rest.length) return respond(res, 404, { error: 'Ruta desconocida' });

          if (!id && method === 'GET') return respond(res, 200, await store.list());
          if (!id && method === 'POST') {
            const { id: created, meta, copyFrom } = await readBody(req);
            return respond(res, 200, await store.crear(created, meta ?? {}, { origen: ORIGIN, copyFrom }));
          }
          if (id && !action && method === 'GET') return respond(res, 200, await store.read(id));
          if (id && !action && method === 'DELETE') return respond(res, 200, await store.eliminar(id) ?? { ok: true });
          if (action === 'historial' && method === 'GET') return respond(res, 200, await store.history(id));
          if (action === 'ops' && method === 'POST') {
            const { ops, nota } = await readBody(req);
            return respond(res, 200, await store.applyOps(id, ops, { origen: ORIGIN, nota }));
          }
          if (action === 'deshacer' && method === 'POST') return respond(res, 200, await store.deshacer(id, ORIGIN));
          if (action === 'rehacer' && method === 'POST') return respond(res, 200, await store.rehacer(id, ORIGIN));
          respond(res, 404, { error: 'Ruta desconocida' });
        } catch (e) {
          respond(res, 400, { error: e.message });
        }
      });

      server.watcher.add(DOCUMENTS_FOLDER);
      // El historial se escribe después del documento, así que también se avisa por separado.
      const EVENTS = { 'documento.json': 'aia:documento', 'historial.jsonl': 'aia:historial' };
      const notify = (file) => {
        const event = EVENTS[path.basename(file)];
        if (event) server.ws.send({ type: 'custom', event: event, data: { id: path.basename(path.dirname(file)) } });
      };
      server.watcher.on('change', notify);
      server.watcher.on('add', notify);
      // Un documento borrado (por ejemplo, con delete_document desde el MCP): el editor cierra su pestaña. Escribir
      // usa un temporal y rename, así que un unlink de documento.json se confirma un momento después.
      const root = path.resolve(DOCUMENTS_FOLDER);
      const deleted = (id) => server.ws.send({ type: 'custom', event: 'aia:borrado', data: { id } });
      server.watcher.on('unlinkDir', (folder) => path.dirname(path.resolve(folder)) === root && deleted(path.basename(folder)));
      server.watcher.on('unlink', (file) => {
        if (path.basename(file) !== 'documento.json' || path.dirname(path.dirname(path.resolve(file))) !== root) return;
        setTimeout(() => !existsSync(file) && deleted(path.basename(path.dirname(file))), 200);
      });
    },
  };
}
