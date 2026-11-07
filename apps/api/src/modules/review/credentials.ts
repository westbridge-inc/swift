/**
 * [STA-1 Part 3 / DL-6] The store reviewer's login credential.
 *
 * A review identifier is a fictional number: no SMS can reach it, so its code
 * is static and stored HASHED. It is accepted only when the identifier
 * resolves to a REVIEW tenant, and (in auth.service) only for a user in that
 * tenant. Everything else about it is the production OTP flow, deliberately:
 * armed by send-otp, five minutes, five attempts, single use, the same error
 * strings — so neither the login screen nor a network observer can tell.
 *
 * Threat model: the prize is the fiction. Online guessing is capped here and
 * by the route rate limit; offline brute force of a leaked hash yields a
 * demo account with invented data and no money rail (DL-5).
 */
import crypto from 'node:crypto';
import type Redis from 'ioredis';
import type { PrismaClient } from '@prisma/client';
import { runWithoutTenant } from '../../plugins/tenant-context';

/** Same window and cap as a real code (utils/otp.ts). */
export const REVIEW_CODE_TTL = 300;
export const REVIEW_CODE_MAX_ATTEMPTS = 5;
/** Failures outlive the window so re-arming does not hand out five more at once. */
export const REVIEW_CODE_LOCKOUT = 900;
const ARMED_PREFIX = 'review_otp:';
const FAIL_PREFIX = 'review_otp_fail:';

export interface ReviewCredentialFacts { id: string; tenantId: string; staticOtpHash: string }

/** The stored form of a static code: salted by the credential's own id. */
export function hashReviewCode(credentialId: string, code: string): string {
  return 'sha256:' + crypto.createHash('sha256')
    .update(`swift:review-code:v1\0${credentialId}\0`)
    .update(code)
    .digest('hex');
}

/**
 * The credential an identifier resolves to — ONLY when its tenant is REVIEW.
 * A system read: authentication runs before any tenant is bound.
 */
export async function reviewCredentialFor(prisma: PrismaClient, identifier: string): Promise<ReviewCredentialFacts | null> {
  return runWithoutTenant(
    () => prisma.reviewCredential.findFirst({
      where: { identifier, tenant: { kind: 'REVIEW' } },
      select: { id: true, tenantId: true, staticOtpHash: true },
    }),
    'review-credential-login',
  );
}

/** Does `code` match the credential's stored hash? Constant-time; nothing else. */
export function reviewCodeMatches(credential: Pick<ReviewCredentialFacts, 'id' | 'staticOtpHash'>, code: string): boolean {
  const expected = Buffer.from(credential.staticOtpHash);
  const got = Buffer.from(hashReviewCode(credential.id, code));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/**
 * [SEC-TRUST F12] Take one attempt from the failure budget BEFORE the code is compared, in one Redis
 * script (one key, so it is atomic on standalone Redis and Redis Cluster, like utils/otp.ts): a guess is
 * compared only if it got one of the five places. Simultaneous guesses cannot all read a low count.
 * Returns false when the budget is spent (nothing is counted then). A correct code clears the key.
 */
const RESERVE_ATTEMPT_SCRIPT = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
if used >= tonumber(ARGV[1]) then return 0 end
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
return 1
`;
export async function reserveReviewAttempt(redis: Pick<Redis, 'eval'>, failKey: string): Promise<boolean> {
  return Number(await redis.eval(RESERVE_ATTEMPT_SCRIPT, 1, failKey, String(REVIEW_CODE_MAX_ATTEMPTS), String(REVIEW_CODE_LOCKOUT))) === 1;
}

/** send-otp for a review identifier: nothing is sent; the window opens. */
export async function armReviewCode(redis: Redis, identifier: string, credentialId: string): Promise<void> {
  await redis.set(`${ARMED_PREFIX}${identifier}`, credentialId, 'EX', REVIEW_CODE_TTL);
}

/** verify-otp for a review identifier. Reasons are the production strings, verbatim. */
export async function verifyReviewCode(
  redis: Redis,
  identifier: string,
  code: string,
  credential: ReviewCredentialFacts,
): Promise<{ valid: boolean; reason?: string }> {
  const armedKey = `${ARMED_PREFIX}${identifier}`;
  const failKey = `${FAIL_PREFIX}${identifier}`;
  const armed = await redis.get(armedKey);
  if (armed !== credential.id) return { valid: false, reason: 'OTP expired or not found. Request a new one.' };
  // [SEC-TRUST F12] The attempt is counted first, atomically; only then is the code compared.
  if (!(await reserveReviewAttempt(redis, failKey))) return { valid: false, reason: 'Too many attempts. Request a new OTP.' };
  if (!reviewCodeMatches(credential, code)) return { valid: false, reason: 'Invalid OTP code' };
  await redis.del(armedKey, failKey);
  return { valid: true };
}
