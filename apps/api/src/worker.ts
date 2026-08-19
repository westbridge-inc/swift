/**
 * Dedicated background-worker entrypoint [SWIFT-AUD-D7-01].
 *
 * Runs the BullMQ workers + the recurring-job schedule WITHOUT the HTTP API,
 * so a scaled deploy pins queue processing to exactly one process:
 *
 *   API instances:  RUN_WORKERS=0  node dist/server.js
 *   worker (×1):                   node dist/worker.js
 *
 * Default single-process topology (no RUN_WORKERS set, no worker process) is
 * unchanged — the API keeps running its own workers.
 *
 * Socket emits from jobs reach user/vendor/order rooms through the Socket.IO
 * Redis adapter (production), exactly like the in-process topology; the local
 * io instance here is a broadcast-only handle with no HTTP listener.
 */
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { Server } from 'socket.io';
import { pino } from 'pino';
import { initializeJobRuntime, type JobRuntime } from './jobs/runtime';
import { assertSafeBootConfig } from './utils/boot-config';
import { initSentry } from './plugins/observability';
import { closeResourcesBounded, idempotentAsync, positiveDurationMs, withTimeout } from './utils/async-lifecycle';
import { installProcessLifecycle } from './utils/process-lifecycle';

async function main() {
  assertSafeBootConfig();
  // SWIFT-042: the worker is a SEPARATE process — it must initialize Sentry
  // itself, or every job failure (captureError in the workers) is silently
  // dropped. The API server does this via observabilityPlugin; the worker never
  // loads that plugin, so it inits here.
  initSentry();

  const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const prisma = new PrismaClient();
  redis.on('error', (err) => log.error({ err }, 'Worker Redis connection error'));

  const io = new Server();
  const adapterConns: Redis[] = [];
  let runtime: JobRuntime | undefined;
  const shutdownTimeoutMs = positiveDurationMs(process.env['QUEUE_SHUTDOWN_TIMEOUT_MS'], 10_000);
  const cleanup = idempotentAsync(async () => {
    const errors: unknown[] = [];
    if (runtime) {
      try {
        await runtime.cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await closeResourcesBounded(
        adapterConns.map((connection, index) => ({
          name: `Socket.IO Redis adapter ${index}`,
          close: async () => {
            if (connection.status === 'end') return;
            try {
              await connection.quit();
            } catch {
              connection.disconnect(false);
            }
          },
        })),
        shutdownTimeoutMs,
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      if (redis.status !== 'end') {
        try {
          await withTimeout(redis.quit(), shutdownTimeoutMs, 'Worker Redis shutdown');
        } catch (error) {
          redis.disconnect(false);
          throw error;
        }
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await withTimeout(prisma.$disconnect(), shutdownTimeoutMs, 'Worker database shutdown');
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Worker shutdown failed');
  });
  installProcessLifecycle({
    cleanup,
    markNotReady: () => {
      runtime?.markNotReady();
    },
    exit: (code) => process.exit(code),
    onSignal: (signal) => {
      log.info({ signal }, 'Worker shutdown signal received');
    },
    onFatal: (event, error) => {
      const message = event === 'unhandledRejection'
        ? 'UNHANDLED PROMISE REJECTION (worker) — draining process'
        : 'UNCAUGHT EXCEPTION (worker) — draining process';
      log.fatal({ err: error, event }, message);
    },
    onCleanupError: (error) => {
      log.fatal({ err: error }, 'Worker bounded shutdown failed');
    },
  });

  try {
    const startupTimeoutMs = positiveDurationMs(process.env['QUEUE_STARTUP_TIMEOUT_MS'], 15_000);
    await withTimeout(redis.ping(), startupTimeoutMs, 'Worker Redis startup');
    if (process.env['NODE_ENV'] === 'production') {
      const { createAdapter } = await import('@socket.io/redis-adapter');
      const pub = redis.duplicate();
      const sub = redis.duplicate();
      adapterConns.push(pub, sub);
      for (const [kind, connection] of [['publish', pub], ['subscribe', sub]] as const) {
        connection.on('error', (err) => log.error({ err, kind }, 'Socket.IO Redis adapter error'));
      }
      await withTimeout(
        Promise.all(adapterConns.map((connection) => connection.ping())),
        startupTimeoutMs,
        'Socket.IO Redis adapter startup',
      );
      io.adapter(createAdapter(pub, sub));
    }

    runtime = await initializeJobRuntime({ prisma, io, redis, log }, { runWorkers: true });
    log.info(
      { maxClockSkewMs: Math.round(runtime.clock.maxSkewMs) },
      'Worker process up — recurring jobs scheduled, workers consuming',
    );
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      log.error({ err: cleanupError }, 'Worker partial initialization cleanup failed');
    }
    throw error;
  }

}

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
