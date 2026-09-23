import { defineConfig } from 'vitest/config';

/** Service-free suite for the direct-MMG claim/disagreement authority. The
 * default API config opens PostgreSQL and Redis through the R048-001 target
 * lock; this suite drives the decision table, the transaction staging and the
 * notice executor through in-memory doubles and must never open either. The
 * real two-session PostgreSQL proof lives in `mmg-claim-races.test.ts`, which
 * runs under the default config. */
export default defineConfig({
  test: {
    root: '.',
    include: [
      'src/__tests__/mmg-claim-state.unit.test.ts',
      'src/__tests__/mmg-claim-picking-fence.unit.test.ts',
      'src/__tests__/mmg-claim-notice-retry.unit.test.ts',
    ],
    testTimeout: 10_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DEV_OTP_BYPASS: '0',
    },
  },
});
