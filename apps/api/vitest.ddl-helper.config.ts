import { defineConfig } from 'vitest/config';

/** Service-free coverage for the DDL installer connection/retry contract. */
export default defineConfig({
  test: {
    root: '.',
    include: ['src/__tests__/install-ddl.unit.test.ts'],
    testTimeout: 10_000,
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
});
