import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { scopedPrisma as prisma, tenantScopeExtensionFor, bindTenantTransaction } from '../plugins/prisma';
import { tenantContext, runAsSystem, runWithTenant, runWithoutTenant, getTenantContext } from '../plugins/tenant-context';
import { tenantUnscopedAccessCounter, tenantBindCounter } from '../plugins/observability';
import { TENANT_TABLES, forceRlsStatements } from '../lib/tenant-rls';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] this suite creates the NOLOGIN probe role and GRANTs it table access by raw DDL to prove the RLS wall from outside the app — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [TEN-01 / TEN-03] The tenant wall binds the app.
//
// TEN-01's red test: every composition root must declare a tenant or a typed
// audited system capability; undeclared database access must fail. TEN-03's
// red test: boot an isolated client with the exact intended app role — tenant
// A sees only A for ORM and raw SQL, and missing context sees zero rows.
// Shadow first: under the default `log` policy the old behaviour holds and is
// COUNTED; `deny` refuses; `TENANT_RLS_BIND=1` binds transaction-locally.
// ---------------------------------------------------------------------------

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const PROBE_LOGIN = 'swift_rls_probe_login';
const PROBE_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${PROBE_LOGIN}:probe@`);
const SYSTEM_LOGIN = 'swift_rls_system_login';
const SYSTEM_URL = TEST_URL.replace(/\/\/[^@]+@/, `//${SYSTEM_LOGIN}:probe@`);
const A = `wall-a-${nanoid(6)}`; const B = `wall-b-${nanoid(6)}`;
const userIds: string[] = [];
let raw: PrismaClient; let sysRaw: PrismaClient; let probe: PrismaClient; let probeNoSystem: PrismaClient;
const counterValue = (labels: Record<string, string>) => tenantUnscopedAccessCounter.get().then((m) => m.values.filter((v) => Object.entries(labels).every(([k, val]) => (v.labels as Record<string, string>)[k] === val)).reduce((n, v) => n + v.value, 0));
const bindValue = (kind: string) => tenantBindCounter.get().then((m) => m.values.filter((v) => (v.labels as Record<string, string>)['kind'] === kind).reduce((n, v) => n + v.value, 0));

