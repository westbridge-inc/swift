import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

// Real route injection with inert dependencies; no database or Redis access.
export default defineConfig({
  test: {
    include: ['src/__tests__/ads-launch-switch.test.ts'],
    fileParallelism: false,
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test' },
  },
});
