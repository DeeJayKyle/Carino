import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The phone app: the web app plus Carino's server running inside it (mobile/engine.ts).
// Node-only modules the server imports are swapped for browser versions in mobile/shims.
const shim = (f: string) => fileURLToPath(new URL(`./mobile/shims/${f}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_MOBILE': JSON.stringify('1'),
  },
  resolve: {
    alias: [
      { find: /^node:sqlite$/, replacement: shim('sqlite.ts') },
      { find: /^node:fs$/, replacement: shim('fs.ts') },
      { find: /^node:crypto$/, replacement: shim('crypto.ts') },
      { find: /^node:path$/, replacement: 'path-browserify' },
      { find: /^node:url$/, replacement: shim('url.ts') },
      { find: /^node:util$/, replacement: shim('util.ts') },
      { find: /^node:net$/, replacement: shim('net.ts') },
      { find: /^node:dns\/promises$/, replacement: shim('dns.ts') },
      { find: /^@hono\/node-server(\/serve-static)?$/, replacement: shim('node-server.ts') },
      { find: /^web-push$/, replacement: shim('web-push.ts') },
    ],
  },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: { outDir: 'android/app/src/main/assets/www', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000, target: 'es2022' },
});
