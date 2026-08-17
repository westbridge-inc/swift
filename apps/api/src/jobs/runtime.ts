import {
  createQueues,
  createWorkers,
  scheduleRecurringJobs,
  type JobContext,
  type SwiftQueues,
} from './queue';
import {
  closeResourcesBounded,
  idempotentAsync,
  positiveDurationMs,
  withTimeout,
} from '../utils/async-lifecycle';
import {
  assertInfrastructureClocksAligned,
  type InfrastructureClockSample,
} from '../utils/infrastructure-clock';

type SwiftWorkers = Awaited<ReturnType<typeof createWorkers>>;

export const CONSUMER_BUNDLE_LEASE_KEY = 'swift:bullmq:consumer-bundle:v1';

export interface JobRuntime {
  queues: SwiftQueues;
  workers: SwiftWorkers | null;
  clock: InfrastructureClockSample;
  checkProducersReady: () => Promise<boolean>;
  checkConsumersReady: () => Promise<boolean>;
  checkQueuesReady: () => Promise<boolean>;
  markNotReady: () => void;
  cleanup: () => Promise<void>;
}

function queueResources(queues: SwiftQueues) {
  return Object.entries(queues).map(([name, queue]) => ({
    name,
    close: () => queue.close(),
  }));
}

async function awaitQueuesReady(queues: SwiftQueues, timeoutMs: number): Promise<void> {
  await withTimeout(
    Promise.all(Object.values(queues).map((queue) => queue.waitUntilReady())),
    timeoutMs,
    'BullMQ queues becoming ready',
  );
}

/** Active producer probe. Queue.waitUntilReady() is a cached startup promise;
 * reading the current client and issuing PING proves each producer can execute
 * a command now, including after a post-boot disconnect. */
export async function probeQueueProducers(queues: SwiftQueues): Promise<void> {
  await Promise.all(Object.values(queues).map(async (queue) => {
    try {
      const client = await queue.client;
      if (client.status !== 'ready') {
        throw new Error(`connection is ${client.status}`);
      }
      const pong = await client.ping();
      if (pong !== 'PONG') throw new Error(`unexpected PING response ${String(pong)}`);
    } catch (error) {
      throw new Error(`BullMQ producer ${queue.name} active probe failed`, { cause: error });
    }
  }));
}

/**
 * Owns the complete queue boot/close transaction. Nothing is published to
 * Fastify until Redis, both infrastructure clocks, every producer Queue, every
 * Worker, and recurring-job registration are ready. Any partial failure closes
 * everything already created before the caller decides whether to degrade
 * (local development) or fail boot (production/dedicated worker).
 */
