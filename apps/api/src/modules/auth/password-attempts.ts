import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type Redis from 'ioredis';
import { isProduction } from '../../utils/runtime-mode';

/**
 * [L04 · MASTER-056] Wrong-password budgets.
 *
 * Two bounds, both on password sign-in only — SMS-code sign-in reads neither,
 * so the real owner always has a way in:
 *  - per (account, source): five wrong passwords from one source inside the
 *    window lock password sign-in for THAT source only. A guesser at one
 *    address can never spend the owner's budget elsewhere.
 *  - per account, across ALL sources: a wider ceiling. An attacker rotating
 *    addresses gets at most this many guesses per window at one account,
 *    then password sign-in pauses for that account everywhere.
 *
 * The source is the client address the app already trusts (request.ip, which
 * Fastify derives under TRUST_PROXY), bucketed: IPv6 by its /64 (one host
 * owns a whole /64), IPv4-mapped IPv6 as its IPv4 address. Keys carry a keyed
 * HMAC of the bucket (the OTP hashing secret), never the address, so the
 * keyspace is not a reversible address log. A password reset or change starts
 * a new generation, leaving every count and lock behind at once.
 */
export const PASSWORD_FAILURES_PER_SOURCE = 5;
export const PASSWORD_FAILURE_WINDOW_S = 15 * 60;
export const PASSWORD_SOURCE_LOCK_S = 15 * 60;
/** The account-wide ceiling across ALL sources in the window. */
export const PASSWORD_FAILURES_PER_ACCOUNT = 20;
export const PASSWORD_ACCOUNT_LOCK_S = 15 * 60;

/** The unit a per-source budget belongs to: an IPv4 address, or an IPv6 /64. */
export function passwordSourceBucket(source: string): string {
  const raw = (source || '').trim().toLowerCase();
  const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped && isIPv4(mapped[1]!)) return `v4:${mapped[1]}`;
  if (isIPv4(raw)) return `v4:${raw}`;
  if (isIPv6(raw)) {
    const [head = '', tail = ''] = raw.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = raw.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return `v6:${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
  }
  return `other:${raw || 'unknown'}`;
}

function digestKey(env: Record<string, string | undefined>): string {
  const secret = env['OTP_HASH_SECRET'] ?? env['JWT_SECRET'];
  if (secret) return secret;
  // Production is refused by the boot guard without one of these secrets.
  if (isProduction(env)) throw new Error('OTP_HASH_SECRET or JWT_SECRET is required in production');
  return 'swift-local-password-source-key-not-for-production';
}

/** A keyed pseudonym of the source's bucket. */
export function passwordSourceDigest(source: string, env: Record<string, string | undefined> = process.env): string {
  return createHmac('sha256', digestKey(env))
    .update('swift:password-source:v2\0')
    .update(passwordSourceBucket(source))
    .digest('hex')
    .slice(0, 32);
}

const generationKey = (userId: string) => `pwauth:{${userId}}:gen`;
const failKey = (userId: string, gen: string, source: string) => `pwauth:{${userId}}:fail:${gen}:${passwordSourceDigest(source)}`;
const lockKey = (userId: string, gen: string, source: string) => `pwauth:{${userId}}:lock:${gen}:${passwordSourceDigest(source)}`;
const accountFailKey = (userId: string, gen: string) => `pwauth:{${userId}}:acctfail:${gen}`;
const accountLockKey = (userId: string, gen: string) => `pwauth:{${userId}}:acctlock:${gen}`;

async function generationOf(redis: Redis, userId: string): Promise<string> {
  return (await redis.get(generationKey(userId))) ?? '0';
}

// INCR the source's failure count inside its window; at the limit, lock the
// source and start its count again. One script, so concurrent failures are
// never lost and never double-lock.
const RECORD_FAILURE_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if n >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/** Password sign-in is paused for this source, or for the whole account. */
export async function isPasswordSignInLocked(redis: Redis, userId: string, source: string): Promise<boolean> {
  const gen = await generationOf(redis, userId);
  return (await redis.exists(lockKey(userId, gen, source), accountLockKey(userId, gen))) > 0;
}

/** Count one wrong password against this source AND the account; says which lock (if any) this failure set. */
export async function recordPasswordFailure(redis: Redis, userId: string, source: string): Promise<{ sourceLocked: boolean; accountLocked: boolean }> {
  const gen = await generationOf(redis, userId);
  const sourceLocked = await redis.eval(
    RECORD_FAILURE_SCRIPT,
    2,
    failKey(userId, gen, source),
    lockKey(userId, gen, source),
    String(PASSWORD_FAILURES_PER_SOURCE),
    String(PASSWORD_FAILURE_WINDOW_S),
    String(PASSWORD_SOURCE_LOCK_S),
  );
  const accountLocked = await redis.eval(
    RECORD_FAILURE_SCRIPT,
    2,
    accountFailKey(userId, gen),
    accountLockKey(userId, gen),
    String(PASSWORD_FAILURES_PER_ACCOUNT),
    String(PASSWORD_FAILURE_WINDOW_S),
    String(PASSWORD_ACCOUNT_LOCK_S),
  );
  return { sourceLocked: Number(sourceLocked) === 1, accountLocked: Number(accountLocked) === 1 };
}

/**
 * The budget subject for an attempt. A real account is its id; an unknown
 * identifier (or an account with no password) gets a keyed pseudonym of the
 * identifier, so every attempt touches the budget store the same way and an
 * unknown account is counted and locked exactly like a real one (MASTER-054).
 */
export function passwordBudgetSubject(
  account: { id: string } | null,
  identifier: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (account) return account.id;
  return `none:${createHmac('sha256', digestKey(env)).update('swift:password-subject:v1\0').update(identifier.toLowerCase()).digest('hex').slice(0, 32)}`;
}

/** A successful sign-in from this source clears its count. */
export async function clearPasswordFailures(redis: Redis, userId: string, source: string): Promise<void> {
  const gen = await generationOf(redis, userId);
  await redis.del(failKey(userId, gen, source), accountFailKey(userId, gen));
}

/** A new credential: every source's count and lock for this account is left behind. */
export async function resetPasswordAttemptBudget(redis: Redis, userId: string): Promise<void> {
  await redis.incr(generationKey(userId));
  // Outlives every count and lock it supersedes (both are at most 15 minutes).
  await redis.expire(generationKey(userId), 24 * 60 * 60);
}

/** [review r2 S3-1] Marks that limit the pause notice: at most one per account
 *  per day, and only the first in a month makes a sound. */
export function passwordPausedNoticeKeys(userId: string): { daily: string; recent: string } {
  return { daily: `pwauth:{${userId}}:paused-notice:day`, recent: `pwauth:{${userId}}:paused-notice:month` };
}
