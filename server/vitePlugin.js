// In development (`npm run dev`) Vite applies the same guard and mounts the same local API as the desktop app's
// server (server/guard.js, server/api.js), so the editor talks to both in the same way.

import fs from 'node:fs';
import { createApi, respond } from './api.js';
import { createEvents } from './events.js';
import { refusal } from './guard.js';
import { resolveDocumentsFolder } from './folder.js';
import { loadSchema } from './schema.js';
import { createStore } from './store.js';

/** @returns {import('vite').Plugin} */
export function aiaServer() {
  return {
    name: 'aia-server',
    configureServer(server) {
      const documents = resolveDocumentsFolder();
      fs.mkdirSync(documents, { recursive: true });
      const events = createEvents(documents);
      server.httpServer?.on('close', () => events.close());
      const api = createApi({ store: createStore({ folder: documents, schema: loadSchema() }), events });
      // The API validates with the schema it loaded on start, so a change to schema/*.json restarts the server.
      server.watcher.on('change', (file) => {
        if (/[\\/]schema[\\/][^\\/]+\.json$/.test(file)) server.restart();
      });
      server.middlewares.use(async (req, res, next) => {
        const refused = refusal(req);
        if (refused) return respond(res, 403, { error: refused });
        if (!(await api(req, res))) next();
      });
    },
  };
}
