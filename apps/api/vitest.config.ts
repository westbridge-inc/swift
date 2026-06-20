import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // All test files share ONE Postgres DB, so run files sequentially: parallel
    // files race on create/delete of shared fixtures (phones, carts→vendors→users)
    // and flake intermittently. Sequential is deterministic (~22s for the suite).
    fileParallelism: false,
  },
});
