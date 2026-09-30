import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { Prisma, type FulfillmentType, type UserRole, type UserStatus } from '@prisma/client';
import { Server as SocketIoServer, type Server, type Socket as ServerSocket } from 'socket.io';
import type Redis from 'ioredis';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { NotificationService, acknowledgeAlert, dedupedOpsAlertId } from '../modules/notification/notification.service';
import {
  LADDER,
  RUNG_SENDING_TTL_MS,
  ladderJobId,
  rungClaimKey,
  rungOf,
  runLadderJob,
  runLadderRung,
  markStoreAlertSeen,
  storeSmsNumber,
  type LadderDeps,
  type LadderRung,
} from '../modules/notification/store-alert-ladder';
import { storeAlertSubmission } from '../modules/notification/store-alert-authority';
import { persistCheckoutOutboxInTransaction } from '../modules/order/checkout-outbox';
import { isStoreRoomMember, storeAlertRecipients } from '../modules/notification/store-alert-recipients';
import {
  STORE_ROOM_EVICTION_BOUND_MS as STORE_ROOM_STRICT_BOUND_MS,
  STORE_ROOM_REVOKED,
  convergeStoreRooms,
  revokeStoreRoom,
  setStoreRoomCluster,
  storeRoomEpoch,
  storeRoomMemberKey,
  storeRoomTiming,
  subscribeToStoreRoom,
} from '../modules/notification/store-room';
import { autoCancelUnresponsiveOrder, type JobContext } from '../jobs/queue';
import { SmsNotSubmittedError, ExpoPushProvider, withPushRetry, devChannelLog, getChannels, type DevChannelEntry, type PushProvider } from '../providers/notifications/channels';
import { STORE_ALERT_SMS_DAILY_PREFIX, checkOtpDailyBudget } from '../utils/sms-budget';
import { guyanaDayKey } from '../utils/guyana-day';
import { storeAlertRungsCounter } from '../plugins/observability';

// The store-room membership rule runs for real; the mock only lets a test
// observe its calls and park one of them (the AX291 F03 interleaving).
vi.mock('../modules/notification/store-alert-recipients', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/notification/store-alert-recipients')>();
  return { ...real, isStoreRoomMember: vi.fn(real.isStoreRoomMember) };
});

// ---------------------------------------------------------------------------
// [Q10 loud alerts 2/4] THE STORE NEW-ORDER LADDER, end to end on the real
// routes, the real rows and what the provider boundary carried:
//
//  - the WHOLE store hears a new order (owner and every active team member of
//    THAT store), never another store and never another tenant; a member
//    removed from the team stops hearing it at the next rung;
//  - the ladder (+30 s, +60 s ring, +90 s text, +3 min operators) stops the
//    moment the order no longer waits (accept, reject, customer cancel,
//    auto-cancel), read at SEND time for every rung, including rungs already
//    queued and a status that flips between the first read and the provider
//    call (DS276 F1); each rung goes out once per order;
//  - a rung that reached nobody is recorded as such (DS276 F2);
//  - the text to the store has its own daily budget, separate from the login
//    OTP budget both ways;
//  - the operator page names the order and store and reaches only operators;
//  - alert-seen checks ownership BEFORE it records, and ends the ladder for
//    that one order;
//  - a push names an Android channel only to a device whose app reported it
//    has the channels (DeviceToken.alertsVersion >= 1);
//  - nothing rings inside the free-cancel hold, and a booking rings only while
//    its store is open.
//
// Fixture range: +5920418nnn (this file only; a grep of apps/, packages/ and
// scripts/ found no other use of 5920418; PR 1 used +5920417).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920418';
// [AX317 F03] The store-room re-validation interval of the instances that
// prove it (production default 30 s; the rest of this file keeps the default,
// so its removal tests prove the revocation itself), and [AX368 R3-01] the
// bound a member whose revocation never arrived is evicted within, from the
// removal's commit: one interval plus one read timeout, as the socket plugin
// derives them (storeRoomTiming cuts that instance's 4 s default read timeout
// to its interval).
const STORE_ROOM_RECHECK_MS = 1_000;
const STORE_ROOM_TIMING = storeRoomTiming(STORE_ROOM_RECHECK_MS, 4_000);
const STORE_ROOM_EVICTION_BOUND_MS = STORE_ROOM_TIMING.intervalMs + STORE_ROOM_TIMING.readTimeoutMs;
// A subscription read timeout the tests that hold a read open never reach.
const HELD_READ_TIMEOUT_MS = 60_000;
// [AX368 R3-01] How long the reviewer's stalled subscription read is held:
// past two passes and past the eviction bound.
const STORE_ROOM_STALL_MS = 2 * STORE_ROOM_RECHECK_MS + 1_000;
const OTHER_TENANT = `q10b-other-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;

let app: FastifyInstance;
let url: string;
let notifications: NotificationService;

type Emit = { room: string; event: string; payload: unknown };
const emitted: Emit[] = [];
const ioRecorder = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }),
  emit: () => {},
} as unknown as Server;

const deps = (overrides: Partial<LadderDeps> = {}): LadderDeps => ({
  prisma: app.prisma, io: ioRecorder, redis: app.redis, channels: getChannels(), ...overrides,
});

type Recorded = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };
function recordingQueue() {
  const jobs: Recorded[] = [];
  return { jobs, add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => { jobs.push({ name, data, opts }); } };
}

type Actor = { userId: string; phone: string; token: string };
let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; status?: UserStatus } = {}): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Ladder', lastName: `Rung${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `q10b-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, phone: user.phone, token };
}

async function makeStore(owner: Actor, name: string, phone = owner.phone): Promise<string> {
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name, slug: `q10b-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`,
      vendorType: 'RESTAURANT', phone,
      addressLine1: '5 Ladder Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  return vendor.id;
}

async function joinTeam(vendorId: string, member: Actor, invitedBy: Actor, role: 'STAFF' | 'MANAGER' = 'STAFF') {
  return app.prisma.vendorStaff.create({ data: { vendorId, userId: member.userId, role, invitedBy: invitedBy.userId } });
}

async function device(user: Actor, alertsVersion = 0): Promise<string> {
  const token = `ExponentPushToken[q10b${nanoid(14)}]`;
  await app.prisma.deviceToken.create({ data: { userId: user.userId, token, platform: 'android', alertsVersion } });
  return token;
}

let customer: Actor;

/** A PENDING order at `vendorId`, and (unless held or `alert: false`) the new-order alert the store gets at checkout. */
async function placeAndAlert(vendorId: string, opts: {
  fulfillment?: FulfillmentType; respondBy?: Date; alert?: boolean; holdExpiresAt?: Date; releasedToVendorAt?: Date; placedAt?: Date;
} = {}) {
  const respondBy = opts.respondBy ?? new Date(Date.now() + 10 * 60_000);
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `Q10B-${nanoid(8).replace(/[^a-zA-Z0-9]/g, '0')}`,
      orderType: 'FOOD_DELIVERY',
      customerId: customer.userId,
      vendorId,
      status: 'PENDING',
      fulfillment: opts.fulfillment ?? 'PICKUP',
      ...(opts.fulfillment === 'APPOINTMENT' ? { appointmentSlot: new Date(Date.now() + DAY) } : {}),
      ...(opts.holdExpiresAt ? { holdExpiresAt: opts.holdExpiresAt } : {}),
      ...(opts.releasedToVendorAt ? { releasedToVendorAt: opts.releasedToVendorAt } : {}),
      ...(opts.placedAt ? { placedAt: opts.placedAt } : {}),
      deliveryAddress: 'counter', deliveryLat: 6.81, deliveryLng: -58.16,
      pickupAddress: 'counter', pickupLat: 6.81, pickupLng: -58.16,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
      deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    },
  });
  if (opts.alert !== false && !opts.holdExpiresAt) {
    await notifications.newOrderForStore({ vendorId, orderId: order.id, orderNumber: order.orderNumber, itemCount: 1, total: 1500, respondBy });
  }
  return { orderId: order.id, orderNumber: order.orderNumber, respondBy };
}

const pushesTo = (token: string) => devChannelLog.filter((e) => e.channel === 'push' && e.to === token);
const stillWaitingPushesTo = (token: string, orderId: string) =>
  pushesTo(token).filter((e) => e.title === 'Order still waiting!' && (e.data as { orderId?: string } | undefined)?.orderId === orderId);
const smsTo = (phone: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);
const opsRowsFor = (userId: string, orderId: string) => app.prisma.notification.findMany({
  where: { userId, AND: [{ data: { path: ['kind'], equals: 'ops_order_unanswered' } }, { data: { path: ['orderId'], equals: orderId } }] },
});

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, token?: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url: path,
    ...(payload ? { payload } : {}),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
  });
}

async function rungCount(rung: LadderRung, outcome: string): Promise<number> {
  const metric = await storeAlertRungsCounter.get();
  return metric.values.find((v) => v.labels['rung'] === rung && v.labels['outcome'] === outcome)?.value ?? 0;
}

/** A Redis whose rung claim (the "sending" SET NX, the step between the
 *  first read and the provider call) runs `onClaim` right after claiming: the
 *  race DS276 F1 is about, injected, not pre-arranged. */
function redisRacingAtClaim(onClaim: () => Promise<void>): Redis {
  return new Proxy(app.redis, {
    get(target, prop) {
      if (prop === 'set') {
        return async (...args: Parameters<Redis['set']>) => {
          const result = await (target.set as (...a: unknown[]) => Promise<unknown>)(...args);
          if (String(args[0]).startsWith('store_ladder:') && String(args[1]).startsWith('sending:')) await onClaim();
          return result;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Redis;
}

const jobCtx = (): JobContext => ({ prisma: app.prisma, io: ioRecorder, redis: app.redis, log: app.log });

/** A real client socket for `token`, ready once the server's authority check has run. */
function socketFor(token: string, opened: Socket[], at = url): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = ioClient(at, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3000 });
    opened.push(socket);
    const timer = setTimeout(() => reject(new Error('socket did not become ready')), 7_500);
    socket.on('auth:ready', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}
const inRoom = async (room: string) => (await app.io.in(room).fetchSockets()).map((s) => s.id);
/** Every store-room membership verdict the server reached from call `from` on. */
async function membershipVerdictsFrom(from: number): Promise<Array<{ userId: string; verdict: boolean }>> {
  const mock = vi.mocked(isStoreRoomMember).mock;
  return Promise.all(mock.calls.slice(from).map(async (args, i) => ({ userId: args[2], verdict: await (mock.results[from + i]!.value as Promise<boolean>) })));
}

/** [AX317 F03] Start `instance` as an API instance of its own whose store-room
 *  re-validation runs every STORE_ROOM_RECHECK_MS; returns its URL. */
async function listenWithStoreRoomRecheck(instance: FastifyInstance): Promise<string> {
  const previous = process.env['SOCKET_STORE_ROOM_RECHECK_MS'];
  process.env['SOCKET_STORE_ROOM_RECHECK_MS'] = String(STORE_ROOM_RECHECK_MS);
  try {
    await instance.register(prismaPlugin);
    await instance.register(redisPlugin);
    await instance.register(authPlugin);
    await instance.register(socketPlugin);
    await instance.listen({ port: 0, host: '127.0.0.1' });
  } finally {
    if (previous === undefined) delete process.env['SOCKET_STORE_ROOM_RECHECK_MS'];
    else process.env['SOCKET_STORE_ROOM_RECHECK_MS'] = previous;
  }
  return `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;
}

/** Texts counted today against one store phone (a refund leaves 0, not nothing). */
const textsCounted = async (phone: string) =>
  Number((await app.redis.get(`${STORE_ALERT_SMS_DAILY_PREFIX}${guyanaDayKey(new Date())}:${phone}`)) ?? 0);

async function purgeRedisFor(orderIds: string[]) {
  const patterns = [
    ...orderIds.map((id) => `store_ladder:${id}:*`),
    `${STORE_ALERT_SMS_DAILY_PREFIX}*:${PHONE_PREFIX}*`,
    `otp_phone_day:*:${PHONE_PREFIX}*`,
  ];
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [next, keys] = await app.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = next;
      if (keys.length > 0) await app.redis.del(...keys);
    } while (cursor !== '0');
  }
}

/** Cleanup crosses tenants (the fixture has one of its own): run it with no
 *  tenant bound, or a context left by an earlier request scopes it away. */
async function purgeFixtures() {
  await runWithoutTenant(purgeFixturesUnbound);
}

/** [AX291 F07] The operator-page receipts THIS suite caused, and nothing
 *  else: one per (page, operator), derived exactly as notifyAdmins derives
 *  them from the page's dedupe key and the operator it reached (the inbox
 *  rows say who that was). Read before the inbox rows go. */
