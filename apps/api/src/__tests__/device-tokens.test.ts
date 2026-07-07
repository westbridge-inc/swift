import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Device push registration. Failure paths first: unauthenticated writes are
// refused; a token that re-registers under a NEW login is reassigned to that
// user (one phone, next owner must not push to the previous account); logout
// deactivation only touches the caller's own token.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdTokens: string[] = [];

let seq = 0;
async function makeUser() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200178${String(seq).padStart(2, '0')}`,
      firstName: 'Push',
      lastName: `User${seq}`,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'device-token-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function register(deviceToken: string, auth?: string) {
  createdTokens.push(deviceToken);
  return app.inject({
    method: 'POST',
    url: '/api/v1/customer/notifications/devices',
    payload: { token: deviceToken, platform: 'ios' },
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  // Must precede route registration (matches server.ts and every route test) —
  // registered after, thrown ZodErrors surface as 500s instead of 400s.
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.deviceToken.deleteMany({ where: { token: { in: createdTokens } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('POST /notifications/devices', () => {
  it('refuses unauthenticated registration', async () => {
    const res = await register(`ExponentPushToken[${nanoid(12)}]`);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed platform', async () => {
    const { token } = await makeUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/notifications/devices',
      payload: { token: `ExponentPushToken[${nanoid(12)}]`, platform: 'blackberry' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('registers, is idempotent, and reassigns the token to the newest login', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const device = `ExponentPushToken[${nanoid(12)}]`;

    expect((await register(device, a.token)).statusCode).toBe(200);
    expect((await register(device, a.token)).statusCode).toBe(200); // same user re-register = no-op upsert

    let row = await app.prisma.deviceToken.findUnique({ where: { token: device } });
    expect(row).toMatchObject({ userId: a.userId, isActive: true, platform: 'ios' });

    // Same phone, next owner: the token must move, never dual-deliver.
    expect((await register(device, b.token)).statusCode).toBe(200);
    row = await app.prisma.deviceToken.findUnique({ where: { token: device } });
    expect(row).toMatchObject({ userId: b.userId, isActive: true });
  });
});

describe('DELETE /notifications/devices', () => {
  it('deactivates own token; cannot touch someone else’s', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const device = `ExponentPushToken[${nanoid(12)}]`;
    await register(device, a.token);

    // B tries to deactivate A's token — silently affects nothing.
    const foreign = await app.inject({
      method: 'DELETE',
      url: '/api/v1/customer/notifications/devices',
      payload: { token: device },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
    });
    expect(foreign.statusCode).toBe(200);
    let row = await app.prisma.deviceToken.findUnique({ where: { token: device } });
    expect(row?.isActive).toBe(true);

    const own = await app.inject({
      method: 'DELETE',
      url: '/api/v1/customer/notifications/devices',
      payload: { token: device },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
    });
    expect(own.statusCode).toBe(200);
    row = await app.prisma.deviceToken.findUnique({ where: { token: device } });
    expect(row?.isActive).toBe(false);
  });
});
