import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import {
  TENANT_POLICY_CONTRACT,
  assertTenantPolicyContract,
  normalizePolicyExpression,
  readTenantPolicyContract,
  tenantPolicyContractGaps,
  type TenantPolicyContractFacts,
} from '../lib/rls-attestation';
import { rlsDdlFor } from '../lib/tenant-rls';
import { attestTenantWallAtBoot } from '../boot/tenant-wall';

// [R048-001] Each drift below is applied by raw DDL INSIDE a transaction that
// is always rolled back — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [DB-01] The runtime attestation reads the tenant POLICIES, not only the
// role and the table flags.
//
// readRlsFacts checked the role and each tenant table's ENABLE/FORCE flags and
// counted the tables; it never read pg_policy. A PUBLIC `USING (true)` policy
// beside the tenant policy, or a tenant policy whose USING / WITH CHECK was
// rewritten, left every flag and count unchanged. Now every registered tenant
// table must exist with its tenantId column and carry exactly the contract
// tenant policy (permissive, ALL commands, PUBLIC, the normalised predicate in
// both USING and WITH CHECK), with no other permissive policy beside it, on
// the schema queries actually resolve to — or production refuses to start.
// ---------------------------------------------------------------------------

const raw = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
afterAll(async () => { await raw.$disconnect(); });

const TABLE = 'eta_pad_stats';
const PROD = { NODE_ENV: 'production' };
const PROD_EXPAND = { ...PROD, TENANT_WALL_EXPAND_ATTESTED: '1' };
const quiet = { info: () => {}, warn: () => {} };

class RolledBack extends Error {}
/** Apply `ddl` in a transaction, measure inside it, and ALWAYS roll it back. */
async function underDrift<T>(ddl: string[], measure: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await raw.$transaction(async (tx) => {
      for (const statement of ddl) await tx.$executeRawUnsafe(statement);
      out = await measure(tx);
      throw new RolledBack();
    }, { timeout: 30_000 });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return out as T;
}

describe('[DB-01] the normalised policy contract', () => {
  it('PostgreSQL’s own rendering of the tenant predicate normalises to the contract', () => {
    const rendered = `(("tenantId" = current_setting('app.current_tenant'::text, true)) OR pg_has_role(CURRENT_USER, 'swift_bypass_rls'::name, 'MEMBER'::text))`;
    expect(normalizePolicyExpression(rendered)).toBe(TENANT_POLICY_CONTRACT);
    // Pinned, so a change to the contract is a reviewed change to this line.
    expect(TENANT_POLICY_CONTRACT).toBe(`"tenantId"=current_setting'app.current_tenant',trueORpg_has_roleCURRENT_USER,'swift_bypass_rls','MEMBER'`);
  });

  it.each([
    ['always true', 'true'],
    ['an added OR', `(("tenantId" = current_setting('app.current_tenant'::text, true)) OR pg_has_role(CURRENT_USER, 'swift_bypass_rls'::name, 'MEMBER'::text) OR true)`],
    ['the retired GUC bypass', `(("tenantId" = current_setting('app.current_tenant'::text, true)) OR (current_setting('app.bypass_tenant'::text, true) = 'on'::text))`],
    ['another bypass role', `(("tenantId" = current_setting('app.current_tenant'::text, true)) OR pg_has_role(CURRENT_USER, 'swift_app'::name, 'MEMBER'::text))`],
    ['another column', `(("vendorId" = current_setting('app.current_tenant'::text, true)) OR pg_has_role(CURRENT_USER, 'swift_bypass_rls'::name, 'MEMBER'::text))`],
    ['a missing-ok flag dropped', `(("tenantId" = current_setting('app.current_tenant'::text)) OR pg_has_role(CURRENT_USER, 'swift_bypass_rls'::name, 'MEMBER'::text))`],
  ])('a predicate that is not the contract (%s) does not normalise to it', (_label, expression) => {
    expect(normalizePolicyExpression(expression)).not.toBe(TENANT_POLICY_CONTRACT);
  });

  it('the migrated database satisfies the contract on every tenant table (the clean-replay check)', async () => {
    const contract = await readTenantPolicyContract(raw);
    expect(tenantPolicyContractGaps(contract)).toEqual([]);
    expect(contract.schema).toBe('public');
  });
});

