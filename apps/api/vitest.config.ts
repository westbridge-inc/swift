import { defineConfig } from 'vitest/config';
import { TEST_TARGET_DEFAULTS } from './src/lib/test-target-lock';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    // The tenant-wall heal a DDL suite installs in beforeAll is O(walled tables) —
    // 96 tables, ~384 statements, each an ACCESS EXCLUSIVE lock behind one advisory
    // lock — and on the CI runner it now crosses 30s (hook timeouts in
    // tenant-lineage-money / review-tenant-contract on 09-05). Setup is not the
    // behaviour under test: give it room; testTimeout stays where it is.
    hookTimeout: 120000,
    // SWIFT-165: measure coverage (v8) and publish the number in CI. No
    // thresholds yet — measure first, ratchet later (the suite is case-rich but
    // its blind spots were never quantified). Excludes tests, generated Prisma
    // client, type decls, and the seed/migration scripts.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/generated/**'],
    },
    // Match CI: tests must exercise the REAL OTP flow. The dev .env sets
    // DEV_OTP_BYPASS=1, which Prisma's dotenv otherwise leaks into the test
    // process (no-override, so setting it here first wins) and turns 2 auth
    // security tests into false negatives. Pin it off + force NODE_ENV=test.
    env: {
      // [FD-DOC-3b · 2026-09-07] Production is on-shore manual review (KYC_PROVIDER=manual in the dev
      // .env). The suites characterise the SANDBOX auto-approval path; pin it here so a local run
      // does not inherit the dev provider through Prisma's dotenv.
      KYC_PROVIDER: 'sandbox',
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
      DATABASE_URL: process.env['DATABASE_URL'] ?? TEST_TARGET_DEFAULTS.DATABASE_URL,
      // [R048-001] Redis is pinned too — to a database of the tests' own, never
      // 0 where the development app keeps its keys. The global setup refuses a
      // run whose URL selects 0, wherever it came from.
      REDIS_URL: process.env['REDIS_URL'] ?? TEST_TARGET_DEFAULTS.REDIS_URL,
      // Dormant feature flags default OFF in tests, exactly as CI runs them.
      // The dev .env turns some ON (LIFECYCLE_V2=1, DISPATCH_AVAILABILITY=1);
      // Prisma's dotenv otherwise leaks those into a bare local `vitest` and
      // flips ~33 flag-agnostic tests red (checkout → 409 no-riders, promo
      // scoping → 400) while CI — which has no dev .env — stays green. Pinning
      // them empty here (set first, wins over the no-override dev .env) makes a
      // local run bit-identical to CI. Tests that exercise a flag ON set it
      // themselves per-case (order-hold, availability, dispatch-journal) and
      // are unaffected. Add any new dormant flag here so it can't leak either.
      LIFECYCLE_V2: '',
      DISPATCH_AVAILABILITY: '',
      DISPATCH_EXHAUSTION: '',
      DELIVERY_BLOCK_ON_NONE: '',
      CONSENT_REQUIRED: '',
      ALERTS_LOUD: '',
      PREVIEW_MODE: '',
    },
    // All test files share ONE Postgres DB, so run files sequentially: parallel
    // files race on create/delete of shared fixtures (phones, carts→vendors→users)
    // and flake intermittently (FK violations). Sequential is deterministic (~22s).
    fileParallelism: false,
    // [R048-001] The target lock: no worker is spawned until Postgres and Redis
    // are proven loopback and disposable, read-only probes agree, and the run
    // id is minted. Rollback means stopping the suite, never relaxing this.
    globalSetup: ['./src/__tests__/setup/target-lock.ts'],
  },
});
