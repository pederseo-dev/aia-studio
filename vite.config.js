import { defineConfig } from 'vite';
import { aiaDocumentos } from './servidor/plugin-vite.js';

export default defineConfig({
  plugins: [aiaDocumentos()],
  server: {
    watch: { ignored: ['**/referencias/**', '**/*.tmp'] },
  },
});
