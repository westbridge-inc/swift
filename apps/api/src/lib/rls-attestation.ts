import { runtimeMode } from '../utils/runtime-mode';

/**
 * [TA-S0-003 / TEN-03] Does the database tenant wall actually bind THIS process?
 *
 * `tenant-rls.ts` documents the staged rollout honestly: EXPAND ships the
 * policies with RLS ENABLED but not FORCED, the app connects as the table
 * owner, and owners bypass non-forced RLS — a deliberate zero-behaviour-change
 * step. CONTRACT (the least-privilege LOGIN + `forceRlsStatements()`) is the
 * founder's deployment decision and has not happened.
 *
 * The gap this closes is not the missing CONTRACT — it is that NOTHING
 * MEASURES WHICH STAGE IS RUNNING. 76 tables carry a `tenant_isolation`
 * policy; a reader (or a launch claim) sees "RLS is on" and concludes there is
 * a database wall. Under the shipped credential there is none, and the process
 * never said so. Measured on a real boot, 3 Sep 2026: connected as `swift`,
 * which is the table owner AND holds BYPASSRLS AND is a superuser — three
 * independent bypasses — and 0 of 76 walled tables are FORCE'd. Scoped to one
 * tenant, that credential read, UPDATEd and DELETEd another tenant's row.
 *
 * So: attest the posture out loud at boot (REPORT-042 names this telemetry
 * "DB role/row-security boot attestation"), and make the spec's own rule —
 * "block tenant two until contract complete" — structural rather than a
 * sentence in a document.
 *
 * Why a BOOT gate is sufficient, and not a per-request one: production has
 * exactly one tenant-creating path (`platform-config.ts` mints `swift-default`
 * once), and no admin route creates a tenant. A second tenant can therefore
 * only arrive out-of-band — a script or a migration — and this refuses the
 * next start. If a runtime tenant-creation route is ever added, it must call
 * `assertTenantWall` too; the census test in `rls-attestation.test.ts` fails
 * if a new `tenant.create` appears in production code without it.
 *
 * This module deliberately does NOT force RLS. Forcing while the app still
 * connects as owner and never sets `app.current_tenant` per request would take
 * the platform from "no wall" to "every query returns zero rows" — an outage
 * dressed as a fix. FORCE lands with the login, together, in one deliberate
 * migration; `forceRlsStatements()` already exists for that day.
 */

/**
 * The distinct ways the wall fails to bind the connected credential.
 *
 * `UNKNOWN_ROLE` is a bypass, not a separate "inconclusive" state: a probe
 * that cannot read `pg_roles` for its own role has learned nothing, and an
 * attestation that reports "no bypass found" when it failed to look is worse
 * than no attestation at all. Unknown posture is unsafe posture.
 */
export type RlsBypass = 'UNKNOWN_ROLE' | 'SUPERUSER' | 'BYPASSRLS' | 'RLS_DISABLED' | 'OWNER_NOT_FORCED';

export interface RlsFacts {
  /** The role the pool actually authenticated as — not the configured one. */
  role: string;
  /** False when `pg_roles` yielded no row for `current_user` — see UNKNOWN_ROLE. */
  roleResolved: boolean;
  isSuperuser: boolean;
  hasBypassRls: boolean;
  /** Tables in `public` carrying a `tenantId` column. */
  tenantTables: number;
  /** ...of those, with row security not enabled at all. */
  rlsDisabledTables: number;
  /** ...of those, owned by the connected role and not FORCE'd (owner bypass). */
  ownedUnforcedTables: number;
}

export interface RlsAttestation {
  facts: RlsFacts;
  /** Every bypass that applies, in escalation order. Empty = the wall binds. */
  bypasses: RlsBypass[];
  /** True only when the database itself would refuse a cross-tenant read. */
  enforced: boolean;
}

/** One line per bypass, written for whoever reads the boot log at 3am. */
export function explainBypass(bypass: RlsBypass, facts: RlsFacts): string {
  switch (bypass) {
    case 'UNKNOWN_ROLE':
      return `could not read pg_roles for "${facts.role}" — the posture of this credential is unknown, which is never a clean bill`;
    case 'SUPERUSER':
      return `role "${facts.role}" is a superuser — PostgreSQL exempts superusers from every policy`;
    case 'BYPASSRLS':
      return `role "${facts.role}" holds the BYPASSRLS attribute`;
    case 'RLS_DISABLED':
      return `${facts.rlsDisabledTables} tenant-bearing table(s) have no row security enabled at all`;
    case 'OWNER_NOT_FORCED':
      return `${facts.ownedUnforcedTables} walled table(s) are owned by "${facts.role}" and not FORCE'd — owners bypass non-forced RLS`;
  }
}

