import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import {
  consumeSignupContinuation,
  issueSignupContinuation,
  SIGNUP_CONTINUATION_TTL_S,
} from './signup-continuation';

type Stored = { value: string; expiresAt: number };

/** The smallest Redis-script harness that preserves the scripts' atomic semantics. */
class ScriptRedis {
  readonly calls: Array<{ script: string; keys: string[]; argv: string[] }> = [];
  readonly values = new Map<string, Stored>();
  now = 1_700_000_000_000;

  async eval(script: string, keyCount: number, ...parts: Array<string | number>): Promise<number> {
    const keys = parts.slice(0, keyCount).map(String);
    const argv = parts.slice(keyCount).map(String);
    this.calls.push({ script, keys, argv });
    this.expire();

    if (argv.length === 2) {
      const [digest, ttl] = argv;
      const expiresAt = this.now + Number(ttl) * 1_000;
      this.values.set(keys[1]!, { value: digest!, expiresAt });
      this.values.set(keys[0]!, { value: digest!, expiresAt });
      return 1;
    }

    const [digest] = argv;
    if (this.values.get(keys[0]!)?.value !== digest) return 0;
    if (this.values.get(keys[1]!)?.value !== digest) return 0;
    this.values.delete(keys[0]!);
    this.values.delete(keys[1]!);
    return 1;
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    this.expire();
  }

  private expire(): void {
    for (const [key, row] of this.values) {
      if (row.expiresAt <= this.now) this.values.delete(key);
    }
  }
}

const asRedis = (redis: ScriptRedis): Pick<Redis, 'eval'> => redis as unknown as Pick<Redis, 'eval'>;

describe('signup continuation capability', () => {
  it('mints random opaque proofs while Redis sees only digests in one cluster slot', async () => {
    const redis = new ScriptRedis();
    const first = await issueSignupContinuation(asRedis(redis), '+5926001001');
    const second = await issueSignupContinuation(asRedis(redis), '+5926001002');

    expect(first.registrationProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.registrationProof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.registrationProof).not.toBe(second.registrationProof);
    expect(first.expiresIn).toBe(SIGNUP_CONTINUATION_TTL_S);

    const { script, keys, argv } = redis.calls[0]!;
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^signup_continuation:\{[a-f0-9]{64}\}:current$/);
    expect(keys[1]).toMatch(/^signup_continuation:\{[a-f0-9]{64}\}:[a-f0-9]{64}$/);
    expect(keys[0]!.match(/\{([^}]+)\}/)?.[1]).toBe(keys[1]!.match(/\{([^}]+)\}/)?.[1]);
    expect(JSON.stringify({ keys, argv })).not.toContain('+5926001001');
    expect(JSON.stringify({ keys, argv })).not.toContain(first.registrationProof);
    expect(argv[1]).toBe(String(SIGNUP_CONTINUATION_TTL_S));
    expect(script).toContain("redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])");
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])");
  });

  it('is purpose-bound to the verified phone and remains usable after a wrong-phone attempt', async () => {
    const redis = new ScriptRedis();
    const { registrationProof } = await issueSignupContinuation(asRedis(redis), '+5926001001');

    await expect(consumeSignupContinuation(asRedis(redis), '+5926001002', registrationProof)).resolves.toBe(false);
    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', registrationProof)).resolves.toBe(true);
  });

  it('is exactly one-use even when two consumers race', async () => {
    const redis = new ScriptRedis();
    const { registrationProof } = await issueSignupContinuation(asRedis(redis), '+5926001001');

    const outcomes = await Promise.all([
      consumeSignupContinuation(asRedis(redis), '+5926001001', registrationProof),
      consumeSignupContinuation(asRedis(redis), '+5926001001', registrationProof),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    for (const call of redis.calls.slice(1)) {
      expect(call.script).toContain("redis.call('GET', KEYS[1])");
      expect(call.script).toContain("redis.call('GET', KEYS[2])");
      expect(call.script).toContain("redis.call('DEL', KEYS[1], KEYS[2])");
    }
  });

  it('a later successful OTP ceremony supersedes the earlier proof', async () => {
    const redis = new ScriptRedis();
    const first = await issueSignupContinuation(asRedis(redis), '+5926001001');
    const second = await issueSignupContinuation(asRedis(redis), '+5926001001');

    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', first.registrationProof)).resolves.toBe(false);
    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', second.registrationProof)).resolves.toBe(true);
  });

  it('expires and rejects malformed input without evaluating a Redis script', async () => {
    const redis = new ScriptRedis();
    const { registrationProof } = await issueSignupContinuation(asRedis(redis), '+5926001001');
    const callsAfterIssue = redis.calls.length;

    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', 'not-a-proof')).resolves.toBe(false);
    expect(redis.calls).toHaveLength(callsAfterIssue);

    redis.advance(SIGNUP_CONTINUATION_TTL_S * 1_000);
    await expect(consumeSignupContinuation(asRedis(redis), '+5926001001', registrationProof)).resolves.toBe(false);
  });
});
