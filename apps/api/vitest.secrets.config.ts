import { defineConfig } from 'vitest/config';

/** Service-free contracts for the secret-file loader and the deploy secrets
 * tree. No database, no Redis, and no results cache: a run through a linked
 * node_modules must never write into it. */
export default defineConfig({
  test: {
    root: '.',
    include: [
      'src/__tests__/secret-files.test.ts',
      'src/__tests__/deploy-secrets-contract.test.ts',
      'src/__tests__/secret-canary.test.ts',
    ],
    testTimeout: 20_000,
    fileParallelism: false,
    cache: false,
    env: { NODE_ENV: 'test' },
  },
});
