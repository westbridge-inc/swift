import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import {
  armDevelopmentSignupGeneration,
  consumeSignupContinuation,
  issueSignupContinuation,
  SIGNUP_CONTINUATION_TTL_S,
  storeSignupOtp,
  verifySignupOtp,
} from './signup-continuation';

type Stored = { value: string; expiresAt: number };
type ScriptCall = { script: string; keyCount: number; keys: string[]; argv: string[] };

/** A deterministic Redis-script harness that models each script's state transition. */
class ScriptRedis {
  readonly calls: ScriptCall[] = [];
  readonly values = new Map<string, Stored>();
  now = 1_700_000_000_000;

  async eval(script: string, keyCount: number, ...parts: Array<string | number>): Promise<number | string> {
    const keys = parts.slice(0, keyCount).map(String);
    const argv = parts.slice(keyCount).map(String);
    this.calls.push({ script, keyCount, keys, argv });
    this.expire();

    // Atomic OTP record + generation replacement.
    if (keyCount === 2 && argv.length === 4) {
      this.put(keys[0]!, argv[0]!, Number(argv[2]));
      this.put(keys[1]!, argv[1]!, Number(argv[3]));
      return 1;
    }

    // Development-only ceremony parity: arm a generation and invalidate the
    // earlier continuation in the same cluster-slot operation.
    if (keyCount === 3 && argv.length === 2 && script.includes("redis.call('SET', KEYS[1], ARGV[1]")) {
      this.put(keys[0]!, argv[0]!, Number(argv[1]));
      this.values.delete(keys[1]!);
      this.values.delete(keys[2]!);
      return 1;
    }

    // Atomic OTP verify/attempt/consume + earlier-continuation invalidation.
    if (keyCount === 3 && argv.length === 2) {
      const row = this.values.get(keys[0]!);
      if (!row) return '0';
      const [version, expected, attemptsText, extra] = row.value.split('|');
      if (version !== 'v2' || !expected || attemptsText == null || extra !== undefined) {
        this.values.delete(keys[0]!);
        return '0';
      }
      const attempts = Number(attemptsText);
      if (attempts >= Number(argv[1])) return '2';
      if (expected === argv[0]) {
        const generation = this.values.get(keys[1]!)?.value;
        this.values.delete(keys[0]!);
        this.values.delete(keys[2]!);
        return generation ? `1|${generation}` : '0';
      }
      this.put(keys[0]!, `v2|${expected}|${attempts + 1}`, Math.ceil((row.expiresAt - this.now) / 1_000));
      return '3';
    }

    // Generation-fenced continuation issuance.
    if (keyCount === 3 && argv.length === 3) {
      if (this.values.get(keys[2]!)?.value !== argv[1]) return 0;
      this.put(keys[1]!, argv[0]!, Number(argv[2]));
      this.put(keys[0]!, argv[0]!, Number(argv[2]));
      this.values.delete(keys[2]!);
      return 1;
    }

    // One-use continuation consumption.
    if (keyCount === 2 && argv.length === 1) {
      if (this.values.get(keys[0]!)?.value !== argv[0]) return 0;
      if (this.values.get(keys[1]!)?.value !== argv[0]) return 0;
      this.values.delete(keys[0]!);
      this.values.delete(keys[1]!);
      return 1;
    }

    // Compare-and-delete OTP generation consumption.
    if (keyCount === 1 && argv.length === 1) {
      if (this.values.get(keys[0]!)?.value !== argv[0]) return 0;
      this.values.delete(keys[0]!);
      return 1;
    }

    throw new Error(`Unhandled script shape: ${keyCount} keys / ${argv.length} args`);
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    this.expire();
  }

  private put(key: string, value: string, ttlSeconds: number): void {
    this.values.set(key, { value, expiresAt: this.now + ttlSeconds * 1_000 });
  }

  private expire(): void {
    for (const [key, row] of this.values) {
      if (row.expiresAt <= this.now) this.values.delete(key);
    }
  }
}

const asRedis = (redis: ScriptRedis): Pick<Redis, 'eval'> => redis as unknown as Pick<Redis, 'eval'>;

async function verifiedGeneration(redis: ScriptRedis, phone: string, otp = '246810'): Promise<string> {
  await storeSignupOtp(asRedis(redis), phone, otp);
  const verified = await verifySignupOtp(asRedis(redis), phone, otp);
  expect(verified.valid).toBe(true);
  expect(verified.generation).toMatch(/^[A-Za-z0-9_-]{32}$/);
  return verified.generation!;
}

async function issued(redis: ScriptRedis, phone: string) {
  const generation = await verifiedGeneration(redis, phone);
  const continuation = await issueSignupContinuation(asRedis(redis), phone, generation);
  expect(continuation).not.toBeNull();
  return continuation!;
}

