import type Redis from 'ioredis';

const OTP_PREFIX = 'otp:';
const OTP_TTL = 300; // 5 minutes
const OTP_RATE_PREFIX = 'otp_rate:';
const OTP_RATE_TTL = 60; // 1 request per 60 seconds
const OTP_MAX_ATTEMPTS = 5;
const OTP_ATTEMPT_PREFIX = 'otp_attempt:';

export function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function storeOtp(redis: Redis, phone: string, otp: string): Promise<void> {
  await redis.set(`${OTP_PREFIX}${phone}`, otp, 'EX', OTP_TTL);
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

  if (stored !== code) {
    return { valid: false, reason: 'Invalid OTP code' };
  }

  // Valid — clean up
  await redis.del(`${OTP_PREFIX}${phone}`);
  await redis.del(`${OTP_ATTEMPT_PREFIX}${phone}`);
  return { valid: true };
}

export async function checkOtpRateLimit(redis: Redis, phone: string): Promise<boolean> {
  const exists = await redis.exists(`${OTP_RATE_PREFIX}${phone}`);
  if (exists) return false;
  await redis.set(`${OTP_RATE_PREFIX}${phone}`, '1', 'EX', OTP_RATE_TTL);
  return true;
}