async function operatorReceiptIdsFor(orderIds: string[]): Promise<string[]> {
  if (orderIds.length === 0) return [];
  const pages = await app.prisma.$queryRaw<Array<{ userId: string; orderId: string }>>`
    SELECT "userId", "data"->>'orderId' AS "orderId" FROM "notifications"
    WHERE "data"->>'kind' = 'ops_order_unanswered' AND "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
  return pages.map((page) => dedupedOpsAlertId(`order-unanswered:${page.orderId}`, page.userId));
}

async function purgeOperatorReceipts(orderIds: string[]) {
  const ids = await operatorReceiptIdsFor(orderIds);
  if (ids.length > 0) await app.prisma.alertDelivery.deleteMany({ where: { kind: 'ADMIN_OPS', id: { in: ids } } });
}

async function purgeFixturesUnbound() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
  const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
  const orderIds = (await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }] },
    select: { id: true },
  })).map((o) => o.id);
  await purgeOperatorReceipts(orderIds);
  if (orderIds.length > 0) {
    // Operator pages reach platform operators outside this fixture: remove every row about these orders.
    await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
  }
  await app.prisma.alertDelivery.deleteMany({
    where: { OR: [{ subjectId: { in: orderIds.length ? orderIds : ['-'] } }, { recipientId: { in: ids.length ? ids : ['-'] } }] },
  });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.deviceToken.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendorStaff.deleteMany({ where: { OR: [{ userId: { in: ids } }, { vendorId: { in: vendorIds } }] } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  await app.prisma.tenant.deleteMany({ where: { id: { startsWith: 'q10b-other-' } } });
  await purgeRedisFor(orderIds);
}

// The cast: store A (owner, two staff, a manager, a suspended member, a member
// from another tenant), store B next door, operators in and out of the tenant.
let ownerA: Actor;
let staffA1: Actor;
let managerA: Actor;
let suspendedA: Actor;
let foreignA: Actor;
let ownerB: Actor;
let staffB: Actor;
let adminA: Actor;
let adminOther: Actor;
let superAdmin: Actor;
let storeA: string;
let storeB: string;
let ownerA0: string; // ownerA's device on today's build (alertsVersion 0)
let ownerA1: string; // ownerA's device on the channel build (alertsVersion 1)
let staffA1Device: string;
let managerADevice: string;
let suspendedADevice: string;
let foreignADevice: string;
let ownerBDevice: string;
let staffBDevice: string;

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
  // Socket.IO needs a real listening server; inject() keeps working beside it.
  await app.listen({ port: 0, host: '127.0.0.1' });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  notifications = new NotificationService(app.prisma, ioRecorder);
  await purgeFixtures();

  await app.prisma.tenant.create({ data: { id: OTHER_TENANT, name: 'Q10 Other Operator', slug: OTHER_TENANT } });
  ownerA = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  staffA1 = await makeUser(['CUSTOMER'], 'CUSTOMER');
  managerA = await makeUser(['CUSTOMER'], 'CUSTOMER');
  suspendedA = await makeUser(['CUSTOMER'], 'CUSTOMER', { status: 'SUSPENDED' });
  foreignA = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER', { tenantId: OTHER_TENANT });
  ownerB = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  staffB = await makeUser(['CUSTOMER'], 'CUSTOMER');
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  adminA = await makeUser(['ADMIN'], 'ADMIN');
  adminOther = await makeUser(['ADMIN'], 'ADMIN', { tenantId: OTHER_TENANT });
  superAdmin = await makeUser(['SUPER_ADMIN'], 'SUPER_ADMIN', { tenantId: OTHER_TENANT });

  storeA = await makeStore(ownerA, 'Ladder Kitchen');
  storeB = await makeStore(ownerB, 'Next Door Kitchen');
  await joinTeam(storeA, staffA1, ownerA);
  await joinTeam(storeA, managerA, ownerA, 'MANAGER');
  await joinTeam(storeA, suspendedA, ownerA);
  // A team row pointing across tenants (no route writes one; the data can).
  await joinTeam(storeA, foreignA, ownerA);
  await joinTeam(storeB, staffB, ownerB);

  ownerA0 = await device(ownerA, 0);
  ownerA1 = await device(ownerA, 1);
  staffA1Device = await device(staffA1);
  managerADevice = await device(managerA);
  suspendedADevice = await device(suspendedA);
  foreignADevice = await device(foreignA);
  ownerBDevice = await device(ownerB);
  staffBDevice = await device(staffB);
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

// ---------------------------------------------------------------------------
describe('the whole store hears a new order, and only that store', () => {
  it('owner and every active member of THAT store get the alert; another store, another tenant and a suspended member get nothing', async () => {
    const o = await placeAndAlert(storeA);
    const alerted = await app.prisma.notification.findMany({
      where: { AND: [{ data: { path: ['kind'], equals: 'vendor_order_alert' } }, { data: { path: ['orderId'], equals: o.orderId } }] },
      select: { userId: true, title: true, data: true },
    });
    expect(alerted.map((row) => row.userId).sort()).toEqual([ownerA.userId, staffA1.userId, managerA.userId].sort());
    for (const row of alerted) {
      expect(row.title).toBe('New Order!');
      expect(row.data).toMatchObject({ kind: 'vendor_order_alert', orderId: o.orderId, audience: 'business' });
    }
    const receipts = await app.prisma.alertDelivery.findMany({ where: { kind: 'VENDOR_ORDER', subjectId: o.orderId }, select: { recipientId: true } });
    expect(receipts.map((r) => r.recipientId).sort()).toEqual([ownerA.userId, staffA1.userId, managerA.userId].sort());

    for (const token of [ownerA0, ownerA1, staffA1Device, managerADevice]) {
      expect(pushesTo(token).filter((e) => (e.data as { orderId?: string }).orderId === o.orderId).map((e) => e.title)).toEqual(['New Order!']);
    }
    for (const token of [suspendedADevice, foreignADevice, ownerBDevice, staffBDevice]) {
      expect(pushesTo(token).filter((e) => (e.data as { orderId?: string }).orderId === o.orderId)).toEqual([]);
    }

    // A staff member sees it in their own pending banner, like the owner.
    const pending = await call('GET', '/api/v1/vendor/alerts/pending', staffA1.token);
    expect(pending.statusCode, pending.body).toBe(200);
    expect((pending.json().data as Array<{ data: { orderId: string } }>).map((a) => a.data.orderId)).toContain(o.orderId);
  });

  it('a re-ring reaches the team as it is at send time, and never another store or tenant', async () => {
    const o = await placeAndAlert(storeA);
    expect(await runLadderRung(deps(), o.orderId, 'ring1')).toBe('realerted');
    for (const token of [ownerA0, ownerA1, staffA1Device, managerADevice]) {
      expect(stillWaitingPushesTo(token, o.orderId), token).toHaveLength(1);
    }
    for (const token of [suspendedADevice, foreignADevice, ownerBDevice, staffBDevice]) {
      expect(stillWaitingPushesTo(token, o.orderId), token).toEqual([]);
    }
    // The in-app re-alert goes to the same people.
    const rooms = emitted
      .filter((e) => e.event === 'vendor:order_alert' && (e.payload as { orderId?: string; reAlert?: boolean }).orderId === o.orderId && (e.payload as { reAlert?: boolean }).reAlert === true)
      .map((e) => e.room);
    expect(rooms.sort()).toEqual([`user:${ownerA.userId}`, `user:${staffA1.userId}`, `user:${managerA.userId}`].sort());
  });

  it('a member removed from the store stops getting the rungs at once', async () => {
    const leaver = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, leaver, ownerA);
    try {
      const leaverDevice = await device(leaver);
      const o = await placeAndAlert(storeA);
      expect(pushesTo(leaverDevice).map((e) => e.title)).toEqual(['New Order!']);
      expect(await runLadderRung(deps(), o.orderId, 'ring1')).toBe('realerted');
      expect(stillWaitingPushesTo(leaverDevice, o.orderId)).toHaveLength(1);

      const removed = await call('DELETE', `/api/v1/vendor/staff/${membership.id}`, ownerA.token);
      expect(removed.statusCode, removed.body).toBe(200);

      expect(await runLadderRung(deps(), o.orderId, 'ring2')).toBe('realerted');
      expect(stillWaitingPushesTo(leaverDevice, o.orderId)).toHaveLength(1); // nothing more
      expect(stillWaitingPushesTo(staffA1Device, o.orderId)).toHaveLength(2); // the team still is
    } finally {
      // Whatever failed above, the store team is left as the file set it up.
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('staff join the store live room, a stranger cannot, and a removed member is taken out of it', async () => {
    const sockets: Socket[] = [];
    const connect = (token: string) => socketFor(token, sockets);
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, member, ownerA);
    try {
      const memberSocket = await connect(member.token);
      const strangerSocket = await connect(ownerB.token);
      memberSocket.emit('vendor:subscribe', { vendorId: storeA });
      strangerSocket.emit('vendor:subscribe', { vendorId: storeA });
      strangerSocket.emit('vendor:subscribe', { vendorId: storeB });
      await vi.waitFor(async () => {
        const [a, b] = [await inRoom(`vendor:${storeA}`), await inRoom(`vendor:${storeB}`)];
        expect(a).toContain(memberSocket.id);
        expect(b).toContain(strangerSocket.id);
      }, { timeout: 5_000, interval: 50 });
      expect(await inRoom(`vendor:${storeA}`)).not.toContain(strangerSocket.id);

      const heard: string[] = [];
      memberSocket.on('order:new', (p: { orderId: string }) => heard.push(p.orderId));
      app.io.to(`vendor:${storeA}`).emit('order:new', { orderId: 'before-removal', vendorId: storeA });
      await vi.waitFor(() => expect(heard).toEqual(['before-removal']), { timeout: 5_000, interval: 25 });

      const removed = await call('DELETE', `/api/v1/vendor/staff/${membership.id}`, ownerA.token);
      expect(removed.statusCode, removed.body).toBe(200);
      await vi.waitFor(async () => expect(await inRoom(`vendor:${storeA}`)).not.toContain(memberSocket.id), { timeout: 5_000, interval: 50 });
      // A later new order reaches the room, and not the removed member.
      const ownerSocket = await connect(ownerA.token);
      ownerSocket.emit('vendor:subscribe', { vendorId: storeA });
      await vi.waitFor(async () => expect(await inRoom(`vendor:${storeA}`)).toContain(ownerSocket.id), { timeout: 5_000, interval: 50 });
      const ownerHeard: string[] = [];
      ownerSocket.on('order:new', (p: { orderId: string }) => ownerHeard.push(p.orderId));
      app.io.to(`vendor:${storeA}`).emit('order:new', { orderId: 'after-removal', vendorId: storeA });
      await vi.waitFor(() => expect(ownerHeard).toEqual(['after-removal']), { timeout: 5_000, interval: 25 });
      expect(heard).toEqual(['before-removal']);
    } finally {
      for (const socket of sockets) socket.disconnect();
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('a team row that points across tenants admits nobody to the store room (AX291 F02)', async () => {
    const sockets: Socket[] = [];
    try {
      const from = vi.mocked(isStoreRoomMember).mock.calls.length;
      const foreignSocket = await socketFor(foreignA.token, sockets);
      const ownerSocket = await socketFor(ownerA.token, sockets);
      foreignSocket.emit('vendor:subscribe', { vendorId: storeA });
      ownerSocket.emit('vendor:subscribe', { vendorId: storeA });
      await vi.waitFor(async () => expect(await inRoom(`vendor:${storeA}`)).toContain(ownerSocket.id), { timeout: 5_000, interval: 25 });
      await vi.waitFor(async () => {
        const verdicts = await membershipVerdictsFrom(from);
        expect(verdicts.filter((v) => v.userId === foreignA.userId)).toEqual([{ userId: foreignA.userId, verdict: false }]);
      }, { timeout: 5_000, interval: 25 });
      expect(await inRoom(`vendor:${storeA}`)).not.toContain(foreignSocket.id);

      const foreignHeard: string[] = [];
      const ownerHeard: string[] = [];
      foreignSocket.on('order:new', (p: { orderId: string }) => foreignHeard.push(p.orderId));
      ownerSocket.on('order:new', (p: { orderId: string }) => ownerHeard.push(p.orderId));
      app.io.to(`vendor:${storeA}`).emit('order:new', { orderId: 'q10b-tenant-wall', vendorId: storeA });
      await vi.waitFor(() => expect(ownerHeard).toEqual(['q10b-tenant-wall']), { timeout: 5_000, interval: 25 });
      expect(foreignHeard).toEqual([]);
    } finally {
      for (const socket of sockets) socket.disconnect();
    }
  });

  it('a member removed while their subscription is being decided never hears the store, not even for the length of a query (AX291/AX308 F03)', async () => {
    const sockets: Socket[] = [];
    const room = `vendor:${storeA}`;
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, member, ownerA);
    const real = vi.mocked(isStoreRoomMember).getMockImplementation()!;
    try {
      // A room member who hears every broadcast: the control that a silent
      // member is silent because they were never a recipient.
      const ownerSocket = await socketFor(ownerA.token, sockets);
      ownerSocket.emit('vendor:subscribe', { vendorId: storeA });
      await vi.waitFor(async () => expect(await inRoom(room)).toContain(ownerSocket.id), { timeout: 5_000, interval: 25 });
      const ownerHeard: string[] = [];
      ownerSocket.on('order:new', (p: { orderId: string }) => ownerHeard.push(p.orderId));
      const memberSocket = await socketFor(member.token, sockets);
      const heard: string[] = [];
      memberSocket.on('order:new', (p: { orderId: string }) => heard.push(p.orderId));
      const broadcast = (orderId: string) => { app.io.to(room).emit('order:new', { orderId, vendorId: storeA }); };

      // The subscription's own membership read is parked right after it said
      // yes. Any LATER read (a re-check after a join) broadcasts while it is
      // still pending: the window AX308 found.
      let resume!: () => void;
      const parked = new Promise<void>((done) => { resume = done; });
      let readDone!: () => void;
      const firstRead = new Promise<void>((done) => { readDone = done; });
      let first = true;
      vi.mocked(isStoreRoomMember).mockImplementation(async (...args) => {
        if (first) {
          first = false;
          const verdict = await real(...args);
          readDone();
          await parked;
          return verdict;
        }
        broadcast('during-a-recheck');
        await new Promise((settle) => setTimeout(settle, 50));
        return real(...args);
      });
      const decided = new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
        memberSocket.emit('vendor:subscribe', { vendorId: storeA }, (result: { joined: boolean }) => resolve(result));
        setTimeout(() => resolve('no-answer'), 4_000);
      });
      await firstRead;
      // The removal lands between that read and the join.
      const removed = await call('DELETE', `/api/v1/vendor/staff/${membership.id}`, ownerA.token);
      expect(removed.statusCode, removed.body).toBe(200);
      broadcast('while-deciding');
      resume();
      const outcome = await decided;
      broadcast('after-deciding');
      await vi.waitFor(() => expect(ownerHeard).toContain('after-deciding'), { timeout: 5_000, interval: 25 });
      // A barrier on the member's own connection: its reply comes after any
      // broadcast the server had already sent that socket.
      await new Promise<void>((done) => {
        memberSocket.emit('vendor:subscribe', {}, () => done());
        setTimeout(done, 1_000);
      });

      expect(heard).toEqual([]);
      expect(outcome).toEqual({ joined: false });
      expect(await inRoom(room)).not.toContain(memberSocket.id);
    } finally {
      vi.mocked(isStoreRoomMember).mockImplementation(real);
      for (const socket of sockets) socket.disconnect();
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('a revocation made on another instance is applied here in one step, and a malformed one is ignored (AX308 F03, across instances)', async () => {
    const sockets: Socket[] = [];
    const room = `vendor:${storeA}`;
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, member, ownerA);
    const real = vi.mocked(isStoreRoomMember).getMockImplementation()!;
    try {
      const memberSocket = await socketFor(member.token, sockets);
      const joined = await new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
        memberSocket.emit('vendor:subscribe', { vendorId: storeA }, resolve);
        setTimeout(() => resolve('no-answer'), 4_000);
      });
      expect(joined).toEqual({ joined: true });
      expect(await inRoom(room)).toContain(memberSocket.id);
      // [AX317 R2-02] A pair's epoch exists only while a subscription for it
      // is in flight: the member's second phone holds one open (its read is
      // parked after it said yes), so the step is observable on the epoch too.
      const secondPhone = await socketFor(member.token, sockets);
      let resume!: () => void;
      const parked = new Promise<void>((done) => { resume = done; });
      let reading!: () => void;
      const inFlight = new Promise<void>((done) => { reading = done; });
      vi.mocked(isStoreRoomMember).mockImplementation(async (...args) => {
        const verdict = await real(...args);
        if (args[2] === member.userId) {
          reading();
          await parked;
        }
        return verdict;
      });
      const secondDecided = new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
        secondPhone.emit('vendor:subscribe', { vendorId: storeA }, resolve);
        setTimeout(() => resolve('no-answer'), 4_000);
      });
      await inFlight;
      const arrive = (payload: unknown) => (app.io.of('/') as unknown as { _onServerSideEmit(args: unknown[]): void })._onServerSideEmit([STORE_ROOM_REVOKED, payload]);

      const before = storeRoomEpoch(app.io, storeA, member.userId);
      expect(before).toEqual(expect.any(Number));
      arrive({ vendorId: storeA });
      expect(storeRoomEpoch(app.io, storeA, member.userId)).toBe(before);
      expect(await inRoom(room)).toContain(memberSocket.id);

      arrive({ vendorId: storeA, userId: member.userId });
      expect(storeRoomEpoch(app.io, storeA, member.userId)).toBe(before! + 1);
      expect(await inRoom(room)).not.toContain(memberSocket.id);
      // The subscription in flight saw it: it read once more (AX317 R2-01),
      // and this simulated event changed nothing in the database.
      resume();
      expect(await secondDecided).toEqual({ joined: true });
    } finally {
      vi.mocked(isStoreRoomMember).mockImplementation(real);
      for (const socket of sockets) socket.disconnect();
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('the instance that removes a member tells the other instances, once, and applies it here itself (AX308 F03, across instances)', async () => {
    const vendorId = `q10b-cluster-${nanoid(6)}`;
    const userId = `q10b-cluster-${nanoid(6)}`;
    const told = vi.spyOn(app.io, 'serverSideEmit').mockReturnValue(true);
    // [AX317 R2-02] The epoch is kept only while a subscription for the pair
    // is in flight: one is held open (its read never answers until the end).
    // [AX368 R3-02] Its epoch moves, so its closing "no" is not taken as it
    // is: the one fresh read it then makes answers no at once.
    let closing = false;
    const answers: Array<(member: boolean) => void> = [];
    const phone = { id: `q10b-${nanoid(6)}`, connected: true, data: { userId, tenantId: 'swift-default' }, join: vi.fn() };
    const decided = subscribeToStoreRoom(app.io, phone as unknown as ServerSocket, vendorId, () => new Promise<boolean>((settle) => {
      if (closing) settle(false);
      else answers.push(settle);
    }), HELD_READ_TIMEOUT_MS);
    try {
      expect(storeRoomEpoch(app.io, vendorId, userId)).toBe(0);
      revokeStoreRoom(app.io, vendorId, userId);
      expect(told).not.toHaveBeenCalled(); // one process: nobody else to tell
      setStoreRoomCluster(app.io, true);
      revokeStoreRoom(app.io, vendorId, userId);
      expect(told.mock.calls).toEqual([[STORE_ROOM_REVOKED, { vendorId, userId }]]);
      expect(storeRoomEpoch(app.io, vendorId, userId)).toBe(2);
    } finally {
      setStoreRoomCluster(app.io, false);
      told.mockRestore();
      closing = true;
      for (const settle of answers) settle(false);
      await decided;
    }
    expect(phone.join).not.toHaveBeenCalled();
  });

  it('a member removed and added back while their subscription is being decided is admitted after one fresh read (AX317 R2-01)', async () => {
    const sockets: Socket[] = [];
    const room = `vendor:${storeA}`;
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    let membership = await joinTeam(storeA, member, ownerA);
    const real = vi.mocked(isStoreRoomMember).getMockImplementation()!;
    try {
      const memberSocket = await socketFor(member.token, sockets);
      // The subscription's first read is parked right after it said yes.
      let resume!: () => void;
      const parked = new Promise<void>((done) => { resume = done; });
      let readDone!: () => void;
      const firstRead = new Promise<void>((done) => { readDone = done; });
      const verdicts: boolean[] = [];
      vi.mocked(isStoreRoomMember).mockImplementation(async (...args) => {
        const verdict = await real(...args);
        if (args[2] !== member.userId) return verdict;
        verdicts.push(verdict);
        if (verdicts.length === 1) {
          readDone();
          await parked;
        }
        return verdict;
      });
      const decided = new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
        memberSocket.emit('vendor:subscribe', { vendorId: storeA }, resolve);
        setTimeout(() => resolve('no-answer'), 4_000);
      });
      await firstRead;
      // Removed (the revocation moves this subscription's epoch) and added
      // back, both committed before that read returns.
      const removed = await call('DELETE', `/api/v1/vendor/staff/${membership.id}`, ownerA.token);
      expect(removed.statusCode, removed.body).toBe(200);
      membership = await joinTeam(storeA, member, ownerA);
      resume();

      expect(await decided).toEqual({ joined: true });
      expect(verdicts).toEqual([true, true]); // the stale yes, then one fresh read
      expect(await inRoom(room)).toContain(memberSocket.id);
      const heard: string[] = [];
      memberSocket.on('order:new', (p: { orderId: string }) => heard.push(p.orderId));
      app.io.to(room).emit('order:new', { orderId: 'q10b-re-added', vendorId: storeA });
      await vi.waitFor(() => expect(heard).toEqual(['q10b-re-added']), { timeout: 5_000, interval: 25 });
    } finally {
      vi.mocked(isStoreRoomMember).mockImplementation(real);
      for (const socket of sockets) socket.disconnect();
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('a member removed and added back while their subscription is being decided is admitted even when its read saw the removal: a no is weighed only after the epoch, and the one fresh read says yes (AX368 R3-02)', async () => {
    const sockets: Socket[] = [];
    const room = `vendor:${storeA}`;
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    let membership = await joinTeam(storeA, member, ownerA);
    const real = vi.mocked(isStoreRoomMember).getMockImplementation()!;
    try {
      const memberSocket = await socketFor(member.token, sockets);
      // The subscription's first read runs only once the removal committed
      // (so it says no), and its answer comes back only once the member is
      // on the team again.
      let started!: () => void;
      const inFlight = new Promise<void>((done) => { started = done; });
      let removalCommitted!: () => void;
      const removed = new Promise<void>((done) => { removalCommitted = done; });
      let answered!: () => void;
      const firstAnswer = new Promise<void>((done) => { answered = done; });
      let resume!: () => void;
      const parked = new Promise<void>((done) => { resume = done; });
      const verdicts: boolean[] = [];
      let reads = 0;
      vi.mocked(isStoreRoomMember).mockImplementation(async (...args) => {
        if (args[2] !== member.userId) return real(...args);
        reads += 1;
        if (reads === 1) {
          started();
          await removed;
        }
        const verdict = await real(...args);
        verdicts.push(verdict);
        if (reads === 1) {
          answered();
          await parked;
        }
        return verdict;
      });
      const decided = new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
        memberSocket.emit('vendor:subscribe', { vendorId: storeA }, resolve);
        setTimeout(() => resolve('no-answer'), 4_000);
      });
      await inFlight;
      // Removed (the revocation moves this subscription's epoch) ...
      const removal = await call('DELETE', `/api/v1/vendor/staff/${membership.id}`, ownerA.token);
      expect(removal.statusCode, removal.body).toBe(200);
      removalCommitted();
      await firstAnswer;
      // ... and added back before that read's "no" returns.
      membership = await joinTeam(storeA, member, ownerA);
      resume();

      expect(await decided).toEqual({ joined: true });
      expect(verdicts).toEqual([false, true]); // the stale no, then one fresh read
      expect(await inRoom(room)).toContain(memberSocket.id);
      const heard: string[] = [];
      memberSocket.on('order:new', (p: { orderId: string }) => heard.push(p.orderId));
      app.io.to(room).emit('order:new', { orderId: 'q10b-re-added-after-a-no', vendorId: storeA });
      await vi.waitFor(() => expect(heard).toEqual(['q10b-re-added-after-a-no']), { timeout: 5_000, interval: 25 });
    } finally {
      vi.mocked(isStoreRoomMember).mockImplementation(real);
      for (const socket of sockets) socket.disconnect();
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('a subscription whose epoch moves again during its fresh read is refused: one retry, never a loop (AX317 R2-01)', async () => {
    const sockets: Socket[] = [];
    const room = `vendor:${storeA}`;
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, member, ownerA);
    const real = vi.mocked(isStoreRoomMember).getMockImplementation()!;
    try {
      const memberSocket = await socketFor(member.token, sockets);
      // Every read says yes, and a revocation lands during each of them.
      let reads = 0;
      vi.mocked(isStoreRoomMember).mockImplementation(async (...args) => {
        const verdict = await real(...args);
        if (args[2] === member.userId) {
          reads += 1;
          revokeStoreRoom(app.io, storeA, member.userId);
        }
        return verdict;
      });
      const decided = await new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
        memberSocket.emit('vendor:subscribe', { vendorId: storeA }, resolve);
        setTimeout(() => resolve('no-answer'), 4_000);
      });
      expect(decided).toEqual({ joined: false });
      expect(reads).toBe(2);
      expect(await inRoom(room)).not.toContain(memberSocket.id);
    } finally {
      vi.mocked(isStoreRoomMember).mockImplementation(real);
      for (const socket of sockets) socket.disconnect();
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('a revocation epoch lives only while a subscription for its pair is in flight, so removals leave nothing behind (AX317 R2-02)', async () => {
    const vendorId = `q10b-r202-${nanoid(6)}`;
    const userIds = Array.from({ length: 50 }, () => `q10b-r202-${nanoid(6)}`);
    // Fifty removals with nothing in flight keep nothing.
    for (const userId of userIds) revokeStoreRoom(app.io, vendorId, userId);
    for (const userId of userIds) expect(storeRoomEpoch(app.io, vendorId, userId)).toBeNull();

    // A subscription in flight holds its pair's epoch, and a removal moves it.
    const userId = userIds[0]!;
    const phone = { id: `q10b-${nanoid(6)}`, connected: true, data: { userId, tenantId: 'swift-default' }, join: vi.fn() };
    const answers: Array<(member: boolean) => void> = [];
    const decided = subscribeToStoreRoom(app.io, phone as unknown as ServerSocket, vendorId, () => new Promise<boolean>((settle) => { answers.push(settle); }), HELD_READ_TIMEOUT_MS);
    expect(storeRoomEpoch(app.io, vendorId, userId)).toBe(0);
    revokeStoreRoom(app.io, vendorId, userId);
    expect(storeRoomEpoch(app.io, vendorId, userId)).toBe(1);
    // Its read says yes, but the epoch moved: the entry of that read goes and
    // the one fresh read starts a new one.
    answers[0]!(true);
    await vi.waitFor(() => expect(answers).toHaveLength(2), { timeout: 2_000, interval: 5 });
    expect(storeRoomEpoch(app.io, vendorId, userId)).toBe(0);
    answers[1]!(false);
    expect(await decided).toBe(false);
    // Nothing is in flight any more: nothing is kept.
    expect(storeRoomEpoch(app.io, vendorId, userId)).toBeNull();
    expect(phone.join).not.toHaveBeenCalled();
  });

  it('a member whose revocation never reaches this instance is evicted by the store-room re-validation within its bound, and hears nothing after (AX317 F03)', async () => {
    const sockets: Socket[] = [];
    const room = `vendor:${storeA}`;
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, member, ownerA);
    // An API instance of its own, with a short re-validation interval.
    const instance = Fastify({ logger: false });
    try {
      const at = await listenWithStoreRoomRecheck(instance);
      const inInstanceRoom = async () => (await instance.io.in(room).fetchSockets()).map((s) => s.id);
      const ownerSocket = await socketFor(ownerA.token, sockets, at);
      const memberSocket = await socketFor(member.token, sockets, at);
      for (const socket of [ownerSocket, memberSocket]) {
        const joined = await new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
          socket.emit('vendor:subscribe', { vendorId: storeA }, resolve);
          setTimeout(() => resolve('no-answer'), 4_000);
        });
        expect(joined).toEqual({ joined: true });
      }
      const ownerHeard: string[] = [];
      const heard: string[] = [];
      ownerSocket.on('order:new', (p: { orderId: string }) => ownerHeard.push(p.orderId));
      memberSocket.on('order:new', (p: { orderId: string }) => heard.push(p.orderId));
      const broadcast = (orderId: string) => { instance.io.to(room).emit('order:new', { orderId, vendorId: storeA }); };
      broadcast('q10b-before-removal');
      await vi.waitFor(() => expect(heard).toEqual(['q10b-before-removal']), { timeout: 5_000, interval: 25 });

      // The removal commits on another instance and its revocation event is
      // lost on the way: here the team row is gone and nothing else happened.
      const removedAt = Date.now();
      await app.prisma.vendorStaff.delete({ where: { id: membership.id } });
      await vi.waitFor(
        async () => expect(await inInstanceRoom()).not.toContain(memberSocket.id),
        { timeout: STORE_ROOM_EVICTION_BOUND_MS, interval: 25 },
      );
      expect(Date.now() - removedAt).toBeLessThanOrEqual(STORE_ROOM_EVICTION_BOUND_MS);
      // Only who is no longer a member leaves.
      expect(await inInstanceRoom()).toContain(ownerSocket.id);

      broadcast('q10b-after-eviction');
      await vi.waitFor(() => expect(ownerHeard).toContain('q10b-after-eviction'), { timeout: 5_000, interval: 25 });
      // A barrier on the member's own connection: its reply comes after any
      // broadcast the server had already sent that socket.
      await new Promise<void>((done) => {
        memberSocket.emit('vendor:subscribe', {}, () => done());
        setTimeout(done, 1_000);
      });
      expect(heard).toEqual(['q10b-before-removal']);
      expect(await inInstanceRoom()).not.toContain(memberSocket.id);
    } finally {
      for (const socket of sockets) socket.disconnect();
      await instance.close();
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('a yes that stalls past a removal whose revocation is lost never admits the member: passes ran and the read timeout passed while it was pending, so it is void, and the one fresh read refuses; they hear nothing (AX368 R3-01)', async () => {
    const sockets: Socket[] = [];
    const room = `vendor:${storeA}`;
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, member, ownerA);
    const real = vi.mocked(isStoreRoomMember).getMockImplementation()!;
    const instance = Fastify({ logger: false });
    try {
      const at = await listenWithStoreRoomRecheck(instance);
      const inInstanceRoom = async () => (await instance.io.in(room).fetchSockets()).map((s) => s.id);
      const ownerSocket = await socketFor(ownerA.token, sockets, at);
      const ownerJoined = await new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
        ownerSocket.emit('vendor:subscribe', { vendorId: storeA }, resolve);
        setTimeout(() => resolve('no-answer'), 4_000);
      });
      expect(ownerJoined).toEqual({ joined: true });
      const memberSocket = await socketFor(member.token, sockets, at);
      const ownerHeard: string[] = [];
      const heard: string[] = [];
      ownerSocket.on('order:new', (p: { orderId: string }) => ownerHeard.push(p.orderId));
      memberSocket.on('order:new', (p: { orderId: string }) => heard.push(p.orderId));
      const broadcast = (orderId: string) => { instance.io.to(room).emit('order:new', { orderId, vendorId: storeA }); };

      // The member's subscription reads yes, and that answer stalls.
      let resume!: () => void;
      const parked = new Promise<void>((done) => { resume = done; });
      let readDone!: () => void;
      const firstRead = new Promise<void>((done) => { readDone = done; });
      const verdicts: boolean[] = [];
      vi.mocked(isStoreRoomMember).mockImplementation(async (...args) => {
        const verdict = await real(...args);
        if (args[2] !== member.userId) return verdict;
        verdicts.push(verdict);
        if (verdicts.length === 1) {
          readDone();
          await parked;
        }
        return verdict;
      });
      let answeredAt = Number.POSITIVE_INFINITY;
      const decided = new Promise<{ joined: boolean } | 'no-answer'>((resolve) => {
        memberSocket.emit('vendor:subscribe', { vendorId: storeA }, (result: { joined: boolean }) => {
          answeredAt = Date.now();
          resolve(result);
        });
        setTimeout(() => resolve('no-answer'), STORE_ROOM_STALL_MS + 5_000);
      });
      await firstRead;
      // The removal commits on another instance and its revocation is lost on
      // the way: here the team row is gone and nothing else happened.
      await app.prisma.vendorStaff.delete({ where: { id: membership.id } });
      // Passes run while that yes is pending (the reviewer's 30 s and 60 s
      // passes), and the eviction bound from the removal passes too.
      await new Promise((settle) => setTimeout(settle, STORE_ROOM_STALL_MS));
      broadcast('q10b-r301-while-stalled');
      // Only now does the stale yes come back.
      const resumedAt = Date.now();
      resume();
      const outcome = await decided;
      broadcast('q10b-r301-after');
      await vi.waitFor(() => expect(ownerHeard).toEqual(['q10b-r301-while-stalled', 'q10b-r301-after']), { timeout: 5_000, interval: 25 });
      // A barrier on the member's own connection: its reply comes after any
      // broadcast the server had already sent that socket.
      await new Promise<void>((done) => {
        memberSocket.emit('vendor:subscribe', {}, () => done());
        setTimeout(done, 1_000);
      });

      expect(outcome).toEqual({ joined: false });
      expect(verdicts).toEqual([true, false]); // the stale yes, then one fresh read: removed
      // Answered while that yes still stalled: this instance's read timeout
      // (its interval, storeRoomTiming) gave up on it for the fresh read.
      expect(answeredAt).toBeLessThan(resumedAt);
      expect(heard).toEqual([]);
      expect(await inInstanceRoom()).not.toContain(memberSocket.id);
      expect(await inInstanceRoom()).toContain(ownerSocket.id);
    } finally {
      vi.mocked(isStoreRoomMember).mockImplementation(real);
      for (const socket of sockets) socket.disconnect();
      await instance.close();
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });
});

describe('a store-room membership answer holds for a bounded time only (AX368 R3-01)', () => {
  // A Socket.IO server of its own: no socket plugin, so no pass ever runs on
  // it unless the test runs one.
  const phoneFor = () => ({
    id: `q10b-${nanoid(6)}`, connected: true, data: { userId: `q10b-r301-${nanoid(6)}`, tenantId: 'swift-default' }, join: vi.fn(),
  });

  it('a convergence pass that runs while a subscription read is pending takes it into its snapshot: that answer is never acted on, and the one fresh read decides', async () => {
    const io = new SocketIoServer();
    const vendorId = `q10b-r301-${nanoid(6)}`;
    const phone = phoneFor();
    const answers: Array<(member: boolean) => void> = [];
    const decided = subscribeToStoreRoom(io, phone as unknown as ServerSocket, vendorId, () => new Promise<boolean>((settle) => { answers.push(settle); }), HELD_READ_TIMEOUT_MS);
    // Nobody is in a store room on this server: the pending subscription is
    // all the pass's snapshot holds.
    const pass = await convergeStoreRooms(io, { readMembers: async () => new Set<string>(), timeoutMs: 1_000 });
    expect(pass).toMatchObject({ outcome: 'idle', superseded: 1 });
    answers[0]!(true); // the yes of a member removed meanwhile, revocation lost
    await vi.waitFor(() => expect(answers).toHaveLength(2), { timeout: 2_000, interval: 5 });
    answers[1]!(false); // the fresh read sees the removal
    expect(await decided).toBe(false);
    expect(phone.join).not.toHaveBeenCalled();

    // The control: with no pass in between, the same yes admits on its read.
    const other = phoneFor();
    expect(await subscribeToStoreRoom(io, other as unknown as ServerSocket, vendorId, async () => true, HELD_READ_TIMEOUT_MS)).toBe(true);
    expect(other.join).toHaveBeenCalledWith(`vendor:${vendorId}`);
  });

  it('a read that has not answered within the read timeout is given up for one fresh read; when both are late the subscription is refused, never left hanging', async () => {
    const io = new SocketIoServer();
    const vendorId = `q10b-r301-${nanoid(6)}`;
    const phone = phoneFor();
    const answers: Array<(member: boolean) => void> = [];
    const decided = subscribeToStoreRoom(io, phone as unknown as ServerSocket, vendorId, () => new Promise<boolean>((settle) => { answers.push(settle); }), 50);
    await vi.waitFor(() => expect(answers).toHaveLength(2), { timeout: 2_000, interval: 5 });
    answers[0]!(true); // the stale yes comes back late: nobody listens any more
    answers[1]!(false);
    expect(await decided).toBe(false);
    expect(phone.join).not.toHaveBeenCalled();

    const stalled = phoneFor();
    const startedAt = performance.now();
    expect(await subscribeToStoreRoom(io, stalled as unknown as ServerSocket, vendorId, () => new Promise<boolean>(() => {}), 50)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(stalled.join).not.toHaveBeenCalled();
  });

  it('an answer that arrives more than the read timeout after its read began is void even when it beats the timer (the process stalled)', async () => {
    const io = new SocketIoServer();
    const vendorId = `q10b-r301-${nanoid(6)}`;
    const phone = phoneFor();
    let reads = 0;
    const decided = subscribeToStoreRoom(io, phone as unknown as ServerSocket, vendorId, async () => {
      reads += 1;
      if (reads > 1) return false; // the fresh read: removed
      // The process stalls past the read timeout while this read answers yes.
      const until = performance.now() + 120;
      while (performance.now() < until) { /* stalled */ }
      return true;
    }, 50);
    expect(await decided).toBe(false);
    expect(reads).toBe(2);
    expect(phone.join).not.toHaveBeenCalled();
  });

  it('the eviction bound counts the read: interval + read timeout never exceeds 60 s, and the read timeout never exceeds the interval', () => {
    expect(STORE_ROOM_STRICT_BOUND_MS).toBe(60_000);
    expect(storeRoomTiming(30_000, 4_000)).toEqual({ intervalMs: 30_000, readTimeoutMs: 4_000 }); // the defaults stand
    expect(storeRoomTiming(60_000, 4_000)).toEqual({ intervalMs: 56_000, readTimeoutMs: 4_000 }); // the read fits inside
    expect(storeRoomTiming(120_000, 60_000)).toEqual({ intervalMs: 30_000, readTimeoutMs: 30_000 });
    expect(storeRoomTiming(1_000, 4_000)).toEqual({ intervalMs: 1_000, readTimeoutMs: 1_000 });
    for (const [interval, read] of [[1, 1], [59_999, 1], [60_000, 60_000], [45_000, 20_000], [5, 90_000], [90_000, 5]] as const) {
      const timing = storeRoomTiming(interval, read);
      expect(timing.intervalMs + timing.readTimeoutMs).toBeLessThanOrEqual(STORE_ROOM_STRICT_BOUND_MS);
      expect(timing.readTimeoutMs).toBeLessThanOrEqual(timing.intervalMs);
      expect(Math.min(timing.intervalMs, timing.readTimeoutMs)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('every rung stops the moment the order no longer waits, read at send time', () => {
  const stops = {
    'a staff member accepts': async (orderId: string) => {
      const res = await call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, staffA1.token);
      expect(res.statusCode, res.body).toBe(200);
    },
    'a staff member rejects': async (orderId: string) => {
      const res = await call('PUT', `/api/v1/vendor/orders/${orderId}/reject`, staffA1.token, { reason: 'Out of stock' });
      expect(res.statusCode, res.body).toBe(200);
    },
    'the customer cancels': async (orderId: string) => {
      const res = await call('POST', `/api/v1/customer/orders/${orderId}/cancel`, customer.token, { reason: 'Changed my mind' });
      expect(res.statusCode, res.body).toBe(200);
    },
    'the auto-cancel fires': async (orderId: string) => {
      expect(await autoCancelUnresponsiveOrder(jobCtx(), orderId)).toBe(true);
    },
  } as const;

  const teamDevices = () => [ownerA0, ownerA1, staffA1Device, managerADevice];
  const snapshot = (orderId: string) => ({
    pushes: teamDevices().map((t) => stillWaitingPushesTo(t, orderId).length),
    texts: smsTo(ownerA.phone).length,
  });

  for (const [how, stop] of Object.entries(stops)) {
    for (const { rung } of LADDER) {
      it(`${rung}: ${how} → stopped, nothing sent`, async () => {
        const o = await placeAndAlert(storeA);
        await stop(o.orderId);
        expect((await app.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).not.toBe('PENDING');
        const before = snapshot(o.orderId);
        expect(await runLadderRung(deps(), o.orderId, rung)).toBe('stopped');
        expect(snapshot(o.orderId)).toEqual(before);
        expect(await opsRowsFor(adminA.userId, o.orderId)).toEqual([]);
      });
    }
  }

  for (const { rung } of LADDER) {
    it(`${rung}: an accept that lands between the first read and the provider call still stops it (DS276 F1)`, async () => {
      const o = await placeAndAlert(storeA);
      const before = snapshot(o.orderId);
      const counted = await textsCounted(ownerA.phone);
      const racing = deps({
        redis: redisRacingAtClaim(async () => {
          await app.prisma.order.update({ where: { id: o.orderId }, data: { status: 'ACCEPTED' } });
        }),
      });
      expect(await runLadderRung(racing, o.orderId, rung)).toBe('stopped');
      expect(snapshot(o.orderId)).toEqual(before);
      expect(await opsRowsFor(adminA.userId, o.orderId)).toEqual([]);
      // Not even the in-app re-alert goes out once the order is answered.
      expect(emitted.filter((e) => (e.payload as { orderId?: string; reAlert?: boolean }).orderId === o.orderId && (e.payload as { reAlert?: boolean }).reAlert)).toEqual([]);
      // A text withdrawn at the last moment gives its budget back.
      expect(await textsCounted(ownerA.phone)).toBe(counted);
    });
  }

  it('an answer that lands while the re-ring is going out stops the devices not yet sent to (DS276 F1)', async () => {
    const o = await placeAndAlert(storeA);
    // ownerA0 is on today's build and ownerA1 on the channel build: two provider
    // requests. The order is accepted while the first one is going out.
    const real = getChannels().push;
    const answeredMidway: PushProvider = {
      async sendPush(tokens, title, body, data, options) {
        const sent = await real.sendPush(tokens, title, body, data, options);
        if (tokens.includes(ownerA0)) await app.prisma.order.update({ where: { id: o.orderId }, data: { status: 'ACCEPTED' } });
        return sent;
      },
    };
    const outcome = await runLadderRung(deps({ channels: { ...getChannels(), push: answeredMidway } }), o.orderId, 'ring1');
    expect(outcome).toBe('realerted');
    expect(stillWaitingPushesTo(ownerA0, o.orderId)).toHaveLength(1);
    expect(stillWaitingPushesTo(ownerA1, o.orderId)).toEqual([]);
  });

  it('an accept during a push retry backoff: the retry never goes out (AX291 F04)', async () => {
    const o = await placeAndAlert(storeA);
    // The relay fails the first attempt, and the order is accepted while the
    // production retry (withPushRetry, 2 s) waits.
    const deliver = Array.prototype.push;
    let attempts = 0;
    let accepted: Promise<unknown> | undefined;
    const outage = vi.spyOn(devChannelLog, 'push').mockImplementation(function (this: DevChannelEntry[], ...entries: DevChannelEntry[]) {
      if (entries.some((e) => e.title === 'Order still waiting!' && (e.data as { orderId?: string } | undefined)?.orderId === o.orderId)) {
        attempts += 1;
        if (attempts === 1) {
          // Started now (a Prisma query runs once something awaits it), done
          // long before the 2 s backoff ends.
          accepted = app.prisma.order.update({ where: { id: o.orderId }, data: { status: 'ACCEPTED' } }).then(() => undefined);
          throw new Error('push relay 503');
        }
      }
      return deliver.apply(devChannelLog, entries);
    });
    let outcome: string;
    try {
      outcome = await runLadderRung(deps(), o.orderId, 'ring1');
    } finally {
      outage.mockRestore();
    }
    await accepted;
    // The later acceptance stops future work; it cannot prove the earlier 503 was not delivered.
    expect(outcome!).toBe('submission_unknown');
    expect(attempts).toBe(1);
    for (const token of teamDevices()) expect(stillWaitingPushesTo(token, o.orderId), token).toEqual([]);
  });

  it('rungs already queued read the answer when they run: nothing goes out after it', async () => {
    const queue = recordingQueue();
    const o = await placeAndAlert(storeA);
    expect(await runLadderJob({ ...deps(), queue }, { orderId: o.orderId, level: 0 })).toBe('realerted');
    expect(queue.jobs.map((j) => j.data)).toEqual([
      { orderId: o.orderId, rung: 'ring2' },
      { orderId: o.orderId, rung: 'sms' },
      { orderId: o.orderId, rung: 'admin' },
    ]);
    const accepted = await call('PUT', `/api/v1/vendor/orders/${o.orderId}/accept`, staffA1.token);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const before = snapshot(o.orderId);
    for (const job of queue.jobs) {
      expect(await runLadderJob({ ...deps(), queue }, job.data), String(job.data['rung'])).toBe('stopped');
    }
    expect(snapshot(o.orderId)).toEqual(before);
    expect(await opsRowsFor(adminA.userId, o.orderId)).toEqual([]);
    expect(queue.jobs).toHaveLength(3); // nothing new was scheduled
  });

  it('each rung goes out once per order, however often its job runs', async () => {
    const o = await placeAndAlert(storeA);
    for (const { rung } of LADDER) {
      const first = await runLadderRung(deps(), o.orderId, rung);
      expect(['realerted', 'sms_sent', 'admin_paged'], `${rung} ${first}`).toContain(first);
      expect(await runLadderRung(deps(), o.orderId, rung), rung).toBe('already_sent');
    }
    expect(stillWaitingPushesTo(staffA1Device, o.orderId)).toHaveLength(2); // ring1 + ring2
    expect(smsTo(ownerA.phone).filter((s) => s.body.includes(o.orderNumber))).toHaveLength(1);
    expect(await opsRowsFor(adminA.userId, o.orderId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('the first rung schedules the rest on the ruling clock', () => {
  it('ring +60 s, text +90 s, operators +3 min, measured from when the store was shown the order, once each', async () => {
    const queue = recordingQueue();
    const o = await placeAndAlert(storeA);
    const placedAt = (await app.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).placedAt.getTime();
    const before = Date.now();
    expect(await runLadderJob({ ...deps(), queue }, { orderId: o.orderId, level: 0 })).toBe('realerted');
    const after = Date.now();
    expect(queue.jobs.map((j) => ({ name: j.name, data: j.data, jobId: j.opts['jobId'] }))).toEqual(
      LADDER.slice(1).map((step) => ({ name: 'vendor-alert-escalate', data: { orderId: o.orderId, rung: step.rung }, jobId: ladderJobId(o.orderId, step.rung) })),
    );
    for (const [i, step] of LADDER.slice(1).entries()) {
      const delay = queue.jobs[i]!.opts['delay'] as number;
      expect(delay).toBeLessThanOrEqual(placedAt + step.afterMs - before);
      expect(delay).toBeGreaterThanOrEqual(placedAt + step.afterMs - after);
    }
    expect(LADDER.map((s) => [s.rung, s.afterMs])).toEqual([['ring1', 30_000], ['ring2', 60_000], ['sms', 90_000], ['admin', 180_000]]);
  });

  it('a released order is measured from its release, never from the hold', async () => {
    const queue = recordingQueue();
    const releasedToVendorAt = new Date(Date.now() - 50_000);
    const o = await placeAndAlert(storeA, { placedAt: new Date(Date.now() - 6 * 60_000), releasedToVendorAt });
    const before = Date.now();
    expect(await runLadderJob({ ...deps(), queue }, { orderId: o.orderId, level: 0 })).toBe('realerted');
    const after = Date.now();
    for (const [i, step] of LADDER.slice(1).entries()) {
      const delay = queue.jobs[i]!.opts['delay'] as number;
      expect(delay).toBeLessThanOrEqual(Math.max(0, releasedToVendorAt.getTime() + step.afterMs - before));
      expect(delay).toBeGreaterThanOrEqual(Math.max(0, releasedToVendorAt.getTime() + step.afterMs - after));
    }
  });

  it('jobs written before the ladder was rebuilt still run: level 0 is the first rung, level 1 the text', () => {
    expect(rungOf({ orderId: 'o', level: 0 })).toBe('ring1');
    expect(rungOf({ orderId: 'o' })).toBe('ring1');
    expect(rungOf({ orderId: 'o', level: 1 })).toBe('sms');
    expect(rungOf({ orderId: 'o', rung: 'admin' })).toBe('admin');
    expect(rungOf({ orderId: 'o', rung: 'nope' })).toBeNull();
    expect(rungOf({ orderId: 'o', level: 7 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('a rung that reached nobody is recorded as that, never as delivered (DS276 F2)', () => {
  it('a store with no device: the re-ring is unsent, logged and counted, and the text still follows', async () => {
    const lonely = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const store = await makeStore(lonely, 'No Phone Kitchen');
    const o = await placeAndAlert(store);
    const [unsent, delivered] = [await rungCount('ring1', 'unsent'), await rungCount('ring1', 'realerted')];
    const queue = recordingQueue();
    expect(await runLadderJob({ ...deps(), queue }, { orderId: o.orderId, level: 0 })).toBe('unsent');
    expect(await rungCount('ring1', 'unsent')).toBe(unsent + 1);
    expect(await rungCount('ring1', 'realerted')).toBe(delivered);
    // The phone that has no app is exactly who the text is for.
    expect(queue.jobs.map((j) => j.data['rung'])).toEqual(['ring2', 'sms', 'admin']);
    expect(await runLadderJob({ ...deps(), queue }, queue.jobs[1]!.data)).toBe('sms_sent');
    expect(smsTo(lonely.phone).map((s) => s.body)).toEqual([`Swift: order ${o.orderNumber} is still waiting for your response. Open your dashboard now.`]);
  });

  it('a response window that has closed: nothing is pushed, it is counted as window_closed, and no later rung is armed', async () => {
    const o = await placeAndAlert(storeA, { respondBy: new Date(Date.now() - 5_000) });
    const closed = await rungCount('ring1', 'window_closed');
    const queue = recordingQueue();
    expect(await runLadderJob({ ...deps(), queue }, { orderId: o.orderId, level: 0 })).toBe('window_closed');
    expect(await rungCount('ring1', 'window_closed')).toBe(closed + 1);
    expect(stillWaitingPushesTo(ownerA0, o.orderId)).toEqual([]);
    expect(queue.jobs).toEqual([]);
    // And the text rung, if it was already queued, sends nothing either.
    expect(await runLadderRung(deps(), o.orderId, 'sms')).toBe('window_closed');
  });

  it('a text the provider PROVABLY never took is sms_unsent, and its budget is given back (AX291 F06)', async () => {
    const o = await placeAndAlert(storeA);
    const counted = await textsCounted(ownerA.phone);
    // A definitive refusal (a 4xx), or a request that never left the process.
    const refused = { ...getChannels(), sms: { sendSms: async () => { throw new SmsNotSubmittedError('Twilio SMS failed (400)'); } } };
    expect(await runLadderRung(deps({ channels: refused }), o.orderId, 'sms')).toBe('sms_unsent');
    expect(await textsCounted(ownerA.phone)).toBe(counted);
  });

  it('a text whose outcome is unknown keeps its place in the day count, so the cap can never be passed (AX291 F06)', async () => {
    // A timeout, a 5xx or an unreadable reply after the request went out: the
    // text may have been sent and billed. It is never reported as sent, and it
    // is never refunded.
    for (const ambiguous of ['Twilio SMS timed out', 'Twilio SMS failed (503)', 'Twilio SMS response invalid']) {
      const o = await placeAndAlert(storeA);
      const counted = await textsCounted(ownerA.phone);
      const lost = { ...getChannels(), sms: { sendSms: async () => { throw new Error(ambiguous); } } };
      expect(await runLadderRung(deps({ channels: lost }), o.orderId, 'sms'), ambiguous).toBe('sms_uncertain');
      expect(await textsCounted(ownerA.phone), ambiguous).toBe(counted + 1);
    }
  });
});

// ---------------------------------------------------------------------------
describe('a rung whose worker died mid-send is sent later, never lost (AX291 F05)', () => {
  it('the claim is short while a send is in flight and becomes a day-long "done" only once it finished', async () => {
    const o = await placeAndAlert(storeA);
    const key = rungClaimKey(o.orderId, 'sms');
    let during: { value: string | null; pttl: number } | undefined;
    const real = getChannels().sms;
    const probing = { ...getChannels(), sms: { sendSms: async (to: string, body: string) => {
      during = { value: await app.redis.get(key), pttl: await app.redis.pttl(key) };
      return real.sendSms(to, body);
    } } };
    expect(await runLadderRung(deps({ channels: probing }), o.orderId, 'sms')).toBe('sms_sent');
    expect(during!.value).toMatch(/^sending:/);
    expect(during!.pttl).toBeGreaterThan(0);
    expect(during!.pttl).toBeLessThanOrEqual(RUNG_SENDING_TTL_MS);
    expect(await app.redis.get(key)).toBe('done:sms_sent');
    expect(await app.redis.ttl(key)).toBeGreaterThan(23 * 3600);
    expect(await runLadderRung(deps(), o.orderId, 'sms')).toBe('already_sent');
  });

  it('a claim left by a crash holds the rung only until it lapses; the job re-arms itself and then sends', async () => {
    const o = await placeAndAlert(storeA);
    const key = rungClaimKey(o.orderId, 'sms');
    // What a worker that died between claiming and sending leaves behind.
    await app.redis.set(key, 'sending:a-worker-that-died', 'PX', 400);
    const texts = smsTo(ownerA.phone).length;
    const queue = recordingQueue();
    expect(await runLadderJob({ ...deps(), queue }, { orderId: o.orderId, rung: 'sms' })).toBe('in_progress');
    expect(smsTo(ownerA.phone)).toHaveLength(texts);
    expect(queue.jobs.map((j) => ({ name: j.name, data: j.data, jobId: j.opts['jobId'] }))).toEqual([
      { name: 'vendor-alert-escalate', data: { orderId: o.orderId, rung: 'sms', retry: 1 }, jobId: `${ladderJobId(o.orderId, 'sms')}-retry-1` },
    ]);
    const delay = queue.jobs[0]!.opts['delay'] as number;
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(400 + 1_000);
    // The lapse comes and the re-armed job runs: the text goes out once.
    await vi.waitFor(async () => expect(await app.redis.exists(key)).toBe(0), { timeout: 5_000, interval: 50 });
    expect(await runLadderJob({ ...deps(), queue }, queue.jobs[0]!.data)).toBe('sms_sent');
    expect(smsTo(ownerA.phone)).toHaveLength(texts + 1);
    expect(await runLadderJob({ ...deps(), queue }, queue.jobs[0]!.data)).toBe('already_sent');
    expect(smsTo(ownerA.phone)).toHaveLength(texts + 1);
  });
});

// ---------------------------------------------------------------------------
describe('the text to the store: its own budget, apart from login', () => {
  const day = () => guyanaDayKey(new Date());

  it('texts the store phone, not the owner, when the store has one that can take a text', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const storePhone = `${PHONE_PREFIX}901`;
    const store = await makeStore(owner, 'Counter Phone Kitchen', storePhone);
    const o = await placeAndAlert(store);
    expect(await runLadderRung(deps(), o.orderId, 'sms')).toBe('sms_sent');
    expect(smsTo(storePhone)).toHaveLength(1);
    expect(smsTo(owner.phone)).toEqual([]);
    // A store phone nothing can dial falls back to the owner number, the one
    // the ladder always texted; neither usable means no text at all.
    expect(storeSmsNumber('+592 600 1234', '+5926009999')).toBe('+5926001234');
    expect(storeSmsNumber('600-1234', '+5926009999')).toBe('+5926009999');
    expect(storeSmsNumber('', '+5926009999')).toBe('+5926009999');
    expect(storeSmsNumber('600-1234', 'not a number')).toBeNull();
  });

  it('a partner who can no longer log in today still gets the order text', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const store = await makeStore(owner, 'Locked Out Kitchen');
    // The login OTP budget for this phone is spent for the day.
    await app.redis.set(`otp_phone_day:${day()}:${owner.phone}`, '8', 'EX', 86_400);
    expect((await checkOtpDailyBudget(app.redis, owner.phone, { knownPhone: true })).allowed).toBe(false);
    const o = await placeAndAlert(store);
    expect(await runLadderRung(deps(), o.orderId, 'sms')).toBe('sms_sent');
    expect(smsTo(owner.phone)).toHaveLength(1);
  });

  it('a flood of unanswered orders never spends the login budget, and is capped per phone per day', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const store = await makeStore(owner, 'Rush Hour Kitchen');
    const otherOwner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const otherStore = await makeStore(otherOwner, 'Quiet Kitchen');
    const previous = process.env['STORE_ALERT_SMS_DAILY_CAP'];
    process.env['STORE_ALERT_SMS_DAILY_CAP'] = '9';
    try {
      // Nine texts: more than the whole daily OTP allowance of one phone (8).
      for (let i = 0; i < 9; i += 1) {
        const o = await placeAndAlert(store);
        expect(await runLadderRung(deps(), o.orderId, 'sms'), `text ${i + 1}`).toBe('sms_sent');
      }
      // The tenth is over the cap: nothing is sent, and it says so.
      const over = await placeAndAlert(store);
      const refused = await rungCount('sms', 'sms_over_budget');
      expect(await runLadderRung(deps(), over.orderId, 'sms')).toBe('sms_over_budget');
      expect(await rungCount('sms', 'sms_over_budget')).toBe(refused + 1);
      expect(smsTo(owner.phone)).toHaveLength(9);
      // The cap is per phone: another store is texted as usual.
      const elsewhere = await placeAndAlert(otherStore);
      expect(await runLadderRung(deps(), elsewhere.orderId, 'sms')).toBe('sms_sent');
    } finally {
      if (previous === undefined) delete process.env['STORE_ALERT_SMS_DAILY_CAP'];
      else process.env['STORE_ALERT_SMS_DAILY_CAP'] = previous;
    }
    // …and the owner can still log in: the OTP counter never moved.
    expect(await app.redis.get(`otp_phone_day:${day()}:${owner.phone}`)).toBeNull();
    const login = await checkOtpDailyBudget(app.redis, owner.phone, { knownPhone: true });
    expect(login.allowed).toBe(true);
    await login.refund?.();
  });

  it('nothing but the ladder text rung spends that budget or sends that text', () => {
    // A census of the source: the budget has one caller, the SMS rung, and the
    // ladder texts from nowhere else.
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
        return e.name.endsWith('.ts') ? [p] : [];
      });
    })(join(process.cwd(), 'src'));
    const callers = files.filter((f) => readFileSync(f, 'utf8').includes('checkStoreAlertSmsBudget(')).map((f) => relative(process.cwd(), f));
    expect(callers.sort()).toEqual(['src/modules/notification/store-alert-ladder.ts', 'src/utils/sms-budget.ts']);
    const ladder = readFileSync(join(process.cwd(), 'src/modules/notification/store-alert-ladder.ts'), 'utf8');
    expect(ladder.match(/sendSms\(/g)).toHaveLength(1);
    const textRung = ladder.slice(ladder.indexOf('async function textTheStore'), ladder.indexOf('async function tellTheOperators'));
    expect(textRung).toContain('checkStoreAlertSmsBudget(');
    expect(textRung).toContain('sendSms(');
  });
});

// ---------------------------------------------------------------------------
describe('the +3 min operator page', () => {
  it('names the order and the store, and reaches the tenant admins and the platform operators only', async () => {
    const o = await placeAndAlert(storeA);
    expect(await runLadderRung(deps(), o.orderId, 'admin')).toBe('admin_paged');
    for (const operator of [adminA, superAdmin]) {
      const rows = await opsRowsFor(operator.userId, o.orderId);
      expect(rows, operator === adminA ? 'tenant admin' : 'platform operator').toHaveLength(1);
      expect(rows[0]!.title).toBe('A store is not answering an order');
      expect(rows[0]!.body).toContain('Ladder Kitchen');
      expect(rows[0]!.body).toContain(o.orderNumber);
      expect(rows[0]!.data).toMatchObject({ kind: 'ops_order_unanswered', orderId: o.orderId, orderNumber: o.orderNumber, vendorId: storeA });
    }
    for (const person of [adminOther, ownerA, staffA1, managerA, customer, ownerB]) {
      expect(await opsRowsFor(person.userId, o.orderId), person.userId).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
describe('alert-seen: ownership first, one order only, once', () => {
  const receiptsSeen = (orderId: string) => app.prisma.alertDelivery.findMany({
    where: { kind: 'VENDOR_ORDER', subjectId: orderId, seenAt: { not: null } },
    select: { recipientId: true, seenAt: true },
  });

  it('another store, a customer, or a removed member is refused and records nothing; the ladder keeps running', async () => {
    const leaver = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, leaver, ownerA);
    const o = await placeAndAlert(storeA);
    await app.prisma.vendorStaff.delete({ where: { id: membership.id } });

    expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, ownerB.token)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, staffB.token)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, customer.token)).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, leaver.token)).statusCode).toBe(403);

    expect(await receiptsSeen(o.orderId)).toEqual([]);
    // No receipt was made for anyone outside the store (the leaver was alerted
    // while still on the team; that receipt stays unseen, as checked above).
    expect(await app.prisma.alertDelivery.count({ where: { subjectId: o.orderId, recipientId: { in: [ownerB.userId, staffB.userId, customer.userId] } } })).toBe(0);
    expect(await runLadderRung(deps(), o.orderId, 'ring1')).toBe('realerted');
  });

  it('the store seeing it ends the ladder for that order, and only that order', async () => {
    const seen = await placeAndAlert(storeA);
    const sameStore = await placeAndAlert(storeA);
    const nextDoor = await placeAndAlert(storeB);

    const res = await call('POST', `/api/v1/vendor/orders/${seen.orderId}/alert-seen`, staffA1.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ seen: true });
    expect((await receiptsSeen(seen.orderId)).map((r) => r.recipientId)).toEqual([staffA1.userId]);

    for (const { rung } of LADDER) expect(await runLadderRung(deps(), seen.orderId, rung), rung).toBe('stopped');
    expect(stillWaitingPushesTo(ownerA0, seen.orderId)).toEqual([]);
    // Seen is not answered: the order still waits for accept or reject.
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: seen.orderId } })).status).toBe('PENDING');

    expect(await runLadderRung(deps(), sameStore.orderId, 'ring1')).toBe('realerted');
    expect(await runLadderRung(deps(), nextDoor.orderId, 'ring1')).toBe('realerted');
  });

  it('is idempotent: a second call keeps the first sighting', async () => {
    const o = await placeAndAlert(storeA);
    expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, ownerA.token)).statusCode).toBe(200);
    const [first] = await receiptsSeen(o.orderId);
    expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, ownerA.token)).statusCode).toBe(200);
    const again = await receiptsSeen(o.orderId);
    expect(again).toHaveLength(1);
    expect(again[0]!.seenAt!.getTime()).toBe(first!.seenAt!.getTime());
  });

  it('a member who joined after the alert went out can still mark it seen', async () => {
    const o = await placeAndAlert(storeA);
    const late = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, late, ownerA);
    try {
      expect(await app.prisma.alertDelivery.count({ where: { subjectId: o.orderId, recipientId: late.userId } })).toBe(0);
      expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, late.token)).statusCode).toBe(200);
      expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, late.token)).statusCode).toBe(200);
      expect((await receiptsSeen(o.orderId)).map((r) => r.recipientId)).toEqual([late.userId]);
      expect(await runLadderRung(deps(), o.orderId, 'ring1')).toBe('stopped');
    } finally {
      await app.prisma.vendorStaff.deleteMany({ where: { id: membership.id } });
    }
  });

  it('an order still inside its free-cancel hold is not the store to see: 404, nothing recorded', async () => {
    const o = await placeAndAlert(storeA, { holdExpiresAt: new Date(Date.now() + 5 * 60_000) });
    expect((await call('POST', `/api/v1/vendor/orders/${o.orderId}/alert-seen`, ownerA.token)).statusCode).toBe(404);
    expect(await app.prisma.alertDelivery.count({ where: { subjectId: o.orderId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('answering clears the alert for the whole team', () => {
  it('a staff reject clears the owner banner too', async () => {
    const o = await placeAndAlert(storeA);
    const rejected = await call('PUT', `/api/v1/vendor/orders/${o.orderId}/reject`, staffA1.token, { reason: 'Kitchen closed early' });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const rows = await app.prisma.notification.findMany({
      where: { AND: [{ data: { path: ['kind'], equals: 'vendor_order_alert' } }, { data: { path: ['orderId'], equals: o.orderId } }] },
      select: { userId: true, isRead: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.isRead)).toBe(true);
    const pending = await call('GET', '/api/v1/vendor/alerts/pending', ownerA.token);
    expect((pending.json().data as Array<{ data: { orderId: string } }>).map((a) => a.data.orderId)).not.toContain(o.orderId);
  });
});

// ---------------------------------------------------------------------------
describe('the free-cancel hold, and bookings', () => {
  it('nothing rings inside the hold, nor before the release has shown the store the order', async () => {
    const held = await placeAndAlert(storeA, { holdExpiresAt: new Date(Date.now() + 5 * 60_000) });
    const waitingForRelease = await placeAndAlert(storeA, { holdExpiresAt: new Date(Date.now() - 5_000) });
    for (const o of [held, waitingForRelease]) {
      const queue = recordingQueue();
      expect(await runLadderJob({ ...deps(), queue }, { orderId: o.orderId, level: 0 })).toBe('stopped');
      for (const rung of ['ring2', 'sms', 'admin'] as const) expect(await runLadderRung(deps(), o.orderId, rung), rung).toBe('stopped');
      expect(queue.jobs).toEqual([]);
      expect(stillWaitingPushesTo(staffA1Device, o.orderId)).toEqual([]);
    }
    // Released (the sweep clears the hold and alerts the store): now it rings.
    await app.prisma.order.update({ where: { id: held.orderId }, data: { holdExpiresAt: null, releasedToVendorAt: new Date() } });
    await notifications.newOrderForStore({ vendorId: storeA, orderId: held.orderId, orderNumber: held.orderNumber, itemCount: 1, total: 1500, respondBy: held.respondBy });
    expect(await runLadderRung(deps(), held.orderId, 'ring1')).toBe('realerted');
  });

  it('a booking rings only while its store is open; any other order keeps ringing when the store closes', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const salon = await makeStore(owner, 'Ladder Salon');
    const salonDevice = await device(owner);
    const booking = await placeAndAlert(salon, { fulfillment: 'APPOINTMENT' });
    const food = await placeAndAlert(salon);
    await app.prisma.vendor.update({ where: { id: salon }, data: { isCurrentlyOpen: false } });

    const queue = recordingQueue();
    expect(await runLadderJob({ ...deps(), queue }, { orderId: booking.orderId, level: 0 })).toBe('store_closed');
    for (const rung of ['ring2', 'sms', 'admin'] as const) expect(await runLadderRung(deps(), booking.orderId, rung), rung).toBe('store_closed');
    expect(stillWaitingPushesTo(salonDevice, booking.orderId)).toEqual([]);
    expect(smsTo(owner.phone)).toEqual([]);
    expect(await opsRowsFor(adminA.userId, booking.orderId)).toEqual([]);
    // Closed is a pause, not an answer: the later rungs stay armed.
    expect(queue.jobs.map((j) => j.data['rung'])).toEqual(['ring2', 'sms', 'admin']);

    expect(await runLadderRung(deps(), food.orderId, 'ring1')).toBe('realerted');

    await app.prisma.vendor.update({ where: { id: salon }, data: { isCurrentlyOpen: true } });
    expect(await runLadderRung(deps(), booking.orderId, 'ring2')).toBe('realerted');
  });
});

// ---------------------------------------------------------------------------
describe('DeviceToken.alertsVersion: a channel only for an app that has it', () => {
  const register = (token: string, body: Record<string, unknown>) =>
    call('POST', '/api/v1/customer/notifications/devices', token, body);
  const stored = async (token: string) => (await app.prisma.deviceToken.findUniqueOrThrow({ where: { token } })).alertsVersion;

  it('the app reports it at registration; absent (every build out today) is 0, and a malformed value is 0 too', async () => {
    const user = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const token = `ExponentPushToken[q10b${nanoid(14)}]`;
    expect((await register(user.token, { token, platform: 'android' })).statusCode).toBe(200);
    expect(await stored(token)).toBe(0);
    expect((await register(user.token, { token, platform: 'android', alertsVersion: 1 })).statusCode).toBe(200);
    expect(await stored(token)).toBe(1);
    // Back on an older build: it reports nothing, and is sent only what that build can show.
    expect((await register(user.token, { token, platform: 'android' })).statusCode).toBe(200);
    expect(await stored(token)).toBe(0);
    for (const malformed of ['1', -1, 1.5, null]) {
      const res = await register(user.token, { token, platform: 'android', alertsVersion: malformed });
      expect(res.statusCode, `${String(malformed)}: ${res.body}`).toBe(200);
      expect(await stored(token)).toBe(0);
    }
  });

  it('the new-order push names its channel to the channel build only; today’s build gets exactly what it got before', async () => {
    const o = await placeAndAlert(storeA);
    const onOld = pushesTo(ownerA0).find((e) => (e.data as { orderId?: string }).orderId === o.orderId)!;
    const onNew = pushesTo(ownerA1).find((e) => (e.data as { orderId?: string }).orderId === o.orderId)!;
    expect(onOld.options).toEqual({ alertClass: 'ring_order', priority: 'high', sound: 'default', deadlineMs: o.respondBy.getTime() });
    expect(onNew.options).toEqual({ alertClass: 'ring_order', priority: 'high', sound: 'default', deadlineMs: o.respondBy.getTime(), channelId: 'swift_orders_v1' });
    // The re-ring too.
    expect(await runLadderRung(deps(), o.orderId, 'ring1')).toBe('realerted');
    expect(stillWaitingPushesTo(ownerA0, o.orderId)[0]!.options).not.toHaveProperty('channelId');
    expect(stillWaitingPushesTo(ownerA1, o.orderId)[0]!.options).toMatchObject({ channelId: 'swift_orders_v1' });
    // A standard push has no channel of its own on any build.
    await notifications.send({ userId: ownerA.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Hello', body: 'plain', data: { orderId: 'q10b-plain' } });
    for (const token of [ownerA0, ownerA1]) {
      expect(pushesTo(token).find((e) => (e.data as { orderId?: string }).orderId === 'q10b-plain')!.options).not.toHaveProperty('channelId');
    }
  });
});

// ---------------------------------------------------------------------------
describe('this suite cleans up only what it made (AX291 F07)', () => {
  it('an operator receipt this suite did not cause survives its cleanup', async () => {
    const unrelated = await app.prisma.alertDelivery.create({
      data: { kind: 'ADMIN_OPS', subjectId: 'ops_order_unanswered', recipientId: `q10b-unrelated-${nanoid(10)}` },
    });
    try {
      const o = await placeAndAlert(storeA);
      expect(await runLadderRung(deps(), o.orderId, 'admin')).toBe('admin_paged');
      const mine = await operatorReceiptIdsFor([o.orderId]);
      expect(mine.length).toBeGreaterThanOrEqual(2); // the tenant admin and the platform operator
      expect(await app.prisma.alertDelivery.count({ where: { id: { in: mine } } })).toBe(mine.length);
      await purgeOperatorReceipts([o.orderId]);
      expect(await app.prisma.alertDelivery.count({ where: { id: { in: mine } } })).toBe(0);
      expect(await app.prisma.alertDelivery.findUnique({ where: { id: unrelated.id } })).not.toBeNull();
    } finally {
      await app.prisma.alertDelivery.deleteMany({ where: { id: unrelated.id } });
    }
  });
});

// SX392: real deletion and delivery boundaries, without auto-cancellation.
describe('SX392 recipient, deadline and ownership handoffs', () => {
  const snapshot = (orderId: string) => ({ pushes: [ownerA0, ownerA1, staffA1Device, managerADevice].map((t) => stillWaitingPushesTo(t, orderId).length), texts: smsTo(ownerA.phone).length, sockets: emitted.filter((e) => (e.payload as { orderId?: string }).orderId === orderId).length });
  for (const phase of ['initial', 'ring1', 'ring2'] as const) {
    it(`${phase}: a deletion committed after selection prevents subsequent recipient delivery`, async () => {
      const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const membership = await joinTeam(storeA, member, ownerA);
      const token = await device(member);
      const o = await placeAndAlert(storeA, { alert: phase !== 'initial' });
      const initialCount = pushesTo(token).length;
      let deleted = false;
      const drop = async () => {
        if (deleted) return;
        deleted = true;
        await app.prisma.vendorStaff.delete({ where: { id: membership.id } });
      };
      const realDevices = app.prisma.deviceToken.findMany.bind(app.prisma.deviceToken);
      const realReceipt = app.prisma.alertDelivery.create.bind(app.prisma.alertDelivery);
      const seam = phase === 'initial'
        ? vi.spyOn(app.prisma.alertDelivery, 'create').mockImplementation((async (args: Parameters<typeof realReceipt>[0]) => {
          const row = await realReceipt(args);
          if (args.data.recipientId === member.userId) await drop();
          return row;
        }) as unknown as typeof realReceipt)
        : vi.spyOn(app.prisma.deviceToken, 'findMany').mockImplementation((async (args: Parameters<typeof realDevices>[0]) => {
          const rows = await realDevices(args);
          if (rows.some((row) => row.token === token)) await drop();
          return rows;
        }) as typeof realDevices);
      const eventsBefore = emitted.length;
      try {
        if (phase === 'initial') await notifications.newOrderForStore({ vendorId: storeA, ...o, itemCount: 1, total: 1500 });
        else await runLadderRung(deps(), o.orderId, phase);
      } finally { seam.mockRestore(); }
      expect(deleted).toBe(true);
      expect(pushesTo(token)).toHaveLength(initialCount);
      expect(emitted.slice(eventsBefore).filter((e) => e.room === `user:${member.userId}`)).toEqual([]);
      if (phase === 'initial') expect(await app.prisma.notification.count({ where: { userId: member.userId, data: { path: ['orderId'], equals: o.orderId } } })).toBe(0);
      expect(emitted.slice(eventsBefore).some((e) => e.room === `user:${ownerA.userId}`)).toBe(true);
    });
  }

  for (const { rung } of LADDER) {
    it(`${rung}: expiry during the claim await prevents every handoff and refunds unused SMS spend`, async () => {
      const o = await placeAndAlert(storeA);
      const counted = await textsCounted(ownerA.phone);
      const before = snapshot(o.orderId);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const racing = deps({ redis: redisRacingAtClaim(async () => { clock.mockReturnValue(o.respondBy.getTime() + 1); }) });
        expect(await runLadderRung(racing, o.orderId, rung)).toBe('window_closed');
        expect(snapshot(o.orderId)).toEqual(before);
        expect(await opsRowsFor(adminA.userId, o.orderId)).toEqual([]);
        expect(await textsCounted(ownerA.phone)).toBe(counted);
      } finally { clock.mockRestore(); }
    });
  }

  it('an expired pre-submission claim cannot send after its replacement has sent', async () => {
    const o = await placeAndAlert(storeA);
    let resume!: () => void;
    let paused!: () => void;
    const held = new Promise<void>((done) => { paused = done; });
    const wait = new Promise<void>((done) => { resume = done; });
    const key = rungClaimKey(o.orderId, 'sms');
    const a = runLadderRung(deps({ redis: redisRacingAtClaim(async () => { paused(); await wait; }) }), o.orderId, 'sms');
    await held;
    await app.redis.pexpire(key, 1);
    await vi.waitFor(async () => expect(await app.redis.exists(key)).toBe(0));
    expect(await runLadderRung(deps(), o.orderId, 'sms')).toBe('sms_sent');
    resume();
    await a;
    expect(smsTo(ownerA.phone).filter((e) => e.body.includes(o.orderNumber))).toHaveLength(1);
    expect(await app.redis.get(key)).toBe('done:sms_sent');
  });

  it('a provider call still in flight cannot become a fresh send when its short claim expires', async () => {
    const o = await placeAndAlert(storeA);
    let resume!: () => void;
    let submitted!: () => void;
    const called = new Promise<void>((done) => { submitted = done; });
    const wait = new Promise<void>((done) => { resume = done; });
    let submissions = 0;
    const channels = { ...getChannels(), sms: { sendSms: async () => { submissions += 1; submitted(); await wait; throw new Error('response lost after submission'); } } };
    const a = runLadderRung(deps({ channels }), o.orderId, 'sms');
    await called;
    const key = rungClaimKey(o.orderId, 'sms');
    await app.redis.pexpire(key, 1);
    await vi.waitFor(async () => expect(await app.redis.exists(key)).toBe(0));
    const second = await runLadderRung(deps(), o.orderId, 'sms');
    resume();
    expect(await a).toBe('sms_uncertain');
    expect(second).not.toBe('sms_sent');
    expect(submissions).toBe(1);
    expect(smsTo(ownerA.phone).filter((e) => e.body.includes(o.orderNumber))).toEqual([]);
  });
});

describe('SX392 convergence deadlines', () => {
  for (const remembered of [false, true]) {
    it(`a stalled positive cannot ${remembered ? 'readmit a remembered' : 'retain a joined'} socket`, async () => {
      const io = new SocketIoServer();
      const vendorId = `q10b-r5-${nanoid(6)}`;
      const rooms = new Set<string>([`vendor:${vendorId}`]);
      const phone = { id: `q10b-${nanoid(6)}`, connected: true, data: { userId: ownerA.userId, tenantId: 'swift-default' }, rooms,
        join: vi.fn((room: string) => { rooms.add(room); }), leave: vi.fn((room: string) => { rooms.delete(room); }) };
      io.of('/').sockets.set(phone.id, phone as unknown as ServerSocket);
      if (remembered) {
        expect((await convergeStoreRooms(io, { readMembers: async () => { throw new Error('temporary failure'); }, timeoutMs: 50 })).outcome).toBe('read_failed');
        expect(rooms.has(`vendor:${vendorId}`)).toBe(false);
      }
      const result = await convergeStoreRooms(io, { timeoutMs: 50, readMembers: async (pairs) => {
        const until = performance.now() + 120;
        while (performance.now() < until) { /* a positive answer beats the overdue timer */ }
        return new Set(pairs.map(storeRoomMemberKey));
      } });
      expect(result.outcome).toBe('read_failed');
      expect(rooms.has(`vendor:${vendorId}`)).toBe(false);
      expect(phone.join).not.toHaveBeenCalled();
    });
  }
});


describe('SX392 actual transport serialization', () => {
  it('DELETE waits until actual Expo handoff, then commits before the provider reply', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const membership = await joinTeam(storeA, member, ownerA);
    let authorityHeld!: () => void;
    let permit!: () => void;
    let reply!: (response: Response) => void;
    let transportStarted!: () => void;
    const locked = new Promise<void>((done) => { authorityHeld = done; });
    const wait = new Promise<void>((done) => { permit = done; });
    const started = new Promise<void>((done) => { transportStarted = done; });
    const response = new Promise<Response>((done) => { reply = done; });
    let removed = false;
    let submitted = false;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      submitted = true;
      expect(removed).toBe(false);
      transportStarted();
      return response;
    });
    try {
      const submit = storeAlertSubmission(app.prisma, storeA, member.userId, async () => { authorityHeld(); await wait; return true; });
      const delivery = new ExpoPushProvider().sendPush(['ExponentPushToken[r5-authority]'], 'Order', 'Body', undefined, { alertClass: 'standard', priority: 'high', submit });
      await locked;
      const deletion = app.prisma.vendorStaff.delete({ where: { id: membership.id } }).then(() => { removed = true; });
      await vi.waitFor(async () => {
        const waiting = await app.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%vendor_staff%'`;
        expect(Number(waiting[0]!.count)).toBeGreaterThan(0);
      }, { timeout: 2_000, interval: 10 });
      expect(submitted).toBe(false);
      permit();
      await started;
      await vi.waitFor(() => expect(removed).toBe(true), { timeout: 1_000, interval: 10 });
      await deletion;
      expect(removed).toBe(true); // response remains pending; no lock spans network completion
      reply(new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }));
      expect((await delivery).sent).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { permit?.(); reply?.(new Response('{}')); fetcher.mockRestore(); }
  });

  for (const phase of ['initial', 'ring1', 'ring2'] as const) {
    it(`${phase}: deletion after the first real Expo chunk prevents the next chunk`, async () => {
      const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const membership = await joinTeam(storeA, member, ownerA);
      const tokens = Array.from({ length: 101 }, (_, i) => `ExponentPushToken[r5-${nanoid(6)}-${i}]`);
      await app.prisma.deviceToken.createMany({ data: tokens.map((token) => ({ userId: member.userId, token, platform: 'android', alertsVersion: 0 })) });
      const o = await placeAndAlert(storeA, { alert: phase !== 'initial' });
      let first!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((done) => { first = done; });
      const wait = new Promise<void>((done) => { resume = done; });
      const handed: string[] = [];
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
        const messages = JSON.parse(String(options?.body)) as Array<{ to: string }>;
        const mine = messages.filter((m) => tokens.includes(m.to));
        handed.push(...mine.map((m) => m.to));
        if (mine.length) { first(); await wait; }
        return new Response(JSON.stringify({ data: messages.map(() => ({ status: 'ok' })) }), { status: 200 });
      });
      const channels = { ...getChannels(), push: withPushRetry(new ExpoPushProvider(), [1]) };
      try {
        const delivery = phase === 'initial'
          ? new NotificationService(app.prisma, ioRecorder, channels).newOrderForStore({ vendorId: storeA, ...o, itemCount: 1, total: 1500 })
          : runLadderRung(deps({ channels }), o.orderId, phase);
        await entered;
        await app.prisma.vendorStaff.delete({ where: { id: membership.id } });
        const afterDeletion = emitted.length;
        resume();
        await delivery;
        expect(handed).toHaveLength(100);
        expect(emitted.slice(afterDeletion).filter((e) => e.room === `user:${member.userId}`)).toEqual([]);
      } finally { resume?.(); fetcher.mockRestore(); }
    });

    it(`${phase}: definitive rejection can retry, but a committed deletion cancels that recipient's retry`, async () => {
      const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const membership = await joinTeam(storeA, member, ownerA);
      const token = await device(member);
      const o = await placeAndAlert(storeA, { alert: phase !== 'initial' });
      let attempts = 0;
      let removed: Promise<unknown> | undefined;
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
        const messages = JSON.parse(String(options?.body)) as Array<{ to: string }>;
        if (messages.some((m) => m.to === token)) {
          attempts += 1;
          removed = app.prisma.vendorStaff.delete({ where: { id: membership.id } }).then(() => undefined);
          return new Response('rejected', { status: 429 });
        }
        return new Response(JSON.stringify({ data: messages.map(() => ({ status: 'ok' })) }), { status: 200 });
      });
      const channels = { ...getChannels(), push: withPushRetry(new ExpoPushProvider(), [50]) };
      try {
        if (phase === 'initial') await new NotificationService(app.prisma, ioRecorder, channels).newOrderForStore({ vendorId: storeA, ...o, itemCount: 1, total: 1500 });
        else await runLadderRung(deps({ channels }), o.orderId, phase);
        await removed;
        expect(attempts).toBe(1);
      } finally { fetcher.mockRestore(); }
    });
  }
});


