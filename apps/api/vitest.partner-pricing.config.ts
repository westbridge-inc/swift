import { defineConfig } from 'vitest/config';

/** Service-free partner weekly-fee contract tests. The default API Vitest
 * configuration intentionally requires isolated PostgreSQL and Redis; these run
 * the real signup, weekly re-tier and public price-list code against in-memory
 * fakes and must never open a service. The URLs below point at a local port
 * nothing listens on, so an accidental connection fails here, loudly. */
export default defineConfig({
  test: {
    root: '.',
    include: ['src/__tests__/partner-pricing-contract.unit.test.ts', 'src/__tests__/doc1-fx-peg.test.ts'],
    testTimeout: 10_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DEV_OTP_BYPASS: '0',
      DATABASE_URL: 'postgresql://service-free:service-free@127.0.0.1:1/service_free',
      REDIS_URL: 'redis://127.0.0.1:1/15',
    },
  },
});
