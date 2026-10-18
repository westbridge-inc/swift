import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

/** Service-free coverage for the DDL installer connection/retry contract. */
export default defineConfig({
  test: {
    root: '.',
    include: ['src/__tests__/install-ddl.unit.test.ts'],
    testTimeout: 10_000,
    fileParallelism: false,
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test' },
  },
});
