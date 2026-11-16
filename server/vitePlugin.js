// In development (`npm run dev`) Vite applies the same guard and mounts the same local API as the desktop app's
// server (server/guard.js, server/api.js), so the editor talks to both in the same way.

import fs from 'node:fs';
import { createApi, respond } from './api.js';
import { refusal } from './guard.js';
import { resolveDocumentsFolder } from './folder.js';

/** @returns {import('vite').Plugin} */
export function aiaServer() {
  return {
    name: 'aia-server',
    configureServer(server) {
      const documents = resolveDocumentsFolder();
      fs.mkdirSync(documents, { recursive: true });
      const api = createApi({ documents });
      server.middlewares.use((req, res, next) => {
        const refused = refusal(req);
        if (refused) return respond(res, 403, { error: refused });
        if (!api(req, res)) next();
      });
    },
  };
}
