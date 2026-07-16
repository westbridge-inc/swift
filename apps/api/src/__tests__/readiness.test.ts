import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';

// ---------------------------------------------------------------------------
// Readiness probe (launch-readiness Phase 6): /ready is 200 only when every
// hard dependency is reachable AND the schema is migrated; 503 otherwise, so a
// booting or broken instance is kept out of the load balancer's rotation. No
// auth, no leaked internals.
// ---------------------------------------------------------------------------

let app: FastifyInstance;

// Minimal re-mount of the two probe routes against the real plugins, so the
// test exercises the same dependency checks the server uses.
beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  app.get('/ready', async (_request, reply) => {
    const deps: Record<string, boolean> = {};
    try {
      const rows = await app.prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT to_regclass('public.users') IS NOT NULL AS ok`;
      deps['database'] = rows[0]?.ok === true;
    } catch {
      deps['database'] = false;
    }
    try {
      deps['redis'] = (await app.redis.ping()) === 'PONG';
    } catch {
      deps['redis'] = false;
    }
    const ready = Object.values(deps).every(Boolean);
    reply.status(ready ? 200 : 503);
    return { ready, deps, timestamp: new Date().toISOString() };
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('readiness probe', () => {
  it('returns 200 + ready:true when db (migrated) and redis are up', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.deps.database).toBe(true);
    expect(body.deps.redis).toBe(true);
  });

  it('leaks no internals (no versions, hostnames, connection strings)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.body).not.toMatch(/postgres|redis:\/\/|password|localhost:5434/);
  });
});
