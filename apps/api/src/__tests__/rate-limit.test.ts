import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { rateLimitKey } from '../utils/rate-limit-key';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// SEC-4 regression — auth endpoints are rate limited.
// This app registers @fastify/rate-limit the way server.ts does, so the
// per-route limits declared in auth.routes.ts are active here.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const phones = Array.from({ length: 6 }, (_, i) => `+59288800${10 + i}`);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(rateLimit, { keyGenerator: rateLimitKey, max: 200, timeWindow: '1 minute' });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();

  // Reset the day-scoped SMS budget counters too (same hygiene as
  // helpers/otp.ts) — repeated local runs otherwise exhaust the global daily
  // cap and every send-otp 429s before the route limiter is even exercised.
  const day = new Date().toISOString().slice(0, 10);
  await app.redis.del(`sms_global_day:${day}`, ...phones.map((p) => `otp_phone_day:${day}:${p}`));
});

afterAll(async () => {
  for (const phone of phones) {
    await app.redis.del(`otp:${phone}`, `otp_rate:${phone}`, `otp_attempt:${phone}`);
  }
  await app.close();
});

describe('SEC-4 regression — auth endpoint rate limiting', () => {
  it('returns 429 from the route limiter on the 6th send-otp within a minute', async () => {
    // Six distinct phones dodge the per-phone cooldown, so only the
    // per-IP route limit (max 5/min) can stop the 6th request.
    const statuses: number[] = [];
    for (const phone of phones) {
      await app.redis.del(`otp_rate:${phone}`);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/send-otp',
        payload: { phone },
        headers: { 'content-type': 'application/json' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});
