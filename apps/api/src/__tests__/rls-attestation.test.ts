import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { grantSuiteCapability } from '../lib/test-target-lock';
import {
  attestationOf,
  attestationLine,
  explainBypass,
  readRlsFacts,
  assertTenantWall,
  type RlsFacts,
  appSideWallGaps,
} from '../lib/rls-attestation';

// This suite creates a throwaway table to prove the owner filter actually
// filters; without DDL the test-mode guard refuses.
grantSuiteCapability('ddl');

/** The CONTRACT-complete posture: nothing bypasses, and there is something to wall. */
const ENFORCED: RlsFacts = {
  role: 'swift_runtime',
  roleResolved: true,
  isSuperuser: false,
  hasBypassRls: false,
  tenantTables: 76,
  rlsDisabledTables: 0,
  ownedUnforcedTables: 0,
};

const PROD = { NODE_ENV: 'production' };
/** The posture that boots with a second tenant: the database wall AND the app's side of it. */
const PROD_HELD_UP = { ...PROD, TENANT_RLS_BIND: '1', TENANT_UNSCOPED_ACCESS: 'deny' };

describe('[TA-S0-003] the attestation names every way the wall fails to bind', () => {
  it('a fully contracted role is enforced and lists no bypass', () => {
    const a = attestationOf(ENFORCED);
    expect(a.enforced).toBe(true);
    expect(a.bypasses).toEqual([]);
  });

  // Each of the four, alone, must be enough to lose enforcement — otherwise a
  // deployment that fixes three of them reads as safe while still bypassing.
  it.each([
    ['UNKNOWN_ROLE', { roleResolved: false }],
    ['SUPERUSER', { isSuperuser: true }],
    ['BYPASSRLS', { hasBypassRls: true }],
    ['RLS_DISABLED', { rlsDisabledTables: 1 }],
    ['OWNER_NOT_FORCED', { ownedUnforcedTables: 1 }],
  ] as const)('%s alone breaks enforcement', (bypass, override) => {
    const a = attestationOf({ ...ENFORCED, ...override });
    expect(a.enforced).toBe(false);
    expect(a.bypasses).toContain(bypass);
  });

  it('reports every bypass that applies, not just the first', () => {
    const a = attestationOf({
      ...ENFORCED,
      isSuperuser: true,
      hasBypassRls: true,
      ownedUnforcedTables: 76,
    });
    expect(a.bypasses).toEqual(['SUPERUSER', 'BYPASSRLS', 'OWNER_NOT_FORCED']);
  });

  // The measured posture of the shipped credential, 3 Sep 2026. If this ever
  // reads "enforced", the CONTRACT stage has landed and the gate below is live.
  // An unreadable pg_roles must never read as a clean bill — a mutation that
  // defaulted the superuser fact to `true` originally survived here, because
  // the probe's failure path had no opinion at all.
  it('an unresolvable role is a bypass, never silence', () => {
    const a = attestationOf({ ...ENFORCED, roleResolved: false });
    expect(a.enforced).toBe(false);
    expect(a.bypasses).toEqual(['UNKNOWN_ROLE']);
    expect(explainBypass('UNKNOWN_ROLE', a.facts)).toMatch(/unknown/i);
  });

  it('refuses tenant-two when the role could not be read at all', () => {
    const blind = attestationOf({ ...ENFORCED, roleResolved: false });
    expect(() => assertTenantWall(blind, 2, PROD)).toThrow(/unknown/i);
  });

  it('the posture this platform actually ships today is NOT enforced', () => {
    const a = attestationOf({
      role: 'swift',
      roleResolved: true,
      isSuperuser: true,
      hasBypassRls: true,
      tenantTables: 76,
      rlsDisabledTables: 0,
      ownedUnforcedTables: 76,
    });
    expect(a.enforced).toBe(false);
    expect(a.bypasses).toEqual(['SUPERUSER', 'BYPASSRLS', 'OWNER_NOT_FORCED']);
  });

  // A probe that finds nothing is a broken census, never a clean bill of health.
  it('zero tenant tables is not enforcement', () => {
    const a = attestationOf({ ...ENFORCED, tenantTables: 0 });
    expect(a.enforced).toBe(false);
  });

  it('explains each bypass with the role and the count that produced it', () => {
    const facts = { ...ENFORCED, role: 'swift', ownedUnforcedTables: 76, rlsDisabledTables: 3 };
    expect(explainBypass('UNKNOWN_ROLE', facts)).toContain('swift');
    expect(explainBypass('SUPERUSER', facts)).toContain('swift');
    expect(explainBypass('BYPASSRLS', facts)).toContain('BYPASSRLS');
    expect(explainBypass('RLS_DISABLED', facts)).toContain('3');
    expect(explainBypass('OWNER_NOT_FORCED', facts)).toContain('76');
  });

  it('the log line carries the state and the numbers behind it', () => {
    const line = attestationLine(attestationOf({ ...ENFORCED, isSuperuser: true }));
    expect(line).toContain('bypassed(SUPERUSER)');
    expect(line).toContain('tenantTables=76');
    expect(attestationLine(attestationOf(ENFORCED))).toContain('enforced');
  });
});

