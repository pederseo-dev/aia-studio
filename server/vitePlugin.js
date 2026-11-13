// API local del editor (origen "user") y aviso en vivo cuando un documento cambia en disco, por ejemplo porque lo
// editó la IA por MCP.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { CARPETA_PERSONAJES, crearAlmacen } from './store.js';
import { cargarEsquema } from './schema.js';
import { MAXIMO_DE_IMAGEN } from '../src/core/images.js';

const ORIGEN = 'user';

function responder(res, estado, datos) {
  res.statusCode = estado;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(datos));
}

async function leerBytes(req) {
  const trozos = [];
  let total = 0;
  for await (const trozo of req) {
    total += trozo.length;
    if (total > MAXIMO_DE_IMAGEN) throw new Error(`The image is too big (at most ${MAXIMO_DE_IMAGEN / 1048576} MB)`);
    trozos.push(trozo);
  }
  return new Uint8Array(Buffer.concat(trozos));
}

async function leerCuerpo(req) {
  let texto = '';
  for await (const trozo of req) texto += trozo;
  return JSON.parse(texto || '{}');
}

function servirAsset(res, { bytes, mime }) {
  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  // Un SVG abierto suelto no puede correr scripts ni cargar nada de afuera (dentro de <image> ya no puede).
  if (mime === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.end(bytes);
}

export function aiaDocumentos() {
  return {
    name: 'aia-documentos',
    configureServer(server) {
      const almacen = crearAlmacen({ esquema: cargarEsquema() });

      server.middlewares.use('/api/documentos', async (req, res) => {
        try {
          const [id, accion, ...resto] = req.url.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
          const metodo = req.method;
          // Imágenes: GET /api/documentos/<id>/assets/<archivo> lo sirve; POST /api/documentos/<id>/assets?name=<original>
          // con los bytes en el cuerpo lo guarda y devuelve { src, ancho, alto, formato, reusado }.
          if (accion === 'assets' && metodo === 'GET' && resto.length === 1) return servirAsset(res, await almacen.leerAsset(id, resto[0]));
          if (accion === 'assets' && metodo === 'POST' && !resto.length) {
            const original = new URL(req.url, 'http://x').searchParams.get('name') ?? 'image';
            return responder(res, 200, await almacen.guardarAsset(id, original, await leerBytes(req)));
          }
          if (resto.length) return responder(res, 404, { error: 'Ruta desconocida' });

          if (!id && metodo === 'GET') return responder(res, 200, await almacen.listar());
          if (!id && metodo === 'POST') {
            const { id: nuevo, meta, copiarDe } = await leerCuerpo(req);
            return responder(res, 200, await almacen.crear(nuevo, meta ?? {}, { origen: ORIGEN, copiarDe }));
          }
          if (id && !accion && metodo === 'GET') return responder(res, 200, await almacen.leer(id));
          if (id && !accion && metodo === 'DELETE') return responder(res, 200, await almacen.eliminar(id) ?? { ok: true });
          if (accion === 'historial' && metodo === 'GET') return responder(res, 200, await almacen.historial(id));
          if (accion === 'ops' && metodo === 'POST') {
            const { ops, nota } = await leerCuerpo(req);
            return responder(res, 200, await almacen.operar(id, ops, { origen: ORIGEN, nota }));
          }
          if (accion === 'deshacer' && metodo === 'POST') return responder(res, 200, await almacen.deshacer(id, ORIGEN));
          if (accion === 'rehacer' && metodo === 'POST') return responder(res, 200, await almacen.rehacer(id, ORIGEN));
          responder(res, 404, { error: 'Ruta desconocida' });
        } catch (e) {
          responder(res, 400, { error: e.message });
        }
      });

      server.watcher.add(CARPETA_PERSONAJES);
      // El historial se escribe después del documento, así que también se avisa por separado.
      const EVENTOS = { 'documento.json': 'aia:documento', 'historial.jsonl': 'aia:historial' };
      const avisar = (archivo) => {
        const evento = EVENTOS[path.basename(archivo)];
        if (evento) server.ws.send({ type: 'custom', event: evento, data: { id: path.basename(path.dirname(archivo)) } });
      };
      server.watcher.on('change', avisar);
      server.watcher.on('add', avisar);
      // Un documento borrado (por ejemplo, con delete_document desde el MCP): el editor cierra su pestaña. Escribir
      // usa un temporal y rename, así que un unlink de documento.json se confirma un momento después.
      const raiz = path.resolve(CARPETA_PERSONAJES);
      const borrado = (id) => server.ws.send({ type: 'custom', event: 'aia:borrado', data: { id } });
      server.watcher.on('unlinkDir', (carpeta) => path.dirname(path.resolve(carpeta)) === raiz && borrado(path.basename(carpeta)));
      server.watcher.on('unlink', (archivo) => {
        if (path.basename(archivo) !== 'documento.json' || path.dirname(path.dirname(path.resolve(archivo))) !== raiz) return;
        setTimeout(() => !existsSync(archivo) && borrado(path.basename(path.dirname(archivo))), 200);
      });
    },
  };
}
