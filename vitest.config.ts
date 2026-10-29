import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The WhatsApp relay (relay/worker.js) runs on Cloudflare; tests use a small stand-in.
  resolve: { alias: { 'cloudflare:workers': new URL('./tests/stubs/cloudflare-workers.ts', import.meta.url).pathname } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
