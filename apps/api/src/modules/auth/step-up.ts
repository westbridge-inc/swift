import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { AppError } from '../../utils/errors';
import { generateOtp, storeOtp, verifyOtp, checkOtpRateLimit } from '../../utils/otp';
import { checkOtpDailyBudget, smsDestinationAllowed } from '../../utils/sms-budget';
import { getChannels } from '../../providers/notifications/channels';
import { log } from '../../utils/logger';
import { reviewCredentialFor, reviewCodeMatches, REVIEW_CODE_TTL } from '../review/credentials';

/**
 * [ALG-34] Step-up: "confirm it's you" for an EXISTING session, before a
 * money surface moves.
 *
 * A session proves it once held the phone; a step-up proves it holds the
 * phone NOW. The code goes to the phone on the account, and a verified
 * step-up is good for ten minutes on THIS session only — another session of
 * the same account (an attacker's, or the owner's other device) must earn its
 * own. The requirement is not switchable: a kill switch on a security
 * invariant is itself the attack surface.
 *
 * Buckets are the account's own (`stepup:<userId>`), never the login OTP's:
 * the algorithm document says an OTP for an existing session's step-up is
 * not the same bucket as a signup OTP, so a step-up can neither exhaust nor
 * be exhausted by the login flow. The paid-SMS daily budget IS shared — that
 * cap is about spend, not about flows.
 *
 * Failure burst: five wrong codes inside ten minutes locks step-up for
 * fifteen minutes. The lock is on the ACCOUNT (whoever holds the session),
 * and it is a lock on step-up alone — the session keeps working for
 * everything that never needed one.
 */

export const STEP_UP_TTL_S = 10 * 60;
export const STEP_UP_FAIL_WINDOW_S = 10 * 60;
export const STEP_UP_FAIL_MAX = 5;
export const STEP_UP_LOCK_S = 15 * 60;

/** The OTP record key handed to utils/otp (which prefixes it `otp:`). */
export const stepUpCodeKey = (userId: string) => `stepup:${userId}`;
/** A verified step-up, bound to the SESSION. */
export const stepUpKey = (sessionId: string) => `stepup:ok:${sessionId}`;
const failKey = (userId: string) => `stepup:fail:${userId}`;
const lockKey = (userId: string) => `stepup:lock:${userId}`;

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const tail = digits.slice(-4);
  const head = phone.startsWith('+') ? phone.slice(0, 4) : '';
  return `${head}•••••${tail}`;
}

