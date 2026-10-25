import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

/** Real routes and authority over synthetic persistence; no connected services. */
export default defineConfig({
  test: {
    include: ['src/__tests__/chat-content-controls.unit.test.ts', 'src/__tests__/chat-content-filter.unit.test.ts'],
    fileParallelism: false,
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
