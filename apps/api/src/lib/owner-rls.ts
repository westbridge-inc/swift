import { runtimeMode } from '../utils/runtime-mode';
import { normalizePolicyExpression } from './rls-attestation';
import { runAsSystem } from '../plugins/tenant-context';

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
export const OWNER_WALLED_TABLES: Readonly<Record<string, 'userId'>> = { addresses: 'userId', device_tokens: 'userId', notifications: 'userId', support_tickets: 'userId' };

/** The USING and WITH CHECK every owner policy carries (the migration writes
 *  exactly this; the boot attestation compares the stored policy with it). */
export const OWNER_POLICY_EXPRESSION = `pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER') OR NOT pg_has_role(current_user, 'swift_owner_wall', 'MEMBER') OR "userId" = NULLIF(current_setting('app.current_user', true), '')`;
const OWNER_POLICY_CONTRACT = normalizePolicyExpression(OWNER_POLICY_EXPRESSION) as string;

/** One permissive policy an owner-walled table must carry: its command
 *  (pg_policy.polcmd: '*' all, r select, a insert, w update, d delete) and its
 *  normalised USING / WITH CHECK (null = none). */
interface OwnerPolicyShape { name: string; cmd: '*' | 'r' | 'a' | 'w' | 'd'; using: string | null; check: string | null }
/** [item 20 · notifications] Anyone may hand a person a notice (the INSERT
 *  policy checks nothing); only the person reads, updates or deletes it. */
export const NOTICE_WRITE_POLICY_NAME = 'notice_write';
/** [item 20 · support tickets] A case may be opened FOR a person; only the person reads, updates or deletes it. */
export const TICKET_WRITE_POLICY_NAME = 'ticket_write';
const OWNER_ALL: readonly OwnerPolicyShape[] = [{ name: OWNER_POLICY_NAME, cmd: '*', using: OWNER_POLICY_CONTRACT, check: OWNER_POLICY_CONTRACT }];
/** Exactly the permissive policies each owner-walled table carries (the
 *  migrations write these; any other permissive policy widens the wall). */
const OWNER_POLICY_LAYOUT: Readonly<Record<string, readonly OwnerPolicyShape[]>> = {
  addresses: OWNER_ALL,
  device_tokens: OWNER_ALL,
  notifications: [
    { name: OWNER_POLICY_NAME, cmd: 'r', using: OWNER_POLICY_CONTRACT, check: null },
    { name: `${OWNER_POLICY_NAME}_update`, cmd: 'w', using: OWNER_POLICY_CONTRACT, check: OWNER_POLICY_CONTRACT },
    { name: `${OWNER_POLICY_NAME}_delete`, cmd: 'd', using: OWNER_POLICY_CONTRACT, check: null },
    { name: NOTICE_WRITE_POLICY_NAME, cmd: 'a', using: null, check: 'true' },
  ],
  support_tickets: [
    { name: OWNER_POLICY_NAME, cmd: 'r', using: OWNER_POLICY_CONTRACT, check: null },
    { name: `${OWNER_POLICY_NAME}_update`, cmd: 'w', using: OWNER_POLICY_CONTRACT, check: OWNER_POLICY_CONTRACT },
    { name: `${OWNER_POLICY_NAME}_delete`, cmd: 'd', using: OWNER_POLICY_CONTRACT, check: null },
    { name: TICKET_WRITE_POLICY_NAME, cmd: 'a', using: null, check: 'true' },
  ],
};

/** OWNER_RLS_BIND=1: every request binding also sets `app.current_user`. */
export const ownerRlsBindEnabled = (env: EnvLike = process.env): boolean => env['OWNER_RLS_BIND'] === '1';

