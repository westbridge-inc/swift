import { defineConfig } from 'vitest/config';

// HTTP injection with in-memory dependencies; no database/Redis test lock.
export default defineConfig({
  test: {
    include: ['src/__tests__/search-guest-auth.test.ts', 'src/__tests__/search-scope.test.ts', 'src/__tests__/search-sync-visibility.test.ts', 'src/__tests__/item-shape-single-source.test.ts'],
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
});