beforeAll(async () => {
  await runAsSystem('test-setup', async () => {
    for (const t of [A, B]) await prisma.tenant.create({ data: { id: t, name: `Wall ${t}`, slug: t } });
    for (const t of [A, B]) {
      const u = await prisma.user.create({ data: { phone: `+5927${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, firstName: 'Wall', lastName: t, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: t } });
      userIds.push(u.id);
    }
  });
  // The intended app role, isolated: a LOGIN inheriting the NOBYPASSRLS probe group
  // (table grants), and the sanctioned bypass group for system work.
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_rls_probe') THEN CREATE ROLE swift_rls_probe NOLOGIN NOBYPASSRLS; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO swift_rls_probe`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO swift_rls_probe`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO swift_rls_probe`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_LOGIN}') THEN CREATE ROLE ${PROBE_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_rls_probe TO ${PROBE_LOGIN}`,
    // the SYSTEM login: its own connection, a member of the sanctioned bypass role — never the request login
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_LOGIN}') THEN CREATE ROLE ${SYSTEM_LOGIN} LOGIN PASSWORD 'probe' NOBYPASSRLS; END IF; END $$`,
    `GRANT swift_rls_probe TO ${SYSTEM_LOGIN}`,
    `GRANT swift_bypass_rls TO ${SYSTEM_LOGIN}`,
  ];
  for (const sql of statements) await prisma.$executeRawUnsafe(sql);
  raw = new PrismaClient({ datasourceUrl: PROBE_URL });
  sysRaw = new PrismaClient({ datasourceUrl: SYSTEM_URL });
  probe = raw.$extends(tenantScopeExtensionFor(raw, sysRaw)) as unknown as PrismaClient;
  probeNoSystem = raw.$extends(tenantScopeExtensionFor(raw, null)) as unknown as PrismaClient;
});
afterEach(() => { delete process.env['TENANT_UNSCOPED_ACCESS']; delete process.env['TENANT_RLS_BIND']; });
afterAll(async () => {
  await raw.$disconnect().catch(() => {});
  await sysRaw.$disconnect().catch(() => {});
  await runAsSystem('test-teardown', async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
  });
});

const mine = () => ({ where: { id: { in: userIds } }, select: { id: true, tenantId: true } });
const mineWhere = () => ({ where: { id: { in: userIds } } });

describe('[TEN-01] undeclared database access is a decision, not a default', () => {
  it('the register’s red test: under `deny`, a request with no tenant bound and an unbound composition are refused; a bound tenant and an audited system capability are not', async () => {
    process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
    // a request that never bound its tenant
    // (a Prisma promise runs its extension when it is awaited — the scope must still be open then, so the callback awaits)
    await expect(tenantContext.run({ tenantId: null, mode: 'request' }, async () => await prisma.user.findMany(mine()))).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', message: expect.stringContaining('(request)') });
    // a composition root that never began a context at all
    expect(getTenantContext().mode).toBe('unbound');
    await expect(prisma.user.findMany(mine())).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED', message: expect.stringContaining('(unbound)') });
    // a bound tenant sees its own
    const a = await runWithTenant(A, () => prisma.user.findMany(mine()));
    expect(a.map((u) => u.tenantId)).toEqual([A]);
    // audited system work sees every tenant, and says who it is
    const before = await counterValue({ model: 'User', mode: 'system', capability: 'wall-census' });
    const all = await runAsSystem('wall-census', () => prisma.user.findMany(mine()));
    expect(all.map((u) => u.tenantId).sort()).toEqual([A, B].sort());
    expect(await counterValue({ model: 'User', mode: 'system', capability: 'wall-census' })).toBe(before + 1);
    // the legacy helper is the same capability under its legacy name — counted so it can be named
    const legacyBefore = await counterValue({ model: 'User', mode: 'system', capability: 'legacy-unscoped' });
    await runWithoutTenant(() => prisma.user.count(mineWhere()));
    expect(await counterValue({ model: 'User', mode: 'system', capability: 'legacy-unscoped' })).toBe(legacyBefore + 1);
    await expect(runAsSystem('', () => prisma.user.count(mineWhere()))).rejects.toThrow(/capability name/);
  });

  it('the shadow (default `log`): the same accesses run as before and are COUNTED by model, operation and mode', async () => {
    const before = await counterValue({ model: 'User', operation: 'findMany', mode: 'unbound' });
    const all = await prisma.user.findMany(mine());
    expect(all).toHaveLength(2);
    expect(await counterValue({ model: 'User', operation: 'findMany', mode: 'unbound' })).toBe(before + 1);
    const reqBefore = await counterValue({ model: 'User', operation: 'count', mode: 'request' });
    expect(await tenantContext.run({ tenantId: null, mode: 'request' }, async () => await prisma.user.count(mineWhere()))).toBe(2);
    expect(await counterValue({ model: 'User', operation: 'count', mode: 'request' })).toBe(reqBefore + 1);
  });
});

describe('[TEN-03] the database wall binds the app under the intended role', () => {
  it('the register’s red test: as the NOBYPASSRLS login with binding on, tenant A sees only A for ORM and raw SQL, missing context sees ZERO rows, and system work sees every tenant through the sanctioned bypass role', async () => {
    process.env['TENANT_RLS_BIND'] = '1';
    const asA = await runWithTenant(A, () => probe.user.findMany({ where: { id: { in: userIds } }, select: { id: true, tenantId: true } }));
    expect(asA.map((u) => u.tenantId)).toEqual([A]);
    // raw SQL inside the caller's own transaction, bound the same way
    const rawA = await runWithTenant(A, () => raw.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
      return tx.$queryRaw<Array<{ tenantId: string }>>`SELECT "tenantId" FROM "users" WHERE "id" = ANY(${userIds})`;
    }));
    expect(rawA.map((r) => r.tenantId)).toEqual([A]);
    // missing context: the database shows nothing — fail closed, not a leak
    const unbound = await probe.user.findMany({ where: { id: { in: userIds } } });
    expect(unbound).toHaveLength(0);
    const rawUnbound = await raw.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "users" WHERE "id" = ANY(${userIds})`;
    expect(rawUnbound).toHaveLength(0);
    // audited system work: its OWN client (the bypass-member login) — never a SET ROLE on the walled login
    const sys = await runAsSystem('wall-probe', () => probe.user.findMany({ where: { id: { in: userIds } }, select: { tenantId: true } }));
    expect(sys.map((u) => u.tenantId).sort()).toEqual([A, B].sort());
    // without a system client, system work on the walled login is fail closed: zero rows, no leak
    const sysNone = await runAsSystem('wall-probe', () => probeNoSystem.user.findMany({ where: { id: { in: userIds } } }));
    expect(sysNone).toHaveLength(0);
    // and the walled login cannot bypass by any role it holds
    const bypassAttempt = await raw.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER') AS ok`;
    expect(bypassAttempt[0]!.ok).toBe(false);
    // the app's own client binds the same way (counted), and the runbook's contract statements cover the whole census
    const b = await bindValue('tenant');
    await runWithTenant(A, () => prisma.user.count(mineWhere()));
    expect(await bindValue('tenant')).toBe(b + 1);
    expect(forceRlsStatements()).toHaveLength(TENANT_TABLES.length);
    expect(forceRlsStatements()[0]).toMatch(/FORCE ROW LEVEL SECURITY;$/);
  });

  it('with binding off (today), the same login sees zero rows for every tenant — which is why the flag stays off until the runbook runs', async () => {
    const asA = await runWithTenant(A, () => probe.user.findMany({ where: { id: { in: userIds } } }));
    expect(asA).toHaveLength(0);
  });
});
