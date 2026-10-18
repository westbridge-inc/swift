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
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { grantStepUp } from './helpers/step-up';
import { STAFF_INVITE_KIND, deliverStaffInvite, staffInviteRevocationVersion } from '../modules/vendor/staff-invites';
import { NotificationService } from '../modules/notification/notification.service';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// Row 55 follow-up (switch ON). Nothing pending is listed to the owner, which
// keeps the invite private, but an owner who typed one digit wrong could not
// take the invite back, and was not told when someone accepted. Now:
//  - the owner can withdraw every unanswered invite from the store at once.
//    The reply is the same whether there were none or many, so it never says
//    how many of the typed numbers are Swift accounts. A delivery requested
//    before the withdraw cannot land after it.
//  - when someone accepts, the owner gets a notice with their first name.
//    Identity reaches the owner only after the person has said yes.
// Fixture range: +59249nnnnn (this file only).
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
const vendorOwnerIds: string[] = [];
let owner: { userId: string; token: string; phone: string };
let vendorId: string;
let storeName: string;

const phone = () => testPhone();

async function makeUser(roles: UserRole[], activeRole: UserRole, firstName = 'Invitee') {
  const user = await app.prisma.user.create({
    data: {
      phone: phone(), firstName, lastName: `Person${userIds.length}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/invitee.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'l05-withdraw', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token, phone: user.phone };
}

async function makeStore(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  vendorOwnerIds.push(vo.id);
  const name = `Withdraw Bistro ${wordFreeTag(4)}`;
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `withdraw-bistro-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: phone(), addressLine1: '9 Crew Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  return { vendorId: vendor.id, name };
}

function inject(method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: Record<string, unknown>) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload } : {}),
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
  });
}

const add = (number: string, token = owner.token) => inject('POST', '/api/v1/vendor/staff', token, { phone: number, role: 'STAFF' });
const withdraw = (token = owner.token) => inject('POST', '/api/v1/vendor/staff/invites/withdraw', token);
const accept = (inviteId: string, token: string) => inject('POST', `/api/v1/customer/team-invites/${inviteId}/accept`, token);
const memberOf = (userId: string, store = vendorId) => app.prisma.vendorStaff.findUnique({ where: { vendorId_userId: { vendorId: store, userId } } });
const invitesOf = (userId: string) => app.prisma.notification.findMany({
  where: { userId, data: { path: ['kind'], equals: STAFF_INVITE_KIND } }, orderBy: { createdAt: 'asc' },
});
const stateOf = (row: { data: unknown }) => (row.data as { state: string }).state;
const ownerNotices = (userId = owner.userId) => app.prisma.notification.findMany({
  where: { userId, data: { path: ['kind'], equals: 'staff_joined' } },
});

async function waitForInvites(userId: string, count: number) {
  for (let i = 0; i < 50; i += 1) {
    const rows = await invitesOf(userId);
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return invitesOf(userId);
}
const settle = () => new Promise((r) => setTimeout(r, 400));

/** Hold one advisory lock in its own transaction until released. */
async function holdLock(key: string, shared: boolean) {
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const holding = app.prisma.$transaction(async (tx) => {
    if (shared) await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    acquired(); await held;
  }, { timeout: 10000 });
  await ready;
  return async () => { release(); await holding; };
}

beforeAll(async () => {
  // One owner makes more than ten adds here to exercise invites; the daily
  // add cap (STAFF_ADD_DAILY_CAP) has its own suite.
  process.env['STAFF_ADD_DAILY_CAP'] = '1000';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER', 'Owner');
  await grantStepUp(app, owner.token);
  ({ vendorId, name: storeName } = await makeStore(owner.userId));
});

afterEach(() => { delete process.env['STAFF_INVITE_ACCEPT']; });

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
  delete process.env['STAFF_ADD_DAILY_CAP'];
});

