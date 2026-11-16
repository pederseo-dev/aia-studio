import { defineConfig } from 'vite';
import { aiaServer } from './server/vitePlugin.js';

export default defineConfig({
  plugins: [aiaServer()],
  server: {
    // Only this machine (see SECURITY.md).
    host: 'localhost',
    watch: { ignored: ['**/documents/**', '**/release/**'] },
  },
});
