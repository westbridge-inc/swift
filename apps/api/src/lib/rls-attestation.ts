import { runtimeMode } from '../utils/runtime-mode';
import { TENANT_POLICY_NAME, TENANT_TABLES } from './tenant-rls';

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
 * independent bypasses — and at that time 0 of 76 walled tables were FORCE'd.
 * Scoped to one tenant, that credential read, UPDATEd and DELETEd another
 * tenant's row. ⚠️ THAT MEASUREMENT IS HISTORICAL: FORCE has since been applied
 * (see below). Read the date, not the number.
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
 * SECURITY has since been applied by migration to the walled tables: 104
 * distinct tables across 12 migration files, 80 of them in
 * `20260905000000_review_tenant`. (An earlier version of this comment said 11
 * and 81 — the 81 was a `grep -c` that counted the section's own header
 * comment. Counts in a security comment are load-bearing; these are measured
 * with an anchored pattern.) Only the
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
export type RlsBypass =
  | 'UNKNOWN_ROLE' | 'SUPERUSER' | 'BYPASSRLS' | 'RLS_DISABLED' | 'OWNER_NOT_FORCED'
  /**
   * [review] Membership of `swift_bypass_rls`. This is not a Postgres role
   * attribute — it is the escape THIS REPOSITORY'S OWN POLICY grants:
   *
   *   USING ("tenantId" = current_setting('app.current_tenant', true)
   *          OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER'))
   *
   * So a login that is NOBYPASSRLS, not a superuser, not the table owner, with
   * every table FORCE'd — the posture this module calls `enforced` — still
   * reads every tenant if it holds that membership. One stray GRANT, or a
   * request pool pointed at SYSTEM_DATABASE_URL, is enough.
   *
   * That mattered less when `enforced` only gated tenant two. It matters now:
   * `enforced` is the FIRST discriminator and the single sufficient condition
   * for an unattested production boot at any tenant count, so an `enforced`
   * that can be a lie is the whole gate.
   */
  | 'BYPASS_ROLE_MEMBER';

