import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { injectWithApproval } from './helpers/admin-approval';
import { blankClosedNumberAsks, confirmPhoneChange } from '../modules/admin/phone-change';
import { AuthService } from '../modules/auth/auth.service';
import { getChannels } from '../providers/notifications/channels';

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

/** The ask, a second person agreeing, and the ask carried out: the whole of the number door's first step. */
const twoPeople = (token: string, userId: string, phone: string) => injectWithApproval(app, {
  method: 'POST', url: `/api/v1/admin/users/${userId}/phone-change`, payload: { phone },
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
});

/** A member of staff, signed in through the real door. */
async function makeStaff(role: 'ADMIN' | 'SUPER_ADMIN') {
  const phone = testPhone();
  const user = await app.prisma.user.create({
    data: { phone, firstName: 'Staff', lastName: `Door${seq}`, roles: [role, 'CUSTOMER'], activeRole: role, isPhoneVerified: true, admin: { create: { permissions: ['*'] } } },
  });
  userIds.push(user.id);
  const token: string = (await loginWithOtp(app, phone)).json().data.tokens.accessToken;
  return { user, token };
}

const smsTo = (phone: string, since: number) => devChannelLog.slice(since).filter((entry) => entry.channel === 'sms' && entry.to === phone);
const phoneOf = async (id: string) => (await app.prisma.user.findUniqueOrThrow({ where: { id } })).phone;
const confirm = (userId: string, code: string) => call('POST', `/api/v1/admin/users/${userId}/phone-change/confirm`, { code });

