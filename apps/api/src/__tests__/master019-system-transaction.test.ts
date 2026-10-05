import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { scopedPrisma as prisma, setSystemPrismaClient, scopedClientFor } from '../plugins/prisma';
import { runAsSystem, runWithTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { SosService } from '../modules/safety/sos.service';

// [R048-001] this suite creates the same NOLOGIN probe group and the SYSTEM
// login the tenant-wall suite uses, by raw DDL — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [MASTER-019] System work inside a transaction stays inside that transaction.
//
// With the tenant wall bound (TENANT_RLS_BIND=1) and a separate system login,
// system-mode queries on a tenant model used to be re-issued one by one on the
// global system client. Inside a caller's interactive transaction that meant
// they ran OUTSIDE it: a write survived the caller's rollback and held no lock
// for the rest of the transaction. The system connection is now chosen when
// the transaction starts, so every dependent query and lock runs on ONE
// transaction, and a system query that would still have to leave a caller's
// transaction is refused instead of escaping it.
// ---------------------------------------------------------------------------

const fault = vi.hoisted(() => ({ stage: false }));
vi.mock('../modules/safety/sos-escalation', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/safety/sos-escalation')>();
  return {
    ...real,
    // Stage for real (so the rows exist inside the transaction), THEN fail: the
    // rollback must take the staged rows AND the ACTIVE flip with it.
    stageEscalations: async (...a: Parameters<typeof real.stageEscalations>) => {
      const staged = await real.stageEscalations(...a);
      if (fault.stage) throw new Error('injected: escalation staging failed after staging');
      return staged;
    },
  };
});

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const SYSTEM_LOGIN = 'swift_rls_system_login';
const SYSTEM_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${SYSTEM_LOGIN}:probe@`);
const PROBE_LOGIN = 'swift_rls_probe_login';
const PROBE_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${PROBE_LOGIN}:probe@`);
const T = `m019-${nanoid(6)}`;
const U = `m019u-${nanoid(6)}`;
const userIds: string[] = [];
const alertIds: string[] = [];
let observer: PrismaClient; // a SECOND connection: what actually committed
let sysRaw: PrismaClient;
let probeRaw: PrismaClient;
let userId = '';
let otherUserId = '';

const io = { to: () => ({ emit: () => undefined }), emit: () => undefined } as unknown as Server;

