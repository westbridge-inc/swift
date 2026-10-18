import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

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
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test' },
  },
});
