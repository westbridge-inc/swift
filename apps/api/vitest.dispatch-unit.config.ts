import { defineConfig } from 'vitest/config';

/** Deterministic dispatch control-flow tests. No service setup or connections. */
export default defineConfig({
  test: {
    include: ['src/__tests__/dispatch-lifecycle.unit.test.ts'],
    testTimeout: 5000,
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
});
