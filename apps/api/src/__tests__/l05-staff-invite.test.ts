import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { grantStepUp } from './helpers/step-up';
import { STAFF_INVITE_KIND, staffInviteAcceptEnabled, deliverStaffInvite } from '../modules/vendor/staff-invites';
import { NotificationService } from '../modules/notification/notification.service';

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

function inject(method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: Record<string, unknown>) {
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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
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
    const res = await inject('POST', `/api/v1/customer/team-invites/${invite!.id}/accept`, known.token);
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

    const mine = await inject('GET', '/api/v1/customer/team-invites', known.token);
    expect(mine.json().data).toEqual([expect.objectContaining({ id: invites[0]!.id, storeName, role: 'MANAGER' })]);

    const accepted = await inject('POST', `/api/v1/customer/team-invites/${invites[0]!.id}/accept`, known.token);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data).toEqual({ decision: 'ACCEPTED', storeName, role: 'MANAGER' });
    expect((await memberOf(known.userId))?.role).toBe('MANAGER');
    expect((await inject('GET', '/api/v1/vendor/staff', owner.token)).body).toContain(known.userId);

    const twice = await inject('POST', `/api/v1/customer/team-invites/${invites[0]!.id}/accept`, known.token);
    expect(twice.statusCode).toBe(409);
    expect((await inject('GET', '/api/v1/customer/team-invites', known.token)).json().data).toEqual([]);
  });

  it('declining grants nothing, and a declined invite cannot be accepted afterwards', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone);
    const [invite] = await waitForInvites(known.userId, 1);
    expect((await inject('POST', `/api/v1/customer/team-invites/${invite!.id}/decline`, known.token)).json().data).toEqual({ decision: 'DECLINED' });
    expect((await inject('POST', `/api/v1/customer/team-invites/${invite!.id}/accept`, known.token)).statusCode).toBe(409);
    expect(await memberOf(known.userId)).toBeNull();
  });

  it('nobody else can answer my invite', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const stranger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone);
    const [invite] = await waitForInvites(known.userId, 1);
    expect((await inject('POST', `/api/v1/customer/team-invites/${invite!.id}/accept`, stranger.token)).statusCode).toBe(404);
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
    const expired = await inject('POST', `/api/v1/customer/team-invites/${lateInvite!.id}/accept`, late.token);
    expect(expired.statusCode).toBe(410);
    const revoked = await inject('POST', `/api/v1/customer/team-invites/${orphanInvite!.id}/accept`, orphan.token);
    expect(revoked.statusCode).toBe(409);
    expect(await memberOf(late.userId)).toBeNull();
    expect(await memberOf(orphan.userId)).toBeNull();
    for (const [person, invite] of [[late, lateInvite], [orphan, orphanInvite]] as const) {
      const row = await app.prisma.notification.findUniqueOrThrow({ where: { id: invite!.id } });
      expect((row.data as { state: string }).state).toBe('CLOSED');
      expect((await inject('GET', '/api/v1/customer/team-invites', person.token)).json().data).toEqual([]);
    }
  });

  it('Accept racing Decline has exactly one winner, and membership matches it', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone);
    const [invite] = await waitForInvites(known.userId, 1);
    const [a, d] = await Promise.all([
      inject('POST', `/api/v1/customer/team-invites/${invite!.id}/accept`, known.token),
      inject('POST', `/api/v1/customer/team-invites/${invite!.id}/decline`, known.token),
    ]);
    expect([a.statusCode, d.statusCode].sort()).toEqual([200, 409]);
    const state = ((await app.prisma.notification.findUniqueOrThrow({ where: { id: invite!.id } })).data as { state: string }).state;
    expect(state).toBe(a.statusCode === 200 ? 'ACCEPTED' : 'DECLINED');
    expect(Boolean(await memberOf(known.userId))).toBe(a.statusCode === 200);
  });
});

