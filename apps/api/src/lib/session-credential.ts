import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';

/**
 * [Row 231 · FABLE-AUTH-1 / DS108] Session credentials at rest are SHA-256 digests.
 *
 * `sessions.token`, `sessions.refreshToken` and `sessions.previousRefreshToken`
 * used to hold the bearer access token and the refresh tokens in plaintext: a
 * database read (a backup, a replica, an injection, an operator's psql) was a
 * login. The columns now hold only the lowercase-hex SHA-256 digest of the
 * credential the client holds, and three CHECK constraints
 * (20261018190000_session_credential_digests) refuse any other shape, from any
 * path — raw SQL, seeds and scripts included.
 *
 * Why an unkeyed digest is enough here: every stored credential carries at
 * least 256 bits the attacker cannot guess (a refresh token is nanoid(64), 384
 * random bits; an access token ends in an HMAC-SHA256 signature under
 * JWT_SECRET). A key only adds strength for a GUESSABLE secret — which is why
 * OTPs and password-source buckets are keyed and these are not. Unkeyed, the
 * migration digests every live row in place in SQL, so nobody is signed out,
 * and no secret rotation can ever sign the fleet out either.
 *
 * ONE mechanism, at the storage boundary:
 *   - Prisma `session` operations take the PLAINTEXT the client presented. The
 *     `sessionCredentialDigestExtension` below digests every credential field in
 *     `data` / `create` / `update` and in every `where` / `cursor`, so no call
 *     site — production or a test fixture — can store or look up plaintext by
 *     accident, and none can compare a digest to a digest of a digest.
 *   - Raw SQL bypasses the extension: a row read by id is checked with
 *     `sessionCredentialMatches(stored, presented)` (constant time; auth.service.ts
 *     refresh / logout-by-refresh), and a raw lookup BY credential binds
 *     `sessionCredentialDigest(presented)` (socket.ts post-connect read). A raw
 *     site that forgets matches nothing: fail closed.
 *   - The extension is the INNERMOST layer of every client (plugins/prisma.ts):
 *     a query the tenant layers re-issue on the system connection is still
 *     plaintext there and is digested exactly once, by that client's own copy.
 *
 * A credential filter is only ever an equality (`=`, `in`, `not`): a prefix or
 * substring filter on a digest is meaningless and would be a probing surface,
 * so the extension refuses it. Relation-nested filters (`user.sessions.some`)
 * are not intercepted; they compare plaintext to a digest and match nothing.
 */

export const SESSION_CREDENTIAL_FIELDS = ['token', 'refreshToken', 'previousRefreshToken'] as const;
export type SessionCredentialField = (typeof SESSION_CREDENTIAL_FIELDS)[number];
const CREDENTIAL_FIELD_SET: ReadonlySet<string> = new Set(SESSION_CREDENTIAL_FIELDS);

/** The exact shape the database accepts: lowercase hex SHA-256. Mirrors the CHECK constraints. */
export const SESSION_CREDENTIAL_DIGEST_RE = /^[0-9a-f]{64}$/;

export class SessionCredentialError extends Error {
  override readonly name = 'SessionCredentialError';
  constructor(readonly code: 'EMPTY_CREDENTIAL' | 'UNSUPPORTED_FILTER' | 'UNSUPPORTED_WRITE', message: string) {
    super(message);
  }
}

