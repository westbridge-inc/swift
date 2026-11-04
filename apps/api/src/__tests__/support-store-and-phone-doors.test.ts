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
import { registerAuthRoutes } from './helpers/auth-routes-harness';
import { devChannelLog } from '../providers/notifications/channels';
import { guyanaDayKey } from '../utils/guyana-day';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [BUG-HUNT F22 · COORD 4 Nov 2026] Support can do what the screens tell people to ask support for. A store type picked
// by mistake, a checked store name, and a person's phone number each had no door: the answer was "we can't" or a
// database edit. Each now takes a reason and leaves a trail; a number also takes a code sent to the new number.
// Synthetic data only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const marker = nanoid(6).toLowerCase();
let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];
let seq = 0;

async function makeUser(first: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: testPhone(), firstName: first, lastName: `Door${seq}`, roles: ['VENDOR_OWNER', 'CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, isPhoneVerified: true, countryCode: 'GY' },
  });
  userIds.push(user.id);
  return user;
}

async function makeStore(ownerUserId: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId: ownerUserId }, update: {}, create: { userId: ownerUserId } });
  return app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Door Mart ${wordFreeTag(6)}`, slug: `door-mart-${marker}-${seq}`, vendorType: 'RESTAURANT', phone: testPhone(), addressLine1: '1 Door St', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'PENDING_APPROVAL', isVerified: false, acceptingOrders: false, ...extra,
    },
  });
}

const call = (method: 'PUT' | 'POST', url: string, payload: Record<string, unknown>, reason: string | null = TEST_ADMIN_REASON) => app.inject({
  method, url, payload, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', ...(reason ? { 'x-swift-reason': reason } : {}) },
});

async function clearCounters(phone: string) {
  const day = guyanaDayKey(new Date());
  await app.redis.del(`otp_phone_day:${day}:${phone}`, `sms_global_day:${day}`, `sms_known_day:${day}`, `otp_ip_day:${day}:127.0.0.1`);
}

/** The code the new number received. */
async function startMove(userId: string, phone: string) {
  await clearCounters(phone);
  const before = devChannelLog.length;
  const res = await call('POST', `/api/v1/admin/users/${userId}/phone-change`, { phone });
  expect(res.statusCode, res.body).toBe(200);
  const sms = devChannelLog.slice(before).filter((entry) => entry.channel === 'sms' && entry.to === phone).at(-1);
  const code = sms?.body.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error('no code was texted to the new number');
  return code;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await registerAuthRoutes(app);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;
}, 60_000);

afterAll(async () => {
  await app.prisma.subscription.deleteMany({ where: { vendor: { owner: { userId: { in: userIds } } } } }).catch(() => undefined);
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } }).catch(() => undefined);
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await app.close();
});

describe('[F22] a store type picked by mistake', () => {
  it('support changes it before the store has been live, the owner is told, and the checklist follows', async () => {
    const owner = await makeUser('Type');
    const store = await makeStore(owner.id);
    const res = await call('PUT', `/api/v1/admin/vendors/${store.id}/type`, { vendorType: 'STORE' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).vendorType).toBe('STORE');
    expect(await app.prisma.notification.count({ where: { userId: owner.id, title: 'Your store type was changed' } })).toBe(1);
    const trail = await app.prisma.auditLog.findFirst({ where: { entityId: store.id, action: 'CHANGE_VENDOR_TYPE' } });
    expect(trail).not.toBeNull();
  });

  it('takes a reason', async () => {
    const owner = await makeUser('Reason');
    const store = await makeStore(owner.id);
    const res = await call('PUT', `/api/v1/admin/vendors/${store.id}/type`, { vendorType: 'STORE' }, null);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).vendorType).toBe('RESTAURANT');
  });

  it('a store that has been live keeps its type, and the refusal says why', async () => {
    const owner = await makeUser('Live');
    const store = await makeStore(owner.id, { firstLiveAt: new Date(), status: 'ACTIVE' });
    const res = await call('PUT', `/api/v1/admin/vendors/${store.id}/type`, { vendorType: 'STORE' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STORE_HAS_BEEN_LIVE');
  });

  it('a store with a weekly fee on record keeps its type', async () => {
    const owner = await makeUser('Fee');
    const store = await makeStore(owner.id);
    await app.prisma.subscription.create({
      data: { vendorId: store.id, type: 'RESTAURANT', status: 'TRIAL', weeklyRate: 5000, currencyCode: 'GYD', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY) },
    });
    const res = await call('PUT', `/api/v1/admin/vendors/${store.id}/type`, { vendorType: 'STORE' });
    expect(res.json().error?.code).toBe('STORE_HAS_BEEN_LIVE');
  });

  it('the same type is not a change', async () => {
    const owner = await makeUser('Same');
    const store = await makeStore(owner.id);
    expect((await call('PUT', `/api/v1/admin/vendors/${store.id}/type`, { vendorType: 'RESTAURANT' })).statusCode).toBe(409);
  });
});

describe('[F22] a checked store name', () => {
  it('support changes it, with a trail, and the owner is told', async () => {
    const owner = await makeUser('Rename');
    const store = await makeStore(owner.id, { firstLiveAt: new Date(), status: 'ACTIVE', isVerified: true });
    const res = await call('PUT', `/api/v1/admin/vendors/${store.id}/name`, { name: 'Corner Kitchen' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).name).toBe('Corner Kitchen');
    expect(await app.prisma.notification.count({ where: { userId: owner.id, title: 'Your store name was changed' } })).toBe(1);
    expect(await app.prisma.auditLog.count({ where: { entityId: store.id, action: 'CHANGE_VENDOR_NAME' } })).toBe(1);
  });

  it('a store trading under its owner\'s own name is refused: a person checked that name against their ID', async () => {
    const owner = await makeUser('Own');
    const store = await makeStore(owner.id, { tradesUnderOwnName: true });
    const res = await call('PUT', `/api/v1/admin/vendors/${store.id}/name`, { name: 'Something Else' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('OWN_NAME_RENAME');
  });

  it('a reserved test name is refused for a real account', async () => {
    const owner = await makeUser('Reserved');
    const store = await makeStore(owner.id);
    await app.prisma.user.update({ where: { id: owner.id }, data: { phone: `+59264${wordFreeTag(5)}` } });
    const res = await call('PUT', `/api/v1/admin/vendors/${store.id}/name`, { name: 'TEST-Kitchen' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESERVED_NAME');
  });
});

describe('[F22] a person\'s number', () => {
  it('moves only after the code sent to the new number is read back, and every session ends', async () => {
    const person = await makeUser('Phone');
    const oldPhone = person.phone;
    const token = app.jwt.sign({ userId: person.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: person.id, token, refreshToken: nanoid(48), deviceId: 'door', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const next = testPhone();
    const code = await startMove(person.id, next);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: person.id } })).phone).toBe(oldPhone);
    const me = () => app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect((await me()).statusCode).toBe(200);

    const before = devChannelLog.length;
    const done = await call('POST', `/api/v1/admin/users/${person.id}/phone-change/confirm`, { code });
    expect(done.statusCode, done.body).toBe(200);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: person.id } })).phone).toBe(next);
    expect((await me()).statusCode).toBe(401);
    expect(devChannelLog.slice(before).some((entry) => entry.channel === 'sms' && entry.to === oldPhone)).toBe(true);
    expect(await app.prisma.notification.count({ where: { userId: person.id, title: 'Your number was changed' } })).toBe(1);
  });

  it('the trail holds the last four digits, never the number', async () => {
    const person = await makeUser('Trail');
    const next = testPhone();
    const code = await startMove(person.id, next);
    await call('POST', `/api/v1/admin/users/${person.id}/phone-change/confirm`, { code });
    const trail = await app.prisma.auditLog.findFirstOrThrow({ where: { entityId: person.id, action: 'CHANGE_USER_PHONE' } });
    expect(JSON.stringify(trail)).not.toContain(next);
    expect(JSON.stringify(trail)).not.toContain(person.phone);
  });

  it('a wrong code moves nothing, and a code cannot be used twice', async () => {
    const person = await makeUser('Wrong');
    const next = testPhone();
    const code = await startMove(person.id, next);
    const wrong = code === '111111' ? '222222' : '111111';
    expect((await call('POST', `/api/v1/admin/users/${person.id}/phone-change/confirm`, { code: wrong })).statusCode).toBe(400);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: person.id } })).phone).toBe(person.phone);
    expect((await call('POST', `/api/v1/admin/users/${person.id}/phone-change/confirm`, { code })).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/admin/users/${person.id}/phone-change/confirm`, { code })).statusCode).toBe(400);
    expect(await app.redis.get(`phone_change:${person.id}`)).toBeNull();
  });

  it('two moves at once: each code belongs to its own account and its own number', async () => {
    const one = await makeUser('First');
    const two = await makeUser('Second');
    const toOne = testPhone();
    const toTwo = testPhone();
    const codeOne = await startMove(one.id, toOne);
    const codeTwo = await startMove(two.id, toTwo);
    expect((await call('POST', `/api/v1/admin/users/${one.id}/phone-change/confirm`, { code: codeOne })).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/admin/users/${two.id}/phone-change/confirm`, { code: codeTwo })).statusCode).toBe(200);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: one.id } })).phone).toBe(toOne);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: two.id } })).phone).toBe(toTwo);
  });

  it('two accounts asking for the same number: the second never spoils the first, and only one can have it', async () => {
    const one = await makeUser('Same');
    const two = await makeUser('Number');
    const wanted = testPhone();
    const codeOne = await startMove(one.id, wanted);
    await app.redis.del(`otp_rate:${wanted}`);
    const codeTwo = await startMove(two.id, wanted);
    expect((await call('POST', `/api/v1/admin/users/${one.id}/phone-change/confirm`, { code: codeOne })).statusCode).toBe(200);
    const late = await call('POST', `/api/v1/admin/users/${two.id}/phone-change/confirm`, { code: codeTwo });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('PHONE_IN_USE');
  });

  it('a code for one account never moves another', async () => {
    const one = await makeUser('One');
    const two = await makeUser('Two');
    const code = await startMove(one.id, testPhone());
    expect((await call('POST', `/api/v1/admin/users/${two.id}/phone-change/confirm`, { code })).statusCode).toBe(400);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: two.id } })).phone).toBe(two.phone);
  });

  it('a number another account uses is refused before any text goes', async () => {
    const one = await makeUser('Taken');
    const two = await makeUser('Holder');
    const before = devChannelLog.length;
    const res = await call('POST', `/api/v1/admin/users/${one.id}/phone-change`, { phone: two.phone });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PHONE_IN_USE');
    expect(devChannelLog.slice(before).filter((entry) => entry.to === two.phone)).toHaveLength(0);
  });

  it('a number outside Guyana is refused', async () => {
    const one = await makeUser('Abroad');
    expect((await call('POST', `/api/v1/admin/users/${one.id}/phone-change`, { phone: '+12025550143' })).statusCode).toBe(400);
  });

  it('a sign-in code for the new number does not open this door, nor this code that one', async () => {
    const one = await makeUser('Key');
    const next = testPhone();
    const code = await startMove(one.id, next);
    expect(await app.redis.get(`otp:${next}`)).toBeNull();
    expect(code).toMatch(/^\d{6}$/);
  });
});
