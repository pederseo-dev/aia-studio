import { defineConfig } from 'vite';
import { aiaDocuments } from './server/vitePlugin.js';

export default defineConfig({
  plugins: [aiaDocuments()],
  server: {
    watch: { ignored: ['**/referencias/**', '**/*.tmp'] },
  },
});
