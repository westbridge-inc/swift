import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { grantStepUp } from './helpers/step-up';
import { STAFF_INVITE_KIND, staffAddDailyCap, spendStaffAddAllowance } from '../modules/vendor/staff-invites';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// Row 55 follow-up. Until STAFF_INVITE_ACCEPT is on, adding a known number
// still puts that person on the team at once, so the team list shows who owns
// any number typed. A daily cap on team adds per owner account stops the add
// being used as a bulk phone-number lookup. The cap is spent BEFORE the number
// is looked up, so hitting it says nothing about any number: a known and an
// unknown number get the same refusal and nothing is granted.
// Fixture range: +59246nnnnn (this file only).
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
const vendorOwnerIds: string[] = [];

const phone = () => testPhone();

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  const user = await app.prisma.user.create({
    data: {
      phone: phone(), firstName: 'Cap', lastName: `Person${userIds.length}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/cap.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'l05-cap', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, phone: user.phone };
}

async function makeOwnerWithStore() {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  await grantStepUp(app, owner.token);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  vendorOwnerIds.push(vo.id);
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Cap Bistro ${wordFreeTag(8)}`, slug: `cap-bistro-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: phone(), addressLine1: '6 Crew Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  return { ...owner, vendorId: vendor.id };
}

const add = (token: string, number: string) => app.inject({
  method: 'POST', url: '/api/v1/vendor/staff', payload: { phone: number, role: 'STAFF' },
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
});
const memberOf = (vendorId: string, userId: string) =>
  app.prisma.vendorStaff.findUnique({ where: { vendorId_userId: { vendorId, userId } } });
const invitesOf = (userId: string) => app.prisma.notification.findMany({
  where: { userId, data: { path: ['kind'], equals: STAFF_INVITE_KIND } },
});
const settle = () => new Promise((r) => setTimeout(r, 400));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
});

afterEach(() => {
  delete process.env['STAFF_INVITE_ACCEPT'];
  delete process.env['STAFF_ADD_DAILY_CAP'];
});

afterAll(async () => {
  await settle();
  await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vendorOwnerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[row 55] daily cap on store team adds', () => {
  it('the cap is 10 adds a day by default; STAFF_ADD_DAILY_CAP tunes it; nonsense falls back to the default', () => {
    expect(staffAddDailyCap({})).toBe(10);
    expect(staffAddDailyCap({ STAFF_ADD_DAILY_CAP: '25' })).toBe(25);
    expect(staffAddDailyCap({ STAFF_ADD_DAILY_CAP: '0' })).toBe(10);
    expect(staffAddDailyCap({ STAFF_ADD_DAILY_CAP: 'lots' })).toBe(10);
  });

  for (const mode of ['off', 'on'] as const) {
    it(`switch ${mode}: past the cap, a known and an unknown number get the same refusal and nothing is granted`, async () => {
      if (mode === 'on') process.env['STAFF_INVITE_ACCEPT'] = '1';
      process.env['STAFF_ADD_DAILY_CAP'] = '3';
      const owner = await makeOwnerWithStore();
      for (let i = 0; i < 3; i += 1) {
        expect((await add(owner.token, phone())).statusCode).toBe(200);
      }

      const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const overKnown = await add(owner.token, known.phone);
      const overUnknown = await add(owner.token, phone());
      expect(overKnown.statusCode).toBe(429);
      expect(overKnown.json()).toMatchObject({ success: false, error: { code: 'STAFF_ADD_DAILY_LIMIT' } });
      // Byte-identical: the refusal never depends on the number typed.
      expect(overKnown.body).toBe(overUnknown.body);
      expect(overKnown.body).not.toContain(known.phone);
      expect(overKnown.body).not.toContain('Cap');

      await settle();
      expect(await memberOf(owner.vendorId, known.userId)).toBeNull();
      expect(await invitesOf(known.userId)).toHaveLength(0);
    });
  }

  it('under the cap, a known number is still added as before (switch off)', async () => {
    process.env['STAFF_ADD_DAILY_CAP'] = '3';
    const owner = await makeOwnerWithStore();
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await add(owner.token, known.phone)).statusCode).toBe(200);
    expect(await memberOf(owner.vendorId, known.userId)).not.toBeNull();
  });

  it('the cap belongs to one owner account: another owner is not affected', async () => {
    process.env['STAFF_ADD_DAILY_CAP'] = '2';
    const busy = await makeOwnerWithStore();
    const other = await makeOwnerWithStore();
    await add(busy.token, phone());
    await add(busy.token, phone());
    expect((await add(busy.token, phone())).statusCode).toBe(429);
    expect((await add(other.token, phone())).statusCode).toBe(200);
  });

  it('every add counts, including the same number twice: repeats cannot be used to probe for free', async () => {
    process.env['STAFF_ADD_DAILY_CAP'] = '2';
    const owner = await makeOwnerWithStore();
    const number = phone();
    expect((await add(owner.token, number)).statusCode).toBe(200);
    expect((await add(owner.token, number)).statusCode).toBe(200);
    expect((await add(owner.token, number)).statusCode).toBe(429);
  });

  it('the allowance is per Guyana day: a new day starts a fresh count', async () => {
    process.env['STAFF_ADD_DAILY_CAP'] = '1';
    const userId = `cap-day-${nanoid(8)}`;
    const today = new Date('2026-10-20T15:00:00Z');
    const tomorrow = new Date('2026-10-21T15:00:00Z');
    expect(await spendStaffAddAllowance(app.redis, userId, today)).toBe(true);
    expect(await spendStaffAddAllowance(app.redis, userId, today)).toBe(false);
    expect(await spendStaffAddAllowance(app.redis, userId, tomorrow)).toBe(true);
  });
});
