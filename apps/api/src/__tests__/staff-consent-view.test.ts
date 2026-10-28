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
// [SEC-TRUST F15] While STAFF_INVITE_ACCEPT is off, a number the owner types
// joins the team without saying yes. The team list then shows the owner only
// the first name and the number they typed — never the member's last name or
// photo — and a team is added only to a store Swift has approved (ACTIVE).
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
      phone: phone(), firstName: 'Team', lastName: `Surname${userIds.length}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/cap.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sec-trust-f15', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, phone: user.phone };
}

async function makeOwnerWithStore(status: 'ACTIVE' | 'PENDING_APPROVAL' = 'ACTIVE') {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  await grantStepUp(app, owner.token);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  vendorOwnerIds.push(vo.id);
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Team Bistro ${wordFreeTag(8)}`, slug: `team-bistro-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: phone(), addressLine1: '6 Crew Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status, acceptingOrders: status === 'ACTIVE', isCurrentlyOpen: status === 'ACTIVE', isVerified: status === 'ACTIVE',
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
const team = (token: string) => app.inject({ method: 'GET', url: '/api/v1/vendor/staff', headers: { authorization: `Bearer ${token}` } });
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

describe('[SEC-TRUST F15] a member added without consent is not shown in full', () => {
  it('switch off: the team list shows the first name and number only (last name and photo null); switch on: shown in full', async () => {
    const owner = await makeOwnerWithStore();
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await add(owner.token, person.phone)).statusCode).toBe(200);
    expect(await memberOf(owner.vendorId, person.userId)).not.toBeNull();

    const off = await team(owner.token);
    expect(off.statusCode, off.body).toBe(200);
    const shown = off.json().data.find((m: { userId: string }) => m.userId === person.userId);
    expect(shown.user).toMatchObject({ id: person.userId, firstName: 'Team', phone: person.phone, lastName: null, avatar: null });

    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const on = await team(owner.token);
    const full = on.json().data.find((m: { userId: string }) => m.userId === person.userId);
    expect(full.user.lastName).toMatch(/^Surname/);
    expect(full.user.avatar).toBe('/uploads/avatars/cap.jpg');
  });

  it('a store still waiting for approval cannot add a team member', async () => {
    const owner = await makeOwnerWithStore('PENDING_APPROVAL');
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await add(owner.token, person.phone);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STORE_NOT_APPROVED');
    await settle();
    expect(await memberOf(owner.vendorId, person.userId)).toBeNull();
  });
});