/**
 * The verdict, as a pure function of the facts, so it can be tested without a
 * database and mutated without a fixture.
 *
 * `tenantTables === 0` is NOT enforcement: it means the probe found nothing to
 * wall, which is a broken census or a wrong schema — never a clean bill.
 */
export function attestationOf(facts: RlsFacts): RlsAttestation {
  const bypasses: RlsBypass[] = [];
  if (!facts.roleResolved) bypasses.push('UNKNOWN_ROLE');
  if (facts.isSuperuser) bypasses.push('SUPERUSER');
  if (facts.hasBypassRls) bypasses.push('BYPASSRLS');
  if (facts.rlsDisabledTables > 0) bypasses.push('RLS_DISABLED');
  if (facts.ownedUnforcedTables > 0) bypasses.push('OWNER_NOT_FORCED');
  return { facts, bypasses, enforced: bypasses.length === 0 && facts.tenantTables > 0 };
}

/** A single log/metric-friendly line: `bypassed(SUPERUSER,BYPASSRLS) role=swift walled=76 forced=0`. */
export function attestationLine(attestation: RlsAttestation): string {
  const { facts } = attestation;
  const state = attestation.enforced ? 'enforced' : `bypassed(${attestation.bypasses.join(',')})`;
  return `${state} role=${facts.role} tenantTables=${facts.tenantTables} rlsDisabled=${facts.rlsDisabledTables} ownedUnforced=${facts.ownedUnforcedTables}`;
}

/** Tagged-template raw only — `sql-safety-surface.test.ts` forbids the Unsafe
 *  variants in production code, and rightly: these queries take no input, so a
 *  parameterised template is strictly better than a string. */
type RawDb = {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

/**
 * Read the posture from the live connection. Everything here is measured from
 * the database's own catalogue as the connected role sees it — never from
 * config, which is what made the gap invisible in the first place.
 */
export async function readRlsFacts(db: RawDb): Promise<RlsFacts> {
  const [role] = await db.$queryRaw<Array<{ role: string; superuser: boolean; bypassrls: boolean }>>`
    SELECT current_user::text AS role,
           COALESCE(r.rolsuper, false)     AS superuser,
           COALESCE(r.rolbypassrls, false) AS bypassrls
      FROM pg_roles r
     WHERE r.rolname = current_user`;
  const [tables] = await db.$queryRaw<Array<{ total: bigint; disabled: bigint; owned_unforced: bigint }>>`
    SELECT count(*)                                                           AS total,
           count(*) FILTER (WHERE NOT c.relrowsecurity)                       AS disabled,
           count(*) FILTER (WHERE c.relrowsecurity
                              AND NOT c.relforcerowsecurity
                              AND pg_get_userbyid(c.relowner) = current_user) AS owned_unforced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)`;
  return {
    role: role?.role ?? 'unknown',
    // A missing row means the probe failed, not that the role is harmless.
    roleResolved: role !== undefined,
    isSuperuser: role?.superuser ?? false,
    hasBypassRls: role?.bypassrls ?? false,
    tenantTables: Number(tables?.total ?? 0),
    rlsDisabledTables: Number(tables?.disabled ?? 0),
    ownedUnforcedTables: Number(tables?.owned_unforced ?? 0),
  };
}

/**
 * REPORT-042 §AI: "block tenant two until contract complete."
 *
 * One tenant with an owner-mode credential is the sanctioned EXPAND state and
 * boots normally — the wall is redundant when there is nothing to isolate it
 * from. The moment a second active tenant exists, application-layer scoping is
 * the ONLY thing standing between two customers' data, and a single missed
 * `where` clause is a cross-tenant breach with no backstop. That is not a
 * posture to discover in production, so it refuses to start.
 */
export function assertTenantWall(
  attestation: RlsAttestation,
  activeTenants: number,
  env: Record<string, string | undefined> = process.env,
): void {
  if (runtimeMode(env) !== 'production') return;
  if (activeTenants <= 1) return;
  if (attestation.enforced) return;
  const why = attestation.bypasses.map((b) => `  - ${explainBypass(b, attestation.facts)}`).join('\n');
  throw new Error(
    `FATAL: ${activeTenants} active tenants, but the database tenant wall does not bind this connection:\n${why}\n` +
      'With more than one tenant, row-level security is the only barrier that survives a missed application-layer scope. ' +
      'Complete the CONTRACT stage — a least-privilege LOGIN that is a member of swift_app (NOBYPASSRLS, not the table owner), ' +
      'per-request SET LOCAL app.current_tenant, and the FORCE ROW LEVEL SECURITY migration from forceRlsStatements(). Refusing to start.',
  );
}
