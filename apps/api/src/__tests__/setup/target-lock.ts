import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { assessTestTarget, TEST_TARGET_DEFAULTS } from '../../lib/test-target-lock';

/**
 * [R048-001] The vitest global setup — the one gate every test process passes.
 *
 * Runs in vitest's main process BEFORE any worker is spawned. The structural
 * proof (lib/test-target-lock.ts) is evaluated first, on the environment
 * alone: a wrong host, a wrong database name, Redis database 0 or a missing
 * URL refuses the run before ANY socket is opened. Only then are read-only
 * probes made — `SELECT current_database()` and a Redis PING — the run id is
 * minted and the target fingerprint (never a credential) is printed for the
 * log that CI keeps.
 *
 *   npx tsx src/__tests__/setup/target-lock.ts --check   the same gate, as a command
 */

export interface TargetLockReceipt {
  runId: string;
  database: string;
  pgHost: string;
  pgPort: number;
  redisDb: number;
  currentUser: string;
  startedAt: string;
}

export function environmentForTests(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  // The same defaults vitest.config.ts pins, applied ONLY when nothing was exported: a bare local run uses the disposable defaults; a shell that exported something is judged on what it exported.
  return { ...env, DATABASE_URL: env['DATABASE_URL'] ?? TEST_TARGET_DEFAULTS.DATABASE_URL, REDIS_URL: env['REDIS_URL'] ?? TEST_TARGET_DEFAULTS.REDIS_URL, NODE_ENV: env['NODE_ENV'] ?? 'test' };
}

/** The gate. Throws before any socket when the target is not provably disposable; returns the receipt after read-only probes. */
export async function lockTestTarget(env: Record<string, string | undefined> = environmentForTests()): Promise<TargetLockReceipt> {
  const assessed = assessTestTarget(env);
  if (!assessed.ok) {
    throw new Error(`[R048-001] test target refused — no connection was opened:\n  - ${assessed.problems.join('\n  - ')}\n  Export a loopback, disposable DATABASE_URL (swift_test…) and a REDIS_URL with a non-zero database (…/15), or stop.`);
  }
  const { target } = assessed;
  const prisma = new PrismaClient({ datasourceUrl: env['DATABASE_URL'] });
  const redis = new Redis(env['REDIS_URL'] as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    const [row] = await prisma.$queryRaw<Array<{ db: string; usr: string }>>`SELECT current_database()::text AS db, current_user::text AS usr`;
    if (!row || row.db !== target.database) throw new Error(`[R048-001] the server answered database "${row?.db}", not "${target.database}"`);
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error('[R048-001] Redis did not answer PING');
    if (redis.options.db !== target.redisDb) throw new Error(`[R048-001] Redis selected database ${redis.options.db}, not ${target.redisDb}`);
    const receipt: TargetLockReceipt = {
      runId: randomUUID(),
      database: target.database,
      pgHost: target.pgHost,
      pgPort: target.pgPort,
      redisDb: target.redisDb,
      currentUser: row.usr,
      startedAt: new Date().toISOString(),
    };
    return receipt;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    redis.disconnect();
  }
}

/** vitest globalSetup: lock, publish the fingerprint, and hand the run id to every worker. */
export default async function setup(): Promise<() => Promise<void>> {
  const receipt = await lockTestTarget();
  process.env['SWIFT_TEST_RUN_ID'] = receipt.runId;
  // eslint-disable-next-line no-console
  console.log(`[R048-001] test target locked: ${receipt.pgHost}:${receipt.pgPort}/${receipt.database} as ${receipt.currentUser} · redis db ${receipt.redisDb} · run ${receipt.runId}`);
  const started = Date.now();
  return async () => {
    // eslint-disable-next-line no-console
    console.log(`[R048-001] run ${receipt.runId} finished in ${Math.round((Date.now() - started) / 1000)}s on ${receipt.database}`);
  };
}

// The same gate as a command (the red test spawns it with hostile environments).
/* eslint-disable no-console */
if (process.argv.includes('--check')) {
  lockTestTarget()
    .then((r) => { console.log(`locked ${r.pgHost}:${r.pgPort}/${r.database} redis db ${r.redisDb} run ${r.runId}`); process.exit(0); })
    .catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