export async function initializeJobRuntime(
  ctx: JobContext,
  options: { runWorkers: boolean },
): Promise<JobRuntime> {
  const startupTimeoutMs = positiveDurationMs(process.env['QUEUE_STARTUP_TIMEOUT_MS'], 15_000);
  const readinessTimeoutMs = positiveDurationMs(process.env['QUEUE_READINESS_TIMEOUT_MS'], 2_000);
  const shutdownTimeoutMs = positiveDurationMs(process.env['QUEUE_SHUTDOWN_TIMEOUT_MS'], 10_000);
  const consumerLeaseTtlMs = positiveDurationMs(process.env['QUEUE_CONSUMER_LEASE_TTL_MS'], 20_000);
  const consumerLeaseRefreshMs = Math.min(
    positiveDurationMs(process.env['QUEUE_CONSUMER_LEASE_REFRESH_MS'], 5_000),
    Math.max(1_000, Math.floor(consumerLeaseTtlMs / 2)),
  );
  let queues: SwiftQueues | undefined;
  let workers: SwiftWorkers | null = null;
  let initialized = false;
  let recurringRegistered = !options.runWorkers;
  let closed = false;
  let consumerLeaseTimer: ReturnType<typeof setInterval> | undefined;
  let consumerLeaseRefresh: Promise<void> | undefined;

  const refreshConsumerLease = (requireHealthy = false): Promise<void> => {
    if (!workers || closed) return Promise.resolve();
    consumerLeaseRefresh ??= withTimeout(
      workers.checkReady().then(async (ready) => {
        if (!ready) {
          if (requireHealthy) throw new Error('BullMQ workers are not healthy enough to publish a consumer lease');
          return;
        }
        if (closed) return;
        await ctx.redis.set(
          CONSUMER_BUNDLE_LEASE_KEY,
          `${process.pid}:${Date.now()}`,
          'PX',
          consumerLeaseTtlMs,
        );
      }),
      readinessTimeoutMs,
      'BullMQ consumer lease refresh',
    ).finally(() => {
      consumerLeaseRefresh = undefined;
    });
    return consumerLeaseRefresh;
  };

  const cleanup = idempotentAsync(async () => {
    closed = true;
    initialized = false;
    if (consumerLeaseTimer) {
      clearInterval(consumerLeaseTimer);
      consumerLeaseTimer = undefined;
    }
    const errors: unknown[] = [];
    if (consumerLeaseRefresh) {
      await consumerLeaseRefresh.catch(() => {});
    }
    if (workers) {
      try {
        await workers.cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (queues) {
      try {
        await closeResourcesBounded(queueResources(queues), shutdownTimeoutMs);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'BullMQ runtime shutdown failed');
    }
  });

  try {
    await withTimeout(ctx.redis.ping(), startupTimeoutMs, 'Redis startup ping');
    const clock = await withTimeout(
      assertInfrastructureClocksAligned(ctx.prisma, ctx.redis),
      startupTimeoutMs,
      'Infrastructure clock verification',
    );

    queues = createQueues(ctx.redis, ctx.log);
    await awaitQueuesReady(queues, startupTimeoutMs);

    if (options.runWorkers) {
      workers = await createWorkers(ctx, queues);
      await withTimeout(workers.waitUntilReady(), startupTimeoutMs, 'BullMQ workers becoming ready');
      await withTimeout(scheduleRecurringJobs(queues), startupTimeoutMs, 'Recurring-job registration');
      recurringRegistered = true;
      // Final commit: no processor can run before all producers, consumers,
      // clocks, and recurring registrations above have succeeded.
      await withTimeout(workers.start(), startupTimeoutMs, 'BullMQ worker activation');
      if (!(await withTimeout(workers.checkReady(), startupTimeoutMs, 'BullMQ worker active probe'))) {
        throw new Error('BullMQ workers failed their initial active probe');
      }
      await withTimeout(refreshConsumerLease(true), startupTimeoutMs, 'BullMQ initial consumer lease');
      consumerLeaseTimer = setInterval(() => {
        void refreshConsumerLease().catch((error) => {
          ctx.log.error({ err: error }, 'BullMQ consumer lease refresh failed');
        });
      }, consumerLeaseRefreshMs);
      consumerLeaseTimer.unref?.();
    }
    initialized = true;

    const checkProducersReady = async (): Promise<boolean> => {
      if (!initialized || closed || !queues) return false;
      try {
        await withTimeout(
          probeQueueProducers(queues),
          readinessTimeoutMs,
          'BullMQ producer readiness probe',
        );
        return initialized && !closed;
      } catch {
        return false;
      }
    };

    const checkConsumersReady = async (): Promise<boolean> => {
      if (!initialized || closed || !recurringRegistered) return false;
      try {
        const ready = await withTimeout(
          workers
            ? workers.checkReady()
            : ctx.redis.get(CONSUMER_BUNDLE_LEASE_KEY).then((lease) => lease !== null),
          readinessTimeoutMs,
          'BullMQ consumer readiness probe',
        );
        return ready && initialized && !closed;
      } catch {
        return false;
      }
    };

    const checkQueuesReady = async (): Promise<boolean> => {
      const [producersReady, consumersReady] = await Promise.all([
        checkProducersReady(),
        checkConsumersReady(),
      ]);
      return producersReady && consumersReady;
    };

    return {
      queues,
      workers,
      clock,
      checkProducersReady,
      checkConsumersReady,
      checkQueuesReady,
      markNotReady: () => {
        initialized = false;
      },
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      ctx.log.error({ err: cleanupError }, 'BullMQ partial initialization cleanup failed');
    }
    throw error;
  }
}