describe('SX392 final awaited stages and completion', () => {
  for (const stage of ['final order read', 'Redis fence'] as const) {
    for (const { rung } of LADDER) {
      it(`${rung}: expiry during ${stage} prevents a late handoff`, async () => {
        const o = await placeAndAlert(storeA);
        const counted = await textsCounted(ownerA.phone);
        const before = emitted.length;
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const realRead = app.prisma.notification.findFirst.bind(app.prisma.notification);
        let reads = 0;
        const read = vi.spyOn(app.prisma.notification, 'findFirst').mockImplementation((async (args: Parameters<typeof realRead>[0]) => {
          const result = await realRead(args);
          if (stage === 'final order read' && ++reads === 2) clock.mockReturnValue(o.respondBy.getTime() + 1);
          return result;
        }) as typeof realRead);
        const redis = new Proxy(app.redis, { get(target, prop) {
          if (prop === 'eval') return async (...args: Parameters<Redis['eval']>) => {
            const result = await (target.eval as (...a: unknown[]) => Promise<unknown>)(...args);
            if (stage === 'Redis fence' && String(args[0]).includes('PEXPIRE')) clock.mockReturnValue(o.respondBy.getTime() + 1);
            return result;
          };
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        } }) as Redis;
        try {
          expect(await runLadderRung(deps({ redis }), o.orderId, rung)).toBe('window_closed');
          expect(emitted.slice(before)).toEqual([]);
          expect(await opsRowsFor(adminA.userId, o.orderId)).toEqual([]);
          expect(await textsCounted(ownerA.phone)).toBe(counted);
        } finally { read.mockRestore(); clock.mockRestore(); }
      });
    }
  }

  it('expiry after SMS budget reservation refunds it without submission', async () => {
    const o = await placeAndAlert(storeA);
    const counted = await textsCounted(ownerA.phone);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const redis = new Proxy(app.redis, { get(target, prop) {
      if (prop === 'incr') return async (key: string) => {
        const result = await target.incr(key);
        if (key.startsWith(STORE_ALERT_SMS_DAILY_PREFIX)) clock.mockReturnValue(o.respondBy.getTime() + 1);
        return result;
      };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Redis;
    try {
      expect(await runLadderRung(deps({ redis }), o.orderId, 'sms')).toBe('window_closed');
      expect(await textsCounted(ownerA.phone)).toBe(counted);
      expect(smsTo(ownerA.phone).filter((e) => e.body.includes(o.orderNumber))).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it('completion cannot overwrite a replacement claim even after a successful submission', async () => {
    const o = await placeAndAlert(storeA);
    const key = rungClaimKey(o.orderId, 'sms');
    const real = getChannels().sms;
    const channels = { ...getChannels(), sms: { sendSms: async (to: string, body: string) => {
      const result = await real.sendSms(to, body);
      await app.redis.set(key, 'sending:replacement', 'PX', RUNG_SENDING_TTL_MS);
      return result;
    } } };
    expect(await runLadderRung(deps({ channels }), o.orderId, 'sms')).toBe('sms_sent');
    expect(await app.redis.get(key)).toBe('sending:replacement');
  });

  for (const status of [429, 503]) {
    it(`Expo ${status}: ${status === 429 ? 'a proven rejection can retry' : 'an uncertain submission cannot retry'}`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const vendor = await makeStore(owner, `R5 ${status}`);
      await device(owner);
      const o = await placeAndAlert(vendor);
      let attempts = 0;
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        attempts += 1;
        return attempts === 1 ? new Response('failure', { status }) : new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 });
      });
      try {
        await runLadderRung(deps({ channels: { ...getChannels(), push: withPushRetry(new ExpoPushProvider(), [1, 1]) } }), o.orderId, 'ring1');
        expect(attempts).toBe(status === 429 ? 2 : 1);
      } finally { fetcher.mockRestore(); }
    });
  }
});


describe('SX392 handoff boundary controls', () => {
  it('an expired claim with no replacement still cannot submit', async () => {
    const o = await placeAndAlert(storeA);
    const redis = redisRacingAtClaim(async () => {
      const key = rungClaimKey(o.orderId, 'sms');
      await app.redis.pexpire(key, 1);
      await vi.waitFor(async () => expect(await app.redis.exists(key)).toBe(0));
    });
    await runLadderRung(deps({ redis }), o.orderId, 'sms');
    expect(smsTo(ownerA.phone).filter((e) => e.body.includes(o.orderNumber))).toEqual([]);
  });

  it('the Expo deadline is measured after an awaited submission guard', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }));
    try {
      const result = await new ExpoPushProvider().sendPush(['ExponentPushToken[r5-expiry]'], 'Order', 'Body', undefined, {
        alertClass: 'standard', priority: 'high', deadlineMs: now + 2_000,
        submit: async (start) => { await Promise.resolve(); clock.mockReturnValue(now + 2_001); return start(); },
      });
      expect(result.sent).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); fetcher.mockRestore(); }
  });

  it('a stalled authority callback cannot hand off after its bounded transaction window', async () => {
    const now = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(now);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }));
    try {
      const submit = storeAlertSubmission(app.prisma, storeA, ownerA.userId, async () => { clock.mockReturnValue(now + 4_001); return true; });
      const result = await new ExpoPushProvider().sendPush(['ExponentPushToken[r5-stall]'], 'Order', 'Body', undefined, { alertClass: 'standard', priority: 'high', submit });
      expect(result.sent).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); fetcher.mockRestore(); }
  });
});


