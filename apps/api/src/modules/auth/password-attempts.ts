import { createHash } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * [L04 · MASTER-056] Wrong-password budget per (account, source).
 *
 * The source is the client address the app already trusts (request.ip, which
 * Fastify derives under TRUST_PROXY). Five wrong passwords from one source
 * inside the window lock password sign-in for THAT source only, for the lock
 * period. A guesser somewhere else can therefore never spend the owner's
 * budget, and SMS-code sign-in reads none of this, so it stays open.
 *
 * The address itself is never stored: keys carry a digest of it. A password
 * reset or a password change starts a new generation, so every source's
 * counter and lock for that account are left behind at once.
 */
export const PASSWORD_FAILURES_PER_SOURCE = 5;
export const PASSWORD_FAILURE_WINDOW_S = 15 * 60;
export const PASSWORD_SOURCE_LOCK_S = 15 * 60;

const sourceDigest = (source: string): string => createHash('sha256')
  .update('swift:password-source:v1\0')
  .update(source || 'unknown')
  .digest('hex')
  .slice(0, 32);

const generationKey = (userId: string) => `pwauth:{${userId}}:gen`;
const failKey = (userId: string, gen: string, source: string) => `pwauth:{${userId}}:fail:${gen}:${sourceDigest(source)}`;
const lockKey = (userId: string, gen: string, source: string) => `pwauth:{${userId}}:lock:${gen}:${sourceDigest(source)}`;

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

export async function isPasswordSourceLocked(redis: Redis, userId: string, source: string): Promise<boolean> {
  const gen = await generationOf(redis, userId);
  return (await redis.exists(lockKey(userId, gen, source))) === 1;
}

/** Count one wrong password from this source. Returns true when it locked the source. */
export async function recordPasswordFailure(redis: Redis, userId: string, source: string): Promise<boolean> {
  const gen = await generationOf(redis, userId);
  const locked = await redis.eval(
    RECORD_FAILURE_SCRIPT,
    2,
    failKey(userId, gen, source),
    lockKey(userId, gen, source),
    String(PASSWORD_FAILURES_PER_SOURCE),
    String(PASSWORD_FAILURE_WINDOW_S),
    String(PASSWORD_SOURCE_LOCK_S),
  );
  return Number(locked) === 1;
}

/** A successful sign-in from this source clears its count. */
export async function clearPasswordFailures(redis: Redis, userId: string, source: string): Promise<void> {
  const gen = await generationOf(redis, userId);
  await redis.del(failKey(userId, gen, source));
}

/** A new credential: every source's count and lock for this account is left behind. */
export async function resetPasswordAttemptBudget(redis: Redis, userId: string): Promise<void> {
  await redis.incr(generationKey(userId));
  // Outlives every count and lock it supersedes (both are at most 15 minutes).
  await redis.expire(generationKey(userId), 24 * 60 * 60);
}
