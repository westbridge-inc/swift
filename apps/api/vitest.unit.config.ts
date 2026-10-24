import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

export default defineConfig({
  test: {
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: sideConfigTestEnv(),
    root: '.',
    include: ['src/**/*.unit.test.ts'],
    fileParallelism: false,
  },
});