describe('SX403 active owner authority', () => {
  for (const phase of ['initial', 'ring1', 'ring2'] as const) {
    it(`${phase}: committed owner deactivation after selection prevents delivery`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const vendorId = await makeStore(owner, 'Owner authority fixture');
      const token = await device(owner);
      const o = await placeAndAlert(vendorId, { alert: phase !== 'initial' });
      const inboxBefore = await app.prisma.notification.count({ where: { userId: owner.userId } });
      let deactivated = false;
      const deactivate = async () => {
        if (deactivated) return;
        await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } });
        deactivated = true;
      };
      const realDevices = app.prisma.deviceToken.findMany.bind(app.prisma.deviceToken);
      const realReceipt = app.prisma.alertDelivery.create.bind(app.prisma.alertDelivery);
      const seam = phase === 'initial'
        ? vi.spyOn(app.prisma.alertDelivery, 'create').mockImplementation((async (args: Parameters<typeof realReceipt>[0]) => {
          const row = await realReceipt(args);
          if (args.data.recipientId === owner.userId) await deactivate();
          return row;
        }) as unknown as typeof realReceipt)
        : vi.spyOn(app.prisma.deviceToken, 'findMany').mockImplementation((async (args: Parameters<typeof realDevices>[0]) => {
          const rows = await realDevices(args);
          if (rows.some((row) => row.token === token)) await deactivate();
          return rows;
        }) as typeof realDevices);
      const handed: string[] = [];
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
        const messages = JSON.parse(String(options?.body)) as Array<{ to: string }>;
        handed.push(...messages.map((message) => message.to));
        return new Response(JSON.stringify({ data: messages.map(() => ({ status: 'ok' })) }), { status: 200 });
      });
      const channels = { ...getChannels(), push: withPushRetry(new ExpoPushProvider(), [1]) };
      const eventsBefore = emitted.length;
      try {
        if (phase === 'initial') await new NotificationService(app.prisma, ioRecorder, channels).newOrderForStore({ vendorId, ...o, itemCount: 1, total: 1500 });
        else await runLadderRung(deps({ channels }), o.orderId, phase);
        expect(deactivated).toBe(true);
        expect(handed).not.toContain(token);
        expect(emitted.slice(eventsBefore).filter((event) => event.room === `user:${owner.userId}`)).toEqual([]);
        expect(await app.prisma.notification.count({ where: { userId: owner.userId } })).toBe(inboxBefore);
        expect(await app.prisma.deviceToken.count({ where: { userId: owner.userId, isActive: true } })).toBe(1);
      } finally { seam.mockRestore(); fetcher.mockRestore(); }
    });
  }
});


