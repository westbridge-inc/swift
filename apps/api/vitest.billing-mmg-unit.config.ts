import { defineConfig } from 'vitest/config';

// This regression suite is intentionally service-free: it exercises the real
// BillingService source against an in-memory transaction harness and sandbox
// provider method spies. Do not inherit the database suite's global setup.
export default defineConfig({
  test: {
    include: [
      'src/__tests__/billing-mmg-immediate-authority.test.ts',
      'src/__tests__/boot-config.test.ts',
      'src/__tests__/mmg-provider.test.ts',
      'src/__tests__/partner-wind-down-lock-order.unit.test.ts',
      'src/__tests__/no-customer-funds-ingress.test.ts',
      'src/__tests__/queue-lifecycle.test.ts',
    ],
    fileParallelism: false,
    env: { NODE_ENV: 'test', MMG_DRIVER: 'sandbox' },
  },
});