async function assertNotLocked(redis: Redis, userId: string): Promise<void> {
  const ttl = await redis.ttl(lockKey(userId));
  if (ttl > 0) {
    const minutes = Math.max(1, Math.ceil(ttl / 60));
    throw new AppError(429, 'STEP_UP_LOCKED', `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

/** [REVIEW-PARTNER · DL-6] Armed by a step-up "send" for a store-review login (the account's own bucket). */
export const reviewStepUpKey = (userId: string) => `stepup:review:${userId}`;

/**
 * [REVIEW-PARTNER · DL-6] The account's store-review credential, when it is
 * one: its phone is a fictional identifier no text can reach, so the static
 * review code from the store notes confirms it instead — exactly as it signs
 * in. Only a credential of a REVIEW tenant, and only for an account IN that
 * tenant (a credential written for a production number confirms nothing).
 */
async function reviewStepUpCredential(app: FastifyInstance, user: { phone: string; tenantId: string }) {
  const credential = await reviewCredentialFor(app.prisma, user.phone);
  return credential && credential.tenantId === user.tenantId ? credential : null;
}

/** Text a confirmation code to the phone on the account. */
export async function sendStepUpOtp(app: FastifyInstance, userId: string): Promise<{ sentTo: string; validForSeconds: number }> {
  const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { phone: true, tenantId: true } });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'This account is no longer active');

  // [REVIEW-PARTNER · DL-6] A store-review login: NO SMS, no budget spent. The
  // window opens exactly as a real send's would (same rate limit, same five
  // minutes, same answer), single use, behind the same failure lock.
  if (await reviewStepUpCredential(app, user)) {
    await assertNotLocked(app.redis, userId);
    if (!(await checkOtpRateLimit(app.redis, stepUpCodeKey(userId)))) {
      throw new AppError(429, 'RATE_LIMITED', 'Please wait a minute before requesting another code');
    }
    // A fresh generation per send: verification consumes exactly THIS window, once.
    await app.redis.set(reviewStepUpKey(userId), randomBytes(16).toString('hex'), 'EX', REVIEW_CODE_TTL);
    return { sentTo: maskPhone(user.phone), validForSeconds: 300 };
  }
  // [AUD-L4-008] A code is texted only to a launch-market number, checked
  // before anything is counted.
  if (!smsDestinationAllowed(user.phone)) {
    throw new AppError(400, 'COUNTRY_NOT_ACTIVE', "We can't text a code to the phone number on this account. Contact Swift support.");
  }

  await assertNotLocked(app.redis, userId);
  if (!(await checkOtpRateLimit(app.redis, stepUpCodeKey(userId)))) {
    throw new AppError(429, 'RATE_LIMITED', 'Please wait a minute before requesting another code');
  }
  // The account exists and holds a live session: its phone is KNOWN, so it
  // draws from the separate known-phone budget — a flood of new-number
  // requests cannot lock an existing user's step-up out (audit High #2).
  const budget = await checkOtpDailyBudget(app.redis, user.phone, { knownPhone: true });
  if (!budget.allowed) {
    if (budget.reason === 'global_daily') log().error('[sms-budget] global daily OTP cap reached — refusing a step-up send');
    else if (budget.reason === 'known_daily') log().error('[sms-budget] known-phone daily OTP cap reached — refusing a step-up send');
    throw new AppError(429, 'RATE_LIMITED', 'Too many verification requests right now. Please try again later.');
  }

  const code = generateOtp();
  await storeOtp(app.redis, stepUpCodeKey(userId), code);
  try {
    await getChannels().sms.sendSms(user.phone, `Your Swift confirmation code is ${code}. It confirms a change to your account. Swift will never ask you for it.`);
  } catch (err) {
    await budget.refund?.().catch(() => {});
    log().error({ err, userId }, 'step-up: SMS send failed');
    throw new AppError(502, 'SMS_SEND_FAILED', "We couldn't send your code right now. Please try again in a moment.");
  }
  return { sentTo: maskPhone(user.phone), validForSeconds: 300 };
}

/** Compare-and-delete: consumes the window only if it still holds the generation this verifier read. */
const CONSUME_REVIEW_WINDOW = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** [REVIEW-PARTNER · DL-6] The static review code, only when a review "send" armed the window.
 *  Single use and expiry-exact: after the code is validated, the window is consumed ATOMICALLY by
 *  the generation read at the start — two concurrent verifiers cannot both win, and a window that
 *  expired (or was re-armed) during the lookup does not succeed. */
async function verifyReviewStepUp(app: FastifyInstance, userId: string, code: string): Promise<{ valid: boolean; reason?: string } | null> {
  const key = reviewStepUpKey(userId);
  const generation = await app.redis.get(key);
  if (!generation) return null;
  const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { phone: true, tenantId: true } });
  const credential = user ? await reviewStepUpCredential(app, user) : null;
  if (!credential) return { valid: false, reason: 'OTP expired or not found. Request a new one.' };
  if (!reviewCodeMatches(credential, code)) return { valid: false, reason: 'Invalid OTP code' };
  const consumed = Number(await app.redis.eval(CONSUME_REVIEW_WINDOW, 1, key, generation));
  if (consumed !== 1) return { valid: false, reason: 'OTP expired or not found. Request a new one.' };
  return { valid: true };
}

/** Check the code; on success the SESSION is stepped up for STEP_UP_TTL_S. */
export async function verifyStepUp(app: FastifyInstance, who: { userId: string; sessionId: string }, code: string): Promise<{ validForSeconds: number }> {
  await assertNotLocked(app.redis, who.userId);
  const result = (await verifyReviewStepUp(app, who.userId, code)) ?? await verifyOtp(app.redis, stepUpCodeKey(who.userId), code);
  if (!result.valid) {
    const failures = await app.redis.incr(failKey(who.userId));
    if (failures === 1) await app.redis.expire(failKey(who.userId), STEP_UP_FAIL_WINDOW_S);
    if (failures >= STEP_UP_FAIL_MAX) {
      await app.redis.set(lockKey(who.userId), '1', 'EX', STEP_UP_LOCK_S);
      await app.redis.del(failKey(who.userId));
      throw new AppError(429, 'STEP_UP_LOCKED', `Too many wrong codes. Try again in ${Math.round(STEP_UP_LOCK_S / 60)} minutes.`);
    }
    throw new AppError(400, 'INVALID_CODE', result.reason ?? 'That code is not right');
  }
  await app.redis.del(failKey(who.userId));
  await app.redis.set(stepUpKey(who.sessionId), '1', 'EX', STEP_UP_TTL_S);
  return { validForSeconds: STEP_UP_TTL_S };
}

export async function hasStepUp(redis: Redis, sessionId: string): Promise<boolean> {
  return (await redis.exists(stepUpKey(sessionId))) === 1;
}

/**
 * The gate a money surface calls first. 403 STEP_UP_REQUIRED tells the client
 * exactly how to earn it, so the screen can run the code sheet and retry.
 */
export async function requireStepUp(app: FastifyInstance, request: { user: { userId: string }; authSessionId: string | null }): Promise<void> {
  const sessionId = request.authSessionId;
  if (!sessionId) throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
  if (await hasStepUp(app.redis, sessionId)) return;
  throw new AppError(403, 'STEP_UP_REQUIRED', 'Confirm it’s you first — we’ll text a code to the phone on this account.', {
    stepUp: { send: 'POST /auth/step-up', verify: 'POST /auth/step-up/verify', validForSeconds: STEP_UP_TTL_S },
  });
}

/**
 * [DELETION-INTEGRITY · coordinator ruling 2026-10-05, Q3b] Account deletion
 * and closure requests only: a session that an OTP sign-in created within the
 * step-up window already carries what a step-up proves — a code reached the
 * phone on the account, on THIS session, minutes ago. App builds without the
 * step-up sheet (and a store reviewer who just signed in with a code) can
 * therefore still delete. Any older session, or one not created by an OTP
 * sign-in, still needs the step-up. Refresh rotation keeps createdAt, so a
 * refreshed session never looks fresh.
 */
export async function requireRecentOtpOrStepUp(
  app: FastifyInstance,
  request: { user: { userId: string }; authSessionId: string | null },
): Promise<void> {
  const sessionId = request.authSessionId;
  if (sessionId) {
    const session = await app.prisma.session.findUnique({
      where: { id: sessionId }, select: { userId: true, authMethod: true, createdAt: true },
    });
    if (session && session.userId === request.user.userId && session.authMethod === 'OTP'
      && Date.now() - session.createdAt.getTime() <= STEP_UP_TTL_S * 1000) return;
  }
  await requireStepUp(app, request);
}

