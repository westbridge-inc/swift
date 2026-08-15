import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// The ops war-room feed (GET /sos): ops-only, and `open` shows the un-closed
// alerts a console must act on while excluding resolved/cancelled ones. A
// non-ops user is refused (an alert list is a god's-eye view).

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdAlertIds: string[] = [];
let seq = 0;
const phoneBase = 592_708_000_000 + Math.floor(Math.random() * 50_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Ops', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date() } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ops', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  return { userId: user.id, token };
}

async function makeAlert(status: 'ACTIVE' | 'RESOLVED', actorUserId: string) {
  const a = await app.prisma.sosAlert.create({ data: { actorUserId, actorRole: 'CUSTOMER', status, triggerSource: 'BUTTON', ...(status === 'RESOLVED' ? { resolvedAt: new Date(), resolutionCode: 'SAFE_CONFIRMED' } : {}) } });
  createdAlertIds.push(a.id);
  return a;
}

function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.sosAlert.deleteMany({ where: { id: { in: createdAlertIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('ops war-room feed (GET /sos)', () => {
  it('ops sees open alerts and, by default, not resolved ones', async () => {
    const ops = await makeUser(['ADMIN']);
    const actor = await makeUser(['CUSTOMER']);
    const active = await makeAlert('ACTIVE', actor.userId);
    const resolved = await makeAlert('RESOLVED', actor.userId);

    const open = await get('/api/v1/safety/sos', ops.token);
    expect(open.statusCode).toBe(200);
    const openIds = (open.json().data as Array<{ id: string }>).map((a) => a.id);
    expect(openIds).toContain(active.id);
    expect(openIds).not.toContain(resolved.id); // default 'open' hides closed alerts

    const all = await get('/api/v1/safety/sos?status=all', ops.token);
    const allIds = (all.json().data as Array<{ id: string }>).map((a) => a.id);
    expect(allIds).toContain(active.id);
    expect(allIds).toContain(resolved.id);

    const activeOnly = await get('/api/v1/safety/sos?status=active', ops.token);
    const activeIds = (activeOnly.json().data as Array<{ id: string }>).map((a) => a.id);
    expect(activeIds).toContain(active.id);
    expect(activeIds).not.toContain(resolved.id);
  });

  it('a non-ops user cannot list alerts', async () => {
    const customer = await makeUser(['CUSTOMER']);
    const res = await get('/api/v1/safety/sos', customer.token);
    expect(res.statusCode).toBe(403);
  });

  it('rejects an out-of-range limit', async () => {
    const ops = await makeUser(['ADMIN']);
    const res = await get('/api/v1/safety/sos?limit=9999', ops.token);
    expect(res.statusCode).toBe(400);
  });
});
