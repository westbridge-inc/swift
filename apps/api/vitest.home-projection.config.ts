import { defineConfig } from 'vitest/config';

// Explicit service-free allowlist. Do not inherit the API DB/Redis lock setup.
export default defineConfig({
  test: {
    include: [
      // Profile guard is a .spec.ts so the default API *.test.ts glob excludes it.
      'src/__tests__/home-service-free.spec.ts',
      'src/__tests__/home-order-projection.unit.test.ts',
      'src/__tests__/order-status-single-source.test.ts',
      'src/__tests__/terminal-status-single-source.test.ts',
      'src/__tests__/order-custody-single-source.test.ts',
      'src/__tests__/order-recovery-transitions.test.ts',
      'src/__tests__/tenant-cache-isolation.test.ts',
      'src/__tests__/search-sync-visibility.test.ts',
      'src/__tests__/delivery-fee-engine.test.ts',
      'src/__tests__/kerb-anti-fork.test.ts',
      'src/__tests__/no-customer-funds-ingress.test.ts',
      'src/__tests__/minimisation-allowlist.test.ts',
      'src/__tests__/verification-object-containment.unit.test.ts',
    ],
    setupFiles: ['src/__tests__/helpers/home-service-free.setup.ts'],
    fileParallelism: false,
    maxWorkers: 3,
    env: { NODE_ENV: 'test' },
  },
});
