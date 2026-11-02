// API local del editor y aviso en vivo cuando un personaje cambia en disco (por ejemplo, porque lo editó la IA).

import path from 'node:path';
import { CARPETA, historial, leer, listar, modificar } from './almacen.js';

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

export function aiaPersonajes() {
  return {
    name: 'aia-personajes',
    configureServer(server) {
      server.middlewares.use('/api/personajes', async (req, res) => {
        try {
          const partes = req.url.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
          if (req.method === 'GET' && partes.length === 0) return responder(res, 200, await listar());
          if (req.method === 'GET' && partes.length === 1) return responder(res, 200, await leer(partes[0]));
          if (req.method === 'GET' && partes[1] === 'historial') return responder(res, 200, await historial(partes[0]));
          if (req.method === 'POST' && partes.length === 1) {
            const { ops, nota } = await leerCuerpo(req);
            return responder(res, 200, await modificar(partes[0], ops, { origen: 'user', nota }));
          }
          responder(res, 404, { error: 'Ruta desconocida' });
        } catch (e) {
          responder(res, 400, { error: e.message });
        }
      });

      server.watcher.add(CARPETA);
      const avisar = (archivo) => {
        if (path.resolve(path.dirname(archivo)) !== path.resolve(CARPETA) || !archivo.endsWith('.json')) return;
        server.ws.send({ type: 'custom', event: 'aia:personaje', data: { id: path.basename(archivo, '.json') } });
      };
      server.watcher.on('change', avisar);
      server.watcher.on('add', avisar);
    },
  };
}
