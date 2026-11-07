import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { redisPlugin } from '../plugins/redis';
import { redisProxy } from './helpers/redis-proxy';

const realRedisUrl = process.env['REDIS_URL'] || 'redis://localhost:6382';
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

let app: FastifyInstance | undefined;
let proxy: ReturnType<typeof redisProxy> | undefined;

async function startBehindProxy() {
  proxy = redisProxy(realRedisUrl);
  await proxy.open();
  process.env['REDIS_URL'] = proxy.url;
  app = Fastify({ logger: false });
  await app.register(redisPlugin);
  await app.ready();
  return { app, proxy };
}

async function pingEventually(redis: Redis, withinMs: number) {
  const startedAt = Date.now();
  for (;;) {
    try {
      return await redis.ping();
    } catch (error) {
      if (Date.now() - startedAt > withinMs) throw error;
      await sleep(50);
    }
  }
}

afterEach(async () => {
  await app?.close().catch(() => {});
  await proxy?.stop();
  app = undefined;
  proxy = undefined;
  process.env['REDIS_URL'] = realRedisUrl;
});

describe('the API Redis client through a Redis outage', () => {
  it('answers again by itself once Redis is back, after an outage longer than the old 1.2 s give-up', async () => {
    const { app, proxy } = await startBehindProxy();
    expect(await app.redis.ping()).toBe('PONG');

    await proxy.stop();
    await sleep(1_500);
    expect(app.redis.status).not.toBe('end');

    await proxy.open();
    expect(await pingEventually(app.redis, 3_000)).toBe('PONG');
    expect(app.redis.status).toBe('ready');
  }, 15_000);

  it('never gives up on its own, however long the outage, and never waits long between tries', async () => {
    const { app } = await startBehindProxy();
    const retryStrategy = app.redis.options.retryStrategy!;
    for (const attempt of [1, 2, 3, 4, 5, 10, 100, 10_000, 10_000_000]) {
      const delay = retryStrategy(attempt);
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });

  it('refuses a command within a bound at every point of a long outage, with no hang', async () => {
    const { app, proxy } = await startBehindProxy();
    await proxy.stop();
    const outcomes: Array<Promise<{ tookMs: number; message: string }>> = [];
    // Commands land across a whole refuse cycle, retries already at their longest wait.
    await sleep(3_200);
    for (let index = 0; index < 9; index += 1) {
      const startedAt = Date.now();
      outcomes.push(app.redis.get('redis-reconnect:bound').then(
        () => ({ tookMs: Date.now() - startedAt, message: 'ANSWERED WITH REDIS DOWN' }),
        (error: Error) => ({ tookMs: Date.now() - startedAt, message: error.message }),
      ));
      await sleep(500);
    }
    const settled = await Promise.all(outcomes);
    expect(settled.map((outcome) => outcome.message).filter((message) => message.includes('ANSWERED'))).toEqual([]);
    expect(Math.max(...settled.map((outcome) => outcome.tookMs))).toBeLessThan(5_000);
  }, 20_000);

  it('waits out a short restart: a command sent in the gap is answered, not refused', async () => {
    const { app, proxy } = await startBehindProxy();
    await proxy.stop();
    await sleep(150);
    const answered = app.redis.ping();
    await sleep(150);
    await proxy.open();
    await expect(answered).resolves.toBe('PONG');
  }, 10_000);

  it('never runs a refused command after Redis comes back: refused means it did not happen', async () => {
    const { app, proxy } = await startBehindProxy();
    const key = `redis-reconnect:refused:${Date.now()}`;
    await proxy.stop();
    await expect(app.redis.set(key, 'late')).rejects.toThrow();

    await proxy.open();
    expect(await pingEventually(app.redis, 3_000)).toBe('PONG');
    await sleep(100);
    expect(await app.redis.get(key)).toBeNull();
  }, 15_000);

  it('still fails a boot with Redis down, fast, and leaves nothing retrying behind it', async () => {
    proxy = redisProxy(realRedisUrl);
    await proxy.open();
    process.env['REDIS_URL'] = proxy.url;
    await proxy.stop();
    const connect = vi.spyOn(Redis.prototype, 'connect');
    try {
      const failedBoot = Fastify({ logger: false });
      const startedAt = Date.now();
      await expect(failedBoot.register(redisPlugin)).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      const attemptsAtFailure = connect.mock.calls.length;
      await sleep(1_500);
      expect(connect.mock.calls.length).toBe(attemptsAtFailure);
    } finally {
      connect.mockRestore();
    }
  }, 15_000);

  it('gives connections a short TCP deadline, so a dropped connect cannot stretch the bound', async () => {
    const { app } = await startBehindProxy();
    expect(app.redis.options.connectTimeout).toBeLessThanOrEqual(2_000);
    expect(app.redis.options.maxRetriesPerRequest).toBe(3);
  });
});

describe('closing the API without Redis', () => {
  it('shuts down at once while Redis is down, even with a command still queued', async () => {
    const { app, proxy } = await startBehindProxy();
    await proxy.stop();
    await sleep(100);
    expect(app.redis.status).not.toBe('ready');
    void app.redis.get('redis-reconnect:queued').catch(() => {});

    const startedAt = Date.now();
    await app.close();
    expect(Date.now() - startedAt).toBeLessThan(500);
  }, 10_000);

  it('stops trying to reconnect once closed', async () => {
    const { app, proxy } = await startBehindProxy();
    const redis = app.redis;
    await proxy.stop();
    await sleep(100);
    await app.close();

    await proxy.open();
    await sleep(1_500);
    expect(redis.status).not.toBe('ready');
  }, 10_000);

  it('shuts down within a bound when Redis holds the connection and answers nothing', async () => {
    const { app, proxy } = await startBehindProxy();
    proxy.freeze();
    const startedAt = Date.now();
    await app.close();
    expect(Date.now() - startedAt).toBeLessThan(3_500);
  }, 10_000);

  it('still says goodbye properly when Redis is healthy', async () => {
    const { app } = await startBehindProxy();
    const redis = app.redis;
    const quit = vi.spyOn(redis, 'quit');
    await app.close();
    expect(quit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => { expect(redis.status).toBe('end'); });
  });
});