describe('invite grants serialize with revocation', () => {
  it('concurrent deliveries record one invitation and wait for the shared grant lock', async () => {
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const key = JSON.stringify(['staff-invite-grant', vendorId, known.userId]);
    const holding = app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      acquired();
      await held;
    }, { timeout: 10000 });
    await ready;
    const input = { vendorId, targetUserId: known.userId, role: 'MANAGER' as const, inviterId: owner.userId, now: new Date(), revocationVersion: 0 };
    const publisher = new NotificationService(app.prisma, app.io);
    const deliveries = Promise.all([deliverStaffInvite(app.prisma, publisher, input), deliverStaffInvite(app.prisma, publisher, input)]);
    let whileHeld: Awaited<ReturnType<typeof invitesOf>> = [];
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      whileHeld = await invitesOf(known.userId);
    } finally { release(); await holding; }
    const results = await deliveries;
    expect(whileHeld, 'issuance cannot pass an outstanding revocation/grant lock').toHaveLength(0);
    expect(results.sort()).toEqual(['ALREADY_INVITED', 'SENT']);
    expect(await invitesOf(known.userId)).toHaveLength(1);
  });

  it.each(['accept', 'remove'] as const)('%s waits for the same grant lock as issuance and revocation', async action => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone, 'MANAGER');
    const [invite] = await waitForInvites(known.userId, 1);
    const member = action === 'remove'
      ? await app.prisma.vendorStaff.create({ data: { vendorId, userId: known.userId, role: 'STAFF', invitedBy: owner.userId } })
      : null;
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const key = JSON.stringify(['staff-invite-grant', vendorId, known.userId]);
    const holding = app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      acquired(); await held;
    }, { timeout: 10000 });
    await ready;
    let finished = false;
    const answer = (action === 'accept'
      ? inject('POST', `/api/v1/customer/team-invites/${invite!.id}/accept`, known.token)
      : inject('DELETE', `/api/v1/vendor/staff/${member!.id}`, owner.token))
      .then(result => { finished = true; return result; });
    let finishedWhileHeld: boolean;
    try { await new Promise(resolve => setTimeout(resolve, 150)); finishedWhileHeld = finished; }
    finally { release(); await holding; }
    const response = await answer;
    expect(response.statusCode, response.body).toBe(200);
    expect(finishedWhileHeld, 'grant/revocation must wait for the shared store/person lock').toBe(false);
    expect(Boolean(await memberOf(known.userId))).toBe(action === 'accept');
  });

  it('accepting one legacy duplicate retires the others, so a removed worker cannot regain MANAGER access', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone, 'MANAGER');
    const [first] = await waitForInvites(known.userId, 1);
    const duplicate = await app.prisma.notification.create({ data: {
      userId: known.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Synthetic duplicate', body: 'Fixture only', data: first!.data!,
    } });
    expect((await inject('POST', `/api/v1/customer/team-invites/${first!.id}/accept`, known.token)).statusCode).toBe(200);
    const member = await memberOf(known.userId);
    expect(member?.role).toBe('MANAGER');
    expect(((await app.prisma.notification.findUniqueOrThrow({ where: { id: duplicate.id } })).data as { state: string }).state).toBe('CLOSED');
    expect((await inject('DELETE', `/api/v1/vendor/staff/${member!.id}`, owner.token)).statusCode).toBe(200);
    const rejoin = await inject('POST', `/api/v1/customer/team-invites/${duplicate.id}/accept`, known.token);
    expect(rejoin.statusCode).toBe(409);
    expect(await memberOf(known.userId)).toBeNull();
    expect((await inject('GET', '/api/v1/vendor/stores', known.token)).statusCode).toBe(403);
    expect((await inject('GET', '/api/v1/customer/team-invites', known.token)).json().data).toEqual([]);
  });

  it('removal closes all outstanding legacy grants in the same transaction as deleting membership', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone, 'MANAGER');
    const [invite] = await waitForInvites(known.userId, 1);
    const member = await app.prisma.vendorStaff.create({ data: { vendorId, userId: known.userId, role: 'STAFF', invitedBy: owner.userId } });
    expect((await inject('DELETE', `/api/v1/vendor/staff/${member.id}`, owner.token)).statusCode).toBe(200);
    const row = await app.prisma.notification.findUniqueOrThrow({ where: { id: invite!.id } });
    expect((row.data as { state: string }).state).toBe('CLOSED');
    expect((await inject('POST', `/api/v1/customer/team-invites/${invite!.id}/accept`, known.token)).statusCode).toBe(409);
    expect(await memberOf(known.userId)).toBeNull();
  });
});