describe('[row 55] the owner withdraws every unanswered invite', () => {
  it('closes all of this store\'s pending invites; a withdrawn invite cannot be accepted and grants nothing', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const a = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const b = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(a.phone);
    await add(b.phone);
    await add(phone());
    const [inviteA] = await waitForInvites(a.userId, 1);
    await waitForInvites(b.userId, 1);

    const response = await withdraw();
    expect(response.statusCode, response.body).toBe(200);
    for (const person of [a, b]) {
      expect((await invitesOf(person.userId)).map(stateOf)).toEqual(['CLOSED']);
    }
    expect((await inject('GET', '/api/v1/customer/team-invites', a.token)).json().data).toEqual([]);
    const late = await accept(inviteA!.id, a.token);
    expect(late.statusCode).toBe(409);
    expect(await memberOf(a.userId)).toBeNull();
    expect(await memberOf(b.userId)).toBeNull();
  });

  it('answers the same whether nothing or several invites were pending, so it never counts accounts', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const empty = await withdraw();
    const a = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const b = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(a.phone);
    await add(b.phone);
    await waitForInvites(a.userId, 1);
    await waitForInvites(b.userId, 1);
    const several = await withdraw();
    expect(empty.statusCode).toBe(200);
    expect(several.body).toBe(empty.body);
    expect(several.body).not.toMatch(/\d/);
  });

  it('touches only this store: another store\'s invite to the same person stays open', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const otherOwner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER', 'Other');
    await grantStepUp(app, otherOwner.token);
    await makeStore(otherOwner.userId);
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(person.phone);
    await add(person.phone, otherOwner.token);
    await waitForInvites(person.userId, 2);
    expect((await withdraw()).statusCode).toBe(200);
    const states = (await invitesOf(person.userId)).map((row) => [(row.data as { vendorId: string }).vendorId === vendorId, stateOf(row)]);
    expect(states.sort()).toEqual([[false, 'PENDING'], [true, 'CLOSED']]);
  });

  it('only the store owner can withdraw', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const manager = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } });
    const stranger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(person.phone);
    await waitForInvites(person.userId, 1);
    expect((await inject('POST', '/api/v1/vendor/staff/invites/withdraw', manager.token)).statusCode).toBe(403);
    expect((await inject('POST', '/api/v1/vendor/staff/invites/withdraw', stranger.token)).statusCode).toBe(403);
    expect((await invitesOf(person.userId)).map(stateOf)).toEqual(['PENDING']);
    await withdraw();
  });

  it('a delivery requested before the withdraw cannot create an invite after it', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const captured = await staffInviteRevocationVersion(app.prisma, vendorId, person.userId);
    let release!: () => void;
    let paused!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { paused = resolve; });
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
      vendorId, targetUserId: person.userId, role: 'STAFF', inviterId: owner.userId, now: new Date(), revocationVersion: captured,
    });
    await ready;
    let result: Awaited<typeof stale>;
    try {
      expect((await withdraw()).statusCode).toBe(200);
    } finally { release(); result = await stale; }
    expect(result).toBe('NOT_INVITABLE');
    expect(await invitesOf(person.userId)).toEqual([]);

    // A deliberate add after the withdraw still works.
    expect((await add(person.phone)).statusCode).toBe(200);
    expect((await waitForInvites(person.userId, 1)).map(stateOf)).toEqual(['PENDING']);
    await withdraw();
  });

  it('a delivery waits while a withdraw holds the store; a withdraw waits for a delivery in flight', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const storeKey = JSON.stringify(['staff-invite-store', vendorId]);

    // (1) The withdraw's side (exclusive) held: a delivery cannot write meanwhile.
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const version = await staffInviteRevocationVersion(app.prisma, vendorId, person.userId);
    const releaseExclusive = await holdLock(storeKey, false);
    const delivery = deliverStaffInvite(app.prisma, new NotificationService(app.prisma, app.io), {
      vendorId, targetUserId: person.userId, role: 'STAFF', inviterId: owner.userId, now: new Date(), revocationVersion: version,
    });
    let whileHeld: Awaited<ReturnType<typeof invitesOf>>;
    try { await new Promise((r) => setTimeout(r, 150)); whileHeld = await invitesOf(person.userId); }
    finally { await releaseExclusive(); }
    expect(whileHeld, 'a delivery must wait for the store lock a withdraw holds').toEqual([]);
    expect(await delivery).toBe('SENT');

    // (2) A delivery's side (shared) held: the withdraw waits, then closes what was written.
    const releaseShared = await holdLock(storeKey, true);
    let finished = false;
    const pending = withdraw().then((r) => { finished = true; return r; });
    let finishedWhileHeld: boolean;
    try { await new Promise((r) => setTimeout(r, 150)); finishedWhileHeld = finished; }
    finally { await releaseShared(); }
    expect((await pending).statusCode).toBe(200);
    expect(finishedWhileHeld, 'a withdraw must wait for a delivery in flight').toBe(false);
    expect((await invitesOf(person.userId)).map(stateOf)).toEqual(['CLOSED']);
  });

  it('the withdraw waits for the person\'s grant lock, the one Accept holds, before closing their invite', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(person.phone);
    await waitForInvites(person.userId, 1);
    const releaseGrant = await holdLock(JSON.stringify(['staff-invite-grant', vendorId, person.userId]), false);
    let finished = false;
    const pending = withdraw().then((r) => { finished = true; return r; });
    let finishedWhileHeld: boolean;
    let stateWhileHeld: string;
    try {
      await new Promise((r) => setTimeout(r, 150));
      finishedWhileHeld = finished;
      stateWhileHeld = stateOf((await invitesOf(person.userId))[0]!);
    } finally { await releaseGrant(); }
    expect((await pending).statusCode).toBe(200);
    expect(finishedWhileHeld, 'a withdraw must not close an invite while Accept holds its grant lock').toBe(false);
    expect(stateWhileHeld).toBe('PENDING');
    expect((await invitesOf(person.userId)).map(stateOf)).toEqual(['CLOSED']);
  });

  it('Accept racing the withdraw has one winner, and membership matches the invite', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await add(person.phone);
    const [invite] = await waitForInvites(person.userId, 1);
    const [accepted, withdrawn] = await Promise.all([accept(invite!.id, person.token), withdraw()]);
    expect(withdrawn.statusCode).toBe(200);
    const state = stateOf((await invitesOf(person.userId))[0]!);
    if (accepted.statusCode === 200) expect(state).toBe('ACCEPTED');
    else { expect(accepted.statusCode).toBe(409); expect(state).toBe('CLOSED'); }
    expect(Boolean(await memberOf(person.userId))).toBe(state === 'ACCEPTED');
  });
});