/** The code the new number received. */
async function startMove(userId: string, phone: string) {
  await clearCounters(phone);
  const before = devChannelLog.length;
  const res = await twoPeople(adminToken, userId, phone);
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
    const started = await app.prisma.auditLog.findMany({ where: { entityId: person.id } });
    expect(started.length).toBeGreaterThanOrEqual(2); // the ask carried out, and the move
    expect(JSON.stringify(started)).not.toContain(next);
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
    const res = await twoPeople(adminToken, one.id, two.phone);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PHONE_IN_USE');
    expect(devChannelLog.slice(before).filter((entry) => entry.to === two.phone)).toHaveLength(0);
  });

  it('the number the account already has is not a move: no text goes', async () => {
    const one = await makeUser('Same');
    await clearCounters(one.phone);
    const since = devChannelLog.length;
    const res = await twoPeople(adminToken, one.id, one.phone);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SAME_PHONE');
    expect(smsTo(one.phone, since)).toHaveLength(0);
  });

  it('a number outside Guyana is refused', async () => {
    const one = await makeUser('Abroad');
    expect((await twoPeople(adminToken, one.id, '+12025550143')).statusCode).toBe(400);
  });

  it('a sign-in code for the new number does not open this door, nor this code that one', async () => {
    const one = await makeUser('Key');
    const next = testPhone();
    const code = await startMove(one.id, next);
    expect(await app.redis.get(`otp:${next}`)).toBeNull();
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe('[F22] the number door: one member of staff is never enough, and staff accounts are out of reach', () => {
  it('asking takes a second person: no text goes out, and nothing moves, until they agree', async () => {
    const person = await makeUser('Ask');
    const next = testPhone();
    await clearCounters(next);
    const since = devChannelLog.length;
    const asked = await call('POST', `/api/v1/admin/users/${person.id}/phone-change`, { phone: next });
    expect(asked.statusCode, asked.body).toBe(202);
    expect(asked.json().error.code).toBe('APPROVAL_REQUIRED');
    expect(smsTo(next, since)).toHaveLength(0);
    expect(await phoneOf(person.id)).toBe(person.phone);
  });

  it('a plain ADMIN cannot take a SUPER_ADMIN\'s account, even with a second person agreeing: no text, and a real sign-in on that number is somebody else', async () => {
    const attacker = await makeStaff('ADMIN');
    const owner = await makeStaff('SUPER_ADMIN');
    const mine = testPhone();
    await clearCounters(mine);
    const since = devChannelLog.length;
    const res = await twoPeople(attacker.token, owner.user.id, mine);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ACCOUNT');
    expect(smsTo(mine, since)).toHaveLength(0);
    expect(await phoneOf(owner.user.id)).toBe(owner.user.phone);
    const signedIn = (await loginWithOtp(app, mine)).json();
    expect(signedIn.data?.user?.id).not.toBe(owner.user.id);
    expect(JSON.stringify(signedIn)).not.toContain('SUPER_ADMIN');
  });

  it('the approval row keeps the last four once the ask is carried out, moved or refused', async () => {
    const stored = async (entityId: string) => JSON.stringify((await app.prisma.privilegedApproval.findFirstOrThrow({ where: { entityId, action: 'POST /users/:id/phone-change' }, orderBy: { createdAt: 'desc' } })).bodySnapshot);
    const person = await makeUser('Blank');
    const next = testPhone();
    const code = await startMove(person.id, next);
    expect(await stored(person.id)).not.toContain(next);
    expect(await stored(person.id)).toContain(next.slice(-4));
    expect((await confirm(person.id, code)).statusCode).toBe(200);
    const staff = await makeStaff('SUPER_ADMIN');
    const held = testPhone();
    expect((await twoPeople(adminToken, staff.user.id, held)).statusCode).toBe(403);
    expect(await stored(staff.user.id)).not.toContain(held);
  });

  it('an ask refused, or left to lapse, gives its number up to the daily sweep; a live one keeps it', async () => {
    const asked = async () => {
      const person = await makeUser('Asked');
      const phone = testPhone();
      const res = await call('POST', `/api/v1/admin/users/${person.id}/phone-change`, { phone });
      expect(res.statusCode, res.body).toBe(202);
      return { phone, id: res.json().error.details.approvalId as string };
    };
    const body = async (id: string) => JSON.stringify((await app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id } })).bodySnapshot);
    const [refused, lapsed, live] = [await asked(), await asked(), await asked()];
    await app.prisma.privilegedApproval.update({ where: { id: refused.id }, data: { status: 'REJECTED' } });
    await app.prisma.privilegedApproval.update({ where: { id: lapsed.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await blankClosedNumberAsks(app.prisma);
    expect(await body(refused.id)).not.toContain(refused.phone);
    expect(await body(lapsed.id)).not.toContain(lapsed.phone);
    expect(await body(live.id)).toContain(live.phone);
    expect(readFileSync(join(__dirname, '../jobs/queue.ts'), 'utf8')).toContain('await blankClosedNumberAsks(ctx.prisma);');
  });

  it('a founder is refused on their own account too', async () => {
    const owner = await makeStaff('SUPER_ADMIN');
    const res = await twoPeople(owner.token, owner.user.id, testPhone());
    expect(res.statusCode, res.body).toBe(403);
    expect(await phoneOf(owner.user.id)).toBe(owner.user.phone);
  });

  it('an account wearing a customer hat with a staff role underneath is staff', async () => {
    const person = await makeUser('Hat');
    await app.prisma.user.update({ where: { id: person.id }, data: { roles: ['CUSTOMER', 'ADMIN'] } });
    const res = await twoPeople(adminToken, person.id, testPhone());
    expect(res.statusCode, res.body).toBe(403);
  });

  it('made staff after the code went out: the read-back is refused on the row read under the lock', async () => {
    const person = await makeUser('Promoted');
    const code = await startMove(person.id, testPhone());
    await app.prisma.user.update({ where: { id: person.id }, data: { roles: ['CUSTOMER', 'SUPER_ADMIN'] } });
    const res = await confirm(person.id, code);
    expect(res.statusCode, res.body).toBe(403);
    expect(await phoneOf(person.id)).toBe(person.phone);
  });

  it('closed between the code and the read-back: the tombstone stays', async () => {
    const person = await makeUser('Closed');
    const code = await startMove(person.id, testPhone());
    const tombstone = `deleted:${person.id}`;
    await app.prisma.user.update({ where: { id: person.id }, data: { phone: tombstone, status: 'DEACTIVATED' } });
    const since = devChannelLog.length;
    const res = await confirm(person.id, code);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ACCOUNT_CLOSED');
    expect(await phoneOf(person.id)).toBe(tombstone);
    expect(devChannelLog.slice(since).filter((entry) => entry.channel === 'sms')).toHaveLength(0); // nobody is told of a move that cannot happen
  });

  it('banned in the last instant, after the first read: the row read under the lock refuses it, and the sessions stay', async () => {
    const person = await makeUser('Instant');
    const token = app.jwt.sign({ userId: person.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: person.id, token, refreshToken: nanoid(48), deviceId: 'instant', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const code = await startMove(person.id, testPhone());
    await expect(confirmPhoneChange(
      {
        prisma: app.prisma, redis: app.redis, channels: getChannels(), log: app.log,
        moveWithSessions: async (write) => {
          await app.prisma.user.update({ where: { id: person.id }, data: { status: 'BANNED' } });
          await new AuthService(app).logoutAll(person.id, write);
        },
      },
      { userId: person.id, code, within: async () => undefined },
    )).rejects.toMatchObject({ code: 'ACCOUNT_BANNED' });
    expect(await phoneOf(person.id)).toBe(person.phone);
    expect(await app.prisma.session.count({ where: { userId: person.id } })).toBe(1);
  });

  it('a banned account keeps its number, at either step', async () => {
    const asked = await makeUser('Banned');
    await app.prisma.user.update({ where: { id: asked.id }, data: { status: 'BANNED' } });
    const refused = await twoPeople(adminToken, asked.id, testPhone());
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('ACCOUNT_BANNED');
    const late = await makeUser('Late');
    const code = await startMove(late.id, testPhone());
    await app.prisma.user.update({ where: { id: late.id }, data: { status: 'BANNED' } });
    expect((await confirm(late.id, code)).statusCode).toBe(409);
    expect(await phoneOf(late.id)).toBe(late.phone);
  });

  it('a real sign-in on the new number reaches the same account, and the old session is gone', async () => {
    const person = await makeUser('Real');
    const token = app.jwt.sign({ userId: person.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: person.id, token, refreshToken: nanoid(48), deviceId: 'real', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const next = testPhone();
    const code = await startMove(person.id, next);
    expect((await confirm(person.id, code)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    const signedIn = await loginWithOtp(app, next);
    expect(signedIn.json().data.user.id).toBe(person.id);
  });

  it('the move, the end of every session and the trail are one commit, and the old number is told first', async () => {
    const person = await makeUser('Atomic');
    const token = app.jwt.sign({ userId: person.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: person.id, token, refreshToken: nanoid(48), deviceId: 'atomic', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const code = await startMove(person.id, testPhone());
    const since = devChannelLog.length;
    await expect(confirmPhoneChange(
      { prisma: app.prisma, redis: app.redis, channels: getChannels(), log: app.log, moveWithSessions: (write) => new AuthService(app).logoutAll(person.id, write) },
      { userId: person.id, code, within: async () => { throw new Error('the trail refused'); } },
    )).rejects.toThrow('the trail refused');
    expect(await phoneOf(person.id)).toBe(person.phone);
    expect(await app.prisma.session.count({ where: { userId: person.id } })).toBe(1);
    expect(smsTo(person.phone, since)).toHaveLength(1);
  });
});

describe('[F22] the store doors', () => {
  it('a store owned by a staff account is out of reach, on type and on name', async () => {
    const staff = await makeStaff('SUPER_ADMIN');
    const store = await makeStore(staff.user.id);
    const type = await call('PUT', `/api/v1/admin/vendors/${store.id}/type`, { vendorType: 'STORE' });
    expect(type.statusCode, type.body).toBe(403);
    const name = await call('PUT', `/api/v1/admin/vendors/${store.id}/name`, { name: `Door Mart ${wordFreeTag(6)}` });
    expect(name.statusCode, name.body).toBe(403);
    const after = await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.vendorType).toBe(store.vendorType);
    expect(after.name).toBe(store.name);
  });

  it('an admin cannot use these doors on their own store', async () => {
    const staff = await makeStaff('ADMIN');
    const store = await makeStore(staff.user.id);
    const own = (url: string, payload: Record<string, unknown>) => app.inject({
      method: 'PUT', url, payload, headers: { authorization: `Bearer ${staff.token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON },
    });
    expect((await own(`/api/v1/admin/vendors/${store.id}/type`, { vendorType: 'STORE' })).statusCode).toBe(403);
    expect((await own(`/api/v1/admin/vendors/${store.id}/name`, { name: `Door Mart ${wordFreeTag(6)}` })).statusCode).toBe(403);
  });

  it('a name with words a person has to check is refused, as the app holds it', async () => {
    const owner = await makeUser('Words');
    const store = await makeStore(owner.id);
    const res = await call('PUT', `/api/v1/admin/vendors/${store.id}/name`, { name: 'Ganja Corner' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('STORE_NAME_HELD');
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: store.id } })).name).toBe(store.name);
  });
});
