import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';

const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export interface InfrastructureClockSample {
  hostNowMs: number;
  databaseNowMs: number;
  redisNowMs: number;
  databaseHostSkewMs: number;
  redisHostSkewMs: number;
  databaseRedisSkewMs: number;
  maxSkewMs: number;
  toleranceMs: number;
  aligned: boolean;
}

export function clockSkewToleranceMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(env['READINESS_CLOCK_SKEW_MS']);
  return Number.isFinite(configured) && configured >= 100
    ? configured
    : DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
}

function finiteClockMs(value: unknown, source: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${source} clock response`);
  }
  return parsed;
}

export function evaluateInfrastructureClocks(input: {
  hostNowMs: number;
  databaseNowMs: number;
  redisNowMs: number;
  toleranceMs?: number;
}): InfrastructureClockSample {
  const hostNowMs = finiteClockMs(input.hostNowMs, 'host');
  const databaseNowMs = finiteClockMs(input.databaseNowMs, 'database');
  const redisNowMs = finiteClockMs(input.redisNowMs, 'Redis');
  const toleranceMs = input.toleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS;
  if (!Number.isFinite(toleranceMs) || toleranceMs < 100) {
    throw new Error('Invalid infrastructure clock-skew tolerance');
  }

  const databaseHostSkewMs = Math.abs(databaseNowMs - hostNowMs);
  const redisHostSkewMs = Math.abs(redisNowMs - hostNowMs);
  const databaseRedisSkewMs = Math.abs(databaseNowMs - redisNowMs);
  const maxSkewMs = Math.max(databaseHostSkewMs, redisHostSkewMs, databaseRedisSkewMs);

  return {
    hostNowMs,
    databaseNowMs,
    redisNowMs,
    databaseHostSkewMs,
    redisHostSkewMs,
    databaseRedisSkewMs,
    maxSkewMs,
    toleranceMs,
    aligned: maxSkewMs <= toleranceMs,
  };
}

/**
 * PostgreSQL and Redis both own expiry/scheduling clocks. If either service is
 * materially skewed from the API host (or from each other), sessions, OTPs,
 * dispatch leases, billing windows, and delayed jobs are not trustworthy.
 */
export async function readInfrastructureClocks(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  redis: Pick<Redis, 'time'>,
  options: { now?: () => number; toleranceMs?: number } = {},
): Promise<InfrastructureClockSample> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const [databaseRows, redisTime] = await Promise.all([
    prisma.$queryRaw<Array<{ nowMs: bigint | number | string }>>`
      SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`,
    redis.time(),
  ]);
  const completedAt = now();

  const databaseNowMs = finiteClockMs(databaseRows[0]?.nowMs, 'database');
  const redisSeconds = finiteClockMs(redisTime[0], 'Redis seconds');
  const redisMicros = Number(redisTime[1]);
  if (!Number.isFinite(redisMicros) || redisMicros < 0) {
    throw new Error('Invalid Redis microseconds clock response');
  }

  return evaluateInfrastructureClocks({
    // Midpoint removes most probe round-trip latency from the skew estimate.
    hostNowMs: startedAt + (completedAt - startedAt) / 2,
    databaseNowMs,
    redisNowMs: redisSeconds * 1_000 + redisMicros / 1_000,
    toleranceMs: options.toleranceMs ?? clockSkewToleranceMs(),
  });
}

export async function assertInfrastructureClocksAligned(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  redis: Pick<Redis, 'time'>,
  options: { now?: () => number; toleranceMs?: number } = {},
): Promise<InfrastructureClockSample> {
  const sample = await readInfrastructureClocks(prisma, redis, options);
  if (!sample.aligned) {
    throw new Error(
      `Infrastructure clock skew ${Math.round(sample.maxSkewMs)}ms exceeds ` +
      `${Math.round(sample.toleranceMs)}ms; refusing timing-sensitive queue startup`,
    );
  }
  return sample;
}
