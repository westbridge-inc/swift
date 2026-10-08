import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { scopedPrisma as prisma, scopedClientFor, TenantSwitchInTransactionError } from '../plugins/prisma';
import { runAsSystem, runWithTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { tenantBindCounter } from '../plugins/observability';

// [R048-001] the same NOLOGIN probe group and logins the tenant-wall suites use, by raw DDL.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [L04 · R5 central auto-bind] Under the contract posture (a NOBYPASSRLS
// request login, TENANT_RLS_BIND=1) the database shows a transaction only the
// rows of the tenant its connection is bound to — and an unbound transaction
// sees NOTHING. Main bound single queries, but an interactive or batch
// transaction (about 200 of them, with ~200 raw SELECT … FOR UPDATE reads)
// ran unbound unless its author remembered bindTenantTransaction: under the
// contract it read empty and wrote nothing — fail closed, but broken.
//
// The fix is central: a transaction that BEGINS while a tenant is bound is
// bound for its whole life, raw SQL included; a query inside it that asks for
// a different tenant is refused by name; top-level raw SQL is bound the same
// way a model query is. The binding is transaction-local, so the pooled
// connection carries nothing into the next transaction (the reuse probe).
// ---------------------------------------------------------------------------

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const PROBE_LOGIN = 'swift_rls_probe_login';
const SYSTEM_LOGIN = 'swift_rls_system_login';
const withLogin = (login: string, extra = '') => {
  const url = TEST_URL.replace(/\/\/[^@]+@/, `//${login}:probe@`);
  return extra ? `${url}${url.includes('?') ? '&' : '?'}${extra}` : url;
};
const T = `ab-t-${nanoid(6)}`;
const U = `ab-u-${nanoid(6)}`;
let userT = '';
let userU = '';
let probeRaw: PrismaClient;
let probeOne: PrismaClient;
let sysRaw: PrismaClient;
let walled: PrismaClient;
let walledOne: PrismaClient;

const countUser = (db: { $queryRaw: PrismaClient['$queryRaw'] }, id: string) =>
  db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "users" WHERE "id" = ${id}`.then((r) => r[0]!.n);

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
    for (const t of [T, U]) await prisma.tenant.create({ data: { id: t, name: `Autobind ${t}`, slug: t } });
    userT = (await prisma.user.create({ data: { phone: `+5928${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, firstName: 'Bound', lastName: 'T', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: T } })).id;
    userU = (await prisma.user.create({ data: { phone: `+5928${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, firstName: 'Bound', lastName: 'U', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: U } })).id;
  });
  probeRaw = new PrismaClient({ datasourceUrl: withLogin(PROBE_LOGIN) });
  // ONE pooled connection, so the reuse probe sees the very connection the
  // bound transaction ran on (an extended client shares its base's pool).
  probeOne = new PrismaClient({ datasourceUrl: withLogin(PROBE_LOGIN, 'connection_limit=1') });
  sysRaw = new PrismaClient({ datasourceUrl: withLogin(SYSTEM_LOGIN) });
  walled = scopedClientFor(probeRaw, sysRaw);
  walledOne = scopedClientFor(probeOne, sysRaw);
  process.env['TENANT_RLS_BIND'] = '1';
});

afterEach(async () => {
  await prisma.user.updateMany({ where: { id: { in: [userT, userU] } }, data: { firstName: 'Bound' } });
});

afterAll(async () => {
  delete process.env['TENANT_RLS_BIND'];
  await runAsSystem('test-teardown', async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userT, userU].filter(Boolean) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [T, U] } } });
  });
  await probeRaw?.$disconnect().catch(() => {});
  await probeOne?.$disconnect().catch(() => {});
  await sysRaw?.$disconnect().catch(() => {});
});

describe('[R5 auto-bind] a transaction that begins under a tenant is bound for its whole life', () => {
  it('the probe login really is walled: unbound, it sees no user at all', async () => {
    expect(await countUser(probeRaw, userT)).toBe(0);
  });

  it('interactive: raw SELECT … FOR UPDATE and model reads see the bound tenant’s row', async () => {
    const seen = await runWithTenant(T, () => walled.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "users" WHERE "id" = ${userT} FOR UPDATE`;
      const viaModel = await tx.user.findUnique({ where: { id: userT }, select: { id: true } });
      return { locked: locked.length, viaModel: viaModel?.id ?? null };
    }));
    expect(seen).toEqual({ locked: 1, viaModel: userT });
  });

  it('interactive: a write inside the transaction lands, and only on the bound tenant', async () => {
    const written = await runWithTenant(T, () => walled.$transaction(async (tx) => {
      const own = await tx.$executeRaw`UPDATE "users" SET "firstName" = 'Written' WHERE "id" = ${userT}`;
      const other = await tx.$executeRaw`UPDATE "users" SET "firstName" = 'Written' WHERE "id" = ${userU}`;
      return { own, other };
    }));
    expect(written).toEqual({ own: 1, other: 0 });
    const after = await prisma.user.findMany({ where: { id: { in: [userT, userU] } }, select: { id: true, firstName: true } });
    expect(Object.fromEntries(after.map((u) => [u.id, u.firstName]))).toEqual({ [userT]: 'Written', [userU]: 'Bound' });
  });

  it('a client derived with $extends (as admin routes derive one) binds its transactions the same way', async () => {
    const derived = (walled as unknown as { $extends: (e: object) => PrismaClient }).$extends({ name: 'derivedForTest' });
    const seen = await runWithTenant(T, () => derived.$transaction(async (tx) => countUser(tx, userT)));
    expect(seen).toBe(1);
  });

  it('batch: an array transaction is bound too', async () => {
    const [viaModel, viaRaw] = await runWithTenant(T, () => walled.$transaction([
      walled.user.findUnique({ where: { id: userT }, select: { id: true } }),
      walled.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "users" WHERE "id" = ${userT}`,
    ]));
    expect(viaModel?.id).toBe(userT);
    expect(viaRaw[0]!.n).toBe(1);
  });

  it('top-level raw SQL under a bound tenant sees that tenant, and nothing of another', async () => {
    const seen = await runWithTenant(T, async () => ({ own: await countUser(walled, userT), other: await countUser(walled, userU) }));
    expect(seen).toEqual({ own: 1, other: 0 });
  });

  it('a second transaction opened inside the first is bound to the same tenant', async () => {
    const inner = await runWithTenant(T, () => walled.$transaction(async () => {
      // A separate transaction (its own connection) begun inside the callback.
      return walled.$transaction(async (tx2) => countUser(tx2, userT));
    }, { timeout: 15_000 }));
    expect(inner).toBe(1);
  });

  it('asking for a different tenant inside a bound transaction is refused by name, never answered empty', async () => {
    const attempt = runWithTenant(T, () => walled.$transaction(async (tx) =>
      runWithTenant(U, () => tx.user.findUnique({ where: { id: userU }, select: { id: true } }))));
    await expect(attempt).rejects.toBeInstanceOf(TenantSwitchInTransactionError);
  });
});

describe('[R5 auto-bind · review S3-1] the refusal follows the TRANSACTION a query runs on', () => {
  it('reusing an outer transaction (bound to T) inside a nested transaction under U is refused — raw SQL included', async () => {
    const attempt = runWithTenant(T, () => walled.$transaction(async (outer) =>
      runWithTenant(U, () => walled.$transaction(async () => countUser(outer, userT)))));
    await expect(attempt).rejects.toBeInstanceOf(TenantSwitchInTransactionError);
  });

  it('system work on a bound transaction’s own client is refused, not run on the tenant connection', async () => {
    const attempt = runWithTenant(T, () => walled.$transaction(async (tx) =>
      runAsSystem('test-system-inside-bound', () => countUser(tx, userT))));
    await expect(attempt).rejects.toThrow();
  });
});

describe('[R5 auto-bind · review S3-2] one set_config per bound query, in production and in the probe alike', () => {
  const kinds = async () => Object.fromEntries((await tenantBindCounter.get()).values.map((v) => [v.labels['kind'], v.value]));
  it('a top-level bound query and a top-level bound raw query each bind once and are not counted as transactions', async () => {
    for (const client of [prisma as unknown as PrismaClient, walled]) {
      const before = await kinds();
      await runWithTenant(T, async () => {
        await client.user.findFirst({ where: { id: userT }, select: { id: true } });
        await countUser(client, userT);
      });
      const after = await kinds();
      expect((after['tenant'] ?? 0) - (before['tenant'] ?? 0)).toBe(2);
      expect((after['tenant_tx'] ?? 0) - (before['tenant_tx'] ?? 0)).toBe(0);
    }
  });

  it('a bound callback transaction counts exactly one transaction bind', async () => {
    const before = await kinds();
    await runWithTenant(T, () => walled.$transaction(async (tx) => countUser(tx, userT)));
    const after = await kinds();
    expect((after['tenant_tx'] ?? 0) - (before['tenant_tx'] ?? 0)).toBe(1);
  });
});

describe('[R5 auto-bind] the binding never outlives its transaction (reuse probe)', () => {
  it('after a bound transaction commits — and after one rolls back — the same pooled connection is unbound again', async () => {
    await runWithTenant(T, () => walledOne.$transaction(async (tx) => countUser(tx, userT)));
    const afterCommit = await probeOne.$queryRaw<Array<{ v: string | null }>>`SELECT current_setting('app.current_tenant', true) AS v`;
    expect(afterCommit[0]!.v ?? '').toBe('');
    expect(await countUser(probeOne, userT)).toBe(0);

    await expect(runWithTenant(T, () => walledOne.$transaction(async (tx) => {
      await countUser(tx, userT);
      throw new Error('roll back');
    }))).rejects.toThrow('roll back');
    const afterRollback = await probeOne.$queryRaw<Array<{ v: string | null }>>`SELECT current_setting('app.current_tenant', true) AS v`;
    expect(afterRollback[0]!.v ?? '').toBe('');
    expect(await countUser(probeOne, userT)).toBe(0);
  });

  it('with no tenant bound, a transaction stays unbound: it sees nothing (fail closed)', async () => {
    expect(await walled.$transaction(async (tx) => countUser(tx, userT))).toBe(0);
  });

  it('with binding OFF nothing is set at all', async () => {
    delete process.env['TENANT_RLS_BIND'];
    try {
      const v = await runWithTenant(T, () => walled.$transaction(async (tx) =>
        tx.$queryRaw<Array<{ v: string | null }>>`SELECT current_setting('app.current_tenant', true) AS v`));
      expect(v[0]!.v ?? '').toBe('');
    } finally {
      process.env['TENANT_RLS_BIND'] = '1';
    }
  });
});
