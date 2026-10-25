import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { appRoleDdl } from '../lib/tenant-rls';
import { installDdl } from './helpers/install-ddl';
import type { Finding, World } from './helpers/cross-tenant-matrix';

// [R048-001] this suite creates the NOLOGIN probe group and two LOGIN roles by raw DDL, exactly as review-partner-strict-posture does.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [row 300 · T3] The cross-tenant attack matrix, on the WALLED login — the
// production CONTRACT posture: the app's own client is a NOBYPASSRLS login,
// TENANT_RLS_BIND=1, TENANT_UNSCOPED_ACCESS=deny, and audited system work runs
// on its own bypass-member login. The same sweep as the owner-login suite:
// every mounted route, fired by the review fiction and a second tenant at the
// production tenant's real objects; no 2xx may carry production data and no
// production row may change. This half is also W0's HTTP proof for Phase C.
// ---------------------------------------------------------------------------

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const PROBE_LOGIN = 'swift_rls_probe_login';
const PROBE_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${PROBE_LOGIN}:probe@`);
const SYSTEM_LOGIN = 'swift_rls_system_login';
const SYSTEM_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${SYSTEM_LOGIN}:probe@`);
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let owner: PrismaClient;
let app: FastifyInstance;
let routes: Array<{ method: string; url: string }>;
let world: World;
let before: Record<string, string>;
let matrix: typeof import('./helpers/cross-tenant-matrix');
let prismaModule: typeof import('../plugins/prisma') | null = null;
const findings: Finding[] = [];

beforeAll(async () => {
  vi.stubEnv('ADS_ENABLED', '1');
  vi.stubEnv('RATE_LIMIT_MAX', '1000000'); // the global ceiling is not under test (see buildMatrixApp)
  vi.stubEnv('TEST_CONTROL_ENABLED', '0'); // the load-build control routes never mount here
  vi.stubEnv('RUN_WORKERS', '0'); // requests only: the scheduler would page the seeded SOS itself (see buildMatrixApp)
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  // The fixture writer: the suite's own privileged connection (never the app's client).
  owner = testPrismaClient(TEST_URL);
  await installDdl(owner, [
    ...appRoleDdl(),
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_rls_probe') THEN CREATE ROLE swift_rls_probe NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO swift_rls_probe`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swift_rls_probe`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swift_rls_probe`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_LOGIN}') THEN CREATE ROLE ${PROBE_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_rls_probe TO ${PROBE_LOGIN}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_LOGIN}') THEN CREATE ROLE ${SYSTEM_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_rls_probe TO ${SYSTEM_LOGIN}`,
    `GRANT swift_bypass_rls TO ${SYSTEM_LOGIN}`,
  ]);
  // The app's OWN client on the walled login, system work on the bypass-member login, and the
  // contract's two settings — set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = PROBE_URL;
  process.env['SYSTEM_DATABASE_URL'] = SYSTEM_URL;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  prismaModule = await import('../plugins/prisma');
  matrix = await import('./helpers/cross-tenant-matrix');
  ({ app, routes } = await matrix.buildMatrixApp());
  world = await matrix.seedWorld(owner);
  before = await matrix.digestProduction(owner, world);
}, 180_000);

afterAll(async () => {
  await world?.cleanup();
  await app?.close();
  // The system login's client is cached by the module: close it before its URL leaves the environment.
  await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
  prismaModule?.setSystemPrismaClient(null);
  for (const k of ENV_KEYS) {
    if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
  }
  await owner?.$disconnect();
  vi.unstubAllEnvs();
}, 120_000);

describe('[T3] cross-tenant attack matrix — walled login (production CONTRACT posture)', () => {
  it('the app really runs on the wall, and the route table was really walked', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
    expect(routes.length).toBeGreaterThan(500);
    expect(routes.some((r) => r.url.startsWith('/api/v1/admin/'))).toBe(true);
    expect(routes.some((r) => r.url.startsWith('/api/v1/market/'))).toBe(true);
  });

  for (const index of [0, 1, 2, 3, 4]) {
    it(`attacker #${index + 1}: no 2xx answer carries production data`, async () => {
      const attacker = world.attackers[index]!;
      const result = await matrix.sweep(app, owner, world, routes, attacker);
      findings.push(...result.findings);
      // A local evidence hook only (CI leaves it unset): one line per attacker with its status spread.
      const report = process.env['T3_MATRIX_REPORT'];
      if (report) appendFileSync(report, `walled ${attacker.label}: fired ${result.fired} ${JSON.stringify(result.byStatus)}\n${result.unanswered.map((u) => `  ${u}\n`).join('')}`);
      expect(result.fired).toBeGreaterThan(400);
      // Vacuity guard: the sweep re-signs in once on a 401, so a 401 left in the spread means the attacker's
      // account itself stopped working mid-sweep and every later route was never really fired.
      expect(result.byStatus['401'] ?? 0, `first 401: ${result.firstRefused}`).toBe(0);
      expect(result.findings, `${attacker.label}: ${JSON.stringify(result.byStatus)} first 401: ${result.firstRefused}`).toEqual([]);
    }, 600_000);
  }

  it('no production row changed under the whole sweep', async () => {
    const after = await matrix.digestProduction(owner, world);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed).toEqual([]);
  });
});
