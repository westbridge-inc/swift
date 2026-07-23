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
import { createQueues, createWorkers, scheduleRecurringJobs } from './jobs/queue';
import { assertSafeBootConfig } from './utils/boot-config';
import { initSentry } from './plugins/observability';

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

  const io = new Server();
  const adapterConns: Redis[] = [];
  if (process.env['NODE_ENV'] === 'production') {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const pub = redis.duplicate();
    const sub = redis.duplicate();
    adapterConns.push(pub, sub);
    io.adapter(createAdapter(pub, sub));
  }

  const queues = createQueues(redis);
  const workers = createWorkers({ prisma, io, redis, log });
  await scheduleRecurringJobs(queues);
  log.info('Worker process up — recurring jobs scheduled, workers consuming');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Worker shutting down');
    try {
      await workers.cleanup();
      await Promise.all(Object.values(queues).map((q) => q.close()));
      // NOT io.close() — this broadcast-only handle never attached an HTTP
      // server, and Server.close() assumes one (throws). Quit the adapter's
      // pub/sub connections instead; process exit reaps the rest.
      await Promise.all(adapterConns.map((c) => c.quit()));
      await redis.quit();
      await prisma.$disconnect();
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Worker shutdown error');
      process.exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'UNHANDLED PROMISE REJECTION (worker)');
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'UNCAUGHT EXCEPTION (worker)');
  });
}

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
