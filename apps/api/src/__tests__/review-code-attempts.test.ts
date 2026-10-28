import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { armReviewCode, hashReviewCode, REVIEW_CODE_LOCKOUT, REVIEW_CODE_MAX_ATTEMPTS, verifyReviewCode } from '../modules/review/credentials';
import { hasStepUp, reviewStepUpKey, reviewStepUpTriesKey, verifyStepUp } from '../modules/auth/step-up';

// ---------------------------------------------------------------------------
// [SEC-TRUST F12] The store-review code's five attempts are counted BEFORE a
// guess is compared, in one atomic Redis script. Guesses sent all at once can
// no longer all read a low count and all be compared: only five are, so a
// correct code arriving behind a burst of wrong ones is refused. The same holds
// for the review account's step-up code.
// ---------------------------------------------------------------------------

const CODE = '135790';
let redis: Redis;

beforeAll(() => {
  redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6382', { lazyConnect: false, maxRetriesPerRequest: 1 });
});
afterAll(async () => { await redis.quit(); });

function credential() {
  const id = `cred-${nanoid(8)}`;
  return { id, tenantId: `review-${nanoid(6)}`, staticOtpHash: hashReviewCode(id, CODE) };
}

describe('[SEC-TRUST F12] review sign-in code', () => {
  it('a burst of wrong guesses spends the five attempts; the correct code behind them is refused', async () => {
    const identifier = `+5920${nanoid(6)}`;
    const cred = credential();
    await armReviewCode(redis, identifier, cred.id);
    const wrong = Array.from({ length: 19 }, (_, i) => verifyReviewCode(redis, identifier, String(100000 + i), cred));
    const right = verifyReviewCode(redis, identifier, CODE, cred);
    const results = await Promise.all([...wrong, right]);
    expect(results.filter((r) => r.reason === 'Invalid OTP code')).toHaveLength(REVIEW_CODE_MAX_ATTEMPTS);
    expect(results.at(-1)).toEqual({ valid: false, reason: 'Too many attempts. Request a new OTP.' });
    await redis.del(`review_otp:${identifier}`, `review_otp_fail:${identifier}`);
  });

  it('within the five attempts the correct code still signs in, once', async () => {
    const identifier = `+5920${nanoid(6)}`;
    const cred = credential();
    await armReviewCode(redis, identifier, cred.id);
    expect((await verifyReviewCode(redis, identifier, '000000', cred)).valid).toBe(false);
    // The counted failure expires on its own (it never becomes a permanent lock).
    const ttl = await redis.ttl(`review_otp_fail:${identifier}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(REVIEW_CODE_LOCKOUT);
    expect(await verifyReviewCode(redis, identifier, CODE, cred)).toEqual({ valid: true });
    expect((await verifyReviewCode(redis, identifier, CODE, cred)).valid).toBe(false);
  });
});

describe('[SEC-TRUST F12] review step-up code', () => {
  function fakeApp(userId: string, cred: ReturnType<typeof credential>) {
    const phone = `+5920${nanoid(6)}`;
    return {
      redis,
      prisma: {
        user: { findUnique: async () => ({ phone, tenantId: cred.tenantId }) },
        reviewCredential: { findFirst: async () => cred },
      },
      userId,
    } as unknown as FastifyInstance;
  }

  it('a burst of wrong guesses cannot carry the correct code past the attempt budget', async () => {
    const userId = `user-${nanoid(8)}`;
    const cred = credential();
    const app = fakeApp(userId, cred);
    await redis.set(reviewStepUpKey(userId), 'generation-1', 'EX', 300);
    const who = { userId, sessionId: `s-${nanoid(6)}` };
    const wrong = Array.from({ length: 19 }, (_, i) => verifyStepUp(app, who, String(200000 + i)).then(() => 'ok', () => 'refused'));
    const right = verifyStepUp(app, who, CODE).then(() => 'ok', () => 'refused');
    const outcomes = await Promise.all([...wrong, right]);
    expect(outcomes.at(-1)).toBe('refused');
    expect(await hasStepUp(redis, who.sessionId)).toBe(false);
    await redis.del(reviewStepUpKey(userId), `stepup:review-tries:${userId}`, `stepup:fail:${userId}`, `stepup:lock:${userId}`);
  });

  it('a successful review step-up gives the attempts back (five step-ups in a row never lock the reviewer)', async () => {
    const userId = `user-${nanoid(8)}`;
    const cred = credential();
    const app = fakeApp(userId, cred);
    const who = { userId, sessionId: `s-${nanoid(6)}` };
    for (let i = 0; i < REVIEW_CODE_MAX_ATTEMPTS + 2; i += 1) {
      await redis.set(reviewStepUpKey(userId), `generation-${i}`, 'EX', 300);
      await expect(verifyStepUp(app, who, CODE)).resolves.toBeTruthy();
      expect(await redis.exists(reviewStepUpTriesKey(userId))).toBe(0);
    }
    await redis.del(reviewStepUpKey(userId), `stepup:fail:${userId}`, `stepup:lock:${userId}`, `stepup:ok:${who.sessionId}`);
  });
});
