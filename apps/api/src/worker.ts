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
 * Redis adapter (production, loadtest/staging, development: see
 * utils/worker-socket-adapter.ts), exactly like the in-process topology; the local
 * io instance here is a broadcast-only handle with no HTTP listener.
 */
// FIRST: secrets delivered as files (NAME_FILE) become NAME in this process
// before any module below can read process.env. Keep this import on top.
import './boot/secret-files';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { pino } from 'pino';
import { loggerRedactConfig, loggerSerializers } from './utils/logger-config';
import { initializeJobRuntime, type JobRuntime } from './jobs/runtime';
import { assertSafeBootConfig } from './utils/boot-config';
import { initSentry } from './plugins/observability';
import { closeResourcesBounded, idempotentAsync, positiveDurationMs, withTimeout } from './utils/async-lifecycle';
import { resolveDatabaseUrl } from './utils/db-pool';
import { installProcessLifecycle } from './utils/process-lifecycle';
import { setAppLogger } from './utils/logger';
import { attachWorkerSocketAdapter } from './utils/worker-socket-adapter';
import { createScopedProcessClient } from './plugins/prisma';
import { attestTenantWallAtBoot } from './boot/tenant-wall';
import { attestSystemLoginAtBoot } from './boot/system-login';
import { assertDeploymentIdentityMatchesMode } from './utils/deployment-identity';

async function main() {
  assertSafeBootConfig();
  // SWIFT-042: the worker is a SEPARATE process — it must initialize Sentry
  // itself, or every job failure (captureError in the workers) is silently
  // dropped. The API server does this via observabilityPlugin; the worker never
  // loads that plugin, so it inits here.
  initSentry();

  const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info', redact: loggerRedactConfig, serializers: loggerSerializers });
  // [M013] Deep services log through utils/logger's log(), which is console
  // until a process hands it a logger (app.ts does for the API). Without this
  // every log() line inside a job printed raw error text with no redaction.
  setAppLogger(log);
  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  // [P1 · WS-8.3] The worker declares 19 concurrent jobs; Prisma's CPU-derived
  // default gives it five connections on a 2-vCPU box, so most of the queue sat
  // on pool_timeout the moment it got busy — money jobs included. Sized here at
  // the construction seam so a deploy that supplies its own DATABASE_URL (the
  // real ones do) still gets it. See utils/db-pool.ts.
  //
  // [MASTER-075] The SAME construction as the API's client (tenant scoping,
  // append-only evidence, system-transaction routing) — never a raw client.
  const prisma = createScopedProcessClient({ datasourceUrl: resolveDatabaseUrl(process.env['DATABASE_URL'], 'worker') });
  redis.on('error', (err) => log.error({ err }, 'Worker Redis connection error'));
  // [S3-L1] Only on a database of this process's own kind (its
  // deployment_identity), before any job runs; a refusal exits 1 (below).
  await assertDeploymentIdentityMatchesMode(prisma);

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
    // [MASTER-075] The worker serves Swift's data like the API does, so it
    // attests the tenant wall the same way — and refuses the same postures —
    // before a single job runs. [L04 · R1] Under the enforced wall, system
    // jobs (SOS escalation among them) read through the system login, so it
    // must be reachable and a bypass member too. Both, always, in this order
    // (system-login-boot.test.ts gates it).
    await attestTenantWallAtBoot(prisma, log);
    await attestSystemLoginAtBoot(prisma, log);
    const startupTimeoutMs = positiveDurationMs(process.env['QUEUE_STARTUP_TIMEOUT_MS'], 15_000);
    await withTimeout(redis.ping(), startupTimeoutMs, 'Worker Redis startup');
    // Production, loadtest (staging) and development: job emits reach the API's sockets through Redis.
    await attachWorkerSocketAdapter({ io, redis, log, startupTimeoutMs }, adapterConns);

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
