import { defineConfig } from 'vitest/config';
import { sideConfigTestEnv } from './src/lib/test-target-lock';

/** Card availability contracts use synthetic inputs and no DB/Redis services. */
export default defineConfig({
  test: {
    include: [
      'src/__tests__/boot-config.test.ts',
      'src/__tests__/payment-provider.test.ts',
      'src/__tests__/card-rail-disabled.unit.test.ts',
      'src/__tests__/billing-firewall.test.ts',
    ],
    fileParallelism: false,
    // [AUD-G7-040] a disposable DB/Redis target, like vitest.config.ts.
    env: { ...sideConfigTestEnv(), NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