describe('SX403 owner transport boundaries', () => {
  it('an inactive owner is absent from recipient selection and socket membership with devices retained', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorId = await makeStore(owner, 'Inactive selection fixture');
    await device(owner);
    expect(await storeAlertRecipients(app.prisma, vendorId)).toContain(owner.userId);
    expect(await isStoreRoomMember(app.prisma, vendorId, owner.userId, 'swift-default')).toBe(true);
    await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } });
    expect(await storeAlertRecipients(app.prisma, vendorId)).not.toContain(owner.userId);
    expect(await isStoreRoomMember(app.prisma, vendorId, owner.userId, 'swift-default')).toBe(false);
    expect(await app.prisma.deviceToken.count({ where: { userId: owner.userId, isActive: true } })).toBe(1);
  });

  for (const phase of ['initial', 'ring1', 'ring2'] as const) {
    it(`${phase}: owner deactivation after a real Expo chunk blocks the next chunk`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const vendorId = await makeStore(owner, 'Owner chunk fixture');
      const tokens = Array.from({ length: 101 }, (_, i) => `ExponentPushToken[r6-${nanoid(6)}-${i}]`);
      await app.prisma.deviceToken.createMany({ data: tokens.map((token) => ({ userId: owner.userId, token, platform: 'android', alertsVersion: 0 })) });
      const o = await placeAndAlert(vendorId, { alert: phase !== 'initial' });
      let first!: () => void; let resume!: () => void;
      const entered = new Promise<void>((done) => { first = done; });
      const wait = new Promise<void>((done) => { resume = done; });
      const handed: string[] = [];
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
        const messages = JSON.parse(String(options?.body)) as Array<{ to: string }>;
        handed.push(...messages.map((message) => message.to));
        first(); await wait;
        return new Response(JSON.stringify({ data: messages.map(() => ({ status: 'ok' })) }), { status: 200 });
      });
      const channels = { ...getChannels(), push: withPushRetry(new ExpoPushProvider(), [1]) };
      try {
        const delivery = phase === 'initial'
          ? new NotificationService(app.prisma, ioRecorder, channels).newOrderForStore({ vendorId, ...o, itemCount: 1, total: 1500 })
          : runLadderRung(deps({ channels }), o.orderId, phase);
        await entered;
        await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } });
        const eventsBefore = emitted.length;
        resume(); await delivery;
        expect(handed).toHaveLength(100);
        expect(emitted.slice(eventsBefore).filter((event) => event.room === `user:${owner.userId}`)).toEqual([]);
      } finally { resume?.(); fetcher.mockRestore(); }
    });

    it(`${phase}: committed owner deactivation prevents retry after an Expo rejection`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const vendorId = await makeStore(owner, 'Owner retry fixture');
      const token = await device(owner);
      const o = await placeAndAlert(vendorId, { alert: phase !== 'initial' });
      let attempts = 0; let deactivated: Promise<unknown> | undefined;
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
        const messages = JSON.parse(String(options?.body)) as Array<{ to: string }>;
        if (messages.some((message) => message.to === token)) {
          attempts++;
          deactivated = app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } }).then(() => undefined);
          await deactivated; // commit before the rejection makes any retry eligible
          return new Response('rejected', { status: 429 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      });
      const channels = { ...getChannels(), push: withPushRetry(new ExpoPushProvider(), [50]) };
      try {
        if (phase === 'initial') await new NotificationService(app.prisma, ioRecorder, channels).newOrderForStore({ vendorId, ...o, itemCount: 1, total: 1500 });
        else await runLadderRung(deps({ channels }), o.orderId, phase);
        await deactivated;
        expect(attempts).toBe(1);
      } finally { fetcher.mockRestore(); }
    });
  }

  it('owner deactivation waits for actual transport and commits before its response', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorId = await makeStore(owner, 'Owner lock fixture');
    let authorityHeld!: () => void; let permit!: () => void; let started!: () => void; let reply!: (response: Response) => void;
    const locked = new Promise<void>((done) => { authorityHeld = done; });
    const wait = new Promise<void>((done) => { permit = done; });
    const invoked = new Promise<void>((done) => { started = done; });
    const response = new Promise<Response>((done) => { reply = done; });
    let deactivated = false;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { expect(deactivated).toBe(false); started(); return response; });
    let delivery: ReturnType<ExpoPushProvider['sendPush']> | undefined; let cutoff: Promise<void> | undefined;
    try {
      const submit = storeAlertSubmission(app.prisma, vendorId, owner.userId, async () => { authorityHeld(); await wait; return true; });
      delivery = new ExpoPushProvider().sendPush(['ExponentPushToken[r6-owner-lock]'], 'Order', 'Body', undefined, { alertClass: 'standard', priority: 'high', submit });
      await locked;
      cutoff = app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } }).then(() => { deactivated = true; });
      await vi.waitFor(async () => {
        const waiting = await app.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%users%'`;
        expect(Number(waiting[0]!.count)).toBeGreaterThan(0);
      }, { timeout: 2_000, interval: 10 });
      expect(fetcher).not.toHaveBeenCalled();
      permit(); await invoked; await cutoff;
      expect(deactivated).toBe(true);
      reply(new Response(JSON.stringify({ data: [{ status: 'ok' }] }), { status: 200 }));
      expect((await delivery).sent).toBe(1);
    } finally {
      permit?.(); reply?.(new Response('{}'));
      await Promise.allSettled([delivery, cutoff]);
      fetcher.mockRestore();
    }
  });
});