beforeAll(async () => {
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_rls_probe') THEN CREATE ROLE swift_rls_probe NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO swift_rls_probe`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swift_rls_probe`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swift_rls_probe`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_LOGIN}') THEN CREATE ROLE ${SYSTEM_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_LOGIN}') THEN CREATE ROLE ${PROBE_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_rls_probe TO ${PROBE_LOGIN}`,
    `GRANT swift_rls_probe TO ${SYSTEM_LOGIN}`,
    `GRANT swift_bypass_rls TO ${SYSTEM_LOGIN}`,
  ];
  for (const sql of statements) await prisma.$executeRawUnsafe(sql);
  await runAsSystem('test-setup', async () => {
    for (const t of [T, U]) await prisma.tenant.create({ data: { id: t, name: `M019 ${t}`, slug: t } });
    for (const t of [T, U]) {
      const u = await prisma.user.create({ data: { phone: `+5928${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, firstName: 'Original', lastName: t, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: t } });
      userIds.push(u.id);
      if (t === T) userId = u.id; else otherUserId = u.id;
    }
  });
  observer = new PrismaClient({ datasourceUrl: TEST_URL });
  sysRaw = new PrismaClient({ datasourceUrl: SYSTEM_URL });
  probeRaw = new PrismaClient({ datasourceUrl: PROBE_URL });
});

afterEach(async () => {
  delete process.env['TENANT_RLS_BIND'];
  delete process.env['SYSTEM_DATABASE_URL'];
  fault.stage = false;
  setSystemPrismaClient(null);
  await observer.user.updateMany({ where: { id: { in: userIds } }, data: { firstName: 'Original' } });
});

afterAll(async () => {
  await runAsSystem('test-teardown', async () => {
    if (alertIds.length) {
      await prisma.sosEscalation.deleteMany({ where: { sosAlertId: { in: alertIds } } });
      await prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [T, U] } } });
  });
  await observer.$disconnect().catch(() => {});
  await sysRaw.$disconnect().catch(() => {});
  await probeRaw.$disconnect().catch(() => {});
});

// The cutover topology: binding on, and a system login of its own.
const bound = () => {
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['SYSTEM_DATABASE_URL'] = SYSTEM_URL;
  setSystemPrismaClient(sysRaw);
};
const committedName = async () => (await observer.user.findUniqueOrThrow({ where: { id: userId }, select: { firstName: true } })).firstName;

async function newPendingAlert(): Promise<string> {
  const a = await observer.sosAlert.create({ data: { tenantId: T, actorUserId: userId, actorRole: 'CUSTOMER', status: 'TRIGGER_PENDING', triggerSource: 'BUTTON', graceEndsAt: new Date(Date.now() + 60_000) } });
  alertIds.push(a.id);
  return a.id;
}

describe('[MASTER-019] system work inside a transaction stays inside it', () => {
  it('a system-mode transaction runs every query on ONE system connection: its write holds the row lock until the end, and a rollback leaves nothing behind', async () => {
    bound();
    let who: string | undefined;
    let lockedOutside: boolean | undefined;
    await expect(runAsSystem('m019-probe', () => prisma.$transaction(async (tx) => {
      who = (await tx.$queryRaw<Array<{ u: string }>>`SELECT current_user::text AS u`)[0]!.u;
      await tx.user.update({ where: { id: userId }, data: { firstName: 'Escaped' } });
      // a second connection must find the row locked by THIS transaction
      lockedOutside = await observer.$transaction(async (o) => {
        try {
          await o.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE NOWAIT`;
          return false;
        } catch {
          return true;
        }
      });
      throw new Error('caller fails before commit');
    }))).rejects.toThrow('caller fails before commit');
    expect({ who, lockedOutside, committed: await committedName() }).toEqual({ who: SYSTEM_LOGIN, lockedOutside: true, committed: 'Original' });
  });

  it('the SOS case: when staging the escalation policy fails, the alert is NOT left ACTIVE and no escalation row survives', async () => {
    bound();
    const id = await newPendingAlert();
    const svc = new SosService(prisma as unknown as PrismaClient, io);
    fault.stage = true;
    await expect(svc.confirm(id)).rejects.toThrow('injected: escalation staging failed');
    const row = await observer.sosAlert.findUniqueOrThrow({ where: { id }, select: { status: true } });
    expect(row.status).toBe('TRIGGER_PENDING');
    expect(await observer.sosEscalation.count({ where: { sosAlertId: id } })).toBe(0);
  });

  it('a system query that would have to leave a caller’s request-connection transaction is refused, never re-issued outside it', async () => {
    bound();
    await expect(runWithTenant(T, () => prisma.$transaction(async (tx) => {
      await runAsSystem('m019-switch', () => tx.user.update({ where: { id: userId }, data: { firstName: 'Escaped' } }));
      throw new Error('caller fails before commit');
    }))).rejects.toMatchObject({ code: 'SYSTEM_WORK_OUTSIDE_TRANSACTION' });
    expect(await committedName()).toBe('Original');
  });

  it('a system-mode array transaction never commits part of itself', async () => {
    bound();
    await expect(runAsSystem('m019-array', () => prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { firstName: 'Escaped' } }),
      prisma.user.update({ where: { id: `missing-${nanoid(8)}` }, data: { firstName: 'Nobody' } }),
    ]))).rejects.toThrow();
    expect(await committedName()).toBe('Original');
    // a batch whose first write is on a model that never moves connection: refused as a whole
    await expect(runAsSystem('m019-array', () => prisma.$transaction([
      prisma.tenant.update({ where: { id: T }, data: { name: 'Escaped' } }),
      prisma.user.update({ where: { id: userId }, data: { firstName: 'Escaped' } }),
    ]))).rejects.toMatchObject({ code: 'SYSTEM_WORK_OUTSIDE_TRANSACTION' });
    expect(await committedName()).toBe('Original');
    expect((await observer.tenant.findUniqueOrThrow({ where: { id: T } })).name).toBe(`M019 ${T}`);
  });

  it('the system transaction keeps the append-only guard on order status logs', async () => {
    bound();
    await expect(runAsSystem('m019-immutable', () => prisma.$transaction(async (tx) =>
      tx.orderStatusLog.updateMany({ where: { id: `missing-${nanoid(8)}` }, data: { note: 'rewritten' } }),
    ))).rejects.toThrow(/append-only/);
  });

  it('activation and a second activation or a cancellation race: exactly one wins and the policy is staged once', async () => {
    bound();
    const svc = new SosService(prisma as unknown as PrismaClient, io);
    const activate = (id: string) => (svc as unknown as { activate(id: string): Promise<boolean> }).activate(id);
    const twice = await newPendingAlert();
    const [a, b] = await Promise.all([activate(twice), activate(twice)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await observer.sosAlert.findUniqueOrThrow({ where: { id: twice } })).status).toBe('ACTIVE');
    const staged = await observer.sosEscalation.count({ where: { sosAlertId: twice } });
    expect(staged).toBeGreaterThan(0);
    expect(await activate(twice)).toBe(false);
    expect(await observer.sosEscalation.count({ where: { sosAlertId: twice } })).toBe(staged);

    for (const order of ['activate-first', 'cancel-first'] as const) {
      const id = await newPendingAlert();
      const runs = order === 'activate-first'
        ? [activate(id).then((m) => (m ? 'ACTIVE' : null)), svc.cancel(id).then(() => 'CANCELLED', () => null)]
        : [svc.cancel(id).then(() => 'CANCELLED', () => null), activate(id).then((m) => (m ? 'ACTIVE' : null))];
      const won = (await Promise.all(runs)).filter(Boolean);
      expect(won).toHaveLength(1);
      const final = await observer.sosAlert.findUniqueOrThrow({ where: { id }, select: { status: true } });
      expect(final.status).toBe(won[0]);
      const rows = await observer.sosEscalation.count({ where: { sosAlertId: id } });
      if (final.status === 'ACTIVE') expect(rows).toBeGreaterThan(0); else expect(rows).toBe(0);
    }
  });
});

