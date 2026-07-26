import crypto from 'node:crypto';
import type Redis from 'ioredis';

const OTP_PREFIX = 'otp:';
const OTP_TTL = 300; // 5 minutes
const OTP_RATE_PREFIX = 'otp_rate:';
const OTP_RATE_TTL = 60; // 1 request per 60 seconds
const OTP_MAX_ATTEMPTS = 5;
const OTP_ATTEMPT_PREFIX = 'otp_attempt:';
const HASH_TAG = 'sha256:';

/** CSPRNG 6-digit code — Math.random is guessable in principle; this isn't. */
export function generateOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

const hashOtp = (otp: string) => HASH_TAG + crypto.createHash('sha256').update(otp).digest('hex');

/** Constant-time equality on equal-length strings. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Codes are HASHED at rest (launch-readiness §1.1): a redis snapshot or a
 *  MONITOR tap never yields a usable code. */
export async function storeOtp(redis: Redis, phone: string, otp: string): Promise<void> {
  await redis.set(`${OTP_PREFIX}${phone}`, hashOtp(otp), 'EX', OTP_TTL);
  await redis.del(`${OTP_ATTEMPT_PREFIX}${phone}`);
}

export async function verifyOtp(redis: Redis, phone: string, code: string): Promise<{ valid: boolean; reason?: string }> {
  // Check attempts
  const attempts = parseInt((await redis.get(`${OTP_ATTEMPT_PREFIX}${phone}`)) || '0', 10);
  if (attempts >= OTP_MAX_ATTEMPTS) {
    return { valid: false, reason: 'Too many attempts. Request a new OTP.' };
  }

  const stored = await redis.get(`${OTP_PREFIX}${phone}`);
  if (!stored) {
    return { valid: false, reason: 'OTP expired or not found. Request a new one.' };
  }

  // Increment attempts
  await redis.incr(`${OTP_ATTEMPT_PREFIX}${phone}`);
  await redis.expire(`${OTP_ATTEMPT_PREFIX}${phone}`, OTP_TTL);

  // Hashed compare (constant-time). The plaintext branch only exists for codes
  // already in flight when this shipped — the 5-minute TTL retires it fast.
  const matches = stored.startsWith(HASH_TAG) ? safeEqual(stored, hashOtp(code)) : safeEqual(stored, code);
  if (!matches) {
    return { valid: false, reason: 'Invalid OTP code' };
  }

  // Valid — clean up
  await redis.del(`${OTP_PREFIX}${phone}`);
  await redis.del(`${OTP_ATTEMPT_PREFIX}${phone}`);
  return { valid: true };
}

export async function checkOtpRateLimit(redis: Redis, phone: string): Promise<boolean> {
  // Atomic check-and-set: SET NX returns null if the key already exists, 'OK' if
  // we just claimed it. A plain exists→set is a TOCTOU race — N concurrent
  // requests all see "not set" and all pass, defeating the 1-per-minute cap and
  // letting an attacker fan out SMS (bombing a victim + burning the SMS budget).
  const claimed = await redis.set(`${OTP_RATE_PREFIX}${phone}`, '1', 'EX', OTP_RATE_TTL, 'NX');
  return claimed === 'OK';
}
