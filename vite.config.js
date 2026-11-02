import { defineConfig } from 'vite';
import { aiaPersonajes } from './servidor/plugin-vite.js';

export default defineConfig({
  plugins: [aiaPersonajes()],
  server: {
    // Los temporales y el historial cambian en cada guardado; no hace falta recargar por ellos.
    watch: { ignored: ['**/referencias/**', '**/*.tmp', '**/*.jsonl'] },
  },
});
