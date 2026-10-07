/**
 * [L04 · R5 follow-up · S-01] SOS escalation works under production's CONTRACT
 * tenant posture.
 *
 * The escalation worker and its watchdog run as named system work (a job) and
 * read the outbox with top-level raw SQL. Under the contract posture the app's
 * own login is walled per tenant and system work belongs on its own bypass-
 * member login. A system statement that stayed on the walled login would see
 * ZERO escalation rows and ZERO active alerts: nobody would ever be paged and
 * the watchdog would stay silent. Both must read what is really there.
 *
 * The suite runs the job's own functions, as the job runs them, through the
 * production client shape on the walled login and the system login, with
 * TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny. Delivery itself is
 * stopped by the worker's observer before anything is sent (nobody is paged).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { scopedPrisma as prisma, scopedClientFor } from '../plugins/prisma';
import { runAsSystem } from '../plugins/tenant-context';
import { drainSosEscalations, scanSosEscalations } from '../modules/safety/sos-escalation';

// [R048-001] creates the probe group and two LOGIN roles by raw DDL, as tenant-autobind does.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const PROBE_LOGIN = 'swift_rls_probe_login';
const SYSTEM_LOGIN = 'swift_rls_system_login';
const withLogin = (login: string) => TEST_URL.replace(/\/\/[^@]+@/, `//${login}:probe@`);
const JOB = 'job:safety-jobs:sos-escalation-contract-test';
const io = { to: () => ({ emit: () => true }) } as unknown as Server;

let probeRaw: PrismaClient;
let sysRaw: PrismaClient;
let walled: PrismaClient;
let userId = '';
let alertId = '';
let escalationId = '';
const prior: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const sql of [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_rls_probe') THEN CREATE ROLE swift_rls_probe NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO swift_rls_probe`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swift_rls_probe`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swift_rls_probe`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_LOGIN}') THEN CREATE ROLE ${SYSTEM_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_LOGIN}') THEN CREATE ROLE ${PROBE_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_rls_probe TO ${PROBE_LOGIN}`,
    `GRANT swift_rls_probe TO ${SYSTEM_LOGIN}`,
    `GRANT swift_bypass_rls TO ${SYSTEM_LOGIN}`,
  ]) await prisma.$executeRawUnsafe(sql);
  await runAsSystem('test-setup', async () => {
    userId = (await prisma.user.create({ data: {
      phone: `+5928${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, firstName: 'Sos', lastName: 'Posture',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    } })).id;
    // An ACTIVE alert, older than the watchdog threshold, whose ops page is still pending.
    alertId = (await prisma.sosAlert.create({ data: {
      actorUserId: userId, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', triggeredAt: new Date(Date.now() - 10 * 60_000),
    } })).id;
    escalationId = (await prisma.sosEscalation.create({ data: {
      sosAlertId: alertId, tenantId: 'swift-default', channel: 'OPS_PAGE', targetKey: 'ops', status: 'PENDING',
    } })).id;
  });
  probeRaw = new PrismaClient({ datasourceUrl: withLogin(PROBE_LOGIN) });
  sysRaw = new PrismaClient({ datasourceUrl: withLogin(SYSTEM_LOGIN) });
  walled = scopedClientFor(probeRaw, sysRaw);
  for (const k of ['TENANT_RLS_BIND', 'TENANT_UNSCOPED_ACCESS']) prior[k] = process.env[k];
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
});

afterAll(async () => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await runAsSystem('test-teardown', async () => {
    await prisma.sosEscalation.deleteMany({ where: { sosAlertId: alertId } });
    await prisma.sosAlert.deleteMany({ where: { id: alertId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });
  await probeRaw?.$disconnect().catch(() => {});
  await sysRaw?.$disconnect().catch(() => {});
});

describe('[S-01] SOS escalation under the production CONTRACT posture', () => {
  it('the watchdog sees the ACTIVE alert whose ops page is undelivered', async () => {
    const scan = await runAsSystem(JOB, () => scanSosEscalations(walled));
    expect(scan.activeWithoutPage.map((a) => a.sosAlertId)).toContain(alertId);
    expect(scan.pending).toBeGreaterThan(0);
  });

  it('the worker claims the pending ops page (and records the attempt) on the system login', async () => {
    const claimed: string[] = [];
    const result = await runAsSystem(JOB, () => drainSosEscalations(walled, io, {
      alertIds: [alertId], limit: 1,
      observer: { beforeDeliver: async (row) => { claimed.push(`${row.channel}:${row.targetKey}`); throw new Error('STOPPED_BEFORE_DELIVERY'); } },
    }));
    expect(claimed).toEqual(['OPS_PAGE:ops']);
    expect(result.failed).toBe(1);
    const row = await runAsSystem('test-read', () => prisma.sosEscalation.findUniqueOrThrow({ where: { id: escalationId }, select: { attempts: true, status: true, lastError: true } }));
    expect(row).toMatchObject({ attempts: 1, status: 'PENDING' });
    expect(row.lastError).toContain('STOPPED_BEFORE_DELIVERY');
  });
});