describe('invitation authority survives delayed work and account closure', () => {
  it('a delivery started before removal cannot create a fresh grant after removal', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone, 'MANAGER');
    const [first] = await waitForInvites(known.userId, 1);
    let release!: () => void;
    let paused!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { paused = resolve; });
    const delayedPrisma = new Proxy(app.prisma, {
      get(target, key, receiver) {
        if (key === '$transaction') return async (...args: unknown[]) => {
          paused(); await held;
          return Reflect.apply(target.$transaction, target, args);
        };
        return Reflect.get(target, key, receiver);
      },
    });
    const stale = deliverStaffInvite(delayedPrisma, new NotificationService(app.prisma, app.io), {
      vendorId, targetUserId: known.userId, role: 'MANAGER', inviterId: owner.userId, now: new Date(), revocationVersion: 0,
    });
    await ready;
    let result: Awaited<typeof stale>;
    try {
      expect((await inject('POST', `/api/v1/customer/team-invites/${first!.id}/accept`, known.token)).statusCode).toBe(200);
      const member = await memberOf(known.userId);
      expect(member?.role).toBe('MANAGER');
      expect((await inject('DELETE', `/api/v1/vendor/staff/${member!.id}`, owner.token)).statusCode).toBe(200);
      expect(await memberOf(known.userId)).toBeNull();
    } finally { release(); result = await stale; }
    const pending = (await invitesOf(known.userId)).filter(row => (row.data as { state: string }).state === 'PENDING');
    if (pending[0]) await inject('POST', `/api/v1/customer/team-invites/${pending[0].id}/accept`, known.token);
    expect(await memberOf(known.userId), 'a stale delivery cannot restore removed access').toBeNull();
    expect(pending, 'no unfinished pre-removal request may create another invitation').toEqual([]);
    expect(result).toBe('NOT_INVITABLE');
    expect(await memberOf(known.userId)).toBeNull();
    // A deliberate new owner request after removal still works.
    expect((await add(known.phone, 'STAFF')).statusCode).toBe(200);
    const fresh = (await waitForInvites(known.userId, 2)).find(row => (row.data as { state: string }).state === 'PENDING');
    expect(fresh).toBeDefined();
    expect((await inject('POST', `/api/v1/customer/team-invites/${fresh!.id}/accept`, known.token)).statusCode).toBe(200);
    expect((await memberOf(known.userId))?.role).toBe('STAFF');
  });

  it.each(['accept', 'deliver'] as const)('%s waits for the account cutoff transaction and then refuses the grant', async action => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone, 'MANAGER');
    const [invite] = await waitForInvites(known.userId, 1);
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const cutoff = app.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${owner.userId} FOR UPDATE`;
      await tx.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } });
      acquired(); await held;
    }, { timeout: 10000 });
    await ready;
    let finished = false;
    const grant = (action === 'accept'
      ? inject('POST', `/api/v1/customer/team-invites/${invite!.id}/accept`, known.token)
      : deliverStaffInvite(app.prisma, new NotificationService(app.prisma, app.io), {
        vendorId, targetUserId: known.userId, role: 'MANAGER', inviterId: owner.userId, now: new Date(), revocationVersion: 0,
      })).then(result => { finished = true; return result; });
    let whileHeld = false;
    try { await new Promise(resolve => setTimeout(resolve, 150)); whileHeld = finished; }
    finally { release(); await cutoff; }
    try {
      const result = await grant;
      expect(whileHeld, 'grant must wait for the same account lock as deletion').toBe(false);
      expect(typeof result === 'string' ? result : result.statusCode).toBe(action === 'accept' ? 409 : 'NOT_INVITABLE');
      expect(await memberOf(known.userId)).toBeNull();
    } finally { await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'ACTIVE' } }); }
  });

  it.each(['owner-deactivated', 'store-wound-down'] as const)('%s cuts off both outstanding acceptance and unfinished issuance', async cutoff => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const known = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const later = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(known.phone, 'MANAGER');
    const [invite] = await waitForInvites(known.userId, 1);
    try {
      if (cutoff === 'owner-deactivated') await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } });
      else await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'SUSPENDED', suspensionSource: 'WIND_DOWN' } });
      const accepted = await inject('POST', `/api/v1/customer/team-invites/${invite!.id}/accept`, known.token);
      const issued = await deliverStaffInvite(app.prisma, new NotificationService(app.prisma, app.io), {
        vendorId, targetUserId: later.userId, role: 'MANAGER', inviterId: owner.userId, now: new Date(), revocationVersion: 0,
      });
      expect(accepted.statusCode, 'retained owner identity does not retain grant authority').toBe(409);
      expect(await memberOf(known.userId)).toBeNull();
      expect(((await app.prisma.notification.findUniqueOrThrow({ where: { id: invite!.id } })).data as { state: string }).state).toBe('CLOSED');
      expect(issued).toBe('NOT_INVITABLE');
      expect(await invitesOf(later.userId)).toEqual([]);
    } finally {
      await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'ACTIVE' } });
      await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'ACTIVE', suspensionSource: null } });
    }
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