describe('SX403 durable stop and destination boundaries', () => {
  for (const stop of ['seen', 'ack', 'accept'] as const) {
    for (const { rung } of LADDER) {
      it(`${rung}: ${stop} committed inside the final Redis fence prevents subsequent handoff`, async () => {
        const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
        const vendorId = await makeStore(owner, 'Stop fence fixture');
        const token = await device(owner);
        const o = await placeAndAlert(vendorId);
        const before = emitted.length; const count = await textsCounted(owner.phone);
        const pushes = pushesTo(token).length;
        let stopped = false;
        const redis = new Proxy(app.redis, { get(target, prop) {
          if (prop === 'eval') return async (...args: Parameters<Redis['eval']>) => {
            const result = await (target.eval as (...a: unknown[]) => Promise<unknown>)(...args);
            if (!stopped && String(args[0]).includes('PEXPIRE')) {
              stopped = true;
              const response = await call(stop === 'seen' ? 'POST' : 'PUT', `/api/v1/vendor/orders/${o.orderId}/${stop === 'seen' ? 'alert-seen' : stop}`, owner.token);
              expect(response.statusCode).toBe(200);
            }
            return result;
          };
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        } }) as Redis;
        await runLadderRung(deps({ redis }), o.orderId, rung);
        expect(stopped).toBe(true);
        expect(emitted.slice(before).filter((event) => (event.payload as { orderId?: string; data?: { orderId?: string } }).orderId === o.orderId || (event.payload as { data?: { orderId?: string } }).data?.orderId === o.orderId).filter((event) => event.event === 'vendor:order_alert' || event.event === 'notification' && event.room !== `user:${customer.userId}`)).toEqual([]);
        expect(pushesTo(token)).toHaveLength(pushes);
        expect(smsTo(owner.phone).filter((entry) => entry.body.includes(o.orderNumber))).toEqual([]);
        expect(await app.prisma.notification.count({ where: { AND: [{ data: { path: ['kind'], equals: 'ops_order_unanswered' } }, { data: { path: ['orderId'], equals: o.orderId } }] } })).toBe(0);
        expect(await textsCounted(owner.phone)).toBe(count);
      });
    }
  }

  it('SMS refreshes the reserved destination after a committed phone replacement', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const replacement = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const vendorId = await makeStore(owner, 'Destination fixture');
    const o = await placeAndAlert(vendorId);
    const oldCount = await textsCounted(owner.phone); const newCount = await textsCounted(replacement.phone);
    let changed = false;
    const redis = new Proxy(app.redis, { get(target, prop) {
      if (prop === 'incr') return async (key: string) => {
        const result = await target.incr(key);
        if (!changed && key.startsWith(STORE_ALERT_SMS_DAILY_PREFIX)) {
          changed = true;
          await app.prisma.vendor.update({ where: { id: vendorId }, data: { phone: replacement.phone } });
        }
        return result;
      };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Redis;
    expect(await runLadderRung(deps({ redis }), o.orderId, 'sms')).toBe('sms_sent');
    expect(changed).toBe(true);
    expect(smsTo(owner.phone).filter((entry) => entry.body.includes(o.orderNumber))).toEqual([]);
    expect(smsTo(replacement.phone).filter((entry) => entry.body.includes(o.orderNumber))).toHaveLength(1);
    expect(await textsCounted(owner.phone)).toBe(oldCount);
    expect(await textsCounted(replacement.phone)).toBe(newCount + 1);
  });

  it('SMS cannot use a fallback owner deactivated during budget reservation', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorId = await makeStore(owner, 'Fallback cutoff fixture', '');
    const o = await placeAndAlert(vendorId);
    const count = await textsCounted(owner.phone);
    let changed = false;
    const redis = new Proxy(app.redis, { get(target, prop) {
      if (prop === 'incr') return async (key: string) => {
        const result = await target.incr(key);
        if (!changed && key.startsWith(STORE_ALERT_SMS_DAILY_PREFIX)) {
          changed = true;
          await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } });
        }
        return result;
      };
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Redis;
    expect(await runLadderRung(deps({ redis }), o.orderId, 'sms')).not.toBe('sms_sent');
    expect(smsTo(owner.phone).filter((entry) => entry.body.includes(o.orderNumber))).toEqual([]);
    expect(await textsCounted(owner.phone)).toBe(count);
  });
});

describe('SX403 authoritative deadline without inbox', () => {
  for (const failed of [false, true]) {
    for (const { rung } of LADDER) {
      it(`${rung}: ${failed ? 'failed' : 'absent'} initial inbox cannot extend a late pending order`, async () => {
        const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
        const vendorId = await makeStore(owner, 'Deadline fixture');
        await device(owner);
        const o = await placeAndAlert(vendorId, { alert: false, placedAt: new Date(Date.now() - 11 * 60_000) });
        if (failed) {
          const persist = vi.spyOn(app.prisma, '$transaction').mockRejectedValueOnce(new Error('synthetic inbox persistence failure'));
          try { await notifications.newOrderForStore({ vendorId, ...o, itemCount: 1, total: 1500 }); }
          finally { persist.mockRestore(); }
        }
        expect(await app.prisma.notification.count({ where: { userId: owner.userId } })).toBe(0);
        const events = emitted.length;
        expect(await runLadderRung(deps(), o.orderId, rung)).toBe('window_closed');
        expect(emitted.slice(events)).toEqual([]);
        expect(smsTo(owner.phone).filter((entry) => entry.body.includes(o.orderNumber))).toEqual([]);
        expect(await app.prisma.notification.count({ where: { AND: [{ data: { path: ['kind'], equals: 'ops_order_unanswered' } }, { data: { path: ['orderId'], equals: o.orderId } }] } })).toBe(0);
        expect((await app.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('PENDING');
      });
    }
  }
});


/** Pause after real subordinate authority rows have been locked. */
function pauseLockedAuthority() {
  let held!: () => void; let release!: () => void;
  const locked = new Promise<void>((done) => { held = done; });
  const wait = new Promise<void>((done) => { release = done; });
  const transaction = app.prisma.$transaction.bind(app.prisma);
  let paused = false;
  const spy = vi.spyOn(app.prisma, '$transaction').mockImplementation(((work: any, options: any) => {
    if (typeof work !== 'function') return transaction(work, options);
    return transaction((tx) => work(new Proxy(tx, { get(target, prop) {
      if (prop === '$queryRaw') return async (...args: any[]) => {
        const result = await (target.$queryRaw as any)(...args);
        const sql = Array.isArray(args[0]) ? args[0].join(' ') : args[0]?.strings?.join(' ') ?? '';
        if (!paused && sql.includes('FOR SHARE OF') && sql.includes('NOWAIT')) { paused = true; held(); await wait; }
        return result;
      };
      return Reflect.get(target, prop, target);
    } })), options);
  }) as typeof transaction);
  return { locked, release, restore: () => spy.mockRestore() };
}

function syntheticSmsChannels(from: string) {
  vi.stubEnv('NOTIFICATION_PROVIDER', 'twilio');
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC' + '1'.repeat(32));
  vi.stubEnv('TWILIO_API_KEY_SID', 'SK' + '2'.repeat(32));
  vi.stubEnv('TWILIO_API_KEY_SECRET', '3'.repeat(32));
  vi.stubEnv('TWILIO_FROM', from);
  vi.stubEnv('TWILIO_MESSAGING_SERVICE_SID', '');
  return getChannels();
}

async function waitForOrderLock() {
  await vi.waitFor(async () => {
    const waiting = await app.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%orders%'`;
    expect(Number(waiting[0]!.count)).toBeGreaterThan(0);
  }, { timeout: 2_000, interval: 10 });
}

describe('SX403 stop and destination serialization at actual fetch', () => {
  for (const stop of ['seen', 'ack', 'read', 'read-all', 'vendor-ack'] as const) {
    it(`${stop}: waits for SMS fetch invocation and commits before its response`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const vendorId = await makeStore(owner, 'Stop ordering fixture');
      const o = await placeAndAlert(vendorId);
      const notification = await app.prisma.notification.findFirstOrThrow({ where: { userId: owner.userId, data: { path: ['orderId'], equals: o.orderId } } });
      // Prove the missing-receipt insert path also takes the parent Order lock.
      if (stop === 'seen') await app.prisma.alertDelivery.deleteMany({ where: { kind: 'VENDOR_ORDER', subjectId: o.orderId } });
      const barrier = pauseLockedAuthority();
      let started!: () => void; let reply!: (response: Response) => void; let committed = false;
      const invoked = new Promise<void>((done) => { started = done; });
      const response = new Promise<Response>((done) => { reply = done; });
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { expect(committed).toBe(false); started(); return response; });
      let delivery: ReturnType<typeof runLadderRung> | undefined; let stopped: Promise<void> | undefined;
      try {
        const channels = syntheticSmsChannels(owner.phone);
        delivery = runLadderRung(deps({ channels }), o.orderId, 'sms');
        await barrier.locked;
        stopped = (stop === 'seen' ? markStoreAlertSeen(app.prisma, o.orderId, owner.userId)
          : stop === 'ack' ? acknowledgeAlert(app.prisma, 'VENDOR_ORDER', o.orderId)
            : stop === 'read' ? notifications.markAsRead(owner.userId, notification.id)
              : stop === 'read-all' ? notifications.markAllAsRead(owner.userId)
                : call('PUT', `/api/v1/vendor/orders/${o.orderId}/ack`, owner.token).then((result) => { expect(result.statusCode).toBe(200); }))
          .then(() => { committed = true; });
        await waitForOrderLock(); expect(fetcher).not.toHaveBeenCalled();
        barrier.release(); await invoked; await stopped;
        expect(committed).toBe(true); // provider response is still pending
        reply(new Response(JSON.stringify({ sid: 'SM' + '4'.repeat(32) }), { status: 201 }));
        expect(await delivery).toBe('sms_sent');
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        barrier.release(); reply?.(new Response('{}'));
        // Failed mutation assertions must settle every task before restoring fake transport.
        await Promise.allSettled([delivery, stopped]);
        barrier.restore(); fetcher.mockRestore(); vi.unstubAllEnvs();
      }
    });
  }

  it('a replacement phone waits behind SMS authority and commits before the fetch response', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const replacement = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const vendorId = await makeStore(owner, 'Destination ordering fixture');
    const o = await placeAndAlert(vendorId);
    const barrier = pauseLockedAuthority();
    let started!: () => void; let reply!: (response: Response) => void; let changed = false;
    const invoked = new Promise<void>((done) => { started = done; });
    const response = new Promise<Response>((done) => { reply = done; });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      expect(new URLSearchParams(String(init?.body)).get('To')).toBe(owner.phone);
      expect(changed).toBe(false); started(); return response;
    });
    let delivery: ReturnType<typeof runLadderRung> | undefined; let replacementWrite: Promise<void> | undefined;
    try {
      delivery = runLadderRung(deps({ channels: syntheticSmsChannels(owner.phone) }), o.orderId, 'sms');
      await barrier.locked;
      replacementWrite = app.prisma.vendor.update({ where: { id: vendorId }, data: { phone: replacement.phone } }).then(() => { changed = true; });
      await vi.waitFor(async () => {
        const waiting = await app.prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%vendors%'`;
        expect(Number(waiting[0]!.count)).toBeGreaterThan(0);
      }, { timeout: 2_000, interval: 10 });
      barrier.release(); await invoked; await replacementWrite;
      expect(changed).toBe(true);
      reply(new Response(JSON.stringify({ sid: 'SM' + '4'.repeat(32) }), { status: 201 }));
      expect(await delivery).toBe('sms_sent');
    } finally {
      barrier.release(); reply?.(new Response('{}'));
      await Promise.allSettled([delivery, replacementWrite]);
      barrier.restore(); fetcher.mockRestore(); vi.unstubAllEnvs();
    }
  });
});

