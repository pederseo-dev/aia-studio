import { defineConfig } from 'vite';
import { aiaDocumentos } from './server/vitePlugin.js';

export default defineConfig({
  plugins: [aiaDocumentos()],
  server: {
    watch: { ignored: ['**/referencias/**', '**/*.tmp'] },
  },
});
