import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { grantStepUp } from './helpers/step-up';
import { STAFF_INVITE_KIND, staffInviteAcceptEnabled } from '../modules/vendor/staff-invites';

// ---------------------------------------------------------------------------
// Row 55. Adding a store team member by phone must not tell the owner whether
// the number is a Swift account, or whose. Every number gets the same reply.
// With STAFF_INVITE_ACCEPT on, a known account gets an invite and joins only
// when it accepts; nothing pending is listed to the owner. With it off (the
// app build without the Accept card) a known account is added at once.
// Fixture range: +59244nnnnn (this file only).
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
const userIds: string[] = [];
let owner: { userId: string; token: string; phone: string };
let vendorId: string;
let vendorOwnerId: string;
let storeName: string;

async function makeUser(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}) {
  const phone = `+59244${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Invitee', lastName: `Person${userIds.length}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/invitee.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'l05-invite', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, phone };
}

function inject(method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload } : {}),
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
}

const add = (phone: string, role: 'STAFF' | 'MANAGER' = 'STAFF') => inject('POST', '/api/v1/vendor/staff', owner.token, { phone, role });
const memberOf = (userId: string) => app.prisma.vendorStaff.findUnique({ where: { vendorId_userId: { vendorId, userId } } });
const invitesOf = (userId: string) => app.prisma.notification.findMany({
  where: { userId, data: { path: ['kind'], equals: STAFF_INVITE_KIND } },
  orderBy: { createdAt: 'asc' },
});

