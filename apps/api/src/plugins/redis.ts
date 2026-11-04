import fp from 'fastify-plugin';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { positiveDurationMs, withTimeout } from '../utils/async-lifecycle';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

/**
 * The wait before each reconnect attempt. It never returns null: null ends the
 * client for good, and a Redis restart slower than the retries would then leave
 * the API without Redis until a person restarted it. The socket adapter's
 * duplicates inherit this.
 */
function redisReconnectDelayMs(attempt: number): number {
  return Math.min(attempt * 200, 1_000);
}

/** A healthy Redis answers QUIT at once; one that holds the connection and answers nothing must not hold the shutdown. */
const REDIS_QUIT_TIMEOUT_MS = 2_000;

export const redisPlugin = fp(async (app: FastifyInstance) => {
  const redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382', {
    // With retries that never stop, this is what still refuses a command while
    // Redis is down: ioredis fails everything queued on every 4th failed attempt,
    // so a command waits about 4 s at most and callers fail closed as before. A
    // refused command is dropped, it never runs after Redis returns.
    maxRetriesPerRequest: 3,
    retryStrategy: redisReconnectDelayMs,
    // A connect that is silently dropped must not stretch that wait by ioredis's default 10 s per attempt.
    connectTimeout: 2_000,
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
    // Not connected: QUIT would sit in the offline queue behind whatever is there.
    if (redis.status !== 'ready') {
      redis.disconnect(false);
      return;
    }
    try {
      await withTimeout(redis.quit(), REDIS_QUIT_TIMEOUT_MS, 'Redis plugin shutdown');
    } catch {
      redis.disconnect(false);
    }
  });
});
