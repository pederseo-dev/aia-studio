import { defineConfig } from 'vite';
import { aiaDocuments } from './server/vitePlugin.js';

export default defineConfig({
  plugins: [aiaDocuments()],
  server: {
    // Documents are watched by server/events.js (live notices over SSE); Vite has nothing to do with them.
    watch: { ignored: ['**/referencias/**', '**/documents/**', '**/release/**'] },
  },
});