/** One-way digest of a session credential. Deterministic, so a lookup by the presented plaintext hits the stored row. */
export function sessionCredentialDigest(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

/**
 * Does a stored digest belong to the credential a client presented? Compared in
 * constant time (both sides are 64 hex characters; a stored value of any other
 * shape is never a match). The single comparison for every raw-SQL site, where
 * the row is read by id and the credential is checked here.
 */
export function sessionCredentialMatches(storedDigest: string | null | undefined, presented: string): boolean {
  if (typeof storedDigest !== 'string' || !SESSION_CREDENTIAL_DIGEST_RE.test(storedDigest) || presented === '') return false;
  return timingSafeEqual(Buffer.from(storedDigest, 'utf8'), Buffer.from(sessionCredentialDigest(presented), 'utf8'));
}

/** A write must never persist an empty credential: `sha256('')` would then be a valid login for a request carrying nothing. */
function storageDigest(field: string, credential: string): string {
  if (credential === '') throw new SessionCredentialError('EMPTY_CREDENTIAL', `sessions.${field}: an empty credential cannot be stored`);
  return sessionCredentialDigest(credential);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digestFilter(field: string, filter: unknown): unknown {
  if (filter === null || filter === undefined) return filter;
  if (typeof filter === 'string') return sessionCredentialDigest(filter);
  if (!isPlainObject(filter)) {
    throw new SessionCredentialError('UNSUPPORTED_FILTER', `sessions.${field}: unsupported filter value`);
  }
  const out: Record<string, unknown> = {};
  for (const [op, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    switch (op) {
      case 'equals':
        out[op] = value === null ? null : typeof value === 'string' ? sessionCredentialDigest(value)
          : (() => { throw new SessionCredentialError('UNSUPPORTED_FILTER', `sessions.${field}.equals must be a string`); })();
        break;
      case 'in':
      case 'notIn':
        if (!Array.isArray(value)) throw new SessionCredentialError('UNSUPPORTED_FILTER', `sessions.${field}.${op} must be an array`);
        out[op] = value.map((v) => {
          if (typeof v !== 'string') throw new SessionCredentialError('UNSUPPORTED_FILTER', `sessions.${field}.${op} must hold strings`);
          return sessionCredentialDigest(v);
        });
        break;
      case 'not':
        out[op] = digestFilter(field, value);
        break;
      default:
        // contains / startsWith / endsWith / lt / gt / mode / search …: a digest has no prefix, no order, no case.
        throw new SessionCredentialError('UNSUPPORTED_FILTER', `sessions.${field}.${op}: a credential is only ever compared for equality`);
    }
  }
  return out;
}

/** Digest every credential field in a where / cursor, through AND / OR / NOT at any depth. */
export function digestSessionWhere(where: unknown): unknown {
  if (!isPlainObject(where)) return where;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      out[key] = Array.isArray(value) ? value.map(digestSessionWhere) : digestSessionWhere(value);
    } else if (CREDENTIAL_FIELD_SET.has(key)) {
      out[key] = digestFilter(key, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Digest every credential field in create / update data (a `createMany` list included). */
export function digestSessionData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(digestSessionData);
  if (!isPlainObject(data)) return data;
  const out: Record<string, unknown> = { ...data };
  for (const field of SESSION_CREDENTIAL_FIELDS) {
    if (!(field in out)) continue;
    const value = out[field];
    if (value === undefined || value === null) continue; // null: only previousRefreshToken is nullable; Prisma refuses the rest
    if (typeof value === 'string') {
      out[field] = storageDigest(field, value);
    } else if (isPlainObject(value) && 'set' in value) {
      const set = value['set'];
      if (set !== null && typeof set !== 'string') throw new SessionCredentialError('UNSUPPORTED_WRITE', `sessions.${field}.set must be a string or null`);
      out[field] = { ...value, set: set === null ? null : storageDigest(field, set) };
    } else {
      throw new SessionCredentialError('UNSUPPORTED_WRITE', `sessions.${field}: unsupported write value`);
    }
  }
  return out;
}

/** Every Prisma argument that can carry a credential, whatever the operation. */
export function digestSessionArgs<T extends Record<string, unknown>>(args: T): T {
  const next: Record<string, unknown> = { ...args };
  if ('where' in next) next['where'] = digestSessionWhere(next['where']);
  if ('cursor' in next) next['cursor'] = digestSessionWhere(next['cursor']);
  if ('data' in next) next['data'] = digestSessionData(next['data']);
  if ('create' in next) next['create'] = digestSessionData(next['create']);
  if ('update' in next) next['update'] = digestSessionData(next['update']);
  return next as T;
}

/** The storage boundary: installed on the process's one client in plugins/prisma.ts. */
export const sessionCredentialDigestExtension = () => Prisma.defineExtension({
  name: 'sessionCredentialDigest',
  query: {
    session: {
      async $allOperations({ args, query }) {
        return query(digestSessionArgs(args as unknown as Record<string, unknown>) as typeof args);
      },
    },
  },
});
