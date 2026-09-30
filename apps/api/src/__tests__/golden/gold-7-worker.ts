import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { QueueEvents, type Job } from 'bullmq';
import { nanoid } from 'nanoid';
import { bullConnectionOpts, createQueues, createWorkers } from '../../jobs/queue';
import { closeResourcesBounded, withTimeout } from '../../utils/async-lifecycle';

// Production consumers, real Redis, real timers. Only the named consumer runs;
// no recurring schedules are installed and cleanup removes only our job IDs.
export async function startGoldenWorker(app: FastifyInstance, consumer: 'subscription' | 'dispatch' | 'order' | 'settlement', prefix: string) {
  const queues = createQueues(app.redis);
  const queue = queues[`${consumer}Queue`];
  let events: QueueEvents | undefined;
  let workers: Awaited<ReturnType<typeof createWorkers>> | undefined;
  let loop: Promise<void> | undefined;
  let failure: unknown;
  const jobs: Job[] = [];

  const close = async () => {
    const errors: unknown[] = [];
    const finish = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { errors.push(error); } };
    if (workers) await finish(() => workers!.cleanup());
    if (loop) await finish(() => withTimeout(loop!, 10_000, 'golden worker shutdown'));
    for (const job of jobs) await finish(() => withTimeout(job.remove(), 10_000, 'own golden job removal'));
    await finish(() => closeResourcesBounded([
      ...(events ? [{ name: 'golden queue events', close: () => events!.close() }] : []),
      ...Object.entries(queues).map(([name, q]) => ({ name, close: () => q.close() })),
    ], 10_000));
    if (errors.length) throw new AggregateError(errors, 'GOLD-7 worker cleanup failed');
  };

  try {
    expect(await queue.isPaused()).toBe(false);
    expect(await queue.getRepeatableJobs()).toHaveLength(0);
    expect(await queue.getJobCounts('waiting', 'active', 'delayed', 'paused', 'prioritized', 'waiting-children'))
      .toEqual({ waiting: 0, active: 0, delayed: 0, paused: 0, prioritized: 0, 'waiting-children': 0 });
    events = new QueueEvents(queue.name, { connection: bullConnectionOpts(app.redis) });
    events.on('error', (error: unknown) => { failure ??= error; });
    await events.waitUntilReady();
    workers = await createWorkers({ prisma: app.prisma, redis: app.redis, io: app.io, log: app.log }, queues);
    await workers.waitUntilReady();
    const worker = workers[`${consumer}Worker`];
    worker.on('error', (error: unknown) => { failure ??= error; });
    loop = worker.run().catch((error: unknown) => { failure ??= error; });
  } catch (error) {
    await close();
    throw error;
  }

  return {
    close,
    async tick(name: string, data: Record<string, unknown> = {}) {
      expect(failure).toBeUndefined();
      const job = await queue.add(name, data, { jobId: `${prefix}-${nanoid(12)}`, removeOnComplete: false, removeOnFail: false });
      jobs.push(job);
      await job.waitUntilFinished(events!, 30_000);
      expect(await job.getState()).toBe('completed');
      expect(failure).toBeUndefined();
    },
  };
}
