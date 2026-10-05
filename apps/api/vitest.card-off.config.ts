import { defineConfig } from 'vitest/config';

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
    env: { NODE_ENV: 'test', DEV_OTP_BYPASS: '0' },
  },
});
