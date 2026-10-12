import { defineConfig } from 'vitest/config';

// Real route injection with inert dependencies; no database or Redis access.
export default defineConfig({
  test: {
    include: ['src/__tests__/ads-launch-switch.test.ts'],
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
});
