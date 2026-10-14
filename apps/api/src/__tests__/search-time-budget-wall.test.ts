import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { scopedPrisma as prisma, scopedClientFor } from '../plugins/prisma';
import { runAsSystem, runWithTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { boundedRead, isOutOfTime } from '../modules/search/search-budget';

grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [Review S2-1 · time bound] A bounded search read under the database wall.
//
// boundedRead opens an interactive transaction and sets a LOCAL statement
// timeout. Under TENANT_RLS_BIND=1 the same transaction is bound to the
// request tenant first (plugins/prisma.ts, R5 auto-bind). Both settings must
// hold for the read inside it, and BOTH must be gone from the pooled
// connection afterwards, on success and when the database cancels the read.
// Run as a NOBYPASSRLS login on ONE connection, so a leak would be seen.
// ---------------------------------------------------------------------------

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const PROBE_LOGIN = 'swift_rls_probe_login';
const SYSTEM_LOGIN = 'swift_rls_system_login';
const withLogin = (login: string, extra = '') => {
  const url = TEST_URL.replace(/\/\/[^@]+@/, `//${login}:probe@`);
  return extra ? `${url}${url.includes('?') ? '&' : '?'}${extra}` : url;
};
const T = `stb-t-${nanoid(6)}`;
const U = `stb-u-${nanoid(6)}`;
let userT = '';
let userU = '';
let probeOne: PrismaClient;
let sysRaw: PrismaClient;
let walledOne: PrismaClient;
const restoreBind = process.env['TENANT_RLS_BIND'];

type Settings = { timeout: number; tenant: string | null };
const settingsOn = (db: { $queryRaw: PrismaClient['$queryRaw'] }) =>
  db.$queryRaw<Array<{ timeout: string; tenant: string | null }>>`
    SELECT (SELECT setting FROM pg_settings WHERE name = 'statement_timeout') AS timeout,
           NULLIF(current_setting('app.current_tenant', true), '') AS tenant`
    .then((r): Settings => ({ timeout: Number(r[0]!.timeout), tenant: r[0]!.tenant }));

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
    for (const t of [T, U]) await prisma.tenant.create({ data: { id: t, name: `Budget wall ${t}`, slug: t } });
    userT = (await prisma.user.create({ data: { phone: `+5928${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, firstName: 'Budget', lastName: 'T', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: T } })).id;
    userU = (await prisma.user.create({ data: { phone: `+5928${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, firstName: 'Budget', lastName: 'U', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: U } })).id;
  });
  probeOne = new PrismaClient({ datasourceUrl: withLogin(PROBE_LOGIN, 'connection_limit=1') });
  sysRaw = new PrismaClient({ datasourceUrl: withLogin(SYSTEM_LOGIN) });
  walledOne = scopedClientFor(probeOne, sysRaw);
  process.env['TENANT_RLS_BIND'] = '1';
});

afterAll(async () => {
  if (restoreBind === undefined) delete process.env['TENANT_RLS_BIND']; else process.env['TENANT_RLS_BIND'] = restoreBind;
  await runAsSystem('test-teardown', async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userT, userU].filter(Boolean) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [T, U] } } });
  });
  await probeOne?.$disconnect().catch(() => {});
  await sysRaw?.$disconnect().catch(() => {});
});

describe('a bounded search read under the tenant wall', () => {
  it('the read sees only the bound tenant and runs under the timeout; afterwards the connection holds neither setting', async () => {
    const before = await settingsOn(probeOne);
    expect(before.tenant).toBeNull();
    const { rows, inside } = await runWithTenant(T, () => boundedRead(walledOne, Date.now() + 800, async (tx) => ({
      rows: await tx.user.findMany({ where: { id: { in: [userT, userU] } }, select: { id: true } }),
      inside: await settingsOn(tx),
    })));
    expect(rows.map((r) => r.id)).toEqual([userT]); // tenant U's row is behind the wall
    expect(inside.tenant).toBe(T);
    expect(inside.timeout).toBeGreaterThan(0);
    expect(inside.timeout).toBeLessThanOrEqual(800);
    // the same (only) pooled connection, outside any transaction
    expect(await settingsOn(probeOne)).toEqual(before);
    const unbound = await probeOne.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "users" WHERE "id" = ANY(${[userT, userU]})`;
    expect(unbound[0]!.n).toBe(0); // fail closed: the tenant did not stay on the connection
  });

  it('a read the database cancels for time rolls back clean: out of time, and nothing left on the connection', async () => {
    const before = await settingsOn(probeOne);
    const start = Date.now();
    const err = await runWithTenant(T, () => boundedRead(walledOne, Date.now() + 200, (tx) => tx.$queryRaw`SELECT pg_sleep(3)`))
      .then(() => null, (e: unknown) => e);
    expect(isOutOfTime(err)).toBe(true);
    expect(Date.now() - start).toBeLessThan(2_500);
    expect(await settingsOn(probeOne)).toEqual(before);
    // and the next bound read on that connection works normally
    const again = await runWithTenant(T, () => boundedRead(walledOne, Date.now() + 800, (tx) => tx.user.findMany({ where: { id: { in: [userT, userU] } }, select: { id: true } })));
    expect(again.map((r) => r.id)).toEqual([userT]);
  });
});