describe('SX403 durable deadline policy snapshots', () => {
  for (const kind of ['held', 'appointment'] as const) {
    it(`${kind}: preserved outbox timing survives absent inbox and later SLA changes`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const vendorId = await makeStore(owner, 'Snapshot timing fixture');
      const placedAt = new Date();
      const o = await placeAndAlert(vendorId, { alert: false, placedAt, fulfillment: kind === 'appointment' ? 'APPOINTMENT' : 'PICKUP',
        ...(kind === 'held' ? { holdExpiresAt: new Date(placedAt.getTime() + 5 * 60_000) } : {}) });
      // Appointment slot is three hours away: canonical cutoff is slot minus one hour.
      if (kind === 'appointment') await app.prisma.order.update({ where: { id: o.orderId }, data: { appointmentSlot: new Date(placedAt.getTime() + 3 * 60 * 60_000) } });
      const order = await app.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
      await app.prisma.$transaction((tx) => persistCheckoutOutboxInTransaction(tx, {
        orders: [order], timing: { alertDelayMs: 30_000, autoCancelDelayMs: 15 * 60_000, vendorResponseSlaMinutes: 10 },
      }));
      const outbox = await app.prisma.orderOutbox.findFirstOrThrow({ where: { orderId: o.orderId, kind: 'auto-cancel' } });
      expect(outbox.delayMs).toBe(kind === 'held' ? 15 * 60_000 : 2 * 60 * 60_000);
      if (kind === 'held') await app.prisma.order.update({ where: { id: o.orderId }, data: { holdExpiresAt: null, releasedToVendorAt: new Date(placedAt.getTime() + 5 * 60_000) } });
      const realConfig = app.prisma.platformConfig.findUnique.bind(app.prisma.platformConfig);
      const config = vi.spyOn(app.prisma.platformConfig, 'findUnique').mockImplementation(((args: any) => args.where.key === 'order_auto_reject_minutes' ? Promise.resolve({ key: args.where.key, value: 1 }) : realConfig(args)) as typeof realConfig);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(outbox.createdAt.getTime() + (kind === 'held' ? 6 * 60_000 : 90 * 60_000));
      try {
        expect(await runLadderRung(deps(), o.orderId, 'sms')).toBe('sms_sent');
        clock.mockReturnValue(outbox.createdAt.getTime() + outbox.delayMs + 1);
        expect(await runLadderRung(deps(), o.orderId, 'admin')).toBe('window_closed');
        expect((await app.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('PENDING');
      } finally { clock.mockRestore(); config.mockRestore(); }
    });
  }
});


async function holdUserAuthority(userId: string) {
  let locked!: () => void; let release!: () => void;
  const entered = new Promise<void>((done) => { locked = done; });
  const wait = new Promise<void>((done) => { release = done; });
  const transaction = app.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    locked(); await wait;
  }, { timeout: 10_000 });
  await entered;
  return { release: async () => { release(); await transaction; } };
}