export interface OwnerWallFacts {
  /** Is the connected login a member of swift_owner_wall (the wall enforced on it)? */
  walledLogin: boolean;
  /** Is it a member of swift_bypass_rls (never walled)? */
  bypassLogin: boolean;
  /** Owner-walled tables missing RLS, FORCE or one of their canonical owner
   *  policies, or carrying another permissive policy (permissive policies are
   *  OR-ed: any other one widens the wall). */
  unwalledTables: string[];
  /** [REVIEW-M S4-1] Owner-wall actions (public.swift_owner_wall_*) the wall
   *  itself would reach: not SECURITY DEFINER, or defined by a role the owner
   *  policy walls (a swift_owner_wall member that is neither a superuser,
   *  BYPASSRLS nor a swift_bypass_rls member). Inside a definer action
   *  current_user is its owner, so such an action sees only the BOUND person's
   *  rows: for anyone else it finds and touches nothing, silently (an invite
   *  outlives its withdrawal, a device is never revoked, a case never closes). */
  walledActions: string[];
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
  const walledActions = await db.$queryRaw<Array<{ name: string }>>`
    SELECT p.proname::text AS name
      FROM pg_proc p
      JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.pronamespace = 'public'::regnamespace
       AND starts_with(p.proname::text, 'swift_owner_wall_')
       AND (NOT p.prosecdef
            OR (NOT o.rolsuper AND NOT o.rolbypassrls
                AND COALESCE((SELECT pg_has_role(o.oid, r.oid, 'MEMBER') FROM pg_roles r WHERE r.rolname = 'swift_owner_wall'), false)
                AND NOT COALESCE((SELECT pg_has_role(o.oid, r.oid, 'MEMBER') FROM pg_roles r WHERE r.rolname = 'swift_bypass_rls'), false)))
     ORDER BY 1`;
  const unwalled = Object.keys(OWNER_WALLED_TABLES).filter((table) => {
    const policies = rows.filter((r) => r.name === table);
    const layout = OWNER_POLICY_LAYOUT[table] ?? OWNER_ALL;
    const permissive = policies.filter((r) => r.polname !== null && r.permissive === true);
    const canonical = (r: (typeof rows)[number], shape: OwnerPolicyShape) => r.polname === shape.name && r.cmd === shape.cmd && r.to_public === true
      && normalizePolicyExpression(r.qual) === shape.using && normalizePolicyExpression(r.with_check) === shape.check;
    return !policies.some((r) => r.secured === true) || !layout.every((shape) => permissive.some((r) => canonical(r, shape)))
      || permissive.some((r) => !layout.some((shape) => shape.name === r.polname));
  });
  return {
    walledLogin: login?.walled ?? false,
    bypassLogin: login?.bypass ?? false,
    unwalledTables: unwalled.sort(),
    walledActions: walledActions.map((r) => r.name),
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
  if (bind && facts.walledActions.length > 0) {
    return `OWNER_RLS_BIND=1 but ${facts.walledActions.join(', ')} run(s) inside the wall (not SECURITY DEFINER, or defined by a ${OWNER_WALL_ROLE} member): each would see only the bound person's rows and silently miss everyone else's`;
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

/**
 * [item 20 · device_tokens] Work that acts for SOMEONE ELSE on an owner-walled
 * table, outside a transaction (a push to a store, a dead-token cleanup, a
 * token moving to the account now signed in on its device): with the wall ON
 * it runs as the named system capability (the system login, never walled);
 * off, exactly as before on the caller's own connection. Never inside a
 * transaction: a transaction's queries never change connection — use the
 * SECURITY DEFINER actions below there.
 */
export function ownerWallSystem<T>(capability: string, fn: () => PromiseLike<T>): Promise<T> {
  return ownerRlsBindEnabled() ? runAsSystem(capability, async () => await fn()) : Promise.resolve(fn());
}

type TxRaw = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> };

/** [item 20] The narrow actions a transaction takes on SOMEONE ELSE'S push
 *  registrations (migration 20261018221000): one SECURITY DEFINER function
 *  each, keyed by the user id it acts on, so the owner wall cannot make them
 *  silently touch nothing. Authorization is the caller's (an admin's ban, a
 *  session revocation, the erasure); a census test pins the callers. */
export const OWNER_WALL_DEVICE_ACTIONS = ['swift_owner_wall_revoke_devices', 'swift_owner_wall_revoke_device', 'swift_owner_wall_erase_devices'] as const;

/** Silence every active registration of `userId`. Returns how many. */
export async function revokeUserDevices(tx: TxRaw, userId: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`SELECT public.swift_owner_wall_revoke_devices(${userId}) AS n`;
  return row?.n ?? 0;
}

/** Silence one registration (`token`) of `userId`. Returns how many (0 or 1). */
export async function revokeUserDevice(tx: TxRaw, userId: string, token: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`SELECT public.swift_owner_wall_revoke_device(${userId}, ${token}) AS n`;
  return row?.n ?? 0;
}

/** Delete every registration of `userId` (the account erasure). Returns how many. [row 622] The action refuses
 *  (throws) unless the account carries the erasure tombstone, which the closure writes first. */
export async function eraseUserDevices(tx: TxRaw, userId: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`SELECT public.swift_owner_wall_erase_devices(${userId}) AS n`;
  return row?.n ?? 0;
}