/** The invite is written off the request path; wait for it to land. */
async function waitForInvites(userId: string, count: number) {
  for (let i = 0; i < 50; i += 1) {
    const rows = await invitesOf(userId);
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return invitesOf(userId);
}
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
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  await grantStepUp(app, owner.token);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  vendorOwnerId = vo.id;
  storeName = `Invite Bistro ${nanoid(4)}`;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: storeName, slug: `invite-bistro-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `+59244${String(Math.floor(Math.random() * 90000) + 10000)}`,
      addressLine1: '4 Crew Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterEach(() => { delete process.env['STAFF_INVITE_ACCEPT']; });

afterAll(async () => {
  await settle();
  await app.prisma.vendorStaff.deleteMany({ where: { vendorId } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: vendorOwnerId } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[row 55] one reply for every number', () => {
  it('the switch reads only an explicit 1', () => {
    expect(staffInviteAcceptEnabled({})).toBe(false);
    expect(staffInviteAcceptEnabled({ STAFF_INVITE_ACCEPT: 'true' })).toBe(false);
    expect(staffInviteAcceptEnabled({ STAFF_INVITE_ACCEPT: '1' })).toBe(true);
  });

  for (const mode of ['off', 'on'] as const) {
    it(`switch ${mode}: unknown, known, already-member and already-invited numbers get byte-identical replies with no identity`, async () => {
      if (mode === 'on') process.env['STAFF_INVITE_ACCEPT'] = '1';
      const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const unknownPhone = `+59244${String(Math.floor(Math.random() * 90000) + 10000)}`;

      const first = await add(known.phone);
      const again = await add(known.phone);
      const unknown = await add(unknownPhone);
      for (const res of [first, again, unknown]) {
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(unknown.body);
        for (const secret of [known.userId, 'Invitee', '/uploads/avatars', known.phone, unknownPhone]) {
          expect(res.body).not.toContain(secret);
        }
      }
    });
  }
});

describe('[row 55] switch OFF (build without the Accept card): added at once, as before', () => {
  it('a known account is a member straight away; an unknown number creates nothing', async () => {
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await add(known.phone, 'MANAGER')).statusCode).toBe(200);
    expect((await memberOf(known.userId))?.role).toBe('MANAGER');
    await settle();
    expect(await invitesOf(known.userId)).toHaveLength(0);
  });

  it('an invite cannot be accepted while the switch is off', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone);
    const [invite] = await waitForInvites(known.userId, 1);
    delete process.env['STAFF_INVITE_ACCEPT'];
    const res = await inject('POST', `/api/v1/vendor/team-invites/${invite!.id}/accept`, known.token);
    expect(res.statusCode).toBe(404);
    expect(await memberOf(known.userId)).toBeNull();
  });
});

describe('[row 55] switch ON: invite, then the person accepts', () => {
  it('a known account gets one invite, is not a member and is not listed until it accepts', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone, 'MANAGER');
    await add(known.phone, 'MANAGER'); // a second tap while the first invite is live
    const invites = await waitForInvites(known.userId, 1);
    await settle();
    expect(await invitesOf(known.userId)).toHaveLength(1);
    expect(invites[0]!.body).toBe(`${storeName} invited you to join their team as a manager. Open your notifications to accept or decline.`);
    expect(await memberOf(known.userId)).toBeNull();

    const listed = await inject('GET', '/api/v1/vendor/staff', owner.token);
    expect(listed.body).not.toContain(known.userId);

    const mine = await inject('GET', '/api/v1/vendor/team-invites', known.token);
    expect(mine.json().data).toEqual([expect.objectContaining({ id: invites[0]!.id, storeName, role: 'MANAGER' })]);

    const accepted = await inject('POST', `/api/v1/vendor/team-invites/${invites[0]!.id}/accept`, known.token);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data).toEqual({ decision: 'ACCEPTED', storeName, role: 'MANAGER' });
    expect((await memberOf(known.userId))?.role).toBe('MANAGER');
    expect((await inject('GET', '/api/v1/vendor/staff', owner.token)).body).toContain(known.userId);

    const twice = await inject('POST', `/api/v1/vendor/team-invites/${invites[0]!.id}/accept`, known.token);
    expect(twice.statusCode).toBe(409);
    expect((await inject('GET', '/api/v1/vendor/team-invites', known.token)).json().data).toEqual([]);
  });

  it('declining grants nothing, and a declined invite cannot be accepted afterwards', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone);
    const [invite] = await waitForInvites(known.userId, 1);
    expect((await inject('POST', `/api/v1/vendor/team-invites/${invite!.id}/decline`, known.token)).json().data).toEqual({ decision: 'DECLINED' });
    expect((await inject('POST', `/api/v1/vendor/team-invites/${invite!.id}/accept`, known.token)).statusCode).toBe(409);
    expect(await memberOf(known.userId)).toBeNull();
  });

  it('nobody else can answer my invite', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const stranger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone);
    const [invite] = await waitForInvites(known.userId, 1);
    expect((await inject('POST', `/api/v1/vendor/team-invites/${invite!.id}/accept`, stranger.token)).statusCode).toBe(404);
    expect(await memberOf(stranger.userId)).toBeNull();
    expect(await memberOf(known.userId)).toBeNull();
  });

  it('an expired invite, or one whose inviter no longer owns the store, grants nothing', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const late = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const orphan = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(late.phone);
    await add(orphan.phone);
    const [lateInvite] = await waitForInvites(late.userId, 1);
    const [orphanInvite] = await waitForInvites(orphan.userId, 1);
    await app.prisma.notification.update({
      where: { id: lateInvite!.id },
      data: { data: { ...(lateInvite!.data as Record<string, unknown>), expiresAt: new Date(Date.now() - 1000).toISOString() } },
    });
    await app.prisma.notification.update({
      where: { id: orphanInvite!.id },
      data: { data: { ...(orphanInvite!.data as Record<string, unknown>), invitedBy: late.userId } },
    });
    const expired = await inject('POST', `/api/v1/vendor/team-invites/${lateInvite!.id}/accept`, late.token);
    expect(expired.statusCode).toBe(410);
    const revoked = await inject('POST', `/api/v1/vendor/team-invites/${orphanInvite!.id}/accept`, orphan.token);
    expect(revoked.statusCode).toBe(409);
    expect(await memberOf(late.userId)).toBeNull();
    expect(await memberOf(orphan.userId)).toBeNull();
  });

  it('Accept racing Decline has exactly one winner, and membership matches it', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone);
    const [invite] = await waitForInvites(known.userId, 1);
    const [a, d] = await Promise.all([
      inject('POST', `/api/v1/vendor/team-invites/${invite!.id}/accept`, known.token),
      inject('POST', `/api/v1/vendor/team-invites/${invite!.id}/decline`, known.token),
    ]);
    expect([a.statusCode, d.statusCode].sort()).toEqual([200, 409]);
    const state = ((await app.prisma.notification.findUniqueOrThrow({ where: { id: invite!.id } })).data as { state: string }).state;
    expect(state).toBe(a.statusCode === 200 ? 'ACCEPTED' : 'DECLINED');
    expect(Boolean(await memberOf(known.userId))).toBe(a.statusCode === 200);
  });
});

describe('[row 55] the console shows which way the switch is set', () => {
  it('GET /admin/config reports staffInviteAccept as this API runs it', async () => {
    const boss = await makeUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } });
    const off = await inject('GET', '/api/v1/admin/config', boss.token);
    expect(off.statusCode).toBe(200);
    expect(off.json().switches).toEqual({ staffInviteAccept: false });
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const on = await inject('GET', '/api/v1/admin/config', boss.token);
    expect(on.json().switches).toEqual({ staffInviteAccept: true });
  });
});
