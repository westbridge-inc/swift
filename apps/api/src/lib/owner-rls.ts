import { runtimeMode } from '../utils/runtime-mode';
import { normalizePolicyExpression } from './rls-attestation';

type EnvLike = Record<string, string | undefined>;

/**
 * [item 20 · owner wall] Personal tables with no tenantId (a saved address is
 * one person's, not a tenant's) get a database wall of their own: a request
 * login sees only the rows of the person it acts for.
 *
 * It mirrors the tenant wall's mechanism (role membership, like
 * `swift_bypass_rls`), so it is INERT until switched on:
 *  - the policy `owner_isolation` admits every row to a login that is NOT a
 *    member of `swift_owner_wall` — today's behaviour, byte for byte;
 *  - switched on (the request login granted `swift_owner_wall`, and
 *    OWNER_RLS_BIND=1 so the app binds `app.current_user` beside
 *    `app.current_tenant`), a row is visible only when its "userId" is the
 *    bound person. Unbound — a job, a pre-auth read, a transaction that began
 *    without a request — sees ZERO rows: fail closed;
 *  - the system login (a `swift_bypass_rls` member) is never walled: jobs and
 *    named system capabilities read through it, as they do the tenant wall.
 *
 * Switching ON waits for a staging journey run (COORD ruling, 18 Oct). The
 * boot attestation refuses a production process whose switch and database
 * disagree (see assertOwnerWall).
 */
export const OWNER_WALL_ROLE = 'swift_owner_wall';
export const OWNER_POLICY_NAME = 'owner_isolation';
/** The owner-walled tables, each keyed by its owner column. */
export const OWNER_WALLED_TABLES: Readonly<Record<string, 'userId'>> = { addresses: 'userId' };

/** The USING and WITH CHECK every owner policy carries (the migration writes
 *  exactly this; the boot attestation compares the stored policy with it). */
export const OWNER_POLICY_EXPRESSION = `pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER') OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER') OR "userId" = NULLIF(current_setting('app.current_user', true), '')`;
const OWNER_POLICY_CONTRACT = normalizePolicyExpression(OWNER_POLICY_EXPRESSION) as string;

/** OWNER_RLS_BIND=1: every request binding also sets `app.current_user`. */
export const ownerRlsBindEnabled = (env: EnvLike = process.env): boolean => env['OWNER_RLS_BIND'] === '1';

export interface OwnerWallFacts {
  /** Is the connected login a member of swift_owner_wall (the wall enforced on it)? */
  walledLogin: boolean;
  /** Is it a member of swift_bypass_rls (never walled)? */
  bypassLogin: boolean;
  /** Owner-walled tables missing RLS, FORCE or the canonical owner policy,
   *  or carrying another permissive policy (permissive policies are OR-ed:
   *  any other one widens the wall). */
  unwalledTables: string[];
}

type RawDb = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> };

/** Read from the live connection's own catalogue, never from config. */
export async function readOwnerWallFacts(db: RawDb): Promise<OwnerWallFacts> {
  const [login] = await db.$queryRaw<Array<{ walled: boolean; bypass: boolean }>>`
    SELECT COALESCE((SELECT pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_roles r WHERE r.rolname = 'swift_owner_wall'), false) AS walled,
           COALESCE((SELECT pg_has_role(current_user, r.oid, 'MEMBER') FROM pg_roles r WHERE r.rolname = 'swift_bypass_rls'), false) AS bypass`;
  const rows = await db.$queryRaw<Array<{ name: string; secured: boolean | null; polname: string | null; permissive: boolean | null; cmd: string | null; to_public: boolean | null; qual: string | null; with_check: string | null }>>`
    SELECT t.name,
           (c.relrowsecurity AND c.relforcerowsecurity) AS secured,
           p.polname::text AS polname, p.polpermissive AS permissive, p.polcmd::text AS cmd,
           (p.polroles = '{0}'::oid[]) AS to_public,
           pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
      FROM unnest(${Object.keys(OWNER_WALLED_TABLES)}::text[]) AS t(name)
      LEFT JOIN pg_class c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      LEFT JOIN pg_policy p ON p.polrelid = c.oid`;
  const unwalled = Object.keys(OWNER_WALLED_TABLES).filter((table) => {
    const policies = rows.filter((r) => r.name === table);
    const canonical = (r: (typeof rows)[number]) => r.polname === OWNER_POLICY_NAME && r.permissive === true && r.cmd === '*' && r.to_public === true
      && normalizePolicyExpression(r.qual) === OWNER_POLICY_CONTRACT && normalizePolicyExpression(r.with_check) === OWNER_POLICY_CONTRACT;
    return !policies.some((r) => r.secured === true) || !policies.some(canonical)
      || policies.some((r) => r.polname !== null && r.polname !== OWNER_POLICY_NAME && r.permissive === true);
  });
  return {
    walledLogin: login?.walled ?? false,
    bypassLogin: login?.bypass ?? false,
    unwalledTables: unwalled.sort(),
  };
}

/** Why a production process must not run with this posture, or null. Pure. */
export function ownerWallRefusal(facts: OwnerWallFacts, env: EnvLike = process.env): string | null {
  const bind = ownerRlsBindEnabled(env);
  // The system login is never walled; its posture is the bypass, checked by the tenant wall.
  if (facts.bypassLogin) return null;
  if (bind && env['TENANT_RLS_BIND'] !== '1') {
    return 'OWNER_RLS_BIND=1 without TENANT_RLS_BIND=1: the person rides the tenant binding, so nothing would bind it';
  }
  if (bind && !facts.walledLogin) {
    return `OWNER_RLS_BIND=1 but this login is not a member of ${OWNER_WALL_ROLE}: the owner wall would be claimed, not enforced`;
  }
  if (bind && facts.unwalledTables.length > 0) {
    return `OWNER_RLS_BIND=1 but ${facts.unwalledTables.join(', ')} lack(s) row security, FORCE or the ${OWNER_POLICY_NAME} policy`;
  }
  if (!bind && facts.walledLogin) {
    return `this login is a member of ${OWNER_WALL_ROLE} but OWNER_RLS_BIND is not 1: no request would bind its person, so every owner-walled read would see nothing`;
  }
  return null;
}

/** [item 20] Refuse, in production, a switch and a database that disagree.
 *  Elsewhere the line is logged by the caller and the process runs. */
export function assertOwnerWall(facts: OwnerWallFacts, env: EnvLike = process.env): void {
  const why = ownerWallRefusal(facts, env);
  if (why && runtimeMode(env) === 'production') {
    throw new Error(`FATAL: owner wall: ${why}. Refusing to start.`);
  }
}

/** One log line: `owner wall: enforced tables=addresses` / `inert` / `REFUSED (...)`. */
export function ownerWallLine(facts: OwnerWallFacts, env: EnvLike = process.env): string {
  const why = ownerWallRefusal(facts, env);
  if (why) return `owner wall: REFUSED (${why})`;
  if (facts.bypassLogin) return 'owner wall: system login (bypass)';
  return ownerRlsBindEnabled(env) && facts.walledLogin
    ? `owner wall: enforced tables=${Object.keys(OWNER_WALLED_TABLES).join(',')}`
    : 'owner wall: inert (OWNER_RLS_BIND off, login not walled)';
}
