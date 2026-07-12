import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// Admin actions leave a trail. The scoped onResponse hook must write an audit
// row for every successful mutating admin request — and stay silent for reads
// and failures (nothing changed, nothing to attest).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;

async function buildTestApp() {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.ready();
  return server;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;
});

afterAll(async () => {
  await app.close();
});

function inject(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
    },
  });
}

describe('admin audit trail', () => {
  it('a successful config change writes an audit row with actor + route + params', async () => {
    const before = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });

    // Read-modify-write the same value: state-neutral for other tests, but a
    // successful mutation as far as the trail is concerned.
    const current = await app.prisma.platformConfig.findUnique({ where: { key: 'delivery_base_fee' } });
    const res = await inject('PUT', '/api/v1/admin/config/delivery_base_fee', {
      value: current!.value,
    });
    expect(res.statusCode).toBe(200);

    const after = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    expect(after).toBe(before + 1);

    const row = await app.prisma.auditLog.findFirst({
      where: { action: { startsWith: 'ADMIN PUT' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.action).toContain('/config/:key');
    expect(row!.entityId).toBe('delivery_base_fee');
    expect(row!.userId).toBeTruthy();
  });

  it('reads do not audit', async () => {
    const before = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    const res = await inject('GET', '/api/v1/admin/dashboard/overview');
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    expect(after).toBe(before);
  });

  it('failed mutations do not audit', async () => {
    const before = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    const res = await inject('PUT', '/api/v1/admin/users/cmq00000000000000000000000/suspend', {});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const after = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    expect(after).toBe(before);
  });
});
