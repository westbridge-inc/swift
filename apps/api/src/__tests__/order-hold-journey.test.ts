import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { holdReleaseObserver } from '../modules/order/order.service';
import { LATE_CANCEL_FEE } from '../modules/order/cancel-policy';
import { escalateVendorAlert } from '../modules/notification/notification.service';
import { autoCancelUnresponsiveOrder, enqueueVendorAlertFollowup, releaseHeldOrdersJob } from '../jobs/queue';
import { drainCheckoutOutbox, vendorAlertLadderDelayMs } from '../modules/order/checkout-outbox';
import { getChannels, devChannelLog } from '../providers/notifications/channels';
import { guyanaDayKey, startOfGuyanaDay } from '../utils/guyana-day';
import { GUYANA_MIDNIGHT_WAIT_TIMEOUT_MS, waitClearOfGuyanaMidnight } from './helpers/guyana-day-clock';

// ---------------------------------------------------------------------------
// Q12 · THE FIVE-MINUTE WINDOW NEVER REACHES THE STORE. The owner, 2026-09-24:
// "if they cancel in the 5 minute window it actually does, and the vendor
// doesn't get it, same with restaurants and stores".
//
// order-hold.test.ts proves the hold's parts on seeded rows. This suite walks
// the whole journey through the REAL mounted routes — cart, checkout, the
// customer's cancel button, the store's board — and then plays every job the
// platform scheduled for the order (the auto-cancel, the vendor alert ladder,
// the release sweep) the way the worker runs them. After each step it asks
// everything a store could possibly have learned from: its socket rooms, its
// inbox, its alert receipts, its phone's pushes and SMS, its board, the order
// by id, the pending-alert banner, its dashboard counters and analytics, a
// real socket client asking to follow the order, and its low-stock pushes.
//
// Time: the hold is the real five minutes. "Five minutes later" is modelled by
// moving the order's clock back (placement, hold and any cancel together, so
// their order is kept) — the server clock owns the window, as in production.
// ---------------------------------------------------------------------------

// This file's fixture block (+5920861nnn, 11 characters): no phone literal,
// generator or purge prefix under apps/, packages/, tools/, scripts/ or
// deploy/ contains "+59208" (the +59204… block is the staging live-test
// reserve — deliberately avoided).
const PHONE_PREFIX = '+5920861';
const DAY = 24 * 60 * 60 * 1000;
const HOLD_MS = 5 * 60_000;

let app: FastifyInstance;
let socketUrl = '';
const openSockets: Socket[] = [];
let seq = 0;
const userIds: string[] = [];
const vendorIds: string[] = [];
/** [AX289 F8] Fixtures deliberately OUTSIDE this file's release scope — the
 *  stand-in for another suite's orders in the shared database. */
const foreignUserIds: string[] = [];
const foreignVendorIds: string[] = [];

type Actor = { userId: string; token: string; phone: string };
type Store = { owner: Actor; vendorId: string; itemId: string; device: string };
type Placed = { id: string; orderNumber: string; holdExpiresAt: string | null };

// ── Harness: the queues the checkout publishes to, and the socket rooms ─────

type Job = { queue: string; name: string; data: Record<string, unknown>; opts: Record<string, unknown>; dueAt: number; ran: boolean };
const jobs: Job[] = [];
const fakeQueue = (queue: string) => ({
  add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
    jobs.push({ queue, name, data, opts, dueAt: Date.now() + Number(opts['delay'] ?? 0), ran: false });
    return { id: String(opts['jobId'] ?? nanoid(8)) };
  },
});
const queues = {
  orderQueue: fakeQueue('order'),
  notificationQueue: fakeQueue('notification'),
  dispatchQueue: fakeQueue('dispatch'),
};

type Emitted = { room: string; event: string; payload: Record<string, unknown> };
const sockets: Emitted[] = [];

const ctx = () => ({ prisma: app.prisma, io: app.io, redis: app.redis, log: app.log });

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole, opts: { foreign?: boolean } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName, lastName: `Q12-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  (opts.foreign ? foreignUserIds : userIds).push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `q12-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, phone };
}

/** A customer with a Georgetown home, a stranger to every earlier case. */
async function makeCustomer(firstName: string, opts: { foreign?: boolean } = {}): Promise<Actor> {
  const customer = await makeUser(firstName, ['CUSTOMER'], 'CUSTOMER', opts);
  await app.prisma.address.create({
    data: {
      userId: customer.userId, label: 'Home', addressLine1: '3 Cancel Close', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8045, longitude: -58.1553, isDefault: true,
    },
  });
  return customer;
}

/** A fresh store per case, so its board and analytics hold only this case's
 *  orders. Its owner's phone is registered for push, so every push is seen. */
async function makeStore(vendorType: 'RESTAURANT' | 'SUPERMARKET', opts: { stock?: number; lowStockThreshold?: number; mmg?: boolean; foreign?: boolean } = {}): Promise<Store> {
  const owner = await makeUser(vendorType === 'RESTAURANT' ? 'Rohan' : 'Sita', ['VENDOR_OWNER'], 'VENDOR_OWNER', { foreign: opts.foreign });
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id,
      name: `Q12 ${vendorType === 'RESTAURANT' ? 'Diner' : 'Grocer'} ${seq}`,
      slug: `q12-${vendorType.toLowerCase()}-${nanoid(8).toLowerCase()}`,
      vendorType,
      phone: `${PHONE_PREFIX}9${String(seq).padStart(2, '0')}`,
      addressLine1: '12 Hold Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, deliveryRadius: 50,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      ...(opts.mmg ? { mmgPayUrl: 'https://pay.example.com/pay/q12-store' } : {}),
    },
  });
  (opts.foreign ? foreignVendorIds : vendorIds).push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 0 } });
  const item = await app.prisma.item.create({
    data: {
      vendorId: vendor.id, categoryId: category.id,
      name: vendorType === 'RESTAURANT' ? 'Pepperpot' : 'Rice 5kg', basePrice: 1800, isAvailable: true,
      ...(opts.stock != null ? { stockQuantity: opts.stock } : {}),
      ...(opts.lowStockThreshold != null ? { lowStockThreshold: opts.lowStockThreshold } : {}),
    },
  });
  const device = `ExponentPushToken[q12${nanoid(16)}]`;
  await app.prisma.deviceToken.create({ data: { userId: owner.userId, token: device, platform: 'android' } });
  return { owner, vendorId: vendor.id, itemId: item.id, device };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** The customer's real path: an empty cart, one line, checkout. */
