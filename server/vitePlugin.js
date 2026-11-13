// In development (`npm run dev`) Vite mounts the same local API and live notices as the desktop app's server
// (server/api.js, server/events.js), so the editor talks to both in the same way.

import { createApi } from './api.js';
import { liveNotices } from './events.js';
import { DOCUMENTS_FOLDER, createStore } from './store.js';
import { loadSchema } from './schema.js';

export function aiaDocuments() {
  return {
    name: 'aia-documents',
    /** @param {import('vite').ViteDevServer} server */
    configureServer(server) {
      const store = createStore({ schema: loadSchema() });
      const live = liveNotices(DOCUMENTS_FOLDER);
      const api = createApi({ store, events: live });
      server.middlewares.use(async (req, res, next) => {
        if (!(await api(req, res))) next();
      });
      server.httpServer?.once('close', () => live.close());
    },
  };
}
