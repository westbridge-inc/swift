import { describe, expect, it } from 'vitest';
import {
  assertInfrastructureClocksAligned,
  clockSkewToleranceMs,
  evaluateInfrastructureClocks,
  readInfrastructureClocks,
} from '../utils/infrastructure-clock';

function fakeClockDependencies(databaseNowMs: number, redisNowMs: number) {
  return {
    prisma: {
      $queryRaw: async () => [{ nowMs: BigInt(Math.trunc(databaseNowMs)) }],
    },
    redis: {
      time: async () => [
        String(Math.floor(redisNowMs / 1_000)),
        String(Math.trunc((redisNowMs % 1_000) * 1_000)),
      ] as [string, string],
    },
  };
}

describe('infrastructure clock protection', () => {
  it('accepts host, PostgreSQL, and Redis clocks inside the bounded tolerance', async () => {
    const { prisma, redis } = fakeClockDependencies(1_000_001, 1_000_001);
    let call = 0;
    const sample = await readInfrastructureClocks(prisma as never, redis as never, {
      now: () => [1_000_000, 1_000_002][call++]!,
      toleranceMs: 100,
    });

    expect(sample.aligned).toBe(true);
    expect(sample.maxSkewMs).toBe(0);
  });

  it('rejects the 21-hour Docker-service skew that invalidates leases and delayed jobs', async () => {
    const hostNowMs = 2_000_000_000_000;
    const serviceNowMs = hostNowMs - 21 * 60 * 60 * 1_000;
    const { prisma, redis } = fakeClockDependencies(serviceNowMs, serviceNowMs);

    await expect(assertInfrastructureClocksAligned(prisma as never, redis as never, {
      now: () => hostNowMs,
      toleranceMs: 5_000,
    })).rejects.toThrow(/clock skew .* exceeds 5000ms/i);
  });

  it('compares every clock pair, including DB versus Redis', () => {
    const sample = evaluateInfrastructureClocks({
      hostNowMs: 10_000,
      databaseNowMs: 10_010,
      redisNowMs: 15_000,
      toleranceMs: 100,
    });
    expect(sample.aligned).toBe(false);
    expect(sample.databaseRedisSkewMs).toBe(4_990);
    expect(sample.maxSkewMs).toBe(5_000);
  });

  it('uses a safe default for missing, garbage, or dangerously tiny tolerances', () => {
    expect(clockSkewToleranceMs({})).toBe(5_000);
    expect(clockSkewToleranceMs({ READINESS_CLOCK_SKEW_MS: 'garbage' })).toBe(5_000);
    expect(clockSkewToleranceMs({ READINESS_CLOCK_SKEW_MS: '10' })).toBe(5_000);
    expect(clockSkewToleranceMs({ READINESS_CLOCK_SKEW_MS: '2500' })).toBe(2_500);
  });
});
