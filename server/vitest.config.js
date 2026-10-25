import { defineConfig } from 'vitest/config';

// API tests run against a separate Postgres schema (hcm_test) that is dropped and recreated on every run,
// so they never touch the real data. The AI key is blanked so tests are deterministic and offline.
export default defineConfig({
  test: {
    env: { DB_SCHEMA: 'hcm_test', AI_API_KEY: '', NODE_ENV: 'test' },
    fileParallelism: false,
    exclude: ['**/node_modules/**', 'tests/tester/**'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
