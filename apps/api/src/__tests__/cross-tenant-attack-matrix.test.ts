import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { buildMatrixApp, digestProduction, seedWorld, sweep, type Finding, type World } from './helpers/cross-tenant-matrix';

// ---------------------------------------------------------------------------
// [row 300 · T3] The cross-tenant attack matrix, on the OWNER login (today's
// production posture: the app's guards are the wall). Every mounted route is
// fired by the store-review fiction's customer, rider and driver, and by a
// second tenant's store owner and administrator, at the production tenant's
// real objects. No 2xx may carry production data, and no production row may
// change. The walled-login half is cross-tenant-attack-matrix-walled.test.ts.
// See helpers/cross-tenant-matrix.ts for the fixtures and the materializer.
// ---------------------------------------------------------------------------

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
let owner: PrismaClient;
let app: FastifyInstance;
let routes: Array<{ method: string; url: string }>;
let world: World;
let before: Record<string, string>;
const findings: Finding[] = [];

beforeAll(async () => {
  vi.stubEnv('ADS_ENABLED', '1');
  vi.stubEnv('RATE_LIMIT_MAX', '1000000'); // the global ceiling is not under test (see buildMatrixApp)
  vi.stubEnv('TEST_CONTROL_ENABLED', '0'); // the load-build control routes never mount here
  vi.stubEnv('RUN_WORKERS', '0'); // requests only: the scheduler would page the seeded SOS itself (see buildMatrixApp)
  owner = testPrismaClient(TEST_URL);
  ({ app, routes } = await buildMatrixApp());
  world = await seedWorld(owner);
  before = await digestProduction(owner, world);
}, 120_000);

afterAll(async () => {
  await world?.cleanup();
  await app?.close();
  await owner?.$disconnect();
  vi.unstubAllEnvs();
}, 120_000);

describe('[T3] cross-tenant attack matrix — owner login', () => {
  it('the route table was really walked', () => {
    // A changed mount list that registers nothing would make every sweep vacuous.
    expect(routes.length).toBeGreaterThan(500);
    expect(routes.some((r) => r.url.startsWith('/api/v1/admin/'))).toBe(true);
    expect(routes.some((r) => r.url.startsWith('/api/v1/customer/'))).toBe(true);
    expect(routes.some((r) => r.url.startsWith('/api/v1/market/'))).toBe(true); // the real app's table, not a hand list
  });

  for (const index of [0, 1, 2, 3, 4]) {
    it(`attacker #${index + 1}: no 2xx answer carries production data`, async () => {
      const attacker = world.attackers[index]!;
      const result = await sweep(app, owner, world, routes, attacker);
      findings.push(...result.findings);
      // A local evidence hook only (CI leaves it unset): one line per attacker with its status spread.
      const report = process.env['T3_MATRIX_REPORT'];
      if (report) appendFileSync(report, `owner ${attacker.label}: fired ${result.fired} ${JSON.stringify(result.byStatus)} approvals ${JSON.stringify(result.approvals)}\n${result.unanswered.map((u) => `  ${u}\n`).join('')}`);
      expect(result.fired).toBeGreaterThan(400);
      // Vacuity guard: the sweep re-signs in once on a 401, so a 401 left in the spread means the attacker's
      // account itself stopped working mid-sweep and every later route was never really fired.
      expect(result.byStatus['401'] ?? 0, `first 401: ${result.firstRefused}`).toBe(0);
      expect(result.findings, `${attacker.label}: ${JSON.stringify(result.byStatus)} first 401: ${result.firstRefused}`).toEqual([]);
      // [REVIEW-M #2069 S3-1] The approval leg really ran: each two-person ask of the tenant-B admin was APPROVED by its
      // colleague and re-sent, and the gate let every re-send through to its handler (the approval is spent: APPLIED).
      if (attacker.role === 'ADMIN') {
        expect(result.approvals.asked, JSON.stringify(result.approvals)).toBeGreaterThan(30);
        expect(result.approvals.approved, JSON.stringify(result.approvals.byStatus)).toBe(result.approvals.asked);
        expect(result.approvals.reached, JSON.stringify(result.approvals.byStatus)).toBe(result.approvals.asked);
        // [REVIEW-M #2126 S4-1] ...and past validation: no re-send was refused for its body (each handler reached its own
        // checks and its object lookup). A 503 is allowed only as a server switch that refuses before anything: billing
        // mutations for a non-production tenant (TENANT_BILLING_UNAVAILABLE) and MMG fee returns while off (REVERSAL_OFF).
        const stopped = Object.entries(result.approvals.byRoute)
          .filter(([, outcome]) => /VALIDATION_ERROR/.test(outcome) || (/^503\b/.test(outcome) && !/TENANT_BILLING_UNAVAILABLE|REVERSAL_OFF/.test(outcome)));
        expect(stopped, JSON.stringify(result.approvals.byRoute)).toEqual([]);
      } else {
        expect(result.approvals.asked).toBe(0);
      }
    }, 600_000);
  }

  it('no production row changed under the whole sweep', async () => {
    const after = await digestProduction(owner, world);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed).toEqual([]);
  });
});
