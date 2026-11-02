// API local del editor (origen "user") y aviso en vivo cuando un documento cambia en disco, por ejemplo porque lo
// editó la IA por MCP.

import path from 'node:path';
import { CARPETA_PERSONAJES, crearAlmacen } from './almacen.js';
import { cargarEsquema } from './esquema.js';

const ORIGEN = 'user';

function responder(res, estado, datos) {
  res.statusCode = estado;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(datos));
}

async function leerCuerpo(req) {
  let texto = '';
  for await (const trozo of req) texto += trozo;
  return JSON.parse(texto || '{}');
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
          if (resto.length) return responder(res, 404, { error: 'Ruta desconocida' });

          if (!id && metodo === 'GET') return responder(res, 200, await almacen.listar());
          if (!id && metodo === 'POST') {
            const { id: nuevo, meta } = await leerCuerpo(req);
            return responder(res, 200, await almacen.crear(nuevo, meta ?? {}, { origen: ORIGEN }));
          }
          if (id && !accion && metodo === 'GET') return responder(res, 200, await almacen.leer(id));
          if (accion === 'historial' && metodo === 'GET') return responder(res, 200, await almacen.historial(id));
          if (accion === 'ops' && metodo === 'POST') {
            const { ops, nota } = await leerCuerpo(req);
            return responder(res, 200, await almacen.operar(id, ops, { origen: ORIGEN, nota }));
          }
          if (accion === 'deshacer' && metodo === 'POST') return responder(res, 200, { doc: await almacen.deshacer(id, ORIGEN) });
          if (accion === 'rehacer' && metodo === 'POST') return responder(res, 200, { doc: await almacen.rehacer(id, ORIGEN) });
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
    },
  };
}
