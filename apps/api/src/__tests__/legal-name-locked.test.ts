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
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { changeLegalName } from '../modules/user/legal-name';

// ---------------------------------------------------------------------------
// [BUG-HUNT F21 · COORD 4 Nov 2026] A verified driver could rename themselves and stay verified. Once a person has
// approved a paper that carries the name, it changes only through a person. Synthetic data only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
let app: FastifyInstance;
let adminToken: string;
let adminId: string;
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
  const admin = (await loginWithOtp(app, '+5926001000')).json().data;
  adminToken = admin.tokens.accessToken;
  adminId = admin.user.id;
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
  it.each([['drivers_licence'], ['national_id'], ['owner_national_id'], ['hire_car_driver_licence'], ['own_name_declaration'], ['police_clearance'], ['food_handler_cert'], ['gei_electrical_licence'], ['pest_control_operator_licence'], ['pesticide_applicator_certificate'], ['digital_id']])('after an approved %s: refused, and the name stands', async (docType) => {
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

  it('a staff account is out of reach, for anyone: a founder\'s name changes only by their own sign-in', async () => {
    const staff = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Staff', lastName: 'Person', roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true } });
    userIds.push(staff.id);
    const res = await support(staff.id, { firstName: 'Taken', lastName: 'Over' });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ACCOUNT');
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: staff.id } })).firstName).toBe('Staff');
  });

  it('an admin cannot use this door on their own account', async () => {
    const res = await support(adminId, { firstName: 'My', lastName: 'Self' });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ACCOUNT');
  });

  it('a staff role under a customer hat is staff', async () => {
    const hat = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Hat', lastName: 'Person', roles: ['CUSTOMER', 'ADMIN'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
    userIds.push(hat.id);
    expect((await support(hat.id, { firstName: 'Taken', lastName: 'Over' })).statusCode).toBe(403);
  });

  it('a closed account stays closed: no name is written over an erased one', async () => {
    const person = await makeUser();
    const tombstone = `deleted:${person.id}`;
    await app.prisma.user.update({ where: { id: person.id }, data: { phone: tombstone, status: 'DEACTIVATED' } });
    const res = await support(person.id, { firstName: 'Back', lastName: 'Again' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_CLOSED');
    expect(await nameOf(person.id)).toBe('Original Person');
  });

  it('a reserved test name is refused for a real account', async () => {
    const person = await makeUser();
    await app.prisma.user.update({ where: { id: person.id }, data: { phone: `+59264${wordFreeTag(5)}` } });
    const res = await support(person.id, { firstName: 'TEST-Person', lastName: 'Person' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('RESERVED_NAME');
  });

  it('the change and its trail are one commit', async () => {
    const person = await makeUser();
    await expect(changeLegalName(app.prisma, person.id, { firstName: 'Second', lastName: 'Name' }, async () => { throw new Error('the trail refused'); })).rejects.toThrow('the trail refused');
    expect(await nameOf(person.id)).toBe('Original Person');
  });

  it('it takes a reason', async () => {
    const u = await makeUser();
    const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/users/${u.id}/name`, payload: { firstName: 'No', lastName: 'Reason' }, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await nameOf(u.id)).toBe('Original Person');
  });
});
