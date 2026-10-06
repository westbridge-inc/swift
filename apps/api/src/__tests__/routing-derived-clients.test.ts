import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { scopedPrisma as prisma, setSystemPrismaClient } from '../plugins/prisma';
import { runAsSystem, runWithTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] this suite creates the same NOLOGIN probe group and the SYSTEM
// login the tenant-wall suite uses, by raw DDL — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [#1444 review S3-1] A client DERIVED with $extends is routed like the client
// it came from. (Setup shared with the MASTER-019 suite; header kept below.)
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

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const SYSTEM_LOGIN = 'swift_rls_system_login';
const SYSTEM_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${SYSTEM_LOGIN}:probe@`);
const PROBE_LOGIN = 'swift_rls_probe_login';
const PROBE_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${PROBE_LOGIN}:probe@`);
const T = `s31-${nanoid(6)}`;
const U = `s31u-${nanoid(6)}`;
const userIds: string[] = [];
const alertIds: string[] = [];
let observer: PrismaClient; // a SECOND connection: what actually committed
let sysRaw: PrismaClient;
let probeRaw: PrismaClient;
let userId = '';

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
      if (t === T) userId = u.id;
    }
  });
  observer = new PrismaClient({ datasourceUrl: TEST_URL });
  sysRaw = new PrismaClient({ datasourceUrl: SYSTEM_URL });
  probeRaw = new PrismaClient({ datasourceUrl: PROBE_URL });
});

afterEach(async () => {
  delete process.env['TENANT_RLS_BIND'];
  delete process.env['SYSTEM_DATABASE_URL'];
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



/** A client derived like admin.routes' tenantPrisma: a query extension that
 *  counts what passes through it, so the test can see it stays in force. */
function derive(base: PrismaClient, seen: string[], name = 'derived-probe') {
  return base.$extends({
    name,
    query: { user: { async $allOperations({ operation, args, query }) { seen.push(`${name}:${operation}`); return query(args); } } },
  }) as unknown as PrismaClient;
}
const whoAmI = async (tx: { $queryRaw: PrismaClient['$queryRaw'] }) => (await tx.$queryRaw<Array<{ u: string }>>`SELECT current_user::text AS u`)[0]!.u;

describe('[#1444 S3-1] a derived client routes its transactions like its base', () => {
  it('(a) a derived client’s system transaction runs on the system login as ONE transaction, with the derived extension in force', async () => {
    bound();
    const seen: string[] = [];
    const derived = derive(prisma as unknown as PrismaClient, seen);
    let who: string | undefined;
    await expect(runAsSystem('s31-derived', () => derived.$transaction(async (tx) => {
      who = await whoAmI(tx);
      await tx.user.update({ where: { id: userId }, data: { firstName: 'Escaped' } });
      throw new Error('caller fails before commit');
    }))).rejects.toThrow('caller fails before commit');
    expect({ who, committed: await committedName() }).toEqual({ who: SYSTEM_LOGIN, committed: 'Original' });
    expect(seen).toContain('derived-probe:update');
  });

  it('(a) a client derived from a derived client routes the same way, every extension in force', async () => {
    bound();
    const seen: string[] = [];
    const twice = derive(derive(prisma as unknown as PrismaClient, seen, 'outer'), seen, 'inner');
    let who: string | undefined;
    await expect(runAsSystem('s31-derived-twice', () => twice.$transaction(async (tx) => {
      who = await whoAmI(tx);
      await tx.user.update({ where: { id: userId }, data: { firstName: 'Escaped' } });
      throw new Error('caller fails before commit');
    }))).rejects.toThrow('caller fails before commit');
    expect({ who, committed: await committedName() }).toEqual({ who: SYSTEM_LOGIN, committed: 'Original' });
    expect(seen).toEqual(expect.arrayContaining(['outer:update', 'inner:update']));
  });

  it('(c) a tenant transaction on a derived client stays on the request login', async () => {
    bound();
    const derived = derive(prisma as unknown as PrismaClient, []);
    const who = await runWithTenant(T, () => derived.$transaction(async (tx) => whoAmI(tx)));
    expect(who).not.toBe(SYSTEM_LOGIN);
    expect(who).toBe(await whoAmI(observer));
  });

  it('with binding off nothing changes: a derived client’s system transaction opens where it always did', async () => {
    const derived = derive(prisma as unknown as PrismaClient, []);
    const who = await runAsSystem('s31-off', () => derived.$transaction(async (tx) => whoAmI(tx)));
    expect(who).toBe(await whoAmI(observer));
  });
});
