import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

// HTTP injection with in-memory dependencies; no database/Redis test lock.
export default defineConfig({
  test: {
    include: ['src/__tests__/search-review-regressions.test.ts', 'src/__tests__/search-guest-auth.test.ts', 'src/__tests__/search-scope.test.ts', 'src/__tests__/search-sync-visibility.test.ts', 'src/__tests__/item-shape-single-source.test.ts'],
    fileParallelism: false,
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test' },
  },
});
