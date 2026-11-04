import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerAuthRoutes } from './helpers/auth-routes-harness';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [BUG-HUNT F21 · COORD 4 Nov 2026] A verified driver could rename themselves and stay verified. Once a person has
// approved a paper that carries the name, it changes only through a person. Synthetic data only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];

async function makeUser(papers: Array<[string, 'APPROVED' | 'PENDING' | 'REJECTED']> = []) {
  const user = await app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Original', lastName: 'Person', roles: ['MOVER', 'CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, isPhoneVerified: true, countryCode: 'GY', customer: { create: {} } },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'name', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  for (const [docType, status] of papers) {
    await app.prisma.verificationDocument.create({ data: { userId: user.id, role: 'MOVER' as never, docType, fileUrl: `test/${nanoid(8)}`, status, expiresAt: new Date(Date.now() + 200 * DAY) } as never });
  }
  return { id: user.id, token };
}

const save = (token: string, payload: Record<string, unknown>) => app.inject({
  method: 'PUT', url: '/api/v1/customer/profile', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload,
});
const support = (id: string, payload: Record<string, unknown>) => app.inject({
  method: 'PUT', url: `/api/v1/admin/users/${id}/name`, payload, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
});
const nameOf = async (id: string) => {
  const row = await app.prisma.user.findUniqueOrThrow({ where: { id }, select: { firstName: true, lastName: true } });
  return `${row.firstName} ${row.lastName}`;
};

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await registerAuthRoutes(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;
}, 60_000);

afterAll(async () => {
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await app.close();
});

describe('[F21] a name a person checked is locked in the apps', () => {
  it.each([['drivers_licence'], ['national_id'], ['owner_national_id'], ['hire_car_driver_licence'], ['own_name_declaration']])('after an approved %s: refused, and the name stands', async (docType) => {
    const u = await makeUser([[docType, 'APPROVED']]);
    const res = await save(u.token, { firstName: 'Someone', lastName: 'Else' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NAME_LOCKED');
    expect(res.json().error.message).toContain('contact Swift support');
    expect(await nameOf(u.id)).toBe('Original Person');
  });

  it('one half is enough', async () => {
    const u = await makeUser([['drivers_licence', 'APPROVED']]);
    expect((await save(u.token, { lastName: 'Else' })).statusCode).toBe(409);
    expect((await save(u.token, { firstName: 'Someone' })).statusCode).toBe(409);
  });

  it('sending the same name back is no change: an email edit still saves', async () => {
    const u = await makeUser([['drivers_licence', 'APPROVED']]);
    const res = await save(u.token, { firstName: 'Original', lastName: 'Person', email: `name-${nanoid(6).toLowerCase()}@example.com`.replace(/[^a-z0-9@.-]/g, 'x') });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a paper nobody approved locks nothing, and neither does a paper with no name on it', async () => {
    for (const papers of [[], [['drivers_licence', 'PENDING']], [['drivers_licence', 'REJECTED']], [['vehicle_registration', 'APPROVED']]] as Array<Array<[string, 'APPROVED' | 'PENDING' | 'REJECTED']>>) {
      const u = await makeUser(papers);
      expect((await save(u.token, { firstName: 'Someone', lastName: 'Else' })).statusCode, JSON.stringify(papers)).toBe(200);
      expect(await nameOf(u.id)).toBe('Someone Else');
    }
  });
});

describe('[F21] the door the refusal points at', () => {
  it('support changes it, with a reason; the person is told; the trail names no name', async () => {
    const u = await makeUser([['drivers_licence', 'APPROVED']]);
    const res = await support(u.id, { firstName: 'Married', lastName: 'Name' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await nameOf(u.id)).toBe('Married Name');
    expect(await app.prisma.notification.count({ where: { userId: u.id, title: 'Your name was changed' } })).toBe(1);
    const trail = await app.prisma.auditLog.findFirstOrThrow({ where: { entityId: u.id, action: 'CHANGE_LEGAL_NAME' } });
    expect(JSON.stringify(trail)).not.toContain('Married');
    expect(JSON.stringify(trail)).not.toContain('Original');
  });

  it('the same name is not a change', async () => {
    const u = await makeUser();
    expect((await support(u.id, { firstName: 'Original', lastName: 'Person' })).statusCode).toBe(409);
  });

  it('it takes a reason', async () => {
    const u = await makeUser();
    const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${u.id}/name`, payload: { firstName: 'No', lastName: 'Reason' }, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await nameOf(u.id)).toBe('Original Person');
  });
});
