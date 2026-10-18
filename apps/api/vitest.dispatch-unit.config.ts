import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

/** Deterministic dispatch control-flow tests. No service setup or connections. */
export default defineConfig({
  test: {
    include: ['src/__tests__/dispatch-lifecycle.unit.test.ts'],
    testTimeout: 5000,
    fileParallelism: false,
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test' },
  },
});
