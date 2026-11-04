import { afterEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import type { Queue } from 'bullmq';
import { bullConnectionOpts, createQueues, type SwiftQueues } from '../jobs/queue';
import { redisProxy } from './helpers/redis-proxy';

// After a Redis restart the API's own client is back in about a second, but a job is added on BullMQ's client, whose
// default retry reaches 20 s between tries. A checkout already committed then sits on queue.add for up to 20 s: longer
// than the phone waits. Producers now retry at most 1 s apart, and an add waits as long as it ever did. Workers keep
// BullMQ's default on purpose: see bullProducerOpts.

const realRedisUrl = process.env['REDIS_URL'] || 'redis://localhost:6382';
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

let proxy: ReturnType<typeof redisProxy> | undefined;
let source: Redis | undefined;
let queues: SwiftQueues | undefined;

async function startQueue(): Promise<Queue> {
  proxy = redisProxy(realRedisUrl);
  await proxy.open();
  source = new Redis(proxy.url, { lazyConnect: true });
  queues = createQueues(source);
  await Promise.all((Object.values(queues) as Queue[]).map((queue) => queue.waitUntilReady()));
  return queues.notificationQueue;
}

afterEach(async () => {
  // Closed with Redis answering, so nothing waits on a dead connection.
  if (queues) await Promise.allSettled((Object.values(queues) as Queue[]).map((queue) => queue.close()));
  await proxy?.stop();
  source?.disconnect(false);
  proxy = undefined;
  source = undefined;
  queues = undefined;
});

describe('a job added after a Redis restart', () => {
  it('an add made during the outage waits it out, and goes in within a second or two of Redis answering', async () => {
    const queue = await startQueue();

    await proxy!.stop();
    await sleep(1_000);
    let refused: Error | undefined;
    const added = queue.add('redis-reconnect-probe', {}, { removeOnComplete: true, removeOnFail: true, delay: 3_600_000 })
      .catch((error: Error) => { refused = error; return null; });
    // Past the 18 s at which a shorter wait alone would have refused it, and into BullMQ's 20 s default wait.
    await sleep(22_000);
    expect(refused).toBeUndefined();

    await proxy!.open();
    const startedAt = Date.now();
    const job = await added;
    expect(refused).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    await job!.remove();
  }, 40_000);

  it('never gives up, and never waits long between tries', async () => {
    const { options } = (await (await startQueue()).client) as unknown as Redis;
    const retry = options.retryStrategy!;
    for (const attempt of [1, 5, 50, 5_000_000]) {
      const delay = retry(attempt);
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
    // A refusal stays about 4 minutes away, as it was with BullMQ's default.
    expect(options.maxRetriesPerRequest).toBeGreaterThanOrEqual(200);
  });
});

describe('a worker keeps BullMQ\'s own retry', () => {
  it('the worker connection carries no retry of ours', () => {
    const redis = new Redis(realRedisUrl, { lazyConnect: true });
    expect(bullConnectionOpts(redis)).not.toHaveProperty('retryStrategy');
    redis.disconnect(false);
  });
});