export interface RlsFacts {
  /** The role the pool actually authenticated as — not the configured one. */
  role: string;
  /** False when `pg_roles` yielded no row for `current_user` — see UNKNOWN_ROLE. */
  roleResolved: boolean;
  isSuperuser: boolean;
  hasBypassRls: boolean;
  /** Member of `swift_bypass_rls` — the escape the tenant policy itself grants. */
  isBypassRoleMember: boolean;
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
    case 'BYPASS_ROLE_MEMBER':
      return `role "${facts.role}" is a member of swift_bypass_rls — every tenant policy in this schema has an OR branch that this membership satisfies, so the wall is open to it whatever the table flags say`;
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
  if (facts.isBypassRoleMember) bypasses.push('BYPASS_ROLE_MEMBER');
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
  const [role] = await db.$queryRaw<Array<{ role: string; superuser: boolean; bypassrls: boolean; bypass_member: boolean }>>`
    SELECT current_user::text AS role,
           COALESCE(r.rolsuper, false)     AS superuser,
           COALESCE(r.rolbypassrls, false) AS bypassrls,
           -- [review] The escape the tenant POLICY grants, not a role attribute.
           -- Addressed by oid so a missing role yields no row (=> NULL => false)
           -- instead of the error the name,name,text form raises.
           COALESCE((SELECT pg_has_role(current_user, b.oid, 'MEMBER')
                       FROM pg_roles b WHERE b.rolname = 'swift_bypass_rls'), false) AS bypass_member
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
    isBypassRoleMember: role?.bypass_member ?? false,
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
  // [review] Before the postures, because the old shape refused a NaN count by
  // accident (`NaN <= 1` is false, so it fell through to the throw) and the new
  // one would have BOOTED it (`NaN > 1` is false, landing in posture 3). A
  // count that is not a count is not evidence of anything.
  if (!Number.isInteger(activeTenants) || activeTenants < 0) {
    throw new Error(
      `FATAL: the active-tenant count is ${String(activeTenants)}, which is not a count. ` +
        'The tenant wall cannot be assessed against it, and guessing is how a wall-less posture boots. Refusing to start.',
    );
  }

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
  //
  // [review] The attestation answers "why is there no wall", NOT "why did the
  // probe find nothing". `tenantTables === 0` produces `bypasses: []` and
  // `enforced: false` — this module's own doc calls that "a broken census or a
  // wrong schema, never a clean bill" — and it landed here with an EMPTY reason
  // list, so an attested deployment booted green on a wrong DATABASE_URL, a
  // changed search_path, or a renamed tenantId column. The attestation is a
  // statement about a KNOWN posture; it cannot cover an unknown one.
  if (attestation.bypasses.length > 0 && expandPostureAttested(env)) return;
  if (attestation.bypasses.length === 0) {
    throw new Error(
      `FATAL: the tenant-wall probe found ${attestation.facts.tenantTables} tenant-bearing table(s) and no bypass — it has learned nothing.\n` +
        'That is a broken census or a wrong schema, not a clean bill: check DATABASE_URL, the search_path, and that the tenantId column still has that name. ' +
        'TENANT_WALL_EXPAND_ATTESTED does not cover this — it declares a KNOWN wall-less posture, not an unreadable one. Refusing to start.',
    );
  }
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

// ---------------------------------------------------------------------------
// [DB-01] The policy CONTRACT: not just "RLS is on and some policy exists",
// but that every tenant table the code expects is there, carries its tenantId
// column, and is guarded by exactly the tenant policy this repository writes
// (rlsDdlFor) — and by no other policy that could widen it.
//
// readRlsFacts measures the ROLE and the table FLAGS. Neither reads pg_policy:
// a PUBLIC `USING (true)` policy added beside the tenant policy, or a tenant
// policy whose USING / WITH CHECK was rewritten, left every flag and count
// intact and the attestation said `enforced`. This reads the policies
// themselves and compares them with a versioned, normalised contract.
// ---------------------------------------------------------------------------

/** Bump when the tenant policy predicate (tenant-rls.ts POLICY_PREDICATE) changes. */
export const TENANT_POLICY_CONTRACT_VERSION = 1;

/** The tenant predicate (tenant-rls.ts POLICY_PREDICATE) exactly as
 *  PostgreSQL stores and renders it — the request's tenant, or membership of
 *  swift_bypass_rls, and nothing else. */
export const TENANT_POLICY_RENDERED = `(("tenantId" = current_setting('app.current_tenant'::text, true)) OR pg_has_role(CURRENT_USER, 'swift_bypass_rls'::name, 'MEMBER'::text))`;

/** PostgreSQL re-renders a stored policy expression (casts such as `::text`,
 *  extra parentheses, its own spacing and keyword case), so the stored text is
 *  normalised before it is compared — casts, parentheses and whitespace
 *  removed, the two keywords upper-cased. Identifiers and literals keep their
 *  case, and every other token must match exactly: an added term, a different
 *  column, role or setting name is a different predicate. */
export function normalizePolicyExpression(expression: string | null | undefined): string | null {
  if (expression === null || expression === undefined) return null;
  return expression
    .replace(/::(?:character varying|double precision|[A-Za-z_][A-Za-z0-9_]*)(?:\[\])?/g, '')
    .replace(/\s+or\s+/gi, ' OR ')
    .replace(/\bcurrent_user\b/gi, 'CURRENT_USER')
    .replace(/[()\s]/g, '');
}

/** The contract a stored USING / WITH CHECK must normalise to. */
export const TENANT_POLICY_CONTRACT: string = normalizePolicyExpression(TENANT_POLICY_RENDERED) as string;

export interface TenantPolicyContractFacts {
  version: number;
  /** current_schema() of the connection: the schema unqualified names resolve to. */
  schema: string;
  /** Registered tenant tables (TENANT_TABLES) absent from `public`, or without their tenantId column. */
  missingTables: string[];
  /** Tenant-bearing tables without the canonical tenant policy (missing, restrictive,
   *  not for ALL commands, not for PUBLIC, or a USING / WITH CHECK that is not the contract). */
  nonCanonicalTables: string[];
  /** Tenant-bearing tables that carry ANY other permissive policy — one that can widen the wall. */
  extraPermissiveTables: string[];
}

/** The contract gaps, as the sentences the boot log prints. Empty = the contract holds. */
export function tenantPolicyContractGaps(c: TenantPolicyContractFacts): string[] {
  const list = (names: string[]) => names.slice(0, 10).join(', ') + (names.length > 10 ? ` and ${names.length - 10} more` : '');
  const gaps: string[] = [];
  if (c.schema !== 'public') gaps.push(`SCHEMA: unqualified names resolve to "${c.schema}", not "public" — the attested tables are not the ones queries reach`);
  if (c.missingTables.length > 0) gaps.push(`TABLE_MISSING: ${c.missingTables.length} registered tenant table(s) absent or without "tenantId": ${list(c.missingTables)}`);
  if (c.nonCanonicalTables.length > 0) gaps.push(`POLICY_NOT_CANONICAL: ${c.nonCanonicalTables.length} tenant table(s) lack the contract tenant policy (v${c.version}): ${list(c.nonCanonicalTables)}`);
  if (c.extraPermissiveTables.length > 0) gaps.push(`EXTRA_PERMISSIVE_POLICY: ${c.extraPermissiveTables.length} tenant table(s) carry another permissive policy that can widen the wall: ${list(c.extraPermissiveTables)}`);
  return gaps;
}

/** [DB-01] Additional PERMISSIVE policies a reviewed migration installed on a
 *  tenant table on purpose, for a dedicated role that is never the request
 *  login (20261004130000_audit_purge_authority: the audit-purge owner and
 *  executor). Each must match exactly — table, name, command and roles — and
 *  must not apply to the connected login; anything else beside the tenant
 *  policy widens the wall and is a gap. */
export const SANCTIONED_EXTRA_POLICIES: ReadonlyArray<{ table: string; name: string; cmd: string; roles: readonly string[] }> = [
  { table: 'sensitive_read_logs', name: 'audit_purge_owner_select', cmd: 'r', roles: ['swift_audit_purge_executor', 'swift_audit_purge_owner'] },
  { table: 'sensitive_read_logs', name: 'audit_purge_owner_delete', cmd: 'd', roles: ['swift_audit_purge_owner'] },
];

type PolicyRow = {
  table: string;
  has_tenant: boolean;
  polname: string | null;
  permissive: boolean | null;
  cmd: string | null;
  to_public: boolean | null;
  /** The policy's roles by name, sorted (empty for PUBLIC). */
  roles: string[] | null;
  /** Whether the policy applies to the connected login through a role
   *  membership (a superuser is reported by readRlsFacts, not here). */
  applies_to_me: boolean | null;
  qual: string | null;
  with_check: string | null;
};

/** Read the policy contract from the live catalogue, as the connected role sees it. */
export async function readTenantPolicyContract(db: RawDb): Promise<TenantPolicyContractFacts> {
  const registered = [...TENANT_TABLES] as string[];
  const [where] = await db.$queryRaw<Array<{ schema: string | null }>>`SELECT current_schema()::text AS schema`;
  // Every tenant-bearing table in public (registered or not) and every
  // registered table (present or not), with each policy on it.
  const rows = await db.$queryRaw<PolicyRow[]>`
    SELECT c.relname::text AS table,
           EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped) AS has_tenant,
           p.polname::text                       AS polname,
           p.polpermissive                       AS permissive,
           p.polcmd::text                        AS cmd,
           (p.polroles = '{0}'::oid[])           AS to_public,
           ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid = ANY(p.polroles) ORDER BY 1) AS roles,
           (NOT COALESCE((SELECT me.rolsuper FROM pg_roles me WHERE me.rolname = current_user), false)
             AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid = ANY(p.polroles) AND pg_has_role(current_user, r.oid, 'MEMBER'))) AS applies_to_me,
           pg_get_expr(p.polqual, p.polrelid)      AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
     WHERE c.relkind IN ('r', 'p')
       AND (c.relname::text = ANY(${registered}::text[])
            OR EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped))`;
  const byTable = new Map<string, PolicyRow[]>();
  for (const row of rows ?? []) byTable.set(row.table, [...(byTable.get(row.table) ?? []), row]);

  const missingTables = registered.filter((name) => !byTable.get(name)?.[0]?.has_tenant).sort();
  const nonCanonicalTables: string[] = [];
  const extraPermissiveTables: string[] = [];
  for (const [table, policies] of byTable) {
    if (!policies[0]?.has_tenant) continue; // already reported as missing (registered) or not tenant-bearing
    const isCanonical = (p: PolicyRow) => p.polname === TENANT_POLICY_NAME && p.permissive === true && p.cmd === '*' && p.to_public === true
      && normalizePolicyExpression(p.qual) === TENANT_POLICY_CONTRACT && normalizePolicyExpression(p.with_check) === TENANT_POLICY_CONTRACT;
    if (!policies.some(isCanonical)) nonCanonicalTables.push(table);
    // Another permissive policy (any name but the tenant policy's): permissive
    // policies are OR-ed, so it widens the wall. (A rewritten tenant policy is
    // reported above as not canonical, not again here.)
    const isSanctioned = (p: PolicyRow) => p.applies_to_me === false && SANCTIONED_EXTRA_POLICIES.some((s) =>
      s.table === table && s.name === p.polname && s.cmd === p.cmd && p.to_public === false
      && [...(p.roles ?? [])].sort().join(',') === [...s.roles].sort().join(','));
    if (policies.some((p) => p.polname !== null && p.polname !== TENANT_POLICY_NAME && p.permissive === true && !isSanctioned(p))) extraPermissiveTables.push(table);
  }
  return {
    version: TENANT_POLICY_CONTRACT_VERSION,
    // A schema that could not be read is not "public".
    schema: where?.schema ?? 'unknown',
    missingTables,
    nonCanonicalTables: nonCanonicalTables.sort(),
    extraPermissiveTables: extraPermissiveTables.sort(),
  };
}

/** [DB-01] In production, a tenant-policy contract gap refuses the start, at
 *  ANY posture and ANY tenant count — TENANT_WALL_EXPAND_ATTESTED does not
 *  cover it: it declares a known wall-less posture, not an unknown policy. */
export function assertTenantPolicyContract(contract: TenantPolicyContractFacts, env: EnvLike = process.env): void {
  if (runtimeMode(env) !== 'production') return;
  const gaps = tenantPolicyContractGaps(contract);
  if (gaps.length === 0) return;
  throw new Error(
    `FATAL: the database tenant policies are not the ones this code was built for:\n${gaps.map((g) => `  - ${g}`).join('\n')}\n` +
      'An unknown or widened tenant policy cannot be vouched for, whatever the role and table flags say. ' +
      'Restore the policies with the migrations (rlsDdlFor in lib/tenant-rls.ts) and restart. Refusing to start.',
  );
}
