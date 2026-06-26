import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Match CI: tests must exercise the REAL OTP flow. The dev .env sets
    // DEV_OTP_BYPASS=1, which Prisma's dotenv otherwise leaks into the test
    // process (no-override, so setting it here first wins) and turns 2 auth
    // security tests into false negatives. Pin it off + force NODE_ENV=test.
    env: { DEV_OTP_BYPASS: '0', NODE_ENV: 'test' },
    // All test files share ONE Postgres DB, so run files sequentially: parallel
    // files race on create/delete of shared fixtures (phones, carts→vendors→users)
    // and flake intermittently (FK violations). Sequential is deterministic (~22s).
    fileParallelism: false,
  },
});
