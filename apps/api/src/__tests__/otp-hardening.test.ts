import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { generateOtp, storeOtp, verifyOtp } from '../utils/otp';

// ---------------------------------------------------------------------------
// OTP hardening (launch-readiness §1.1): codes are CSPRNG-generated, hashed
// at rest with a keyed HMAC, atomically attempt-limited, and single-use. A
// Redis snapshot must never contain a directly usable or offline-brute-forceable
// six-digit code.
// ---------------------------------------------------------------------------

let redis: Redis;
const PHONE = '+59299otp-hardening';

beforeAll(() => {
  redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382');
});

afterAll(async () => {
  await redis.del(`otp:${PHONE}`, `otp_attempt:${PHONE}`, `otp_rate:${PHONE}`);
  redis.disconnect();
});

describe('otp hardening', () => {
  it('generates 6 digits from the CSPRNG range', () => {
    for (let i = 0; i < 50; i++) {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
      expect(Number(otp)).toBeGreaterThanOrEqual(100000);
      expect(Number(otp)).toBeLessThan(1000000);
    }
  });

  it('stores a hash, never the code — and verifies single-use', async () => {
    const otp = generateOtp();
    await storeOtp(redis, PHONE, otp);

    const atRest = await redis.get(`otp:${PHONE}`);
    expect(atRest).not.toBeNull();
    expect(atRest).not.toContain(otp); // the snapshot yields nothing usable
    expect(atRest).toMatch(/^v2\|hmac-sha256:[a-f0-9]{64}\|0$/);

    expect((await verifyOtp(redis, PHONE, '000001')).valid).toBe(false);
    expect((await verifyOtp(redis, PHONE, otp)).valid).toBe(true);
    // Single-use: the same code is gone.
    expect((await verifyOtp(redis, PHONE, otp)).valid).toBe(false);
  });

  it('invalidates a pre-v2 plaintext record instead of retaining a weak path', async () => {
    await redis.set(`otp:${PHONE}`, '424242', 'EX', 60);
    expect((await verifyOtp(redis, PHONE, '424242')).valid).toBe(false);
    expect(await redis.get(`otp:${PHONE}`)).toBeNull();
  });

  it('locks after 5 wrong attempts even with the right code afterwards', async () => {
    const otp = generateOtp();
    await storeOtp(redis, PHONE, otp);
    for (let i = 0; i < 5; i++) {
      expect((await verifyOtp(redis, PHONE, '999999')).valid).toBe(false);
    }
    const locked = await verifyOtp(redis, PHONE, otp);
    expect(locked.valid).toBe(false);
    expect(locked.reason).toContain('Too many attempts');
  });

  it('enforces the five-attempt ceiling atomically under parallel guesses', async () => {
    await storeOtp(redis, PHONE, '123456');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyOtp(redis, PHONE, '000000')),
    );
    expect(results.filter((result) => result.reason === 'Invalid OTP code')).toHaveLength(5);
    expect(results.filter((result) => result.reason?.includes('Too many attempts'))).toHaveLength(15);
    expect((await verifyOtp(redis, PHONE, '123456')).valid).toBe(false);
  });

  it('consumes one correct code exactly once under parallel submissions', async () => {
    await storeOtp(redis, PHONE, '654321');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => verifyOtp(redis, PHONE, '654321')),
    );
    expect(results.filter((result) => result.valid)).toHaveLength(1);
    expect(results.filter((result) => !result.valid)).toHaveLength(9);
  });
});
