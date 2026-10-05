import { defineConfig } from 'vitest/config';

/** Manual-only admission uses synthetic inputs; no database or provider calls. */
export default defineConfig({
  test: {
    include: ['src/__tests__/kyc-launch-policy.test.ts', 'src/__tests__/boot-config.test.ts'],
    fileParallelism: false,
    env: { NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
