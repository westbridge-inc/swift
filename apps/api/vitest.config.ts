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
    env: {
      DEV_OTP_BYPASS: '0',
      NODE_ENV: 'test',
      // Auth fails fast without a JWT secret — and a suite that crashes at
      // boot still runs afterAll teardowns, which is how a missing env var
      // once wiped a seeded DB. Tests always get a secret; prod never does.
      JWT_SECRET: process.env['JWT_SECRET'] ?? 'vitest-local-jwt-secret',
      // Pin the test DB here so a bare `vitest` NEVER touches the dev DB.
      // Set first, this wins over the dev .env that Prisma's dotenv loads
      // (no-override). Every test file falls back to `|| .../swift` internally;
      // without this pin that default leaked fixture vendors (Race Diner ×3,
      // Audit Corner Shop ×3, …) into the seeded dev DB, where they duplicated
      // in the customer app. CI/local still override by exporting DATABASE_URL.
      DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgresql://swift:swift@localhost:5434/swift_test',
    },
    // All test files share ONE Postgres DB, so run files sequentially: parallel
    // files race on create/delete of shared fixtures (phones, carts→vendors→users)
    // and flake intermittently (FK violations). Sequential is deterministic (~22s).
    fileParallelism: false,
  },
});
