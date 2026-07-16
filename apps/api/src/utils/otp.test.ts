import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateOtp, storeOtp, verifyOtp, checkOtpRateLimit } from './otp';

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function createMockRedis() {
  const store = new Map<string, string>();

  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ex?: string, _ttl?: number) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    incr: vi.fn(async (key: string) => {
      const current = parseInt(store.get(key) || '0', 10);
      store.set(key, (current + 1).toString());
      return current + 1;
    }),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// generateOtp
// ---------------------------------------------------------------------------

describe('generateOtp', () => {
  it('returns a 6-digit string', () => {
    const otp = generateOtp();
    expect(otp).toHaveLength(6);
  });

  it('contains only digits', () => {
    for (let i = 0; i < 50; i++) {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
    }
  });

  it('is between 100000 and 999999', () => {
    for (let i = 0; i < 50; i++) {
      const num = parseInt(generateOtp(), 10);
      expect(num).toBeGreaterThanOrEqual(100000);
      expect(num).toBeLessThanOrEqual(999999);
    }
  });
});

// ---------------------------------------------------------------------------
// storeOtp
// ---------------------------------------------------------------------------

describe('storeOtp', () => {
  it('stores OTP in Redis with correct key', async () => {
    const redis = createMockRedis();
    await storeOtp(redis as never, '+5926003000', '123456');

    // Hashed at rest (launch-readiness §1.1): the stored value is sha256:<hex>.
    expect(redis.set).toHaveBeenCalledWith(
      'otp:+5926003000',
      'sha256:8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
      'EX',
      300,
    );
  });

  it('clears previous attempts on store', async () => {
    const redis = createMockRedis();
    await storeOtp(redis as never, '+5926003000', '123456');

    expect(redis.del).toHaveBeenCalledWith('otp_attempt:+5926003000');
  });
});

// ---------------------------------------------------------------------------
// verifyOtp
// ---------------------------------------------------------------------------

describe('verifyOtp', () => {
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    redis = createMockRedis();
  });

  it('returns valid:true for correct OTP', async () => {
    redis.store.set('otp:+5926003000', '123456');

    const result = await verifyOtp(redis as never, '+5926003000', '123456');
    expect(result).toEqual({ valid: true });
  });

  it('cleans up keys after successful verification', async () => {
    redis.store.set('otp:+5926003000', '123456');

    await verifyOtp(redis as never, '+5926003000', '123456');

    // Should have deleted both the OTP and attempt keys
    expect(redis.del).toHaveBeenCalledWith('otp:+5926003000');
    expect(redis.del).toHaveBeenCalledWith('otp_attempt:+5926003000');
  });

  it('returns valid:false for wrong OTP', async () => {
    redis.store.set('otp:+5926003000', '123456');

    const result = await verifyOtp(redis as never, '+5926003000', '999999');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid OTP code');
  });

  it('returns valid:false for expired OTP (not found)', async () => {
    // No OTP stored in Redis
    const result = await verifyOtp(redis as never, '+5926003000', '123456');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('returns valid:false after too many attempts', async () => {
    redis.store.set('otp:+5926003000', '123456');
    redis.store.set('otp_attempt:+5926003000', '5'); // Max attempts reached

    const result = await verifyOtp(redis as never, '+5926003000', '123456');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Too many attempts');
  });

  it('increments attempts on each verification', async () => {
    redis.store.set('otp:+5926003000', '123456');

    await verifyOtp(redis as never, '+5926003000', '000000');
    expect(redis.incr).toHaveBeenCalledWith('otp_attempt:+5926003000');
  });
});

// ---------------------------------------------------------------------------
// checkOtpRateLimit
// ---------------------------------------------------------------------------

describe('checkOtpRateLimit', () => {
  it('returns true (allowed) when no recent request exists', async () => {
    const redis = createMockRedis();
    const allowed = await checkOtpRateLimit(redis as never, '+5926003000');
    expect(allowed).toBe(true);
  });

  it('sets rate limit key after allowing request', async () => {
    const redis = createMockRedis();
    await checkOtpRateLimit(redis as never, '+5926003000');
    expect(redis.set).toHaveBeenCalledWith('otp_rate:+5926003000', '1', 'EX', 60);
  });

  it('returns false (rate-limited) when recent request exists', async () => {
    const redis = createMockRedis();
    redis.store.set('otp_rate:+5926003000', '1');
    const allowed = await checkOtpRateLimit(redis as never, '+5926003000');
    expect(allowed).toBe(false);
  });
});
