import { runtimeMode } from '../utils/runtime-mode';

type EnvLike = Record<string, string | undefined>;

/** [TEN-01] What the app does with a query that reaches a tenant model with no
 *  tenant bound. `log` (the default) runs it and counts it — the shadow that
 *  finds every unnamed caller; `deny` refuses it before the query. Audited
 *  system work runs either way. */
export const unscopedAccessPolicy = (env: EnvLike = process.env): 'log' | 'deny' =>
  (env['TENANT_UNSCOPED_ACCESS'] === 'deny' ? 'deny' : 'log');

/** [TEN-03] Bind the tenant transaction-locally on every tenant-model query
 *  (`set_config('app.current_tenant', …, true)`; system work SETs the bypass
 *  role) so the database wall binds the APP under a NOBYPASSRLS login. Off
 *  until the least-privilege login exists (runbook in TEN-03). */
export const rlsBindEnabled = (env: EnvLike = process.env): boolean => env['TENANT_RLS_BIND'] === '1';

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
 * This module does not force RLS, and no longer needs to: FORCE ROW LEVEL
 * SECURITY has since been applied by migration to the walled tables (11
 * migrations, 81 of them in `20260905000000_review_tenant`). Only the
 * least-privilege LOGIN is still outstanding, so under the shipped credential
 * three bypasses (owner, BYPASSRLS, superuser) still mask it.
 *
 * That changes what this gate must watch for. The danger used to be one-sided
 * — a missing wall. It is now two-sided, and the second side is an OUTAGE: the
 * day the login lands, an app that has not also set `TENANT_RLS_BIND=1` reads
 * NOTHING, because a FORCE'd table returns zero rows to a connection that never
 * SET LOCALs `app.current_tenant`. Neither side scales with tenant count, which
 * is why this gate no longer returns early when there is only one tenant.
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

/** [REPORT-111 P0.3] Has this deployment DECLARED that it runs wall-less?
 *
 *  Exactly `'1'`. A posture this consequential is not something to infer from
 *  a truthy string. */
export const expandPostureAttested = (env: EnvLike = process.env): boolean =>
  env['TENANT_WALL_EXPAND_ATTESTED'] === '1';

/**
 * REPORT-042 §AI: "block tenant two until contract complete."
 * REPORT-111 P0.3: "RLS must fail closed even with one active tenant."
 *
 * Three postures, and only one of them boots:
 *
 * 1. **The wall binds (`enforced`).** Then the application must bind it too —
 *    at ANY tenant count, zero and one included. A FORCE'd table returns zero
 *    rows to a connection that never SET LOCALs `app.current_tenant`, so an
 *    enforced wall in front of an unbound app is a total outage that used to
 *    boot green and silent. Tenant count has nothing to do with it.
 * 2. **No wall, two or more tenants.** Application-layer scoping is then the
 *    only thing between two customers' data, and one missed `where` clause is
 *    a breach with no backstop. Refuse — unchanged, and not waivable.
 * 3. **No wall, at most one tenant.** The sanctioned EXPAND state: there is
 *    nothing to isolate yet. It may be run deliberately — but it must be SAID.
 *    A posture nobody declared is indistinguishable from an accident, and
 *    silence here is exactly how an owner-mode credential survives to the day
 *    tenant two arrives. `TENANT_WALL_EXPAND_ATTESTED=1` is that declaration,
 *    and it buys precisely one tenant.
 */
export function assertTenantWall(
  attestation: RlsAttestation,
  activeTenants: number,
  env: EnvLike = process.env,
): void {
  if (runtimeMode(env) !== 'production') return;

  // POSTURE 1 — the database holds up its end, so the application must hold up
  // its own. [STA-1 4.1 / DL-2] A wall the app never binds returns NOTHING to a
  // NOBYPASSRLS login, and a request that never bound its tenant must fail
  // closed rather than read every tenant and be counted. Neither consequence
  // waits for a second tenant, so neither does this check.
  if (attestation.enforced) {
    const missing = appSideWallGaps(env);
    if (missing.length === 0) return;
    throw new Error(
      `FATAL: the database tenant wall binds this connection (${activeTenants} active tenant(s)), but the application does not hold up its end:\n` +
        missing.map((m) => `  - ${m}`).join('\n') + '\n' +
        'A FORCE\'d table returns ZERO ROWS to a connection that never SET LOCALs app.current_tenant — this is an outage, not a gap, and it does not wait for a second tenant. ' +
        'Set both and restart. Refusing to start.',
    );
  }

  const why = attestation.bypasses.map((b) => `  - ${explainBypass(b, attestation.facts)}`).join('\n');

  // POSTURE 2 — no wall, and something to isolate. Not waivable.
  if (activeTenants > 1) {
    throw new Error(
      `FATAL: ${activeTenants} active tenants, but the database tenant wall does not bind this connection:\n${why}\n` +
        'With more than one tenant, row-level security is the only barrier that survives a missed application-layer scope. ' +
        'Complete the CONTRACT stage — a least-privilege LOGIN that is a member of swift_app (NOBYPASSRLS, not the table owner), ' +
        'per-request SET LOCAL app.current_tenant, and the FORCE ROW LEVEL SECURITY migration from forceRlsStatements(). Refusing to start.',
    );
  }

  // POSTURE 3 — no wall, nothing to isolate yet. Legitimate, once declared.
  if (expandPostureAttested(env)) return;
  throw new Error(
    `FATAL: the database tenant wall does not bind this connection:\n${why}\n` +
      `There ${activeTenants === 1 ? 'is 1 active tenant' : `are ${activeTenants} active tenants`}, so there is nothing to isolate yet and this posture MAY be deliberate — ` +
      'but a wall-less production deployment must be declared, never assumed. Choose one:\n' +
      '  - complete the CONTRACT stage: a least-privilege LOGIN that is a member of swift_app (NOBYPASSRLS, not the table owner), then TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny; or\n' +
      '  - set TENANT_WALL_EXPAND_ATTESTED=1 to record that this deployment runs the wall-less EXPAND posture on purpose. It buys exactly one tenant — the second still refuses to start.\n' +
      'Refusing to start.',
  );
}

/** The application-side requirements of the wall, as the sentences the boot log prints. */
export function appSideWallGaps(env: EnvLike = process.env): string[] {
  const gaps: string[] = [];
  if (!rlsBindEnabled(env)) {
    gaps.push('TENANT_RLS_BIND is not "1" — the app never SET LOCALs app.current_tenant, so an enforced wall returns nothing to anyone (and a bypassing role would return everything)');
  }
  if (unscopedAccessPolicy(env) !== 'deny') {
    gaps.push('TENANT_UNSCOPED_ACCESS is not "deny" — a request that never bound its tenant reads every tenant and is merely counted');
  }
  return gaps;
}
