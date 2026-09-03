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
import { nanoid } from 'nanoid';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// ---------------------------------------------------------------------------
// Admin actions leave a trail. The scoped onResponse hook must write an audit
// row for every successful mutating admin request and every founder-only
// identity view — while staying silent for ordinary reads and failures.
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

function inject(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown, token = adminToken) {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), 'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
  });
}

function founderReadAction(routeTemplate: string) {
  return { startsWith: 'ADMIN GET ', endsWith: routeTemplate };
}

async function waitForFounderReadAuditCount(routeTemplate: string, expected: number): Promise<number> {
  let count = await app.prisma.auditLog.count({ where: { action: founderReadAction(routeTemplate) } });
  for (let i = 0; i < 30 && count !== expected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    count = await app.prisma.auditLog.count({ where: { action: founderReadAction(routeTemplate) } });
  }
  return count;
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

    // The audit row lands in an async onResponse hook AFTER the reply is
    // sent — poll briefly instead of racing it (CI flaked exactly here).
    let after = before;
    for (let i = 0; i < 30 && after !== before + 1; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    }
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

  it('ordinary reads do not audit', async () => {
    const before = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    const res = await inject('GET', '/api/v1/admin/dashboard/overview');
    expect(res.statusCode).toBe(200);
    const after = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    expect(after).toBe(before);
  });

  it.each([
    {
      routeTemplate: '/integrity/appeals',
      url: '/api/v1/admin/integrity/appeals',
      entityId: '-',
    },
    {
      routeTemplate: '/integrity/identity/:userId',
      url: '/api/v1/admin/integrity/identity/%USER_ID%',
      entityId: '%USER_ID%',
    },
  ])('audits the founder-only view $routeTemplate', async ({ routeTemplate, url, entityId }) => {
    const founder = await app.prisma.user.findUniqueOrThrow({ where: { phone: '+5926001000' } });
    const resolvedUrl = url.replace('%USER_ID%', founder.id);
    const resolvedEntityId = entityId.replace('%USER_ID%', founder.id);
    const before = await app.prisma.auditLog.count({ where: { action: founderReadAction(routeTemplate) } });

    const res = await inject('GET', resolvedUrl);
    expect(res.statusCode).toBe(200);
    expect(await waitForFounderReadAuditCount(routeTemplate, before + 1)).toBe(before + 1);

    const row = await app.prisma.auditLog.findFirst({
      where: { action: founderReadAction(routeTemplate) },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row!.action.endsWith(routeTemplate)).toBe(true);
    expect(row!.userId).toBe(founder.id);
    expect(row!.entity).toBe('integrity');
    expect(row!.entityId).toBe(resolvedEntityId);
    expect(row!.changes).toEqual(expect.objectContaining({ params: expect.any(Object) }));
  });

  it('rejects an ordinary admin from identity data without writing a view audit', async () => {
    const ordinaryAdmin = await app.prisma.user.create({
      data: {
        phone: `+592${nanoid(8)}`,
        firstName: 'Ordinary',
        lastName: 'Admin',
        roles: ['ADMIN'],
        activeRole: 'ADMIN',
        isPhoneVerified: true,
        admin: { create: { permissions: ['*'] } },
      },
    });
    const token = app.jwt.sign({ userId: ordinaryAdmin.id, role: 'ADMIN', jti: nanoid(8) });
    await app.prisma.session.create({
      data: {
        userId: ordinaryAdmin.id,
        token,
        refreshToken: nanoid(48),
        authMethod: 'OTP',
        deviceId: 'admin-audit',
        deviceType: 'test',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const routeTemplate = '/integrity/appeals';
    const before = await app.prisma.auditLog.count({ where: { action: founderReadAction(routeTemplate) } });
    try {
      const res = await inject('GET', '/api/v1/admin/integrity/appeals', undefined, token);
      expect(res.statusCode).toBe(403);
      expect(await waitForFounderReadAuditCount(routeTemplate, before)).toBe(before);
    } finally {
      await app.prisma.user.delete({ where: { id: ordinaryAdmin.id } });
    }
  });

  it('failed mutations do not audit', async () => {
    const before = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    const res = await inject('PUT', '/api/v1/admin/users/cmq00000000000000000000000/suspend', {});
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const after = await app.prisma.auditLog.count({ where: { action: { startsWith: 'ADMIN ' } } });
    expect(after).toBe(before);
  });
});