describe('[TA-S0-003] the tenant-two gate', () => {
  const bypassed = attestationOf({ ...ENFORCED, isSuperuser: true });

  it('refuses production boot with a second tenant and no wall', () => {
    expect(() => assertTenantWall(bypassed, 2, PROD)).toThrow(/tenant wall does not bind/i);
  });

  it('names the bypass in the failure, so the fix is obvious from the log', () => {
    expect(() => assertTenantWall(bypassed, 2, PROD)).toThrow(/superuser/i);
  });

  it('single-tenant production boots — the sanctioned EXPAND state', () => {
    expect(() => assertTenantWall(bypassed, 1, PROD)).not.toThrow();
    expect(() => assertTenantWall(bypassed, 0, PROD)).not.toThrow();
  });

  it('an enforced wall, with the app holding up its end, boots at any tenant count', () => {
    expect(() => assertTenantWall(attestationOf(ENFORCED), 50, PROD_HELD_UP)).not.toThrow();
  });

  it('development is never gated — local stacks run owner-mode by design', () => {
    expect(() => assertTenantWall(bypassed, 99, { NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertTenantWall(bypassed, 99, { NODE_ENV: 'test' })).not.toThrow();
  });
});

describe('[TA-S0-003] the facts come from the database, not from config', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('reads the posture of the credential this process actually authenticated as', async () => {
    const facts = await readRlsFacts(app.prisma);

    // Cross-check every number against the catalogue directly, so the helper
    // cannot drift from the truth it claims to report.
    const [truth] = await app.prisma.$queryRaw<Array<{
      role: string; superuser: boolean; bypassrls: boolean;
      total: bigint; disabled: bigint; owned_unforced: bigint;
    }>>`
      SELECT current_user::text AS role,
              (SELECT COALESCE(rolsuper,false) FROM pg_roles WHERE rolname = current_user)     AS superuser,
              (SELECT COALESCE(rolbypassrls,false) FROM pg_roles WHERE rolname = current_user) AS bypassrls,
              (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
                WHERE c.relkind='r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenantId' AND NOT a.attisdropped)) AS total,
              (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
                WHERE c.relkind='r' AND NOT c.relrowsecurity AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenantId' AND NOT a.attisdropped)) AS disabled,
              (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
                WHERE c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity
                  AND pg_get_userbyid(c.relowner) = current_user
                  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenantId' AND NOT a.attisdropped)) AS owned_unforced`;

    expect(truth, 'the catalogue cross-check returned no row').toBeDefined();
    if (!truth) return;
    expect(facts.roleResolved).toBe(true);
    expect(facts.role).toBe(truth.role);
    expect(facts.isSuperuser).toBe(truth.superuser);
    expect(facts.hasBypassRls).toBe(truth.bypassrls);
    expect(facts.tenantTables).toBe(Number(truth.total));
    expect(facts.rlsDisabledTables).toBe(Number(truth.disabled));
    expect(facts.ownedUnforcedTables).toBe(Number(truth.owned_unforced));
  });

  // Every table in a normal test database is owned by the connecting role, so
  // `pg_get_userbyid(relowner) = current_user` is a no-op here and a mutation
  // that deletes it survives. A table owned by SOMEONE ELSE is the only way to
  // prove the filter filters.
  it('does not count a walled table owned by a different role', async () => {
    const probe = 'rls_attest_probe';
    await app.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${probe}"`);
    const before = await readRlsFacts(app.prisma);
    await app.prisma.$executeRawUnsafe(`CREATE TABLE "${probe}" (id text PRIMARY KEY, "tenantId" text NOT NULL)`);
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "${probe}" ENABLE ROW LEVEL SECURITY`);
    await app.prisma.$executeRawUnsafe(`ALTER TABLE "${probe}" OWNER TO swift_app`);
    try {
      const after = await readRlsFacts(app.prisma);
      // It IS a tenant-bearing walled table...
      expect(after.tenantTables).toBe(before.tenantTables + 1);
      // ...but it is not OURS to bypass, so the owner-bypass count must not move.
      expect(after.ownedUnforcedTables).toBe(before.ownedUnforcedTables);
    } finally {
      await app.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${probe}"`);
    }
  });

  it('the schema really does carry tenant tables — a zero here means the probe is wrong', async () => {
    const facts = await readRlsFacts(app.prisma);
    expect(facts.tenantTables).toBeGreaterThan(50);
  });
});