describe('[DB-01] each drift is named, and production refuses to start on it', () => {
  const expectGap = (contract: TenantPolicyContractFacts, pattern: RegExp) => {
    expect(tenantPolicyContractGaps(contract).join('\n')).toMatch(pattern);
    expect(() => assertTenantPolicyContract(contract, PROD)).toThrow(pattern);
    // Outside production it is reported, never thrown.
    expect(() => assertTenantPolicyContract(contract, { NODE_ENV: 'test' })).not.toThrow();
  };

  it('an extra PUBLIC permissive USING (true) policy beside the tenant policy', async () => {
    const c = await underDrift([`CREATE POLICY db01_open ON "${TABLE}" AS PERMISSIVE FOR SELECT TO PUBLIC USING (true)`], readTenantPolicyContract);
    expect(c.extraPermissiveTables).toEqual([TABLE]);
    expect(c.nonCanonicalTables).toEqual([]);
    expectGap(c, /EXTRA_PERMISSIVE_POLICY.*eta_pad_stats/);
  });

  it('an extra permissive policy granted to one role only is still a widening', async () => {
    const c = await underDrift([`CREATE POLICY db01_role ON "${TABLE}" AS PERMISSIVE FOR ALL TO swift_app USING (true) WITH CHECK (true)`], readTenantPolicyContract);
    expect(c.extraPermissiveTables).toEqual([TABLE]);
  });

  it('an extra RESTRICTIVE policy only narrows the wall and is not a gap', async () => {
    const c = await underDrift([`CREATE POLICY db01_narrow ON "${TABLE}" AS RESTRICTIVE FOR ALL TO PUBLIC USING (true)`], readTenantPolicyContract);
    expect(tenantPolicyContractGaps(c)).toEqual([]);
  });

  it.each([
    ['USING rewritten', `ALTER POLICY tenant_isolation ON "${TABLE}" USING (true)`],
    ['WITH CHECK rewritten', `ALTER POLICY tenant_isolation ON "${TABLE}" WITH CHECK (true)`],
    ['the tenant policy dropped', `DROP POLICY tenant_isolation ON "${TABLE}"`],
    ['the tenant policy narrowed to one role', `ALTER POLICY tenant_isolation ON "${TABLE}" TO swift_app`],
  ])('%s', async (_label, ddl) => {
    const c = await underDrift([ddl], readTenantPolicyContract);
    expect(c.nonCanonicalTables).toEqual([TABLE]);
    expect(c.extraPermissiveTables).toEqual([]); // named once, as what it is
    expectGap(c, /POLICY_NOT_CANONICAL.*eta_pad_stats/);
  });

  it('the sanctioned audit-purge policies pass only exactly as reviewed, and never when they apply to the connected login', async () => {
    const S = 'sensitive_read_logs';
    // as installed by the reviewed migration: not a gap
    expect((await readTenantPolicyContract(raw)).extraPermissiveTables).not.toContain(S);
    // the same name widened to everyone
    expect((await underDrift([`ALTER POLICY audit_purge_owner_select ON "${S}" TO PUBLIC`], readTenantPolicyContract)).extraPermissiveTables).toEqual([S]);
    // the same name with another command
    expect((await underDrift([`DROP POLICY audit_purge_owner_select ON "${S}"`, `CREATE POLICY audit_purge_owner_select ON "${S}" FOR ALL TO swift_audit_purge_owner, swift_audit_purge_executor USING (true)`], readTenantPolicyContract)).extraPermissiveTables).toEqual([S]);
    // the sanctioned name on another tenant table
    expect((await underDrift([`CREATE POLICY audit_purge_owner_select ON "${TABLE}" FOR SELECT TO swift_audit_purge_owner, swift_audit_purge_executor USING (true)`], readTenantPolicyContract)).extraPermissiveTables).toEqual([TABLE]);
    // the connected (non-superuser) login made a member of the executor role
    const asMember = await underDrift([
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'swift_rls_probe') THEN CREATE ROLE swift_rls_probe NOLOGIN NOBYPASSRLS; END IF; END $$`,
      'GRANT swift_audit_purge_executor TO swift_rls_probe',
      'SET LOCAL ROLE swift_rls_probe',
    ], readTenantPolicyContract);
    expect(asMember.extraPermissiveTables).toEqual([S]);
  });

  it('the tenant policy re-created as RESTRICTIVE (no permissive tenant policy left)', async () => {
    const c = await underDrift([
      `DROP POLICY tenant_isolation ON "${TABLE}"`,
      ...rlsDdlFor(TABLE).filter((s) => s.startsWith('CREATE POLICY')).map((s) => s.replace('ON "eta_pad_stats"', 'ON "eta_pad_stats" AS RESTRICTIVE')),
    ], readTenantPolicyContract);
    expect(c.nonCanonicalTables).toEqual([TABLE]);
  });

  it.each([
    ['its tenantId column dropped', `ALTER TABLE "${TABLE}" DROP COLUMN "tenantId" CASCADE`],
    ['the table dropped', `DROP TABLE "${TABLE}" CASCADE`],
  ])('a registered tenant table with %s', async (_label, ddl) => {
    const c = await underDrift([ddl], readTenantPolicyContract);
    expect(c.missingTables).toEqual([TABLE]);
    expectGap(c, /TABLE_MISSING.*eta_pad_stats/);
  });

  it('a search_path that resolves names somewhere other than public', async () => {
    const c = await underDrift(['SET LOCAL search_path TO pg_catalog'], readTenantPolicyContract);
    expect(c.schema).toBe('pg_catalog');
    expectGap(c, /SCHEMA/);
  });

  it('the boot attestation refuses a drift in production even when the wall-less EXPAND posture is declared', async () => {
    await underDrift([`CREATE POLICY db01_open ON "${TABLE}" AS PERMISSIVE FOR SELECT TO PUBLIC USING (true)`], async (tx) => {
      await expect(attestTenantWallAtBoot(tx as never, quiet, PROD_EXPAND)).rejects.toThrow(/tenant policies are not the ones this code was built for[\s\S]*EXTRA_PERMISSIVE_POLICY/);
    });
    // Control: without the drift, whatever the posture verdict is, it is not the contract.
    const control = await attestTenantWallAtBoot(raw, quiet, PROD_EXPAND).then(() => null, (e: Error) => e.message);
    expect(control ?? '').not.toMatch(/tenant policies are not the ones/);
  });

  it('every drift above was rolled back: the contract holds again', async () => {
    expect(tenantPolicyContractGaps(await readTenantPolicyContract(raw))).toEqual([]);
  });
});
