import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// [D-12 / D-17] The desktop ops app had NO test script at all, which is why two
// S0 clauses against it could not be proven or fixed: a console that can
// requeue a dead job and close a child-safety report was the only surface in
// this repository with nothing grading it. Same shape as apps/admin's config,
// so the two operator consoles are tested the same way rather than two ways.
export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    preserveSymlinks: true,
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
