import { defineConfig } from 'vitest/config';

/** Service-free payment-provider contract tests. The default API Vitest
 * configuration intentionally requires isolated PostgreSQL and Redis; this
 * suite exercises only fetch-injected adapters and must never open services. */
export default defineConfig({
  test: {
    root: '.',
    include: ['src/__tests__/payment-provider.test.ts'],
    testTimeout: 10_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DEV_OTP_BYPASS: '0',
    },
  },
});
