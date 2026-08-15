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
    set: vi.fn(async (key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
      // Model atomic SET NX: a no-op returning null when the key already exists.
      if (nx === 'NX' && store.has(key)) return null;
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
    eval: vi.fn(async (
      _script: string,
      _keyCount: number,
      key: string,
      candidate: string,
      maxAttemptsRaw: string,
    ) => {
      const raw = store.get(key);
      if (!raw) return 0;
      const [version, expected, attemptsRaw, extra] = raw.split('|');
      if (version !== 'v2' || !expected || !attemptsRaw || extra !== undefined) {
        store.delete(key);
        return 0;
      }
      const attempts = Number(attemptsRaw);
      const maxAttempts = Number(maxAttemptsRaw);
      if (attempts >= maxAttempts) return 2;
      if (expected === candidate) {
        store.delete(key);
        return 1;
      }
      store.set(key, `v2|${expected}|${attempts + 1}`);
      return 3;
    }),
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

    // Keyed at rest and versioned with the attempt counter in one record.
    expect(redis.set).toHaveBeenCalledWith(
      'otp:+5926003000',
      expect.stringMatching(/^v2\|hmac-sha256:[a-f0-9]{64}\|0$/),
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
    await storeOtp(redis as never, '+5926003000', '123456');

    const result = await verifyOtp(redis as never, '+5926003000', '123456');
    expect(result).toEqual({ valid: true });
  });

  it('cleans up keys after successful verification', async () => {
    await storeOtp(redis as never, '+5926003000', '123456');

    await verifyOtp(redis as never, '+5926003000', '123456');

    expect(redis.store.has('otp:+5926003000')).toBe(false);
  });

  it('returns valid:false for wrong OTP', async () => {
    await storeOtp(redis as never, '+5926003000', '123456');

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
    await storeOtp(redis as never, '+5926003000', '123456');
    for (let i = 0; i < 5; i++) {
      await verifyOtp(redis as never, '+5926003000', '000000');
    }

    const result = await verifyOtp(redis as never, '+5926003000', '123456');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Too many attempts');
  });

  it('checks, increments, and consumes through one atomic one-key script', async () => {
    await storeOtp(redis as never, '+5926003000', '123456');

    await verifyOtp(redis as never, '+5926003000', '000000');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      1,
      'otp:+5926003000',
      expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
      '5',
    );
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
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
    expect(redis.set).toHaveBeenCalledWith('otp_rate:+5926003000', '1', 'EX', 60, 'NX');
  });

  it('returns false (rate-limited) when recent request exists', async () => {
    const redis = createMockRedis();
    redis.store.set('otp_rate:+5926003000', '1');
    const allowed = await checkOtpRateLimit(redis as never, '+5926003000');
    expect(allowed).toBe(false);
  });
});