describe('[TA-S0-003] readRlsFacts maps what the catalogue returns — including nothing', () => {
  // The real database always resolves its own role, so the probe's failure
  // path is unreachable from an integration test. A stub is the only way to
  // traverse it — and it must be traversed, because "we could not look" is
  // exactly the case a security attestation must not report as clean.
  const stub = (rows: unknown[][]) => {
    let call = 0;
    return { $queryRaw: async <T,>() => rows[call++] as T };
  };

  it('an empty pg_roles result is roleResolved=false, and the verdict is a bypass', async () => {
    const facts = await readRlsFacts(stub([[], [{ total: 76n, disabled: 0n, owned_unforced: 0n }]]));
    expect(facts.roleResolved).toBe(false);
    expect(facts.role).toBe('unknown');
    // We failed to READ these, so we must not INVENT them either way: report
    // them false and let UNKNOWN_ROLE — not a fabricated attribute — carry the
    // verdict. A log line claiming "superuser: true" about a role we could not
    // look up would send an operator chasing a permission that may not exist.
    expect(facts.isSuperuser).toBe(false);
    expect(facts.hasBypassRls).toBe(false);
    expect(attestationOf(facts).enforced).toBe(false);
    expect(attestationOf(facts).bypasses).toContain('UNKNOWN_ROLE');
  });

  it('an unreadable role never reports a permissive default for the attributes it could not read', async () => {
    const facts = await readRlsFacts(stub([[], [{ total: 76n, disabled: 0n, owned_unforced: 0n }]]));
    // Whatever these default to, the verdict must not depend on them being
    // benign — UNKNOWN_ROLE carries the failure on its own.
    expect(attestationOf({ ...facts, isSuperuser: false, hasBypassRls: false }).enforced).toBe(false);
    expect(attestationOf({ ...facts, isSuperuser: true, hasBypassRls: true }).enforced).toBe(false);
  });

  it('a resolved role is mapped faithfully, bigint counts included', async () => {
    const facts = await readRlsFacts(stub([
      [{ role: 'swift_runtime', superuser: false, bypassrls: false }],
      [{ total: 76n, disabled: 2n, owned_unforced: 5n }],
    ]));
    expect(facts).toEqual({
      role: 'swift_runtime',
      roleResolved: true,
      isSuperuser: false,
      hasBypassRls: false,
      tenantTables: 76,
      rlsDisabledTables: 2,
      ownedUnforcedTables: 5,
    });
  });

  it('an empty table census is zero, not NaN', async () => {
    const facts = await readRlsFacts(stub([[{ role: 'r', superuser: false, bypassrls: false }], []]));
    expect(facts.tenantTables).toBe(0);
    expect(attestationOf(facts).enforced).toBe(false);
  });
});