describe('[MASTER-019] under real, distinct request and system logins', () => {
  const names = async () => (await observer.user.findMany({ where: { id: { in: [userId, otherUserId] } }, orderBy: { id: 'asc' }, select: { firstName: true } })).map((u) => u.firstName);

  it('the request login sees only its tenant; a system transaction runs entirely on the system login and commits or rolls back as ONE', async () => {
    process.env['TENANT_RLS_BIND'] = '1';
    const client = scopedClientFor(probeRaw, sysRaw);
    const mine = await runWithTenant(T, () => client.user.findMany({ where: { id: { in: [userId, otherUserId] } }, select: { tenantId: true } }));
    expect(mine.map((u) => u.tenantId)).toEqual([T]);

    let who: string | undefined;
    await expect(runAsSystem('m019-roles', () => client.$transaction(async (tx) => {
      who = (await tx.$queryRaw<Array<{ u: string }>>`SELECT current_user::text AS u`)[0]!.u;
      const both = await tx.user.updateMany({ where: { id: { in: [userId, otherUserId] } }, data: { firstName: 'Escaped' } });
      expect(both.count).toBe(2);
      throw new Error('caller fails before commit');
    }))).rejects.toThrow('caller fails before commit');
    expect(who).toBe(SYSTEM_LOGIN);
    expect(await names()).toEqual(['Original', 'Original']);

    await runAsSystem('m019-roles', () => client.$transaction(async (tx) => {
      await tx.user.updateMany({ where: { id: { in: [userId, otherUserId] } }, data: { firstName: 'Committed' } });
    }));
    expect(await names()).toEqual(['Committed', 'Committed']);
  });

  it('a tenant switch inside a system transaction keeps the tenant predicate on the system connection', async () => {
    process.env['TENANT_RLS_BIND'] = '1';
    const client = scopedClientFor(probeRaw, sysRaw);
    const seen = await runAsSystem('m019-roles', () => client.$transaction(async (tx) =>
      runWithTenant(T, () => tx.user.findMany({ where: { id: { in: [userId, otherUserId] } }, select: { tenantId: true } }))));
    expect(seen.map((u) => u.tenantId)).toEqual([T]);
  });

  it('with no system client, system work on the walled request login sees nothing and changes nothing — fail closed', async () => {
    process.env['TENANT_RLS_BIND'] = '1';
    const client = scopedClientFor(probeRaw, null);
    const out = await runAsSystem('m019-roles', () => client.$transaction(async (tx) => ({
      seen: await tx.user.count({ where: { id: { in: [userId, otherUserId] } } }),
      moved: (await tx.user.updateMany({ where: { id: { in: [userId, otherUserId] } }, data: { firstName: 'Escaped' } })).count,
    })));
    expect(out).toEqual({ seen: 0, moved: 0 });
    expect(await names()).toEqual(['Original', 'Original']);
  });

  it('a system query inside a request-login transaction is refused there too', async () => {
    process.env['TENANT_RLS_BIND'] = '1';
    const client = scopedClientFor(probeRaw, sysRaw);
    await expect(runWithTenant(T, () => client.$transaction(async (tx) => {
      await runAsSystem('m019-switch', () => tx.user.updateMany({ where: { id: { in: [userId, otherUserId] } }, data: { firstName: 'Escaped' } }));
    }))).rejects.toMatchObject({ code: 'SYSTEM_WORK_OUTSIDE_TRANSACTION' });
    expect(await names()).toEqual(['Original', 'Original']);
  });
});