describe('signup continuation capability', () => {
  it('atomically pairs each hashed OTP record with an opaque generation in one cluster slot', async () => {
    const redis = new ScriptRedis();
    await storeSignupOtp(asRedis(redis), '+5926001001', '246810');

    const call = redis.calls[0]!;
    expect(call.keys).toHaveLength(2);
    expect(call.keys[0]).toMatch(/^signup_otp:\{[a-f0-9]{64}\}:record$/);
    expect(call.keys[1]).toMatch(/^signup_continuation:\{[a-f0-9]{64}\}:otp_generation$/);
    expect(call.keys[0]!.match(/\{([^}]+)\}/)?.[1]).toBe(call.keys[1]!.match(/\{([^}]+)\}/)?.[1]);
    expect(JSON.stringify(call)).not.toContain('+5926001001');
    expect(JSON.stringify(call)).not.toContain('246810');
    expect(call.argv[0]).toMatch(/^v2\|hmac-sha256:[a-f0-9]{64}\|0$/);
    expect(call.script).toContain("redis.call('SET', KEYS[1]");
    expect(call.script).toContain("redis.call('SET', KEYS[2]");
  });

  it('mints random opaque proofs while Redis sees only their digests', async () => {
    const redis = new ScriptRedis();
    const first = await issued(redis, '+5926001001');
    const second = await issued(redis, '+5926001002');

    expect(first.registrationProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.registrationProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.registrationProof).not.toBe(second.registrationProof);
    expect(first.expiresIn).toBe(SIGNUP_CONTINUATION_TTL_S);

    const issue = redis.calls.find((call) => call.keyCount === 3 && call.argv.length === 3)!;
    expect(JSON.stringify(issue)).not.toContain(first.registrationProof);
    expect(issue.argv[2]).toBe(String(SIGNUP_CONTINUATION_TTL_S));
    expect(issue.script).toContain("generation ~= ARGV[2]");
    expect(issue.script).toContain("redis.call('DEL', KEYS[3])");
  });

  it('is purpose-bound to the verified phone and remains usable after a wrong-phone attempt', async () => {
    const redis = new ScriptRedis();
    const { registrationProof } = await issued(redis, '+5926001001');

    await expect(consumeSignupContinuation(asRedis(redis), '+5926001002', registrationProof)).resolves.toBe(false);
    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', registrationProof)).resolves.toBe(true);
  });

  it('is exactly one-use even when two consumers race', async () => {
    const redis = new ScriptRedis();
    const { registrationProof } = await issued(redis, '+5926001001');

    const outcomes = await Promise.all([
      consumeSignupContinuation(asRedis(redis), '+5926001001', registrationProof),
      consumeSignupContinuation(asRedis(redis), '+5926001001', registrationProof),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    const consume = redis.calls.filter((call) => call.keyCount === 2 && call.argv.length === 1);
    expect(consume).toHaveLength(2);
    expect(consume[0]!.script).toContain("redis.call('DEL', KEYS[1], KEYS[2])");
  });

  it('an older verifier cannot overwrite a newer ceremony after awaiting account lookup', async () => {
    const redis = new ScriptRedis();
    const oldGeneration = await verifiedGeneration(redis, '+5926001001', '111111');
    const newGeneration = await verifiedGeneration(redis, '+5926001001', '222222');

    // Model the exact inversion: the old handler resumes first, after the new
    // code has verified but before the new handler has minted its proof.
    const stale = await issueSignupContinuation(asRedis(redis), '+5926001001', oldGeneration);
    expect(stale).toBeNull();
    const newer = await issueSignupContinuation(asRedis(redis), '+5926001001', newGeneration);
    expect(newer).not.toBeNull();
    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', newer!.registrationProof)).resolves.toBe(true);
  });

  it('a later successful OTP verification invalidates an earlier continuation immediately', async () => {
    const redis = new ScriptRedis();
    const first = await issued(redis, '+5926001001');
    await verifiedGeneration(redis, '+5926001001', '135790');

    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', first.registrationProof)).resolves.toBe(false);
  });

  it('the explicit development bypass invalidates an earlier continuation too', async () => {
    const redis = new ScriptRedis();
    const first = await issued(redis, '+5926001001');
    const generation = await armDevelopmentSignupGeneration(asRedis(redis), '+5926001001');

    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', first.registrationProof)).resolves.toBe(false);
    await expect(issueSignupContinuation(asRedis(redis), '+5926001001', generation)).resolves.not.toBeNull();
  });

  it('the development bypass discards an outstanding real code without invalidating its issued proof', async () => {
    const redis = new ScriptRedis();
    const phone = '+5926001001';
    await storeSignupOtp(asRedis(redis), phone, '111111');

    const generation = await armDevelopmentSignupGeneration(asRedis(redis), phone);
    const continuation = await issueSignupContinuation(asRedis(redis), phone, generation);
    expect(continuation).not.toBeNull();

    await expect(verifySignupOtp(asRedis(redis), phone, '111111')).resolves.toMatchObject({ valid: false });
    await expect(consumeSignupContinuation(asRedis(redis), phone, continuation!.registrationProof)).resolves.toBe(true);
  });

  it('an outstanding real code cannot consume a bypass generation while its account lookup is paused', async () => {
    const redis = new ScriptRedis();
    const phone = '+5926001001';
    await storeSignupOtp(asRedis(redis), phone, '111111');

    // Arming represents successful bypass verification. Before its handler
    // resumes from user lookup to mint the continuation, the older real code
    // must already be gone and therefore unable to consume this generation.
    const generation = await armDevelopmentSignupGeneration(asRedis(redis), phone);
    await expect(verifySignupOtp(asRedis(redis), phone, '111111')).resolves.toMatchObject({ valid: false });
    await expect(issueSignupContinuation(asRedis(redis), phone, generation)).resolves.not.toBeNull();
  });

  it('expires and rejects malformed input without evaluating a Redis script', async () => {
    const redis = new ScriptRedis();
    const { registrationProof } = await issued(redis, '+5926001001');
    const callsAfterIssue = redis.calls.length;

    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', 'not-a-proof')).resolves.toBe(false);
    expect(redis.calls).toHaveLength(callsAfterIssue);

    redis.advance(SIGNUP_CONTINUATION_TTL_S * 1_000);
    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', registrationProof)).resolves.toBe(false);
  });
});