async function placeOrder(buyer: Actor, store: Store, quantity: number, body: Record<string, unknown> = { paymentMethod: 'CASH' }): Promise<Placed> {
  const cleared = await call('DELETE', '/api/v1/customer/cart', buyer.token);
  expect(cleared.statusCode, cleared.body).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', buyer.token, { vendorId: store.vendorId, itemId: store.itemId, quantity });
  expect(added.statusCode, added.body).toBe(201);
  const res = await call('POST', '/api/v1/customer/checkout', buyer.token, body, { 'idempotency-key': `q12-${nanoid(12)}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.order as Placed;
}

const orderRow = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id } });
const stockOf = async (itemId: string) => (await app.prisma.item.findUniqueOrThrow({ where: { id: itemId } })).stockQuantity;

/** "Five minutes later": the order's placement, hold and cancellation all
 *  happened `ms` earlier — relative order kept, only now has moved on. */
async function travel(orderId: string, ms: number) {
  const row = await orderRow(orderId);
  const back = (d: Date | null) => (d ? new Date(d.getTime() - ms) : d);
  await app.prisma.order.update({
    where: { id: orderId },
    data: { placedAt: back(row.placedAt)!, holdExpiresAt: back(row.holdExpiresAt), cancelledAt: back(row.cancelledAt) },
  });
}

/** The worker's own release-held-orders job (queue.ts) — the release, the
 *  store's alert, and the immediate publish of the alert ladder the release
 *  wrote — confined to THIS file's orders [AX289 F8]: the job's due-order read
 *  is narrowed to this file's customers and stores, so it never releases,
 *  counts or alerts an order another suite left due in the shared database,
 *  and a backlog there cannot keep ours from being reached. Everything else is
 *  the real job on the real client. */
async function releaseSweep(): Promise<string[]> {
  const findMany = app.prisma.order.findMany.bind(app.prisma.order);
  let scoped = 0;
  const spy = vi.spyOn(app.prisma.order, 'findMany').mockImplementation(((args: Prisma.OrderFindManyArgs = {}) => {
    scoped += 1;
    return findMany({ ...args, where: { AND: [args.where ?? {}, { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }] } });
  }) as never);
  try {
    const released = await releaseHeldOrdersJob(ctx(), queues as never);
    expect(scoped, 'the sweep read its due orders through the fixture scope').toBeGreaterThan(0);
    return released;
  } finally {
    spy.mockRestore();
  }
}

/** The worker's checkout-outbox sweep, for one order: publish its due outbox
 *  rows to the harness queues (the same drainer the worker runs). */
const outboxSweep = (orderId: string) =>
  drainCheckoutOutbox({ prisma: app.prisma, queues: queues as never, log: app.log }, { orderIds: [orderId] });

/** The order's durable vendor alert ladder rows (one per order, ever). */
const ladderRows = (orderId: string) =>
  app.prisma.orderOutbox.findMany({ where: { orderId, kind: 'vendor-alert-escalate' }, orderBy: { createdAt: 'asc' } });

const jobsFor = (orderId: string) => jobs.filter((j) => j.data['orderId'] === orderId);

/** Run every job scheduled for this order (or only the named kinds), as the
 *  worker would, in the order their delays fire — including the follow-up
 *  rung a re-alert enqueues. */
async function runJobsFor(orderId: string, only?: string[]): Promise<string[]> {
  const outcomes: string[] = [];
  for (let guard = 0; guard < 10; guard += 1) {
    const next = jobsFor(orderId).filter((j) => !j.ran && (!only || only.includes(j.name))).sort((a, b) => a.dueAt - b.dueAt)[0];
    if (!next) break;
    next.ran = true;
    if (next.name === 'vendor-alert-escalate') {
      const level = Number(next.data['level'] ?? 0);
      const outcome = await escalateVendorAlert(app.prisma, app.io, getChannels(), orderId, level);
      outcomes.push(`vendor-alert-escalate:${level}:${outcome}`);
      if (outcome === 'realerted') await enqueueVendorAlertFollowup(queues as never, orderId);
    } else if (next.name === 'auto-cancel') {
      outcomes.push(`auto-cancel:${await autoCancelUnresponsiveOrder(ctx(), orderId)}`);
    } else {
      outcomes.push(next.name);
    }
  }
  return outcomes;
}

const mentions = (payload: Record<string, unknown>, orderId: string) =>
  payload['orderId'] === orderId || (payload['data'] as Record<string, unknown> | undefined)?.['orderId'] === orderId;

/** Everything that could have TOLD the store about this order. */
async function storeHeard(store: Store, order: Placed) {
  const inbox = await app.prisma.notification.findMany({
    where: { userId: store.owner.userId, data: { path: ['orderId'], equals: order.id } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    sockets: sockets
      .filter((s) => (s.room === `vendor:${store.vendorId}` || s.room === `user:${store.owner.userId}`) && mentions(s.payload, order.id))
      .map((s) => s.event),
    inbox: inbox.map((n) => ({ title: n.title, kind: (n.data as Record<string, unknown> | null)?.['kind'] ?? null, isRead: n.isRead })),
    deliveries: await app.prisma.alertDelivery.count({ where: { kind: 'VENDOR_ORDER', subjectId: order.id } }),
    pushes: devChannelLog
      .filter((e) => e.channel === 'push' && e.to === store.device && (e.data as Record<string, unknown> | undefined)?.['orderId'] === order.id)
      .map((e) => e.title),
    sms: devChannelLog.filter((e) => e.channel === 'sms' && e.to === store.owner.phone && e.body.includes(order.orderNumber)).map((e) => e.body),
  };
}
const HEARD_NOTHING = { sockets: [], inbox: [], deliveries: 0, pushes: [], sms: [] };

/** Everything the store can SEE of this order on its own surfaces. */
async function storeSees(store: Store, orderId: string) {
  const board = await call('GET', '/api/v1/vendor/orders?limit=50', store.owner.token);
  expect(board.statusCode, board.body).toBe(200);
  const cancelledTab = await call('GET', '/api/v1/vendor/orders?status=CANCELLED&limit=50', store.owner.token);
  expect(cancelledTab.statusCode, cancelledTab.body).toBe(200);
  const detail = await call('GET', `/api/v1/vendor/orders/${orderId}`, store.owner.token);
  const banner = await call('GET', '/api/v1/vendor/alerts/pending', store.owner.token);
  expect(banner.statusCode, banner.body).toBe(200);
  const ops = await call('GET', '/api/v1/vendor/analytics/ops?days=7', store.owner.token);
  expect(ops.statusCode, ops.body).toBe(200);
  const listed = (res: typeof board) => (res.json().data as Array<{ id: string }>).some((o) => o.id === orderId);
  return {
    board: listed(board),
    cancelledTab: listed(cancelledTab),
    detail: detail.statusCode,
    banner: (banner.json().data as Array<{ data: { orderId?: string } }>).some((a) => a.data?.orderId === orderId),
    ops: { placedOrders: ops.json().data.placedOrders as number, cancellationRate: ops.json().data.cancellationRate as number | null },
    dashboard: await storeDashboard(store),
  };
}

/** The store's own counters: the dashboard overview, the popular-items card,
 *  busy hours and the tier meter. The store is fresh per case, so every one of
 *  them counts only that case's orders. */
async function storeDashboard(store: Store) {
  const overview = await call('GET', '/api/v1/vendor/analytics/overview', store.owner.token);
  const popular = await call('GET', '/api/v1/vendor/analytics/popular-items', store.owner.token);
  const busy = await call('GET', '/api/v1/vendor/analytics/busy-hours', store.owner.token);
  const tier = await call('GET', '/api/v1/vendor/tier', store.owner.token);
  for (const res of [overview, popular, busy, tier]) expect(res.statusCode, res.body).toBe(200);
  const o = overview.json().data;
  const item = (popular.json().data as Array<{ id: string; totalOrdered: number; recentOrders: number }>).find((i) => i.id === store.itemId);
  return {
    today: o.today.orders as number, week: o.week.orders as number, month: o.month.orders as number,
    pending: o.pendingOrders as number, totalOrders: o.vendor.totalOrders as number,
    itemTotalOrdered: item?.totalOrdered ?? null, itemRecent: item?.recentOrders ?? null,
    busyHours: busy.json().data.total as number, tierToday: tier.json().data.usage.ordersToday as number,
  };
}
/** The store counts an order in the GUYANA day it was placed (#1491). The
 *  journey moves placement minutes into the past, so a run in the first
 *  minutes after Guyana midnight places the order in yesterday: today's
 *  counters then read 0 for it, never 2. Week and month are rolling windows. */
async function countedToday(orderId: string): Promise<0 | 1> {
  const { placedAt } = await orderRow(orderId);
  return placedAt >= startOfGuyanaDay(guyanaDayKey(new Date())) ? 1 : 0;
}
const DASHBOARD_EMPTY = { today: 0, week: 0, month: 0, pending: 0, totalOrders: 0, itemTotalOrdered: 0, itemRecent: 0, busyHours: 0, tierToday: 0 };

/** The store's low-stock notices for its item: inbox rows and pushes. */
async function lowStockNotices(store: Store) {
  const inbox = await app.prisma.notification.findMany({
    where: { userId: store.owner.userId, AND: [{ data: { path: ['kind'], equals: 'low_stock' } }, { data: { path: ['itemId'], equals: store.itemId } }] },
  });
  return {
    inbox: inbox.map((n) => n.body),
    pushes: devChannelLog
      .filter((e) => e.channel === 'push' && e.to === store.device && (e.data as Record<string, unknown> | undefined)?.['kind'] === 'low_stock')
      .map((e) => e.body),
  };
}

/** A real Socket.IO client for this actor, admitted once the server says so. */
async function socketFor(actor: Actor): Promise<Socket> {
  const socket = ioClient(socketUrl, { auth: { token: actor.token }, transports: ['websocket'], reconnection: false, timeout: 3000 });
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket was not admitted')), 7_500);
    socket.on('auth:ready', () => { clearTimeout(timer); resolve(); });
    socket.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
  return socket;
}

/** Is this client in the order's room on the server? */
const inOrderRoom = (socket: Socket, orderId: string) =>
  app.io.of('/').adapter.rooms.get(`order:${orderId}`)?.has(socket.id ?? '') ?? false;

/** Record each time the socket door's authority read for an order:subscribe
 *  returns (whichever way it went): the join, if any, follows synchronously,
 *  so a test can wait for the DECISION instead of sleeping. */
function watchSubscribeDecisions() {
  const decided = new Map<string, number>();
  const original = app.prisma.order.findFirst.bind(app.prisma.order);
  const spy = vi.spyOn(app.prisma.order, 'findFirst').mockImplementation((async (args: unknown) => {
    const result = await original(args as never);
    const where = (args as { where?: { id?: unknown; OR?: unknown } } | undefined)?.where;
    if (typeof where?.id === 'string' && Array.isArray(where.OR)) decided.set(where.id, (decided.get(where.id) ?? 0) + 1);
    return result;
  }) as never);
  return { decisions: (orderId: string) => decided.get(orderId) ?? 0, restore: () => spy.mockRestore() };
}

async function waitFor(what: string, predicate: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const priorHoldMinutes = process.env['ORDER_HOLD_MINUTES'];

// "Five minutes later" moves an order back, and the store's counters read the
// Guyana day: never run across Guyana midnight (helpers/guyana-day-clock).
beforeAll(waitClearOfGuyanaMidnight, GUYANA_MIDNIGHT_WAIT_TIMEOUT_MS);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.example.com');
  // The window under test is the real one: the flag on, the minutes unset
  // (the settled default, five).
  vi.stubEnv('LIFECYCLE_V2', '1');
  delete process.env['ORDER_HOLD_MINUTES'];

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.decorate('queues', queues as never);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  // Socket.IO needs a real listening server — inject() cannot carry websockets.
  await app.listen({ port: 0, host: '127.0.0.1' });
  socketUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // Every room emit — order service, notification service, the ladder — is
  // recorded; nothing is delivered to a real client.
  vi.spyOn(app.io, 'to').mockImplementation(((room: string | string[]) => {
    const op: Record<string, unknown> = {};
    op['emit'] = (event: string, payload?: Record<string, unknown>) => {
      sockets.push({ room: String(room), event, payload: payload ?? {} });
      return true;
    };
    op['to'] = () => op;
    op['in'] = () => op;
    op['except'] = () => op;
    return op;
  }) as never);
});

afterAll(async () => {
  for (const socket of openSockets) socket.disconnect();
  vi.unstubAllEnvs();
  if (priorHoldMinutes !== undefined) process.env['ORDER_HOLD_MINUTES'] = priorHoldMinutes;
  vi.restoreAllMocks();
  userIds.push(...foreignUserIds);
  vendorIds.push(...foreignVendorIds);
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length > 0) {
    await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
  }
  await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: userIds } }] } });
  await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

// ---------------------------------------------------------------------------
// (A1–A2) A cancel inside the window — for a restaurant and for a store
// ---------------------------------------------------------------------------

describe.each([
  { label: 'restaurant', vendorType: 'RESTAURANT' as const, orderType: 'FOOD_DELIVERY', stock: undefined },
  { label: 'store', vendorType: 'SUPERMARKET' as const, orderType: 'GROCERY_DELIVERY', stock: 10 },
])('Q12 · $label — the customer cancels inside the five-minute window', ({ vendorType, orderType, stock }) => {
  let store: Store;
  let buyer: Actor;
  let order: Placed;

  beforeAll(async () => {
    store = await makeStore(vendorType, { stock });
    buyer = await makeCustomer(vendorType === 'RESTAURANT' ? 'Asha' : 'Dev');
  });

  it('checkout holds the order for exactly the five-minute window and tells the store nothing', async () => {
    order = await placeOrder(buyer, store, 2);
    const row = await orderRow(order.id);
    expect(row.orderType).toBe(orderType);
    expect(row.status).toBe('PENDING');
    expect(row.isExpress).toBe(false);
    // The window is the settled five minutes, stamped by the server at checkout.
    expect(row.holdExpiresAt).not.toBeNull();
    const windowMs = row.holdExpiresAt!.getTime() - row.placedAt.getTime();
    expect(windowMs).toBeGreaterThan(HOLD_MS - 5_000);
    expect(windowMs).toBeLessThanOrEqual(HOLD_MS);
    expect(order.holdExpiresAt).toBe(row.holdExpiresAt!.toISOString());
    if (stock != null) expect(await stockOf(store.itemId)).toBe(stock - 2);

    expect(await storeHeard(store, order)).toEqual(HEARD_NOTHING);
    // Not on the board, and not in a single dashboard counter either.
    expect(await storeSees(store, order.id)).toEqual({
      board: false, cancelledTab: false, detail: 404, banner: false, ops: { placedOrders: 0, cancellationRate: null },
      dashboard: DASHBOARD_EMPTY,
    });

    // The customer's own screen offers the cancel as free, counting down to
    // the same server instant.
    const mine = await call('GET', `/api/v1/customer/orders/${order.id}`, buyer.token);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().data).toMatchObject({
      canCancel: true, freeCancellationWindow: true, cancellationFee: 0,
      holdExpiresAt: row.holdExpiresAt!.toISOString(),
      freeCancellationExpiresAt: row.holdExpiresAt!.toISOString(),
    });
  });

  it('the cancel button works: CANCELLED at no charge, goods back on the shelf, and cash has nothing to refund', async () => {
    const res = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, { reason: 'Changed my mind' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ message: 'Order cancelled — no charge', cancellationFee: 0 });

    const row = await orderRow(order.id);
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledBy).toBe(buyer.userId);
    expect(row.cancellationReason).toBe('Changed my mind');
    expect(row.lateCancelFeeDue).toBe(0);
    // Cash: no money ever moved, so there is nothing to refund or reverse.
    expect(row.paymentMethod).toBe('CASH');
    expect(row.paymentStatus).toBe('PENDING');
    expect(row.releasedToVendorAt).toBeNull();
    if (stock != null) expect(await stockOf(store.itemId)).toBe(stock);

    const mine = await call('GET', `/api/v1/customer/orders/${order.id}`, buyer.token);
    expect(mine.json().data).toMatchObject({ status: 'CANCELLED', canCancel: false, cancellationFee: 0 });
    // A second tap is refused, never a second cancellation.
    const again = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, {});
    expect(again.statusCode).toBe(400);

    expect(await storeHeard(store, order)).toEqual(HEARD_NOTHING);
  });

  it('the store never learns — not from any job checkout scheduled, not after the window, not from the release sweep', async () => {
    // Checkout scheduled the no-response auto-cancel, and NO vendor alert
    // ladder: a held order has no alert to escalate; the release arms it.
    expect(jobsFor(order.id).map((j) => j.name)).toEqual(['auto-cancel']);
    // Played the way the worker plays them: the auto-cancel finds nothing to do.
    expect(await runJobsFor(order.id)).toEqual(['auto-cancel:false']);

    // Five minutes and a second later, the window the order was held for has
    // closed. The release sweep runs and releases nothing, arms nothing.
    await travel(order.id, HOLD_MS + 1_000);
    expect(await releaseSweep()).not.toContain(order.id);
    expect(jobsFor(order.id).map((j) => j.name)).toEqual(['auto-cancel']);
    expect(await ladderRows(order.id)).toEqual([]); // not even owed: no release, no ladder

    const row = await orderRow(order.id);
    expect(row.status).toBe('CANCELLED');
    expect(row.releasedToVendorAt).toBeNull();

    // Nothing reached the store, and its own surfaces never show the order —
    // not on the board, not in its cancelled history, not by id, not in its
    // alert banner and not in its cancellation rate.
    expect(await storeHeard(store, order)).toEqual(HEARD_NOTHING);
    expect(await storeSees(store, order.id)).toEqual({
      board: false, cancelledTab: false, detail: 404, banner: false, ops: { placedOrders: 0, cancellationRate: null },
      dashboard: DASHBOARD_EMPTY,
    });
  });
});

// ---------------------------------------------------------------------------
// (A3) No cancel — the window closes and the store is alerted exactly once
// ---------------------------------------------------------------------------

describe.each([
  { label: 'restaurant', vendorType: 'RESTAURANT' as const },
  { label: 'store', vendorType: 'SUPERMARKET' as const },
])('Q12 · $label — no cancel: the window closes and the store is alerted exactly once', ({ vendorType }) => {
  it('held → released by the sweep → one alert on every channel → later sweeps add nothing', async () => {
    const store = await makeStore(vendorType, { stock: vendorType === 'SUPERMARKET' ? 5 : undefined });
    const buyer = await makeCustomer('Ben');
    const order = await placeOrder(buyer, store, 1);

    // Inside the window a sweep leaves it alone, and no counter has moved.
    expect(await releaseSweep()).not.toContain(order.id);
    expect(await storeHeard(store, order)).toEqual(HEARD_NOTHING);
    expect(await storeDashboard(store)).toEqual(DASHBOARD_EMPTY);

    await travel(order.id, HOLD_MS + 1_000);
    expect(await releaseSweep()).toContain(order.id);

    const heard = await storeHeard(store, order);
    // The board's order:new, the inbox row's live copy, and the ringing banner.
    expect([...heard.sockets].sort()).toEqual(['notification', 'order:new', 'vendor:order_alert']);
    expect(heard.inbox).toEqual([{ title: 'New Order!', kind: 'vendor_order_alert', isRead: false }]);
    expect(heard.deliveries).toBe(1);
    expect(heard.pushes).toEqual(['New Order!']);
    expect(heard.sms).toEqual([]);
    // The ladder is armed once — by the release, at rung 0 — as the release's
    // own durable outbox row, published at once [AX289 F5].
    expect(jobsFor(order.id).filter((j) => j.name === 'vendor-alert-escalate').map((j) => j.data['level'])).toEqual([0]);
    const ladder = await ladderRows(order.id);
    expect(ladder.map((r) => ({ key: r.dedupeKey, published: r.processedAt !== null }))).toEqual([{ key: `order:${order.id}:vendor-alert-escalate`, published: true }]);
    expect(jobsFor(order.id).find((j) => j.name === 'vendor-alert-escalate')?.opts['jobId']).toBe(ladder[0]!.id);

    const row = await orderRow(order.id);
    expect(row.holdExpiresAt).toBeNull();
    expect(row.releasedToVendorAt).not.toBeNull();
    expect(row.status).toBe('PENDING'); // release is visibility, not a transition
    // Counted by the store's own counters at the release — once.
    const today = await countedToday(order.id);
    const counted = { today, week: 1, month: 1, pending: 1, totalOrders: 1, itemTotalOrdered: 1, itemRecent: 1, busyHours: 1, tierToday: today };
    expect(await storeSees(store, order.id)).toMatchObject({ board: true, detail: 200, banner: true, dashboard: counted });

    // Exactly once: every later sweep is a no-op on every channel and counter.
    expect(await releaseSweep()).not.toContain(order.id);
    expect(await storeHeard(store, order)).toEqual(heard);
    expect(await storeDashboard(store)).toEqual(counted);
    expect((await ladderRows(order.id)).map((r) => r.id)).toEqual([ladder[0]!.id]);
    expect(jobsFor(order.id).filter((j) => j.name === 'vendor-alert-escalate')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (A4) The race: a cancel at the same moment as the release sweep. The order
// row lock serializes them; each interleaving has exactly one outcome.
// ---------------------------------------------------------------------------

describe('Q12 · the cancel and the release sweep at the same moment', () => {
  it('cancel first: the sweep already holds the order as due when the cancel commits — it releases nothing, and the store is never alerted', async () => {
    const store = await makeStore('SUPERMARKET', { stock: 4 });
    const buyer = await makeCustomer('Gail');
    const order = await placeOrder(buyer, store, 1);
    await travel(order.id, HOLD_MS + 1_000); // the window has just closed; the tick is due

    // The sweep has read the order as due; the customer's cancel commits
    // before the sweep's release CAS runs.
    let cancelled: Awaited<ReturnType<typeof call>> | undefined;
    holdReleaseObserver.beforeRelease = async ({ orderId }) => {
      if (orderId === order.id) cancelled = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, { reason: 'Changed my mind' });
    };
    try {
      expect(await releaseSweep()).not.toContain(order.id);
    } finally {
      delete holdReleaseObserver.beforeRelease;
    }
    expect(cancelled?.statusCode, cancelled?.body).toBe(200);

    // One outcome: cancelled, never released, never alerted, no ladder.
    const row = await orderRow(order.id);
    expect(row.status).toBe('CANCELLED');
    expect(row.releasedToVendorAt).toBeNull();
    expect(await stockOf(store.itemId)).toBe(4);
    const heard = await storeHeard(store, order);
    expect({ inbox: heard.inbox, deliveries: heard.deliveries, pushes: heard.pushes, sms: heard.sms }).toEqual({ inbox: [], deliveries: 0, pushes: [], sms: [] });
    expect(heard.sockets).not.toContain('order:new');
    expect(heard.sockets).not.toContain('vendor:order_alert');
    expect(jobsFor(order.id).map((j) => j.name)).toEqual(['auto-cancel']);
    expect(await ladderRows(order.id)).toEqual([]);
  });

  it('release first by a hair: the release commits, the cancel lands before the store was alerted — the store is never told a dead order is new', async () => {
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Hari');
    const order = await placeOrder(buyer, store, 1);
    await travel(order.id, HOLD_MS + 1_000);

    // The release CAS has committed; before the sweep alerts the store, the
    // customer's cancel takes the row lock and commits.
    let cancelled: Awaited<ReturnType<typeof call>> | undefined;
    holdReleaseObserver.afterRelease = async ({ orderId }) => {
      if (orderId === order.id) cancelled = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, { reason: 'Too slow' });
    };
    try {
      expect(await releaseSweep()).not.toContain(order.id);
    } finally {
      delete holdReleaseObserver.afterRelease;
    }
    expect(cancelled?.statusCode, cancelled?.body).toBe(200);
    // The release had committed, so the cancel took the ordinary post-window
    // rules — the late-cancel marker the app previews.
    expect(cancelled!.json().data).toEqual({ message: 'Order cancelled', cancellationFee: LATE_CANCEL_FEE });
    const row = await orderRow(order.id);
    expect(row.status).toBe('CANCELLED');
    expect(row.releasedToVendorAt).not.toBeNull();

    // One outcome: the store's board is told the order died — and it is never
    // told the dead order is new: no order:new, no "New Order!" push, no
    // inbox alert, no receipt, no ladder.
    expect(await storeHeard(store, order)).toEqual({ ...HEARD_NOTHING, sockets: ['order:status_changed'] });
    expect(jobsFor(order.id).map((j) => j.name)).toEqual(['auto-cancel']);
    expect(await storeSees(store, order.id)).toMatchObject({ board: true, cancelledTab: true, detail: 200, banner: false });

    // The ladder committed WITH the release, so it is still owed [AX289 F5];
    // when the outbox sweep publishes it, it stops at its first rung — the
    // dead order never rings, pushes or texts.
    expect((await ladderRows(order.id)).map((r) => r.processedAt)).toEqual([null]);
    expect(await outboxSweep(order.id)).toMatchObject({ processed: 1, failed: 0 });
    expect(await runJobsFor(order.id, ['vendor-alert-escalate'])).toEqual(['vendor-alert-escalate:0:stopped']);
    expect(await storeHeard(store, order)).toEqual({ ...HEARD_NOTHING, sockets: ['order:status_changed'] });
  });

  it('release first, then the cancel: the store was alerted once, the normal cancel rules apply — and the ladder never rings for a dead order', async () => {
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Cleo');
    const order = await placeOrder(buyer, store, 1);
    await travel(order.id, HOLD_MS + 1_000);
    expect(await releaseSweep()).toContain(order.id);
    const alerted = await storeHeard(store, order);
    expect(alerted.pushes).toEqual(['New Order!']);

    // The window has closed: the cancel is still honoured, with the recorded
    // (never collected) late-cancel marker the app previews.
    const mine = await call('GET', `/api/v1/customer/orders/${order.id}`, buyer.token);
    expect(mine.json().data).toMatchObject({ canCancel: true, freeCancellationWindow: false, cancellationFee: LATE_CANCEL_FEE });
    const res = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, { reason: 'Too slow' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ message: 'Order cancelled', cancellationFee: LATE_CANCEL_FEE });
    expect((await orderRow(order.id)).lateCancelFeeDue).toBe(LATE_CANCEL_FEE);

    // The store that saw it is told it died (its board refreshes)…
    const told = await storeHeard(store, order);
    expect(told.sockets.filter((e) => e === 'order:status_changed')).toHaveLength(1);
    // …and the alert ladder the release armed stops at its first rung: no
    // "still waiting" push, no SMS about an order that no longer exists.
    expect(await runJobsFor(order.id)).toEqual(['vendor-alert-escalate:0:stopped', 'auto-cancel:false']);
    const after = await storeHeard(store, order);
    expect(after.pushes).toEqual(['New Order!']);
    expect(after.sms).toEqual([]);
    // The store saw it, so it stays in its history — as cancelled.
    expect(await storeSees(store, order.id)).toMatchObject({ board: true, cancelledTab: true, detail: 200 });
  });
});

// ---------------------------------------------------------------------------
// (A3 · AX289 F5) The alert ladder a release arms survives a crash and a
// queue outage: it is the checkout's own durable outbox row, written inside
// the release transaction — never an enqueue after the commit.
// ---------------------------------------------------------------------------

describe('Q12 · the alert ladder a release arms is durable', () => {
  it('a crash right after the release commits: the ladder is still owed — one outbox row the sweep publishes — and a second release adds none', async () => {
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Nadia');
    const order = await placeOrder(buyer, store, 1);
    await travel(order.id, HOLD_MS + 1_000);

    // The worker dies the instant the release commits: before the store is
    // alerted, and before any queue is touched.
    holdReleaseObserver.afterRelease = async ({ orderId }) => {
      if (orderId === order.id) throw new Error('the worker died right after the release committed');
    };
    try {
      await expect(releaseSweep()).rejects.toThrow('the worker died right after the release committed');
    } finally {
      delete holdReleaseObserver.afterRelease;
    }
    const row = await orderRow(order.id);
    expect({ hold: row.holdExpiresAt, released: row.releasedToVendorAt !== null }).toEqual({ hold: null, released: true });
    // Nothing was published — but the ladder committed with the release.
    expect(jobsFor(order.id).map((j) => j.name)).toEqual(['auto-cancel']);
    const owed = await ladderRows(order.id);
    expect(owed.map((r) => ({ key: r.dedupeKey, queue: r.queue, payload: r.payload, delayMs: r.delayMs, published: r.processedAt !== null }))).toEqual([{
      key: `order:${order.id}:vendor-alert-escalate`, queue: 'notification',
      payload: { version: 1, orderId: order.id, level: 0 }, delayMs: vendorAlertLadderDelayMs(), published: false,
    }]);

    // A replayed release sweep releases nothing and writes no second ladder.
    expect(await releaseSweep()).not.toContain(order.id);
    expect((await ladderRows(order.id)).map((r) => r.id)).toEqual([owed[0]!.id]);

    // The worker's outbox sweep publishes it — rung 0, under the row's own job id.
    expect(await outboxSweep(order.id)).toMatchObject({ processed: 1, failed: 0 });
    expect(jobsFor(order.id).filter((j) => j.name === 'vendor-alert-escalate').map((j) => ({ level: j.data['level'], jobId: j.opts['jobId'] })))
      .toEqual([{ level: 0, jobId: owed[0]!.id }]);
    expect((await ladderRows(order.id))[0]!.processedAt).not.toBeNull();
  });

  it('the ladder publish fails after the store was told: the row stays owed, the outbox sweep publishes it, and the ladder rings', async () => {
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Obi');
    const order = await placeOrder(buyer, store, 1);
    await travel(order.id, HOLD_MS + 1_000);

    const add = queues.notificationQueue.add;
    queues.notificationQueue.add = async (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
      if (name === 'vendor-alert-escalate' && data['orderId'] === order.id) throw new Error('connection lost: the notification queue is down');
      return add(name, data, opts);
    };
    try {
      expect(await releaseSweep()).toContain(order.id);
    } finally {
      queues.notificationQueue.add = add;
    }
    // The store was told, once — and its ladder is owed, not lost.
    expect((await storeHeard(store, order)).pushes).toEqual(['New Order!']);
    expect(jobsFor(order.id).filter((j) => j.name === 'vendor-alert-escalate')).toEqual([]);
    const [owed] = await ladderRows(order.id);
    expect({ published: owed!.processedAt !== null, attempts: owed!.attempts, lastError: owed!.lastError })
      .toEqual({ published: false, attempts: 1, lastError: 'connection lost: the notification queue is down' });

    // Its retry backoff lapses; the worker's outbox sweep publishes it, and
    // the ladder rings the store that has not answered: the re-alert, then the SMS.
    await app.prisma.orderOutbox.update({ where: { id: owed!.id }, data: { availableAt: new Date(Date.now() - 1_000) } });
    expect(await outboxSweep(order.id)).toMatchObject({ processed: 1, failed: 0 });
    expect(await runJobsFor(order.id, ['vendor-alert-escalate'])).toEqual(['vendor-alert-escalate:0:realerted', 'vendor-alert-escalate:1:sms_sent']);
    const heard = await storeHeard(store, order);
    expect(heard.pushes).toEqual(['New Order!', 'Order still waiting!']);
    expect(heard.sms).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (A3 · AX289 F1) The store acts on an order whose hold lapsed before the
// sweep reached it: the store's first action releases it, counted once.
// ---------------------------------------------------------------------------

describe('Q12 · the store acts first on an order whose hold lapsed before the sweep', () => {
  const COUNTED = { totalOrders: 1, itemTotalOrdered: 1 };

  it('accepting it releases it: counted for the store exactly once, at the acceptance — the sweep then neither counts nor alerts it', async () => {
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Pria');
    const order = await placeOrder(buyer, store, 1);
    await travel(order.id, HOLD_MS + 1_000); // the window closed; the sweep has not run yet

    // The board shows it from the moment its hold lapsed; only the lifetime
    // counters wait for a release.
    expect(await storeSees(store, order.id)).toMatchObject({ board: true, detail: 200, dashboard: { today: await countedToday(order.id), totalOrders: 0, itemTotalOrdered: 0 } });
    const res = await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, store.owner.token, {});
    expect(res.statusCode, res.body).toBe(200);
    const row = await orderRow(order.id);
    expect({ status: row.status, hold: row.holdExpiresAt, released: row.releasedToVendorAt !== null }).toEqual({ status: 'ACCEPTED', hold: null, released: true });
    expect(await storeDashboard(store)).toMatchObject(COUNTED);

    // Out of the sweep's reach: nothing released, counted, alerted or armed.
    expect(await releaseSweep()).not.toContain(order.id);
    expect(await storeDashboard(store)).toMatchObject(COUNTED);
    expect((await storeHeard(store, order)).pushes).toEqual([]);
    expect(await ladderRows(order.id)).toEqual([]);
  });

  it('declining it releases it too: counted once, at the decline, and the goods go back on the shelf', async () => {
    const store = await makeStore('SUPERMARKET', { stock: 5 });
    const buyer = await makeCustomer('Quin');
    const order = await placeOrder(buyer, store, 2);
    await travel(order.id, HOLD_MS + 1_000);

    const res = await call('PUT', `/api/v1/vendor/orders/${order.id}/reject`, store.owner.token, { reason: 'Out of stock' });
    expect(res.statusCode, res.body).toBe(200);
    const row = await orderRow(order.id);
    expect({ status: row.status, hold: row.holdExpiresAt, released: row.releasedToVendorAt !== null }).toEqual({ status: 'CANCELLED', hold: null, released: true });
    expect(await stockOf(store.itemId)).toBe(5);
    expect(await storeDashboard(store)).toMatchObject(COUNTED);

    expect(await releaseSweep()).not.toContain(order.id);
    expect(await storeDashboard(store)).toMatchObject(COUNTED);
    expect(await ladderRows(order.id)).toEqual([]);
  });

  it.each([
    { label: 'the acceptance commits first', seam: 'beforeRelease' as const, ladder: [] as string[] },
    { label: 'the release commits first', seam: 'afterRelease' as const, ladder: ['vendor-alert-escalate:0:stopped'] },
  ])('the store accepts at the moment the sweep releases — $label: counted exactly once, and never alerted about the order it is accepting', async ({ seam, ladder }) => {
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Rui');
    const order = await placeOrder(buyer, store, 1);
    await travel(order.id, HOLD_MS + 1_000);

    let accepted: Awaited<ReturnType<typeof call>> | undefined;
    holdReleaseObserver[seam] = async ({ orderId }) => {
      if (orderId === order.id) accepted = await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, store.owner.token, {});
    };
    try {
      expect(await releaseSweep()).not.toContain(order.id);
    } finally {
      delete holdReleaseObserver[seam];
    }
    expect(accepted?.statusCode, accepted?.body).toBe(200);
    expect((await orderRow(order.id)).status).toBe('ACCEPTED');
    expect(await storeDashboard(store)).toMatchObject(COUNTED);
    expect((await storeHeard(store, order)).pushes).toEqual([]);
    // A ladder the release wrote before the acceptance stops at its first rung.
    await outboxSweep(order.id);
    expect(await runJobsFor(order.id, ['vendor-alert-escalate'])).toEqual(ladder);
    expect((await storeHeard(store, order)).pushes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (AX289 F8) This file's sweep releases only this file's orders
// ---------------------------------------------------------------------------

describe('Q12 · the sweep this file drives touches only its own orders', () => {
  it('a foreign order due in the same database is never released, counted or alerted by it', async () => {
    const foreignStore = await makeStore('RESTAURANT', { foreign: true });
    const foreignBuyer = await makeCustomer('Sol', { foreign: true });
    const foreign = await placeOrder(foreignBuyer, foreignStore, 1);
    await travel(foreign.id, HOLD_MS + 1_000);
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Tara');
    const mine = await placeOrder(buyer, store, 1);
    await travel(mine.id, HOLD_MS + 1_000);
    try {
      const released = await releaseSweep();
      expect(released).toContain(mine.id);
      expect(released).not.toContain(foreign.id);
      expect((await orderRow(foreign.id)).releasedToVendorAt).toBeNull();
      expect(await storeHeard(foreignStore, foreign)).toEqual(HEARD_NOTHING);
    } finally {
      // Not left due for another suite's sweep to find.
      await call('POST', `/api/v1/customer/orders/${foreign.id}/cancel`, foreignBuyer.token, {});
    }
  });
});

// ---------------------------------------------------------------------------
// (A2) Nor does the store learn through a socket or a low-stock push
// ---------------------------------------------------------------------------

describe('Q12 · the socket door and the low-stock push obey the window too', () => {
  it('a store socket asking to follow a held order is refused; once the order is released it is admitted', async () => {
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Ivy');
    const order = await placeOrder(buyer, store, 1);
    const storeSocket = await socketFor(store.owner);
    const buyerSocket = await socketFor(buyer);
    const watch = watchSubscribeDecisions();
    try {
      storeSocket.emit('order:subscribe', { orderId: order.id });
      await waitFor('the store request to be decided', () => watch.decisions(order.id) >= 1);
      expect(inOrderRoom(storeSocket, order.id)).toBe(false);
      // Control: the customer follows their own held order.
      buyerSocket.emit('order:subscribe', { orderId: order.id });
      await waitFor('the customer to join', () => inOrderRoom(buyerSocket, order.id));

      await travel(order.id, HOLD_MS + 1_000);
      expect(await releaseSweep()).toContain(order.id);
      storeSocket.emit('order:subscribe', { orderId: order.id });
      await waitFor('the store to join the released order', () => inOrderRoom(storeSocket, order.id));
    } finally {
      watch.restore();
    }
  });

  it('a store socket asking to follow an order cancelled inside its window is refused, even after the window lapsed', async () => {
    const store = await makeStore('SUPERMARKET', { stock: 6 });
    const buyer = await makeCustomer('Jai');
    const order = await placeOrder(buyer, store, 1);
    expect((await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, {})).statusCode).toBe(200);
    await travel(order.id, HOLD_MS + 1_000);
    expect(await releaseSweep()).not.toContain(order.id);

    const storeSocket = await socketFor(store.owner);
    const watch = watchSubscribeDecisions();
    try {
      storeSocket.emit('order:subscribe', { orderId: order.id });
      await waitFor('the store request to be decided', () => watch.decisions(order.id) >= 1);
      expect(inOrderRoom(storeSocket, order.id)).toBe(false);
    } finally {
      watch.restore();
    }
  });

  it('a low-stock threshold crossed by a held order stays silent until the release — then exactly one notice', async () => {
    // Three on the shelf, threshold two: selling one IS the crossing.
    const store = await makeStore('SUPERMARKET', { stock: 3, lowStockThreshold: 2 });
    const buyer = await makeCustomer('Kai');
    const order = await placeOrder(buyer, store, 1);
    expect(await stockOf(store.itemId)).toBe(2);
    expect(await lowStockNotices(store)).toEqual({ inbox: [], pushes: [] });

    await travel(order.id, HOLD_MS + 1_000);
    expect(await releaseSweep()).toContain(order.id);
    const told = { inbox: ['Rice 5kg is down to 2 in stock.'], pushes: ['Rice 5kg is down to 2 in stock.'] };
    expect(await lowStockNotices(store)).toEqual(told);
    expect(await releaseSweep()).not.toContain(order.id);
    expect(await lowStockNotices(store)).toEqual(told);
  });

  it('a low-stock threshold crossed by a held order that is then cancelled in the window never sends a notice', async () => {
    const store = await makeStore('SUPERMARKET', { stock: 3, lowStockThreshold: 2 });
    const buyer = await makeCustomer('Lia');
    const order = await placeOrder(buyer, store, 1);
    expect((await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, {})).statusCode).toBe(200);
    expect(await stockOf(store.itemId)).toBe(3); // the cancel put it back

    await travel(order.id, HOLD_MS + 1_000);
    expect(await releaseSweep()).not.toContain(order.id);
    expect(await runJobsFor(order.id)).toEqual(['auto-cancel:false']);
    expect(await lowStockNotices(store)).toEqual({ inbox: [], pushes: [] });
  });
});

// ---------------------------------------------------------------------------
// (A5) Express orders are never held
// ---------------------------------------------------------------------------

describe('Q12 · express — never held, so the store sees it at once; a cancel in the first five minutes is free and stops the alert ladder', () => {
  it('alerted at checkout, cancelled free inside five minutes, and the ladder never rings or texts about the dead order', async () => {
    const store = await makeStore('RESTAURANT');
    const buyer = await makeCustomer('Esi');
    const order = await placeOrder(buyer, store, 1, { paymentMethod: 'CASH', express: true });
    const row = await orderRow(order.id);
    expect(row.isExpress).toBe(true);
    expect(row.holdExpiresAt).toBeNull(); // the customer paid 1.5x to skip the wait

    const alerted = await storeHeard(store, order);
    expect([...alerted.sockets].sort()).toEqual(['notification', 'order:new', 'vendor:order_alert']);
    expect(alerted.pushes).toEqual(['New Order!']);
    // The express checkout arms the ladder itself — there is no release.
    expect(jobsFor(order.id).map((j) => j.name).sort()).toEqual(['auto-cancel', 'vendor-alert-escalate']);

    // Documented rule: inside five minutes of placing, a PENDING order with no
    // rider cancels free (FREE_CANCEL_WINDOW_MIN) — express included.
    const res = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, { reason: 'Ordered twice' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ message: 'Order cancelled — no charge', cancellationFee: 0 });
    expect((await storeHeard(store, order)).sockets.filter((e) => e === 'order:status_changed')).toHaveLength(1);

    // The ladder the checkout armed stops: no "Order still waiting!", no SMS.
    expect(await runJobsFor(order.id)).toEqual(['vendor-alert-escalate:0:stopped', 'auto-cancel:false']);
    const after = await storeHeard(store, order);
    expect(after.pushes).toEqual(['New Order!']);
    expect(after.sms).toEqual([]);
    expect(await storeSees(store, order.id)).toMatchObject({ cancelledTab: true });
  });
});

// ---------------------------------------------------------------------------
// (A1 · MMG) What happens to an MMG order cancelled inside the window
// ---------------------------------------------------------------------------

describe('Q12 · MMG — the one thing the store is told about an order cancelled in the window', () => {
  let store: Store;
  let buyer: Actor;
  let order: Placed;

  beforeAll(async () => {
    store = await makeStore('RESTAURANT', { mmg: true });
    buyer = await makeCustomer('Fay');
  });

  it('held like any order; the customer may say "I paid", and the store still hears nothing and cannot act on it', async () => {
    order = await placeOrder(buyer, store, 1, { paymentMethod: 'MOBILE_MONEY' });
    const row = await orderRow(order.id);
    expect(row.holdExpiresAt).not.toBeNull();
    expect(row.paymentStatus).toBe('PENDING');

    const claim = await call('POST', `/api/v1/customer/orders/${order.id}/payment-claim`, buyer.token, { paid: true, reference: `Q12${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}` });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json().data.paymentStatus).toBe('PENDING'); // a customer's word never moves the payment state
    // The store cannot see — so cannot confirm — a held order.
    const confirm = await call('POST', `/api/v1/vendor/orders/${order.id}/confirm-payment`, store.owner.token, { reference: 'Q12REF0001' });
    expect(confirm.statusCode).toBe(404);
    expect(await storeHeard(store, order)).toEqual(HEARD_NOTHING);
  });

  it('the cancel works and costs nothing, but the store gets ONE refund notice (money may be in its wallet) — never a new-order alert', async () => {
    const res = await call('POST', `/api/v1/customer/orders/${order.id}/cancel`, buyer.token, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ message: 'Order cancelled. If you already sent the MMG payment, the store refunds you directly.', cancellationFee: 0 });
    const row = await orderRow(order.id);
    expect(row.status).toBe('CANCELLED');
    expect(row.lateCancelFeeDue).toBe(0);

    const heard = await storeHeard(store, order);
    expect(heard.inbox).toEqual([{ title: 'Cancelled order may hold an MMG payment', kind: 'mmg_unattested_cancellation', isRead: false }]);
    expect(heard.deliveries).toBe(0);
    expect(heard.sockets).toEqual(['notification']); // the refund notice's live copy — no order:new, no banner
    expect(heard.pushes).toEqual(['Cancelled order may hold an MMG payment']);
    expect(heard.sms).toEqual([]);

    await travel(order.id, HOLD_MS + 1_000);
    expect(await releaseSweep()).not.toContain(order.id);
    expect(await runJobsFor(order.id)).toEqual(['auto-cancel:false']);
    expect(await storeHeard(store, order)).toEqual(heard);
    // The documented exception to "the store never sees it": the store was
    // told money may be in its wallet, so it can open the order it may have
    // to refund — as a cancelled order, never as a live one.
    expect(await storeSees(store, order.id)).toMatchObject({ board: true, cancelledTab: true, detail: 200, banner: false });
  });

  it('once the store has confirmed an MMG payment, the app no longer offers a cancel the server would refuse', async () => {
    const paid = await placeOrder(buyer, store, 1, { paymentMethod: 'MOBILE_MONEY' });
    await travel(paid.id, HOLD_MS + 1_000);
    expect(await releaseSweep()).toContain(paid.id);
    const confirm = await call('POST', `/api/v1/vendor/orders/${paid.id}/confirm-payment`, store.owner.token, { reference: `Q12${nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}` });
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect((await orderRow(paid.id)).paymentStatus).toBe('CLAIMED');

    const refused = await call('POST', `/api/v1/customer/orders/${paid.id}/cancel`, buyer.token, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('MMG_CANCEL_UNAVAILABLE');
    const mine = await call('GET', `/api/v1/customer/orders/${paid.id}`, buyer.token);
    expect(mine.json().data).toMatchObject({ paymentStatus: 'CLAIMED', canCancel: false, cancellationFee: 0, freeCancellationExpiresAt: null });
  });
});