describe('[TA-S0-003] the gate cannot be outflanked by a new tenant-creation path', () => {
  // The boot gate is sufficient ONLY while production has no runtime route
  // that mints a tenant. If one is ever added, it must call assertTenantWall —
  // this census goes red the day a new `tenant.create` appears in production
  // code, so the reasoning behind the boot-only gate cannot rot silently.
  // review/provision.ts calls assertTenantWall before it mints the review tenant.
  const ALLOWED = new Set(['modules/ops/platform-config.ts', 'modules/review/provision.ts']);

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  it('platform-config is still the only production code that creates a tenant', () => {
    const root = join(__dirname, '..');
    const offenders = sourceFiles(root)
      .filter((f) => /\btenant\.(create|upsert|createMany)\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
      .filter((rel) => !ALLOWED.has(rel));

    expect(
      offenders,
      'A new tenant-creation path makes the boot-only wall gate insufficient: call assertTenantWall there, then add the file here.',
    ).toEqual([]);
  });
});

describe('[STA-1 4.1 / DL-2] with a second tenant, the APPLICATION side of the wall is required too', () => {
  const enforced = attestationOf(ENFORCED);
  const HELD_UP = PROD_HELD_UP;

  it('a bound, denying app in front of an enforced wall boots with two tenants', () => {
    expect(() => assertTenantWall(enforced, 2, HELD_UP)).not.toThrow();
    expect(appSideWallGaps(HELD_UP)).toEqual([]);
  });

  it('an enforced wall the app never binds is refused — by name', () => {
    expect(() => assertTenantWall(enforced, 2, { ...HELD_UP, TENANT_RLS_BIND: undefined })).toThrow(/TENANT_RLS_BIND/);
    expect(() => assertTenantWall(enforced, 2, { ...HELD_UP, TENANT_RLS_BIND: '0' })).toThrow(/does not hold up its end/);
  });

  it('an enforced wall with unscoped access merely logged is refused — by name', () => {
    expect(() => assertTenantWall(enforced, 2, { ...HELD_UP, TENANT_UNSCOPED_ACCESS: undefined })).toThrow(/TENANT_UNSCOPED_ACCESS/);
    expect(() => assertTenantWall(enforced, 2, { ...HELD_UP, TENANT_UNSCOPED_ACCESS: 'log' })).toThrow(/merely counted/);
  });

  it('both gaps are named at once, so one restart fixes both', () => {
    expect(appSideWallGaps(PROD)).toHaveLength(2);
    expect(() => assertTenantWall(enforced, 2, PROD)).toThrow(/TENANT_RLS_BIND[\s\S]*TENANT_UNSCOPED_ACCESS/);
  });

  it('the database side is named first when both sides are missing', () => {
    const bypassed = attestationOf({ ...ENFORCED, isSuperuser: true });
    expect(() => assertTenantWall(bypassed, 2, PROD)).toThrow(/tenant wall does not bind/i);
  });

  it('one tenant is the sanctioned EXPAND state and boots without either; outside production nothing is asserted', () => {
    expect(() => assertTenantWall(enforced, 1, PROD)).not.toThrow();
    expect(() => assertTenantWall(enforced, 2, { NODE_ENV: 'development' })).not.toThrow();
  });
});
