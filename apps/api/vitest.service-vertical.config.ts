import { defineConfig } from 'vitest/config';

/**
 * Service-free coverage for the service-vertical separation (a SERVICE
 * business's appointment presented as a FOOD order). The default API Vitest
 * configuration intentionally requires isolated PostgreSQL and Redis; these
 * suites drive the real customer/vendor route handlers, the hold-release tick,
 * the dispatch worker and the cancellation policy against in-memory doubles
 * that project by the exact `select` and grade the exact `where`, and must
 * never open a service.
 *
 * `cache: false` keeps the run from writing a results cache into the
 * dependency tree (which may be a read-only shared install).
 */
export default defineConfig({
  test: {
    root: '.',
    include: [
      'src/__tests__/service-vertical.unit.test.ts',
      'src/__tests__/service-cancel-policy.unit.test.ts',
      'src/__tests__/service-vertical-projection.unit.test.ts',
      'src/__tests__/service-appointment-provider.unit.test.ts',
      'src/__tests__/service-vertical-contract.test.ts',
      'src/__tests__/service-vertical-r2.unit.test.ts',
      'src/__tests__/service-slot-wire-composition.unit.test.ts',
    ],
    testTimeout: 10_000,
    fileParallelism: false,
    cache: false,
    env: {
      NODE_ENV: 'test',
      DEV_OTP_BYPASS: '0',
      KYC_PROVIDER: 'sandbox',
    },
  },
});
