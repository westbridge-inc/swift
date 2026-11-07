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
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] Add one person to several branches in one step: every branch must be the owner's
// own and approved, the person joins each, and the daily allowance is spent ONCE (it is about numbers looked up).
// (Harness from l05-staff-add-cap.) Row 55 follow-up. Until STAFF_INVITE_ACCEPT is on, adding a known number
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
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'chains-staff', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) },
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

async function secondStore(ownerUserId: string, status: 'ACTIVE' | 'PENDING_APPROVAL' = 'ACTIVE') {
  const vo = await app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Cap Branch ${wordFreeTag(8)}`, slug: `cap-branch-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: phone(), addressLine1: '7 Crew Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status, acceptingOrders: status === 'ACTIVE', isCurrentlyOpen: status === 'ACTIVE', isVerified: status === 'ACTIVE',
    },
  });
  vendorIds.push(vendor.id);
  return vendor.id;
}
const addTo = (token: string, number: string, stores: string[], role: 'STAFF' | 'MANAGER' = 'STAFF') => app.inject({
  method: 'POST', url: '/api/v1/vendor/staff', payload: { phone: number, role, vendorIds: stores },
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
});

describe('[CHAINS] one person, several branches, one add', () => {
  it('joins every branch named, and spends the daily allowance once', async () => {
    process.env['STAFF_ADD_DAILY_CAP'] = '1';
    const owner = await makeOwnerWithStore();
    const second = await secondStore(owner.userId);
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await addTo(owner.token, person.phone, [owner.vendorId, second], 'MANAGER');
    expect(res.statusCode, res.body).toBe(200);
    expect((await memberOf(owner.vendorId, person.userId))?.role).toBe('MANAGER');
    expect((await memberOf(second, person.userId))?.role).toBe('MANAGER');
    // The allowance (1) was spent once: the next add of anyone is refused.
    const next = await add(owner.token, phone());
    expect(next.statusCode).toBe(429);
  });

  it('a store that is not the owner\'s own, or not approved yet, refuses the whole add', async () => {
    const owner = await makeOwnerWithStore();
    const stranger = await makeOwnerWithStore();
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const foreign = await addTo(owner.token, person.phone, [owner.vendorId, stranger.vendorId]);
    expect(foreign.statusCode, foreign.body).toBe(404);
    const waiting = await secondStore(owner.userId, 'PENDING_APPROVAL');
    const pending = await addTo(owner.token, person.phone, [owner.vendorId, waiting]);
    expect(pending.statusCode, pending.body).toBe(403);
    expect(pending.json().error.code).toBe('STORE_NOT_APPROVED');
    expect(await memberOf(owner.vendorId, person.userId)).toBeNull();
    expect(await memberOf(stranger.vendorId, person.userId)).toBeNull();
  });

  it('a manager cannot use it to add people to branches', async () => {
    const owner = await makeOwnerWithStore();
    const second = await secondStore(owner.userId);
    const manager = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await grantStepUp(app, manager.token);
    await app.prisma.vendorStaff.create({ data: { vendorId: owner.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } });
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await addTo(manager.token, person.phone, [owner.vendorId, second]);
    expect(res.statusCode).toBe(403);
    expect(await memberOf(second, person.userId)).toBeNull();
  });
});
