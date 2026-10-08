import { defineConfig } from 'vitest/config';

/** Real routes and authority over synthetic persistence; no connected services. */
export default defineConfig({
  test: {
    include: ['src/__tests__/chat-content-controls.unit.test.ts', 'src/__tests__/chat-content-filter.unit.test.ts'],
    fileParallelism: false,
    env: { NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
