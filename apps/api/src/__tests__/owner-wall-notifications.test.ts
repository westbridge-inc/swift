/**
 * [item 20 · owner wall] The in-app inbox (notifications) is walled to its
 * person (migration 20261018222000_owner_wall_notifications), like addresses
 * and push registrations — but a notice is almost always written FOR SOMEONE
 * ELSE, so the wall splits by command: only the person reads, updates or
 * deletes a notice (owner_isolation*), anyone may hand one over (notice_write,
 * INSERT WITH CHECK (true)). Measured through the app's own client on a
 * per-suite walled request login that is a swift_owner_wall member,
 * OWNER_RLS_BIND=1, system work on its bypass-member login:
 *  - fail closed: unbound, a job bound to a tenant only, and another person's
 *    request see none of a person's notices; the person sees their own inbox;
 *  - a notice sent from SOMEONE ELSE's request lands, and its push reaches the
 *    recipient (the one notice helper: no INSERT ... RETURNING; the fan-out
 *    reads it through the named capability);
 *  - inside a transaction bound to someone else: a store's invite reaches the
 *    invitee once (the already-invited check is a narrow SECURITY DEFINER
 *    action), the owner's withdrawal closes the invitee's invites, an
 *    idempotent write finds the notice already there;
 *  - a once-a-day notice from a customer's checkout is still sent once;
 *  - GOLDEN: every converted call-site class writes, with the wall ON, the row
 *    it wrote with the wall OFF (the call it replaced), field by field except
 *    id and time — and an id of the same cuid shape;
 *  - the actions are executable by their owner and swift_app only, pin their
 *    search_path, qualify their table, and a census pins every caller and
 *    every notice accessor in the app;
 *  - the person binding is transaction-local (REVIEW-G S4-1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { testPrismaClient } from './helpers/test-prisma-client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone } from './helpers/fixture-ids';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';
import { OWNER_WALL_DEVICE_ACTIONS, readOwnerWallFacts } from '../lib/owner-rls';
import {
  OWNER_WALL_NOTICE_ACTIONS, insertNoticeFor, noticeId, pendingStaffInvitesOf, publicPhoneAsked, staffInviteesOf, upsertNoticeFor,
} from '../lib/owner-wall-notices';
import { STAFF_INVITE_KIND } from '../modules/vendor/staff-invites';
import { NEEDS_PUBLIC_PHONE_KIND } from '../modules/vendor/go-live';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, and grants the owner wall to one, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'OWNER_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const DAY = 86_400_000;
const CUID = /^c[0-9a-z]{24}$/;
const EXPIRES = new Date(Date.now() + DAY).toISOString();

type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let tenant: TenantModule;
let prismaModule: typeof import('../plugins/prisma');

const ids = { target: '', other: '', storeOwner: '', invitee: '', vendor: '', vendorOwner: '', goldOff: '', goldOn: '' };
const tokens = { target: '', other: '' };
const users: string[] = [];
const pushed: string[] = [];
const channels = {
  push: { sendPush: async (to: string[]) => { pushed.push(...to); return { sent: to.length, invalidTokens: [] }; } },
  sms: { sendSms: async () => ({ sent: true }) },
  email: { sendEmail: async () => ({ sent: true }) },
};
const silentIo = { to: () => ({ emit: () => true }) };

async function sessionFor(userId: string, role: string): Promise<string> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await owner.session.create({ data: {
    userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `own-${RUN}-${userId.slice(-6)}`, deviceType: 'test',
    expiresAt: new Date(Date.now() + DAY),
  } });
  return token;
}
const mkUser = async (roles: string[], activeRole: string) => {
  const id = (await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Notice', lastName: `Wall${RUN}`, roles: roles as never, activeRole: activeRole as never,
    isPhoneVerified: true, tenantId: PRODUCTION,
  } })).id;
  users.push(id);
  return id;
};
const inbox = (userId: string) => owner.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
const invite = (userId: string, vendorId: string, extra: Record<string, unknown> = {}) => owner.notification.create({ data: {
  userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Team invite', body: `invite ${RUN}`,
  data: {
    kind: STAFF_INVITE_KIND, vendorId, storeName: `Wall Store ${RUN}`, role: 'STAFF', invitedBy: ids.storeOwner,
    expiresAt: EXPIRES, state: 'PENDING', audience: 'customer', ...extra,
  },
} });
/** Run `fn` with the switch as given, restoring it after (the golden writes both ways). */
async function withBind<T>(value: '0' | '1', fn: () => Promise<T>): Promise<T> {
  const prior = process.env['OWNER_RLS_BIND'];
  process.env['OWNER_RLS_BIND'] = value;
  try { return await fn(); } finally { process.env['OWNER_RLS_BIND'] = prior; }
}
/** A notice row without what differs by construction (id, time, whose inbox). */
const fields = (row: { userId: string; type: string; title: string; body: string; data: Prisma.JsonValue; isRead: boolean; readAt: Date | null; dedupeKey: string | null }) =>
  ({ type: row.type, title: row.title, body: row.body, data: row.data, isRead: row.isRead, readAt: row.readAt, dedupeKey: row.dedupeKey });

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  const requestRole = decodeURIComponent(new URL(logins.requestUrl).username);
  await owner.$executeRawUnsafe(`GRANT swift_owner_wall TO ${requestRole}`);

  ids.target = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.other = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.storeOwner = await mkUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  ids.invitee = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.goldOff = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.goldOn = await mkUser(['CUSTOMER'], 'CUSTOMER');
  ids.vendorOwner = (await owner.vendorOwner.create({ data: { userId: ids.storeOwner } })).id;
  ids.vendor = (await owner.vendor.create({ data: {
    ownerId: ids.vendorOwner, name: `Wall Store ${RUN}`, slug: `wall-store-${RUN}`, vendorType: 'RESTAURANT', tenantId: PRODUCTION,
    phone: testPhone(), addressLine1: '1 Wall Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } })).id;
  await owner.deviceToken.create({ data: { userId: ids.target, token: `ExponentPushToken[own-target-${RUN}]`, platform: 'ios' } });
  await owner.notification.create({ data: { userId: ids.target, type: 'ORDER_UPDATE', title: 'Mine', body: `target inbox ${RUN}` } });

  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['OWNER_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  tenant = await import('../plugins/tenant-context');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { customerRoutes } = await import('../modules/user/customer.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  tokens.target = await sessionFor(ids.target, 'CUSTOMER');
  tokens.other = await sessionFor(ids.other, 'CUSTOMER');
});

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    if (users.length) {
      await owner.notification.deleteMany({ where: { userId: { in: users } } });
      await owner.deviceToken.deleteMany({ where: { userId: { in: users } } });
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await purgeFixtureAuditTrail(owner, users, 'owner-wall-notifications');
      if (ids.vendor) await owner.vendor.deleteMany({ where: { id: ids.vendor } }).catch(() => undefined);
      if (ids.vendorOwner) await owner.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } }).catch(() => undefined);
      await owner.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
    }
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const call = (method: 'GET' | 'PUT', url: string, token: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
/** A flow bound the way a request is (awaited INSIDE the context: Prisma queries are lazy). */
const asPerson = <T>(userId: string, fn: () => PromiseLike<T>): Promise<T> =>
  tenant.tenantContext.run({ tenantId: PRODUCTION, mode: 'request', userId }, async () => await fn());
const notices = async () => {
  const { NotificationService } = await import('../modules/notification/notification.service');
  return new NotificationService(app.prisma, app.io, channels as never);
};

describe('[item 20] notifications: the owner wall fails closed', () => {
  it('unbound, a job bound to a tenant only, and another person see none of a person\'s notices; the person sees their own', async () => {
    const raw = testPrismaClient(logins!.requestUrl);
    try {
      expect(await raw.notification.count({ where: { userId: ids.target } })).toBe(0);
    } finally { await raw.$disconnect(); }
    expect(await tenant.runWithTenant(PRODUCTION, () => app.prisma.notification.count({ where: { userId: ids.target } }))).toBe(0);
    expect(await asPerson(ids.other, () => app.prisma.notification.count({ where: { userId: ids.target } }))).toBe(0);
    expect(await asPerson(ids.target, () => app.prisma.notification.count({ where: { userId: ids.target } }))).toBeGreaterThan(0);
    // Another person cannot read the notice even by id, nor mark it read.
    const mine = (await inbox(ids.target))[0]!;
    expect(await asPerson(ids.other, () => app.prisma.notification.findUnique({ where: { id: mine.id } }))).toBeNull();
    expect((await asPerson(ids.other, () => app.prisma.notification.updateMany({ where: { id: mine.id }, data: { isRead: true } }))).count).toBe(0);
    // The plain create Prisma issues (INSERT ... RETURNING) fails for someone else: why every notice goes through the helper.
    await expect(asPerson(ids.other, () => app.prisma.notification.create({ data: {
      userId: ids.target, type: 'ORDER_UPDATE', title: 'Returning', body: `returning ${RUN}`,
    } }))).rejects.toThrow();
    expect((await readOwnerWallFacts(app.prisma)).unwalledTables).toEqual([]);
  });

  it('the person\'s own inbox routes: list, unread count, mark read', async () => {
    const list = await call('GET', '/api/v1/customer/notifications', tokens.target);
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(`target inbox ${RUN}`);
    const theirs = await call('GET', '/api/v1/customer/notifications', tokens.other);
    expect(JSON.stringify(theirs.json())).not.toContain(`target inbox ${RUN}`);
    const mine = (await inbox(ids.target))[0]!;
    expect((await call('PUT', `/api/v1/customer/notifications/${mine.id}/read`, tokens.target)).statusCode).toBe(200);
    expect((await owner.notification.findUnique({ where: { id: mine.id } }))?.isRead).toBe(true);
  });
});

describe('[item 20] notifications written for someone else', () => {
  it('a notice sent from someone else\'s request lands in the recipient\'s inbox and its push reaches their phone', async () => {
    pushed.length = 0;
    const service = await notices();
    const id = await asPerson(ids.other, () => service.send({ userId: ids.target, type: 'ORDER_UPDATE', title: 'Wall', body: `sent by other ${RUN}` }));
    expect(id).toMatch(CUID);
    expect(await owner.notification.findUnique({ where: { id } })).toMatchObject({ userId: ids.target, body: `sent by other ${RUN}`, isRead: false });
    expect(pushed).toContain(`ExponentPushToken[own-target-${RUN}]`);
    // A retried send (same dedupe key) returns the first delivery and pushes nothing again.
    const key = `own-dedupe-${RUN}`;
    pushed.length = 0;
    const first = await asPerson(ids.other, () => service.send({ userId: ids.target, type: 'ORDER_UPDATE', title: 'Once', body: 'once', dedupeKey: key }));
    const again = await asPerson(ids.other, () => service.send({ userId: ids.target, type: 'ORDER_UPDATE', title: 'Once', body: 'once', dedupeKey: key }));
    expect(again).toBe(first);
    expect(pushed).toHaveLength(1);
  });

  it('a store\'s invite reaches the invitee once; the owner\'s withdrawal closes it; the invitee declines their own', async () => {
    const { deliverStaffInvite, staffInviteRevocationVersion, withdrawPendingStaffInvites, decideStaffInvite } = await import('../modules/vendor/staff-invites');
    const service = await notices();
    const send = async () => asPerson(ids.storeOwner, async () => deliverStaffInvite(app.prisma, service, {
      vendorId: ids.vendor, targetUserId: ids.invitee, role: 'STAFF', inviterId: ids.storeOwner, now: new Date(),
      revocationVersion: await staffInviteRevocationVersion(app.prisma, ids.vendor, ids.invitee),
    }));
    expect(await send()).toBe('SENT');
    expect(await send()).toBe('ALREADY_INVITED');
    const live = (await inbox(ids.invitee)).filter((n) => (n.data as { state?: string } | null)?.state === 'PENDING');
    expect(live).toHaveLength(1);
    await asPerson(ids.storeOwner, () => withdrawPendingStaffInvites(app.prisma, { vendorId: ids.vendor, actorId: ids.storeOwner, now: new Date() }));
    expect((await owner.notification.findUnique({ where: { id: live[0]!.id } }))).toMatchObject({ isRead: true, data: expect.objectContaining({ state: 'CLOSED' }) });
    // A fresh invite, declined by the invitee: their own row, their own transaction.
    expect(await send()).toBe('SENT');
    const fresh = (await inbox(ids.invitee)).find((n) => (n.data as { state?: string } | null)?.state === 'PENDING')!;
    expect(await asPerson(ids.invitee, () => decideStaffInvite(app.prisma, { inviteId: fresh.id, userId: ids.invitee, decision: 'DECLINE', now: new Date() })))
      .toMatchObject({ decision: 'DECLINED' });
  });

  it('an idempotent write inside someone else\'s transaction finds the notice already there', async () => {
    const byId = { id: `own_${RUN}_inbox`, userId: ids.target, type: 'ORDER_UPDATE' as const, title: 'Outbox', body: 'outbox', dedupeKey: `own-outbox-${RUN}` };
    const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => asPerson(ids.other, () => app.prisma.$transaction(fn));
    expect(await tx((t) => upsertNoticeFor(t, byId))).toEqual({ id: byId.id });
    expect(await tx((t) => upsertNoticeFor(t, { ...byId, title: 'Changed' }))).toEqual({ id: byId.id });
    expect(await owner.notification.findUnique({ where: { id: byId.id } })).toMatchObject({ title: 'Outbox', userId: ids.target });
    const byKey = { userId: ids.target, type: 'SYSTEM_ANNOUNCEMENT' as const, title: 'Fee', body: 'fee', dedupeKey: `own-fee-${RUN}` };
    const created = await tx((t) => upsertNoticeFor(t, byKey));
    expect(await tx((t) => upsertNoticeFor(t, byKey))).toEqual(created);
    expect(await owner.notification.count({ where: { userId: ids.target, dedupeKey: byKey.dedupeKey } })).toBe(1);
    // A different notice already holding the person's dedupe key fails the write, as the unique index failed the upsert.
    await expect(tx((t) => upsertNoticeFor(t, { ...byId, id: `own_${RUN}_other` }))).rejects.toMatchObject({ code: 'P2002' });
    // The go-live projection's once-per-store check sees the owner's notice from inside an admin's transaction.
    expect(await tx((t) => publicPhoneAsked(t, ids.storeOwner, ids.vendor))).toBe(false);
    await owner.notification.create({ data: { userId: ids.storeOwner, type: 'SYSTEM_ANNOUNCEMENT', title: 'Phone', body: 'phone', data: { kind: NEEDS_PUBLIC_PHONE_KIND, vendorId: ids.vendor } } });
    expect(await tx((t) => publicPhoneAsked(t, ids.storeOwner, ids.vendor))).toBe(true);
    expect(await tx((t) => t.notification.count({ where: { userId: ids.storeOwner } }))).toBe(0);
  });

  it('the go-live projection asks a store owner for a callable number once, from inside an admin\'s transaction', async () => {
    const { VerificationService } = await import('../modules/verification/verification.service');
    const { getKycProvider } = await import('../providers/kyc/kyc-provider');
    const svc = new VerificationService(app.prisma, await notices(), getKycProvider());
    // The projection's own step (private): it runs inside the projection transaction, whoever's flow opened it.
    const ask = (svc as unknown as { askForPublishedPhone(db: Prisma.TransactionClient, userId: string, vendor: { id: string; name: string }): Promise<void> }).askForPublishedPhone.bind(svc);
    const vendor = { id: `ask-${RUN}`, name: `Wall Store ${RUN}` };
    const asked = () => owner.notification.count({ where: { userId: ids.storeOwner, AND: [{ data: { path: ['kind'], equals: NEEDS_PUBLIC_PHONE_KIND } }, { data: { path: ['vendorId'], equals: vendor.id } }] } });
    await asPerson(ids.other, () => app.prisma.$transaction((tx) => ask(tx, ids.storeOwner, vendor)));
    expect(await asked()).toBe(1);
    await asPerson(ids.other, () => app.prisma.$transaction((tx) => ask(tx, ids.storeOwner, vendor)));
    expect(await asked()).toBe(1);
  });

  it('a once-a-day notice to a store owner, from a customer\'s checkout, is still sent once', async () => {
    const { tellOwnerHomeVisitsPaused } = await import('../modules/verification/home-visits');
    const service = await notices();
    expect(await asPerson(ids.target, () => tellOwnerHomeVisitsPaused(app.prisma, service, ids.storeOwner, `Wall Store ${RUN}`))).toBe(true);
    expect(await asPerson(ids.target, () => tellOwnerHomeVisitsPaused(app.prisma, service, ids.storeOwner, `Wall Store ${RUN}`))).toBe(false);
  });
});

describe('[item 20] GOLDEN: with the wall ON every converted call-site class writes the row it wrote OFF', () => {
  /** Write `make(userId)` OFF for goldOff and ON for goldOn on the owner connection; return both rows. */
  async function both(make: (userId: string) => Promise<{ id: string }>, givenTime = false) {
    const start = Date.now() - 1000;
    const off = await withBind('0', () => make(ids.goldOff));
    const on = await withBind('1', () => make(ids.goldOn));
    const rowOff = await owner.notification.findUniqueOrThrow({ where: { id: off.id } });
    const rowOn = await owner.notification.findUniqueOrThrow({ where: { id: on.id } });
    expect(rowOff.userId).toBe(ids.goldOff);
    expect(rowOn.userId).toBe(ids.goldOn);
    expect(fields(rowOn)).toEqual(fields(rowOff));
    // The database stamps the time (the same default both ways) unless the caller gave one.
    if (!givenTime) for (const row of [rowOff, rowOn]) expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(start);
    return { off, on, rowOff, rowOn };
  }

  it('a send (out of a transaction): the same row, an id of the same cuid shape', async () => {
    const { NotificationService } = await import('../modules/notification/notification.service');
    const service = new NotificationService(owner, silentIo as never, channels as never);
    const plain = await both(async (userId) => ({ id: await service.send({ userId, type: 'ORDER_UPDATE', title: 'Gold', body: `gold ${RUN}` }) }));
    expect(plain.rowOff.id).toMatch(CUID);
    expect(plain.rowOn.id).toMatch(CUID);
    expect(plain.rowOn.data).toBeNull();
    await both(async (userId) => ({ id: await service.send({ userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Gold', body: 'audience', audience: 'business', data: { kind: 'gold_probe', n: 1 }, dedupeKey: `gold-send-${RUN}` }) }));
    expect(noticeId()).toMatch(CUID);
  });

  it('a create inside a transaction (with data, a dedupe key, or an explicit time): the same row', async () => {
    await both((userId) => owner.$transaction((tx) => insertNoticeFor(tx, {
      userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Pin moved', body: 'pin', dedupeKey: `gold-tx-${RUN}`,
      data: { kind: 'gold_probe', orderId: 'o1', nested: { a: [1, 2] } },
    })));
    const at = new Date('2026-10-18T22:00:00.123Z');
    const timed = await both((userId) => owner.$transaction((tx) => insertNoticeFor(tx, { userId, type: 'SAFETY', title: 'Suspended', body: 'case', createdAt: at })), true);
    expect(timed.rowOff.createdAt.toISOString()).toBe(at.toISOString());
    expect(timed.rowOn.createdAt.toISOString()).toBe(at.toISOString());
    // The return is what callers use: the data plus the id.
    const ret = await withBind('1', () => insertNoticeFor(owner, { userId: ids.goldOn, type: 'ORDER_UPDATE', title: 'Ret', body: 'ret' }));
    expect(ret).toEqual({ userId: ids.goldOn, type: 'ORDER_UPDATE', title: 'Ret', body: 'ret', id: expect.stringMatching(CUID) });
  });

  it('a dedupe-key collision fails with P2002 both ways', async () => {
    for (const [bind, userId] of [['0', ids.goldOff], ['1', ids.goldOn]] as const) {
      const data = { userId, type: 'ORDER_UPDATE' as const, title: 'Dup', body: 'dup', dedupeKey: `gold-dup-${RUN}` };
      await withBind(bind, () => insertNoticeFor(owner, data));
      await expect(withBind(bind, () => insertNoticeFor(owner, data))).rejects.toMatchObject({ code: 'P2002' });
      await expect(withBind(bind, () => owner.$transaction((tx) => insertNoticeFor(tx, data)))).rejects.toMatchObject({ code: 'P2002' });
    }
  });

  it('an upsert by id (the inbox outboxes) and by dedupe key (the fee demand): the same row, the same id on a replay', async () => {
    const byId = await both((userId) => owner.$transaction((tx) => upsertNoticeFor(tx, {
      id: `gold_${userId.slice(-8)}_${RUN}_inbox`, userId, dedupeKey: `gold-byid-${RUN}`, type: 'ORDER_UPDATE', title: 'Delivered!', body: 'outbox',
      data: { orderId: 'o1', status: 'DELIVERED', audience: 'customer' },
    })));
    for (const [bind, row] of [['0', byId.rowOff], ['1', byId.rowOn]] as const) {
      const replay = await withBind(bind, () => owner.$transaction((tx) => upsertNoticeFor(tx, { id: row.id, userId: row.userId, dedupeKey: `gold-byid-${RUN}`, type: 'ORDER_UPDATE', title: 'Other', body: 'other' })));
      expect(replay).toEqual({ id: row.id });
      expect(fields(await owner.notification.findUniqueOrThrow({ where: { id: row.id } }))).toEqual(fields(row));
      await expect(withBind(bind, () => owner.$transaction((tx) => upsertNoticeFor(tx, { id: `${row.id}_x`, userId: row.userId, dedupeKey: `gold-byid-${RUN}`, type: 'ORDER_UPDATE', title: 'x', body: 'x' }))))
        .rejects.toMatchObject({ code: 'P2002' });
    }
    const byKey = await both((userId) => owner.$transaction((tx) => upsertNoticeFor(tx, {
      userId, dedupeKey: `gold-fee-${RUN}`, type: 'SYSTEM_ANNOUNCEMENT', title: 'Fee due', body: 'fee', data: { feeDemandId: 'f1', audience: 'business' },
    })));
    for (const [bind, row] of [['0', byKey.rowOff], ['1', byKey.rowOn]] as const) {
      expect(await withBind(bind, () => owner.$transaction((tx) => upsertNoticeFor(tx, { userId: row.userId, dedupeKey: `gold-fee-${RUN}`, type: 'SYSTEM_ANNOUNCEMENT', title: 'Again', body: 'again' })))).toEqual({ id: row.id });
    }
  });

  it('closing staff invites (acceptance, removal, withdrawal): the same rows, the excepted one untouched', async () => {
    const { closePendingStaffInvites } = await import('../modules/vendor/staff-invites');
    const now = new Date('2026-10-18T23:00:00.456Z');
    const seeded: Record<'0' | '1', string[]> = { '0': [], '1': [] };
    for (const [bind, userId] of [['0', ids.goldOff], ['1', ids.goldOn]] as const) {
      for (let i = 0; i < 3; i += 1) seeded[bind].push((await invite(userId, ids.vendor, { n: i })).id);
      seeded[bind].push((await invite(userId, `other-${RUN}`)).id);
      seeded[bind].push((await invite(userId, ids.vendor, { state: 'DECLINED' })).id);
      await withBind(bind, () => owner.$transaction((tx) => closePendingStaffInvites(tx, ids.vendor, userId, now, seeded[bind][0])));
    }
    for (let i = 0; i < 5; i += 1) {
      const off = await owner.notification.findUniqueOrThrow({ where: { id: seeded['0'][i]! } });
      const on = await owner.notification.findUniqueOrThrow({ where: { id: seeded['1'][i]! } });
      expect(fields(on), `row ${i}`).toEqual(fields(off));
    }
    const closed = await owner.notification.findUniqueOrThrow({ where: { id: seeded['1'][1]! } });
    expect(closed).toMatchObject({ isRead: true, readAt: now, data: expect.objectContaining({ state: 'CLOSED', decidedAt: now.toISOString(), n: 1 }) });
    expect((await owner.notification.findUniqueOrThrow({ where: { id: seeded['1'][0]! } })).isRead).toBe(false);
  });

  it('the in-transaction reads (pending invites, invitees, the public-phone ask) answer what the plain reads answered', async () => {
    const userId = ids.goldOn;
    const pending = await invite(userId, ids.vendor);
    await invite(userId, ids.vendor, { state: 'CLOSED' });
    const plain = await owner.notification.findMany({ where: { userId, AND: [
      { data: { path: ['kind'], equals: STAFF_INVITE_KIND } }, { data: { path: ['state'], equals: 'PENDING' } }, { data: { path: ['vendorId'], equals: ids.vendor } },
    ] }, select: { id: true, data: true } });
    const viaAction = await pendingStaffInvitesOf(owner, userId, ids.vendor);
    expect(viaAction.map((r) => r.id).sort()).toEqual(plain.map((r) => r.id).sort());
    expect(viaAction.find((r) => r.id === pending.id)?.data).toEqual(pending.data);
    const since = new Date(Date.now() - DAY);
    const plainInvitees = await owner.notification.findMany({ where: { createdAt: { gte: since }, AND: [
      { data: { path: ['kind'], equals: STAFF_INVITE_KIND } }, { data: { path: ['state'], equals: 'PENDING' } }, { data: { path: ['vendorId'], equals: ids.vendor } },
    ] }, select: { userId: true } });
    expect((await staffInviteesOf(owner, ids.vendor, since)).sort()).toEqual([...new Set(plainInvitees.map((r) => r.userId))].sort());
    expect(await publicPhoneAsked(owner, userId, ids.vendor)).toBe(false);
  });
});

describe('[item 20] notifications: the narrow actions and the census', () => {
  it('every owner-wall action is executable by its owner and swift_app only, pins its search_path and qualifies its table', async () => {
    const rows = await owner.$queryRaw<Array<{ name: string; secdef: boolean; config: string[] | null; grantees: string[]; owner: string; src: string }>>`
      SELECT p.proname::text AS name, p.prosecdef AS secdef, p.proconfig AS config, pg_get_userbyid(p.proowner)::text AS owner, p.prosrc AS src,
             ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
                     FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1) AS grantees
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       WHERE p.proname LIKE 'swift_owner_wall_%' ORDER BY 1`;
    expect(rows.map((r) => r.name).sort()).toEqual([...OWNER_WALL_DEVICE_ACTIONS, ...OWNER_WALL_NOTICE_ACTIONS].sort());
    for (const r of rows) {
      expect(r, r.name).toMatchObject({ secdef: true });
      expect(r.config, r.name).toContain('search_path=pg_catalog, public');
      expect([...r.grantees].sort(), r.name).toEqual([r.owner, 'swift_app'].sort());
      expect(r.src.match(/(?<![.\w])(notifications|device_tokens)\b/g), `${r.name} names its table unqualified`).toBeNull();
    }
  });

  it('every notice write goes through the helper, and every notice read or update is the person\'s own or names its capability', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(path); }
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(root);
    const HELPER = 'lib/owner-wall-notices.ts';
    const writes: string[] = [];
    const bulk: Record<string, number> = {};
    const helperCalls: Record<string, number> = {};
    const actionCalls: Record<string, number> = {};
    const plainReads: Record<string, number> = {};
    const rawSql: Record<string, number> = {};
    const relationCounts: Record<string, number> = {};
    const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };
    for (const path of files) {
      const rel = relative(root, path);
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(/\.\s*notification\s*\.\s*(create|upsert)\s*\(/g)) if (rel !== HELPER) writes.push(`${rel}: notification.${m[1]}`);
      for (let n = (text.match(/\.\s*notification\s*\.\s*createMany\s*\(/g) ?? []).length; n > 0; n -= 1) bump(bulk, rel);
      for (const m of text.matchAll(/\b(insertNoticeFor|upsertNoticeFor)\s*\(/g)) if (!/function\s+$/.test(text.slice(0, m.index))) bump(helperCalls, `${rel} ${m[1]}`);
      for (const m of text.matchAll(/\b(pendingStaffInvitesOf|closeStaffInvitesOf|staffInviteesOf|publicPhoneAsked)\s*\(/g)) {
        if (!/function\s+$/.test(text.slice(0, m.index))) bump(actionCalls, `${rel} ${m[1]}`);
      }
      if (rel !== HELPER && /swift_owner_wall_(notice_id|pending_staff_invites|close_staff_invites|staff_invitees|public_phone_asked)/.test(text)) writes.push(`${rel}: calls a notice action by name`);
      for (const m of text.matchAll(/\.\s*notification\s*\.\s*(findFirst|findFirstOrThrow|findMany|findUnique|findUniqueOrThrow|count|aggregate|groupBy|update|updateMany|delete|deleteMany)\s*\(/g)) {
        const before = text.slice(Math.max(0, m.index! - 200), m.index);
        if (!/(ownerWallSystem|runAsSystem)\(\s*'[^']+',\s*\(\)\s*=>\s*[\w.$]*$/.test(before)) bump(plainReads, rel);
      }
      for (let n = (text.match(/\b(FROM|INTO|UPDATE|JOIN)\s+"?notifications"?\b/g) ?? []).length; n > 0; n -= 1) bump(rawSql, rel);
      for (let n = (text.match(/\bnotifications\s*:\s*true\b/g) ?? []).length; n > 0; n -= 1) bump(relationCounts, rel);
    }
    expect(writes).toEqual([]);
    // INSERTs without RETURNING already (they pass notice_write as written).
    expect(bulk).toEqual({ [HELPER]: 2, 'modules/admin/admin.routes.ts': 1, 'modules/mover-revocation-outbox.ts': 1, 'modules/safety/incident.service.ts': 1 });
    expect(helperCalls).toEqual({
      'modules/auth/auth.service.ts insertNoticeFor': 1,
      'modules/billing/fee-demand-delivery.ts upsertNoticeFor': 1,
      'modules/cash/door-cash-hold.ts insertNoticeFor': 1,
      'modules/handover/handover-notice.ts upsertNoticeFor': 1,
      'modules/notification/notification.service.ts insertNoticeFor': 1,
      'modules/order/rider-cancel-notice.ts upsertNoticeFor': 1,
      'modules/rating/vendor-review-visibility.ts insertNoticeFor': 1,
      'modules/rides/driver-pickup.ts upsertNoticeFor': 1,
      'modules/safety/incident.service.ts insertNoticeFor': 1,
      'modules/services/service-job-transition.ts insertNoticeFor': 1,
      'modules/user/inactivity.ts insertNoticeFor': 1,
      'modules/vendor/staff-invites.ts insertNoticeFor': 2,
      'modules/vendor/store-pin-move.ts insertNoticeFor': 1,
      'modules/verification/verification.service.ts insertNoticeFor': 4,
    });
    // The narrow SECURITY DEFINER actions: these callers only, each holding the authorization.
    expect(actionCalls).toEqual({
      'modules/vendor/staff-invites.ts closeStaffInvitesOf': 1,
      'modules/vendor/staff-invites.ts pendingStaffInvitesOf': 1,
      'modules/vendor/staff-invites.ts staffInviteesOf': 1,
      'modules/verification/verification.service.ts publicPhoneAsked': 1,
    });
    // Plain accessors left: the person's own inbox (customer routes, the service's mark-read/count, the vendor's own alerts,
    // an invitee's own invite) and the wall-OFF branches of the in-transaction actions (staff invites x4, the public-phone ask).
    expect(plainReads).toEqual({
      'modules/notification/notification.service.ts': 3,
      'modules/user/customer.routes.ts': 3,
      'modules/vendor/staff-invites.ts': 8,
      'modules/vendor/vendor.routes.ts': 2,
      'modules/verification/verification.service.ts': 1,
    });
    // Raw SQL: the retention sweep (a system job) and the invitee's own invite lock.
    expect(rawSql).toEqual({ 'modules/compliance/retention.service.ts': 2, 'modules/vendor/staff-invites.ts': 1 });
    // The admin user detail's inbox count is recounted through its capability with the wall on.
    expect(relationCounts).toEqual({ 'modules/admin/admin.routes.ts': 1 });
  });
});

describe('[item 20 · S4-1] notifications: the person binding is transaction-local', () => {
  it('a pooled connection that served one person shows the next unbound query none of their notices', async () => {
    const one = prismaModule.createScopedProcessClient({ datasourceUrl: logins!.singleConnectionUrl });
    const count = (c: { notification: { count(a: { where: { userId: string } }): Promise<number> } }) => c.notification.count({ where: { userId: ids.target } });
    try {
      expect(await asPerson(ids.target, () => count(one))).toBeGreaterThan(0);
      expect(await count(one)).toBe(0);
      expect(await asPerson(ids.target, () => one.$transaction((tx) => count(tx)))).toBeGreaterThan(0);
      expect(await count(one)).toBe(0);
      expect((await asPerson(ids.target, () => one.$transaction([one.notification.count({ where: { userId: ids.target } })])))[0]).toBeGreaterThan(0);
      expect(await count(one)).toBe(0);
      expect(await tenant.runWithTenant(PRODUCTION, () => count(one))).toBe(0);
    } finally { await one.$disconnect(); }
  });
});