describe('SX403 bounded not-submitted ownership', () => {
  for (const newer of ['none', 'claim', 'marker', 'both'] as const) {
    it(`pre-handoff contention retries without sending and ${newer === 'none' ? 'releases only its own marker' : `preserves ${newer} token`}`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const vendorId = await makeStore(owner, 'Contention fixture');
      await device(owner);
      const o = await placeAndAlert(vendorId);
      const held = await holdUserAuthority(owner.userId);
      const key = rungClaimKey(o.orderId, 'ring1');
      const queue = recordingQueue(); const before = emitted.length;
      let replaced = false; let expectedClaim: string | null = null; let expectedMarker: string | null = null;
      const redis = new Proxy(app.redis, { get(target, prop) {
        if (prop === 'eval') return async (...args: Parameters<Redis['eval']>) => {
          if (newer !== 'none' && !replaced && String(args[0]).includes("local submitted") && String(args[0]).includes("'DEL'")) {
            replaced = true;
            if (newer === 'claim' || newer === 'both') await target.set(key, 'sending:newer-worker', 'PX', RUNG_SENDING_TTL_MS);
            if (newer === 'marker' || newer === 'both') await target.set(`${key}:submitted`, 'sending:newer-worker', 'EX', 86400);
            expectedClaim = await target.get(key); expectedMarker = await target.get(`${key}:submitted`);
          }
          return (target.eval as (...a: unknown[]) => Promise<unknown>)(...args);
        };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as Redis;
      try {
        expect(await runLadderJob({ ...deps({ redis }), queue }, { orderId: o.orderId, rung: 'ring1' })).toBe('not_submitted');
        expect(emitted.slice(before)).toEqual([]);
        expect(queue.jobs.filter((job) => job.data['rung'] === 'admin')).toHaveLength(1);
        expect(queue.jobs.filter((job) => job.data['rung'] === 'ring1')).toMatchObject([{ data: { retry: 1 }, opts: { delay: 1000 } }]);
        expect(await app.redis.get(key)).toBe(expectedClaim);
        expect(await app.redis.get(`${key}:submitted`)).toBe(expectedMarker);
      } finally { await held.release(); }
    });
  }

  it('contention after a partial handoff retains its marker and never retries the whole rung', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const vendorId = await makeStore(owner, 'Partial handoff fixture');
    await joinTeam(vendorId, member, owner);
    const ownerToken = await device(owner); const memberToken = await device(member);
    const o = await placeAndAlert(vendorId);
    const held = await holdUserAuthority(member.userId);
    const queue = recordingQueue();
    try {
      expect(await runLadderJob({ ...deps(), queue }, { orderId: o.orderId, rung: 'ring1' })).toBe('realerted');
      expect(stillWaitingPushesTo(ownerToken, o.orderId)).toHaveLength(1);
      expect(stillWaitingPushesTo(memberToken, o.orderId)).toEqual([]);
      expect(queue.jobs.filter((job) => job.data['rung'] === 'ring1')).toEqual([]);
      expect(queue.jobs.filter((job) => job.data['rung'] === 'admin')).toHaveLength(1);
      expect(await app.redis.get(`${rungClaimKey(o.orderId, 'ring1')}:submitted`)).not.toBeNull();
    } finally { await held.release(); }
  });

  for (const retry of [0, 3]) {
    it(`two destination changes refund both unused reservations and respect retry count ${retry}`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const second = await makeUser(['CUSTOMER'], 'CUSTOMER'); const third = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const vendorId = await makeStore(owner, 'Bounded destination fixture');
      const o = await placeAndAlert(vendorId); const queue = recordingQueue();
      let reservations = 0;
      const redis = new Proxy(app.redis, { get(target, prop) {
        if (prop === 'incr') return async (key: string) => {
          const result = await target.incr(key);
          if (key.startsWith(STORE_ALERT_SMS_DAILY_PREFIX)) {
            reservations++;
            await app.prisma.vendor.update({ where: { id: vendorId }, data: { phone: reservations === 1 ? second.phone : third.phone } });
          }
          return result;
        };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as Redis;
      expect(await runLadderJob({ ...deps({ redis }), queue }, { orderId: o.orderId, rung: 'sms', retry })).toBe('not_submitted');
      expect(reservations).toBe(2);
      for (const actor of [owner, second, third]) {
        expect(smsTo(actor.phone).filter((entry) => entry.body.includes(o.orderNumber))).toEqual([]);
        expect(await textsCounted(actor.phone)).toBe(0);
      }
      expect(queue.jobs).toHaveLength(retry === 0 ? 1 : 0);
      expect(await app.redis.get(rungClaimKey(o.orderId, 'sms'))).toBeNull();
      expect(await app.redis.get(`${rungClaimKey(o.orderId, 'sms')}:submitted`)).toBeNull();
    });
  }

  it('an unknown SMS result keeps spend and marker and cannot enter not-submitted retry', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorId = await makeStore(owner, 'Unknown handoff fixture');
    const o = await placeAndAlert(vendorId); const queue = recordingQueue(); let submissions = 0;
    const channels = { ...getChannels(), sms: { sendSms: async () => { submissions++; throw new Error('synthetic lost response after transport'); } } };
    expect(await runLadderJob({ ...deps({ channels }), queue }, { orderId: o.orderId, rung: 'sms' })).toBe('sms_uncertain');
    expect(submissions).toBe(1); expect(queue.jobs).toEqual([]);
    expect(await textsCounted(owner.phone)).toBe(1);
    expect(await app.redis.get(`${rungClaimKey(o.orderId, 'sms')}:submitted`)).not.toBeNull();
    expect(await runLadderJob({ ...deps({ channels }), queue }, { orderId: o.orderId, rung: 'sms' })).toBe('already_sent');
    expect(submissions).toBe(1);
  });
});


describe('DS403 current team stopping authority', () => {
  for (const history of ['removed-then-read', 'removed-then-read-all', 'read-then-removed', 'seen-then-removed', 'ack-then-removed'] as const) {
    it(`${history}: historical inbox or receipt does not stop the remaining team`, async () => {
      const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
      const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
      const vendorId = await makeStore(owner, 'Historical reader fixture');
      const membership = await joinTeam(vendorId, member, owner);
      const ownerToken = await device(owner);
      const o = await placeAndAlert(vendorId);
      const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: member.userId, data: { path: ['orderId'], equals: o.orderId } } });
      if (history === 'read-then-removed') await notifications.markAsRead(member.userId, notice.id);
      if (history === 'seen-then-removed') await markStoreAlertSeen(app.prisma, o.orderId, member.userId);
      if (history === 'ack-then-removed') await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', o.orderId, member.userId);
      await app.prisma.vendorStaff.delete({ where: { id: membership.id } });
      if (history === 'removed-then-read') await notifications.markAsRead(member.userId, notice.id);
      if (history === 'removed-then-read-all') await notifications.markAllAsRead(member.userId);
      expect(await runLadderRung(deps(), o.orderId, 'ring1')).toBe('realerted');
      expect(stillWaitingPushesTo(ownerToken, o.orderId)).toHaveLength(1);
      expect(await app.prisma.notification.findUnique({ where: { id: notice.id } })).not.toBeNull();
      if (history.includes('read')) expect((await app.prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).isRead).toBe(true);
      else expect(await app.prisma.alertDelivery.findFirst({ where: { subjectId: o.orderId, recipientId: member.userId, ...(history === 'seen-then-removed' ? { seenAt: { not: null } } : { acknowledgedAt: { not: null } }) } })).not.toBeNull();
    });
  }

  it('inactive owner historical read cannot silence an active staff member', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const vendorId = await makeStore(owner, 'Inactive reader fixture');
    await joinTeam(vendorId, member, owner); const token = await device(member);
    const o = await placeAndAlert(vendorId);
    await notifications.markAllAsRead(owner.userId);
    await app.prisma.user.update({ where: { id: owner.userId }, data: { status: 'DEACTIVATED' } });
    expect(await runLadderRung(deps(), o.orderId, 'ring1')).toBe('realerted');
    expect(stillWaitingPushesTo(token, o.orderId)).toHaveLength(1);
  });

  it('a current eligible member still stops pending rungs and accepted status remains authoritative', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const vendorId = await makeStore(owner, 'Current reader fixture');
    const membership = await joinTeam(vendorId, member, owner); await device(owner);
    const o = await placeAndAlert(vendorId);
    await notifications.markAllAsRead(member.userId);
    expect(await runLadderRung(deps(), o.orderId, 'ring1')).toBe('stopped');
    await app.prisma.order.update({ where: { id: o.orderId }, data: { status: 'ACCEPTED' } });
    await app.prisma.vendorStaff.delete({ where: { id: membership.id } });
    expect(await runLadderRung(deps(), o.orderId, 'sms')).toBe('stopped');
  });
});

describe('DS403 partial delivery uncertainty', () => {
  it('partial socket handoff and ambiguous push preserve unknown when later recipients are suppressed', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const vendorId = await makeStore(owner, 'Unknown push fixture');
    await joinTeam(vendorId, member, owner); await device(owner); await device(member);
    const o = await placeAndAlert(vendorId); const queue = recordingQueue(); const before = emitted.length;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status: 503 }));
    try {
      const channels = { ...getChannels(), push: withPushRetry(new ExpoPushProvider(), [1]) };
      expect(await runLadderJob({ ...deps({ channels }), queue }, { orderId: o.orderId, rung: 'ring1' })).toBe('submission_unknown');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(emitted.slice(before).filter((event) => event.room === `user:${owner.userId}`)).toHaveLength(1);
      expect(emitted.slice(before).filter((event) => event.room === `user:${member.userId}`)).toEqual([]);
      expect(queue.jobs.filter((job) => job.data['rung'] === 'ring1')).toEqual([]);
      expect(await app.redis.get(`${rungClaimKey(o.orderId, 'ring1')}:submitted`)).not.toBeNull();
    } finally { fetcher.mockRestore(); }
  });
});


describe('SX403 last durable boundaries', () => {
  it('operator inbox insertion rolls back with its Order authority transaction', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorId = await makeStore(owner, 'Atomic inbox fixture');
    const o = await placeAndAlert(vendorId);
    const transaction = app.prisma.$transaction.bind(app.prisma);
    let rolledBack = false;
    const guard = vi.spyOn(app.prisma, '$transaction').mockImplementation(((work: any, options: any) => {
      if (typeof work !== 'function') return transaction(work, options);
      return transaction(async (tx) => {
        const result = await work(tx);
        if (await tx.notification.count({ where: { AND: [{ data: { path: ['kind'], equals: 'ops_order_unanswered' } }, { data: { path: ['orderId'], equals: o.orderId } }] } })) {
          rolledBack = true; throw new Error('synthetic failure before authority commit');
        }
        return result;
      }, options);
    }) as typeof transaction);
    try {
      expect(await runLadderRung(deps(), o.orderId, 'admin')).toBe('submission_unknown');
      expect(rolledBack).toBe(true);
      expect(await app.prisma.notification.count({ where: { AND: [{ data: { path: ['kind'], equals: 'ops_order_unanswered' } }, { data: { path: ['orderId'], equals: o.orderId } }] } })).toBe(0);
    } finally { guard.mockRestore(); }
  });

  it('expiry after the final destination lock prevents fetch and refunds its reservation', async () => {
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorId = await makeStore(owner, 'Last deadline fixture');
    const o = await placeAndAlert(vendorId);
    const barrier = pauseLockedAuthority(); const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sid: 'SM' + '4'.repeat(32) }), { status: 201 }));
    let delivery: ReturnType<typeof runLadderRung> | undefined;
    try {
      delivery = runLadderRung(deps({ channels: syntheticSmsChannels(owner.phone) }), o.orderId, 'sms');
      await barrier.locked;
      clock.mockReturnValue(o.respondBy.getTime() + 1);
      barrier.release();
      expect(await delivery).toBe('window_closed');
      expect(fetcher).not.toHaveBeenCalled();
      expect(await textsCounted(owner.phone)).toBe(0);
    } finally {
      barrier.release(); await Promise.allSettled([delivery]);
      barrier.restore(); clock.mockRestore(); fetcher.mockRestore(); vi.unstubAllEnvs();
    }
  });
});
