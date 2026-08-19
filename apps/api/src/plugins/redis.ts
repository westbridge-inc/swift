import fp from 'fastify-plugin';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { positiveDurationMs, withTimeout } from '../utils/async-lifecycle';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export const redisPlugin = fp(async (app: FastifyInstance) => {
  const redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382', {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    },
  });

  redis.on('error', (err) => app.log.error({ err }, 'Redis connection error'));
  redis.on('connect', () => app.log.info('Redis connected'));

  try {
    await withTimeout(
      redis.ping(),
      positiveDurationMs(process.env['REDIS_STARTUP_TIMEOUT_MS'], 10_000),
      'Redis plugin startup',
    );
  } catch (error) {
    // Stop reconnect timers before failing Fastify registration. Leaving this
    // client alive after partial plugin init was one source of late
    // "Connection is closed" rejections during boot cleanup.
    redis.disconnect(false);
    throw error;
  }

  app.decorate('redis', redis);

  app.addHook('onClose', async () => {
    if (redis.status === 'end') return;
    try {
      await redis.quit();
    } catch {
      redis.disconnect(false);
    }
  });
});