describe('[row 55] the owner hears when someone accepts', () => {
  it('accepting tells the owner, by first name, after the person said yes, and not before', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const before = (await ownerNotices()).length;
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER', 'Asha');
    await add(person.phone);
    const [invite] = await waitForInvites(person.userId, 1);
    await settle();
    expect(await ownerNotices(), 'nothing reaches the owner while the invite is unanswered').toHaveLength(before);

    expect((await accept(invite!.id, person.token)).statusCode).toBe(200);
    const notices = await ownerNotices();
    expect(notices).toHaveLength(before + 1);
    const notice = notices.find((n) => n.body.includes('Asha'))!;
    expect(notice.body).toBe(`Asha joined ${storeName} as staff.`);
    expect(notice.data).toMatchObject({ kind: 'staff_joined', vendorId });
    expect(JSON.stringify(notice)).not.toContain(person.phone);
    expect(JSON.stringify(notice)).not.toContain('Person');
  });

  it('declining tells the owner nothing', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    const before = (await ownerNotices()).length;
    const person = await makeUser(['CUSTOMER'], 'CUSTOMER', 'Ravi');
    await add(person.phone);
    const [invite] = await waitForInvites(person.userId, 1);
    expect((await inject('POST', `/api/v1/customer/team-invites/${invite!.id}/decline`, person.token)).statusCode).toBe(200);
    await settle();
    expect(await ownerNotices()).toHaveLength(before);
  });
});
