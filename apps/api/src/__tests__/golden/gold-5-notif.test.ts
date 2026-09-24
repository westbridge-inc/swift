import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerErrorHandler } from '../../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';
import { escalateVendorAlert } from '../../modules/notification/notification.service';
import { enqueueVendorAlertFollowup } from '../../jobs/queue';
import { devChannelLog, getChannels, PUSH_RETRY_DELAYS_MS, type DevChannelEntry } from '../../providers/notifications/channels';
import { notificationFailuresCounter } from '../../plugins/observability';

// ---------------------------------------------------------------------------
// GOLD-5 · NOTIF-01 / NOTIF-02 — notifications, end to end through the REAL
// mounted customer and vendor routes as real sessions, asserted on durable
// rows and on what the provider boundary actually carried:
//
//   NOTIF-01  a customer registers a device; a REAL order is placed and the
//             store's REAL acceptance lands exactly one inbox row and exactly
//             one push, whose payload is the one the app's tap router reads
//             (orderId, no business audience, no diverting kind) and whose
//             destination opens for the owner and 404s for anyone else;
//             another account can neither see, read, read-all nor silence it;
//             reading drops the unread count by exactly one; a device
//             deactivated at logout receives nothing more.
//   NOTIF-02  a REAL checkout arms the vendor alert ladder (the outbox job the
//             worker consumes, at its production delay); the worker's rung 0
//             re-alerts by push — one transient provider failure is retried
//             by the production withPushRetry to exactly ONE receipt — and
//             arms rung 1, which falls back to SMS; a stranger store's ack is
//             refused and silences nothing; the store's own ack stops the
//             ladder; an SMS provider failure on the last rung is counted,
//             never silent and never receipted.
//   G5-F1     [it.fails] a stranger's refused ack still stamps the store's
//             alert-delivery receipt as acknowledged (the stamp runs before
//             the ownership check).
//
// The worker is driven exactly as its processor runs (jobs/queue.ts, the
// NOTIFICATION worker): escalateVendorAlert(prisma, io, getChannels(), …) and,
// on 'realerted', enqueueVendorAlertFollowup. The queues are an acknowledged
// recording double: the checkout's outbox drain publishes into it and the
// recorded jobs are asserted, then driven. Dispatch is recorded, not run.
//
// Fixture range: +5920351nnn (this file only; audited range-aware against
// every phone literal, generator and purge prefix under apps/, packages/ and
// scripts/).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920351';
const FIXTURE = 'gold5-notif-fixture';
const STORE_AT = { lat: 6.80131, lng: -58.15512 };
const HOME_AT = { lat: 6.80455, lng: -58.15533 };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; phone: string; firstName: string };
type Recorded = { queue: string; name: string; data: Record<string, unknown>; opts: Record<string, unknown> };
const published: Recorded[] = [];

function recorder(queue: string) {
  return {
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
      published.push({ queue, name, data, opts });
      return { id: String(opts['jobId'] ?? `recorded-${published.length}`) };
    },
  };
}
const queues = { orderQueue: recorder('order'), notificationQueue: recorder('notification'), dispatchQueue: recorder('dispatch') };

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone, firstName, lastName: `Notif${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `gold5-notif-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, phone, firstName };
}

async function makeStore(owner: Actor, name: string) {
  const vendorOwner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name, slug: `gold5-notif-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: owner.phone, addressLine1: '1 Golden Notice Way', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE_AT.lat, longitude: STORE_AT.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 10,
    },
  }));
  const category = await sys(() => app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } }));
  const item = await sys(() => app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Pepperpot', basePrice: 2500, isAvailable: true } }));
  return { vendorId: vendor.id, itemId: item.id, name };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

/** A real cash order: cart → address → checkout, through the mounted routes. */
async function placeOrder(customer: Actor, store: { vendorId: string; itemId: string }) {
  const address = await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '77 Golden Notice Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME_AT.lat, longitude: HOME_AT.lng, isDefault: true },
  }));
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBeLessThan(300);
  const addressed = await call('PUT', '/api/v1/customer/cart/address', customer.token, { addressId: address.id });
  expect(addressed.statusCode, addressed.body).toBe(200);
  const checkout = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': `gold5-notif-${nanoid(12)}` });
  expect(checkout.statusCode, checkout.body).toBe(200);
  const orders = checkout.json().data.orders as Array<{ id: string; orderNumber: string }>;
  expect(orders).toHaveLength(1);
  return { orderId: orders[0]!.id, orderNumber: orders[0]!.orderNumber };
}

const pushesTo = (token: string) => devChannelLog.filter((e) => e.channel === 'push' && e.to === token);
const smsTo = (phone: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);

async function failures(channel: string, stage: string): Promise<number> {
  const metric = await notificationFailuresCounter.get();
  return metric.values.find((v) => v.labels['channel'] === channel && v.labels['stage'] === stage)?.value ?? 0;
}

/** The worker's NOTIFICATION processor, step for step (jobs/queue.ts). */
async function runLadderJob(orderId: string, level: number) {
  const outcome = await escalateVendorAlert(app.prisma, app.io, getChannels(), orderId, level);
  if (outcome === 'realerted') await enqueueVendorAlertFollowup(queues as never, orderId);
  return outcome;
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
    const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.deviceToken.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await purgeRedis([...ids, ...vendorIds, ...orderIds]);
  });
}

async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.decorate('queues', queues as never);
  app.decorate('dispatchQueue', queues.dispatchQueue as never);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

// ---------------------------------------------------------------------------
// NOTIF-01 — device token → real order event → inbox → read → tap destination
// ---------------------------------------------------------------------------

describe('GOLD-5 · NOTIF-01 — push register and inbox', () => {
  let alice: Actor;
  let bram: Actor;
  let owner: Actor;
  let store: { vendorId: string; itemId: string; name: string };
  let order = { orderId: '', orderNumber: '' };
  let aliceToken = '';
  let bramToken = '';
  let rowId = '';

  beforeAll(async () => {
    alice = await makeUser('Alicia', ['CUSTOMER'], 'CUSTOMER');
    bram = await makeUser('Bram', ['CUSTOMER'], 'CUSTOMER');
    owner = await makeUser('Omar', ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    store = await makeStore(owner, 'Gold5 Notice Diner');
  });

  it('registers the device, and the store’s real acceptance lands ONE inbox row and ONE push whose payload routes the tap to the order', async () => {
    aliceToken = `ExponentPushToken[g5a${nanoid(16)}]`;
    bramToken = `ExponentPushToken[g5b${nanoid(16)}]`;
    const reg = await call('POST', '/api/v1/customer/notifications/devices', alice.token, { token: aliceToken, platform: 'ios' });
    expect(reg.statusCode, reg.body).toBe(200);
    const regB = await call('POST', '/api/v1/customer/notifications/devices', bram.token, { token: bramToken, platform: 'android' });
    expect(regB.statusCode, regB.body).toBe(200);
    const devices = await sys(() => app.prisma.deviceToken.findMany({ where: { userId: { in: [alice.userId, bram.userId] } }, orderBy: { platform: 'asc' } }));
    expect(devices.map((d) => ({ user: d.userId, token: d.token, platform: d.platform, active: d.isActive }))).toEqual([
      { user: bram.userId, token: bramToken, platform: 'android', active: true },
      { user: alice.userId, token: aliceToken, platform: 'ios', active: true },
    ]);

    order = await placeOrder(alice, store);
    // The checkout itself tells the customer nothing: the store must act first.
    expect(await sys(() => app.prisma.notification.count({ where: { userId: alice.userId } }))).toBe(0);
    expect(pushesTo(aliceToken)).toHaveLength(0);

    const accepted = await call('PUT', `/api/v1/vendor/orders/${order.orderId}/accept`, owner.token, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().data.status).toBe('ACCEPTED');

    const expectedData = { orderId: order.orderId, orderNumber: order.orderNumber, status: 'ACCEPTED' };
    const rows = await sys(() => app.prisma.notification.findMany({ where: { userId: alice.userId } }));
    expect(rows.map((r) => ({ type: r.type, title: r.title, body: r.body, data: r.data, isRead: r.isRead, readAt: r.readAt }))).toEqual([{
      type: 'ORDER_UPDATE',
      title: 'Order Accepted!',
      body: `${store.name} has accepted your order ${order.orderNumber} and is preparing it.`,
      data: expectedData,
      isRead: false,
      readAt: null,
    }]);
    rowId = rows[0]!.id;

    // The inbox the app reads is that row, as the route serves it.
    const inbox = await call('GET', '/api/v1/customer/notifications', alice.token);
    expect(inbox.statusCode).toBe(200);
    const served = inbox.json().data as Array<{ id: string; title: string; data: unknown; isRead: boolean }>;
    expect(served.map((n) => ({ id: n.id, title: n.title, data: n.data, isRead: n.isRead }))).toEqual([{ id: rowId, title: 'Order Accepted!', data: expectedData, isRead: false }]);

    // Exactly one push, to Alicia's device only, carrying the inbox row's own payload.
    expect(pushesTo(aliceToken).map((p) => ({ title: p.title, body: p.body, data: p.data }))).toEqual([
      { title: 'Order Accepted!', body: rows[0]!.body, data: expectedData },
    ]);
    expect(pushesTo(bramToken)).toHaveLength(0);

    // TAP ROUTING, the server's half: the mobile router (notification-router.ts)
    // opens the order screen for any payload that carries the orderId and is
    // neither a special kind nor addressed to a business. The payload is
    // exactly that — and the destination it names opens for the owner.
    const payload = pushesTo(aliceToken)[0]!.data as Record<string, unknown>;
    expect(payload['orderId']).toBe(order.orderId);
    expect(payload).not.toHaveProperty('kind');
    expect(payload).not.toHaveProperty('audience');
    const destination = await call('GET', `/api/v1/customer/orders/${payload['orderId'] as string}`, alice.token);
    expect(destination.statusCode, destination.body).toBe(200);
    expect({ id: destination.json().data.id, status: destination.json().data.status }).toEqual({ id: order.orderId, status: 'ACCEPTED' });
  });

  it('another account can neither see, read, read-all nor silence it, and its tap destination is refused', async () => {
    expect(rowId, 'the first test landed the row').not.toBe('');
    const inbox = await call('GET', '/api/v1/customer/notifications', bram.token);
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().data).toEqual([]);
    expect((await call('GET', '/api/v1/customer/notifications/unread-count', bram.token)).json().data).toEqual({ count: 0 });

    const steal = await call('PUT', `/api/v1/customer/notifications/${rowId}/read`, bram.token);
    expect(steal.statusCode).toBe(200); // a no-op by design: the write is scoped to the caller
    const readAll = await call('PUT', '/api/v1/customer/notifications/read-all', bram.token);
    expect(readAll.statusCode).toBe(200);
    const silence = await call('DELETE', '/api/v1/customer/notifications/devices', bram.token, { token: aliceToken });
    expect(silence.statusCode).toBe(200);

    const row = await sys(() => app.prisma.notification.findUniqueOrThrow({ where: { id: rowId } }));
    expect({ isRead: row.isRead, readAt: row.readAt, owner: row.userId }).toEqual({ isRead: false, readAt: null, owner: alice.userId });
    const device = await sys(() => app.prisma.deviceToken.findUniqueOrThrow({ where: { token: aliceToken } }));
    expect({ user: device.userId, active: device.isActive }).toEqual({ user: alice.userId, active: true });

    const destination = await call('GET', `/api/v1/customer/orders/${order.orderId}`, bram.token);
    expect(destination.statusCode).toBe(404);
    const anonymous = await call('GET', '/api/v1/customer/notifications');
    expect(anonymous.statusCode).toBe(401);
  });

  it('reading drops the unread count by exactly one; a device deactivated at logout receives nothing more', async () => {
    expect(rowId, 'the first test landed the row').not.toBe('');
    expect((await call('GET', '/api/v1/customer/notifications/unread-count', alice.token)).json().data).toEqual({ count: 1 });
    const unread = await call('GET', '/api/v1/customer/notifications?unread=true', alice.token);
    expect((unread.json().data as Array<{ id: string }>).map((n) => n.id)).toEqual([rowId]);

    const before = Date.now();
    const read = await call('PUT', `/api/v1/customer/notifications/${rowId}/read`, alice.token);
    const after = Date.now();
    expect(read.statusCode).toBe(200);
    const row = await sys(() => app.prisma.notification.findUniqueOrThrow({ where: { id: rowId } }));
    expect(row.isRead).toBe(true);
    expect(row.readAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(row.readAt!.getTime()).toBeLessThanOrEqual(after + 5);
    expect((await call('GET', '/api/v1/customer/notifications/unread-count', alice.token)).json().data).toEqual({ count: 0 });
    expect((await call('GET', '/api/v1/customer/notifications?unread=true', alice.token)).json().data).toEqual([]);
    const all = await call('GET', '/api/v1/customer/notifications', alice.token);
    expect((all.json().data as Array<{ id: string; isRead: boolean }>).map((n) => ({ id: n.id, isRead: n.isRead }))).toEqual([{ id: rowId, isRead: true }]);

    // Logout deactivates the device; the next event lands in the inbox only.
    const logout = await call('DELETE', '/api/v1/customer/notifications/devices', alice.token, { token: aliceToken });
    expect(logout.statusCode).toBe(200);
    expect((await sys(() => app.prisma.deviceToken.findUniqueOrThrow({ where: { token: aliceToken } }))).isActive).toBe(false);
    const preparing = await call('PUT', `/api/v1/vendor/orders/${order.orderId}/preparing`, owner.token, {});
    expect(preparing.statusCode, preparing.body).toBe(200);
    const rows = await sys(() => app.prisma.notification.findMany({ where: { userId: alice.userId }, orderBy: { createdAt: 'asc' } }));
    expect(rows.map((r) => ({ title: r.title, data: r.data, isRead: r.isRead }))).toEqual([
      { title: 'Order Accepted!', data: { orderId: order.orderId, orderNumber: order.orderNumber, status: 'ACCEPTED' }, isRead: true },
      { title: 'Being Prepared', data: { orderId: order.orderId, orderNumber: order.orderNumber, status: 'PREPARING' }, isRead: false },
    ]);
    expect(pushesTo(aliceToken).map((p) => p.title)).toEqual(['Order Accepted!']);
  });
});

// ---------------------------------------------------------------------------
// NOTIF-02 — the vendor alert ladder: push → unread re-alert → SMS fallback
// ---------------------------------------------------------------------------

describe('GOLD-5 · NOTIF-02 — SMS fallback and escalation', () => {
  let owner: Actor;
  let stranger: Actor;
  let customer: Actor;
  let store: { vendorId: string; itemId: string; name: string };
  let vendorDevice = '';
  let o2 = { orderId: '', orderNumber: '' };

  const alertRow = (orderId: string) => sys(() => app.prisma.notification.findFirstOrThrow({
    where: { userId: owner.userId, AND: [{ data: { path: ['kind'], equals: 'vendor_order_alert' } }, { data: { path: ['orderId'], equals: orderId } }] },
  }));
  const receipt = (orderId: string) => sys(() => app.prisma.alertDelivery.findFirstOrThrow({ where: { kind: 'VENDOR_ORDER', subjectId: orderId } }));
  const ladderJobs = (orderId: string) => published
    .filter((j) => j.queue === 'notification' && j.name === 'vendor-alert-escalate' && j.data['orderId'] === orderId)
    .map((j) => ({ level: j.data['level'], delay: j.opts['delay'] }));

  beforeAll(async () => {
    owner = await makeUser('Vashti', ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    stranger = await makeUser('Sunil', ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    customer = await makeUser('Carla', ['CUSTOMER'], 'CUSTOMER');
    store = await makeStore(owner, 'Gold5 Ladder Kitchen');
    await makeStore(stranger, 'Gold5 Other Kitchen');
    vendorDevice = `ExponentPushToken[g5v${nanoid(16)}]`;
    const reg = await call('POST', '/api/v1/customer/notifications/devices', owner.token, { token: vendorDevice, platform: 'android' });
    expect(reg.statusCode, reg.body).toBe(200);
  });

  it('a real order arms the ladder; rung 0 re-alerts by push — one transient provider failure is retried to exactly ONE receipt — and rung 1 falls back to SMS', async () => {
    o2 = await placeOrder(customer, store);

    // The alert: one inbox row (the ladder's state), one push, one delivery receipt.
    const alert = await alertRow(o2.orderId);
    expect({ title: alert.title, isRead: alert.isRead, data: alert.data }).toEqual({
      title: 'New Order!', isRead: false,
      data: { orderId: o2.orderId, orderNumber: o2.orderNumber, status: 'PENDING', kind: 'vendor_order_alert' },
    });
    expect(pushesTo(vendorDevice).map((p) => ({ title: p.title, data: p.data }))).toEqual([
      { title: 'New Order!', data: { orderId: o2.orderId, orderNumber: o2.orderNumber, status: 'PENDING', kind: 'vendor_order_alert' } },
    ]);
    const tracked = await receipt(o2.orderId);
    expect({ recipient: tracked.recipientId, ack: tracked.acknowledgedAt }).toEqual({ recipient: owner.userId, ack: null });
    const pending = await call('GET', '/api/v1/vendor/alerts/pending', owner.token);
    expect((pending.json().data as Array<{ id: string }>).map((a) => a.id)).toEqual([alert.id]);

    // The checkout's outbox armed rung 0 at the production delay (60 s).
    const armed = ladderJobs(o2.orderId);
    expect(armed).toHaveLength(1);
    expect(armed[0]!.level).toBe(0);
    expect(armed[0]!.delay as number).toBeGreaterThan(55_000);
    expect(armed[0]!.delay as number).toBeLessThanOrEqual(60_000);

    // RUNG 0 — the provider fails the re-alert push once; the production
    // withPushRetry backs off and delivers it exactly once.
    let attempts = 0;
    const deliver = Array.prototype.push;
    const outage = vi.spyOn(devChannelLog, 'push').mockImplementation(function (this: DevChannelEntry[], ...entries: DevChannelEntry[]) {
      if (entries.some((e) => e.channel === 'push' && e.to === vendorDevice && e.title === 'Order still waiting!')) {
        attempts += 1;
        if (attempts === 1) throw new Error('push relay 503');
      }
      return deliver.apply(devChannelLog, entries);
    });
    const started = Date.now();
    let outcome: string;
    try {
      outcome = await runLadderJob(o2.orderId, 0);
    } finally {
      outage.mockRestore();
    }
    expect(outcome).toBe('realerted');
    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(PUSH_RETRY_DELAYS_MS[0]! - 50);
    expect(pushesTo(vendorDevice).map((p) => ({ title: p.title, body: p.body, data: p.data }))).toEqual([
      { title: 'New Order!', body: alert.body, data: { orderId: o2.orderId, orderNumber: o2.orderNumber, status: 'PENDING', kind: 'vendor_order_alert' } },
      { title: 'Order still waiting!', body: alert.body, data: { orderId: o2.orderId } },
    ]);
    expect(smsTo(owner.phone)).toHaveLength(0);
    // …and the worker armed rung 1, one minute on.
    expect(ladderJobs(o2.orderId)).toEqual([armed[0], { level: 1, delay: 60_000 }]);

    // RUNG 1 — still unread: the SMS fallback, exactly once, to the owner's phone.
    expect(await runLadderJob(o2.orderId, 1)).toBe('sms_sent');
    expect(smsTo(owner.phone).map((s) => s.body)).toEqual([
      `Swift: order ${o2.orderNumber} is still waiting for your response. Open your dashboard now.`,
    ]);
    expect(pushesTo(vendorDevice)).toHaveLength(2);
    expect((await alertRow(o2.orderId)).isRead).toBe(false);
  });

  it('a stranger store’s ack is refused and silences nothing; the store’s own ack stops the ladder', async () => {
    expect(o2.orderId, 'the ladder test placed the order').not.toBe('');
    const foreign = await call('PUT', `/api/v1/vendor/orders/${o2.orderId}/ack`, stranger.token, {});
    expect(foreign.statusCode).toBe(404);
    const customerTry = await call('PUT', `/api/v1/vendor/orders/${o2.orderId}/ack`, customer.token, {});
    expect(customerTry.statusCode).toBe(403);
    expect((await alertRow(o2.orderId)).isRead).toBe(false);
    const stillPending = await call('GET', '/api/v1/vendor/alerts/pending', owner.token);
    expect((stillPending.json().data as unknown[])).toHaveLength(1);

    const before = Date.now();
    const ack = await call('PUT', `/api/v1/vendor/orders/${o2.orderId}/ack`, owner.token, {});
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json().data).toEqual({ acknowledged: true });
    const acked = await alertRow(o2.orderId);
    expect(acked.isRead).toBe(true);
    const ackedAfter = Date.now();
    expect(acked.readAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(acked.readAt!.getTime()).toBeLessThanOrEqual(ackedAfter + 5);
    // (The delivery receipt is not asserted here: the stranger's refused ack
    // above already stamped it — that is G5-F1, pinned below.)
    expect((await call('GET', '/api/v1/vendor/alerts/pending', owner.token)).json().data).toEqual([]);

    // Every later rung is a no-op: nothing more reaches the store.
    const pushes = pushesTo(vendorDevice).length;
    const texts = smsTo(owner.phone).length;
    expect(await runLadderJob(o2.orderId, 0)).toBe('stopped');
    expect(await runLadderJob(o2.orderId, 1)).toBe('stopped');
    expect(pushesTo(vendorDevice)).toHaveLength(pushes);
    expect(smsTo(owner.phone)).toHaveLength(texts);
    expect(ladderJobs(o2.orderId)).toHaveLength(2);
  });

  it('an SMS provider failure on the last rung is counted, never silent and never receipted; accepting the order stops the ladder', async () => {
    const o3 = await placeOrder(customer, store);
    expect(await runLadderJob(o3.orderId, 0)).toBe('realerted');
    const texts = smsTo(owner.phone).length;
    const counted = await failures('sms', 'escalation');

    const sms = getChannels().sms;
    const down = vi.spyOn(sms, 'sendSms').mockRejectedValue(new Error('sms gateway 503'));
    let outcome: string;
    try {
      outcome = await runLadderJob(o3.orderId, 1);
    } finally {
      down.mockRestore();
    }
    // The ladder completes (fail-soft), but the miss is counted and nothing claims it was sent.
    expect(outcome).toBe('sms_sent');
    expect(await failures('sms', 'escalation')).toBe(counted + 1);
    expect(smsTo(owner.phone)).toHaveLength(texts);
    expect((await alertRow(o3.orderId)).isRead).toBe(false);

    const acceptAt = Date.now();
    const accepted = await call('PUT', `/api/v1/vendor/orders/${o3.orderId}/accept`, owner.token, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await alertRow(o3.orderId)).isRead).toBe(true);
    const acceptStamp = (await receipt(o3.orderId)).acknowledgedAt!;
    expect(acceptStamp.getTime()).toBeGreaterThanOrEqual(acceptAt - 5);
    expect(acceptStamp.getTime()).toBeLessThanOrEqual(Date.now() + 5);
    const pushes = pushesTo(vendorDevice).length;
    expect(await runLadderJob(o3.orderId, 0)).toBe('stopped');
    expect(pushesTo(vendorDevice)).toHaveLength(pushes);
  });
});

// ---------------------------------------------------------------------------
// G5-F1 — a refused ack still stamps the store's alert-delivery receipt
// ---------------------------------------------------------------------------
//
// vendor.routes.ts `PUT /orders/:id/ack` (and accept / reject) call
// acknowledgeAlert(prisma, 'VENDOR_ORDER', orderId) BEFORE resolveOwnedOrder,
// with no recipient: any signed-in account that names an order id stamps
// acknowledgedAt on that store's delivery receipt, and only then is refused.
// The receipt is the alert-latency record the admin alerts view reads. This
// asserts the correct behaviour; the setup runs in beforeAll, so the only
// assertion that can fail is the receipt check.
describe('GOLD-5 · NOTIF-02 — G5-F1', () => {
  let orderId = '';
  let refusedStatus = 0;
  let ownerId = '';

  beforeAll(async () => {
    const owner = await makeUser('Rekha', ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    const stranger = await makeUser('Tariq', ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    const customer = await makeUser('Indra', ['CUSTOMER'], 'CUSTOMER');
    ownerId = owner.userId;
    const store = await makeStore(owner, 'Gold5 Receipt Kitchen');
    await makeStore(stranger, 'Gold5 Stranger Kitchen');
    orderId = (await placeOrder(customer, store)).orderId;
    const tracked = await sys(() => app.prisma.alertDelivery.findFirstOrThrow({ where: { kind: 'VENDOR_ORDER', subjectId: orderId } }));
    expect({ recipient: tracked.recipientId, ack: tracked.acknowledgedAt }).toEqual({ recipient: ownerId, ack: null });
    refusedStatus = (await call('PUT', `/api/v1/vendor/orders/${orderId}/ack`, stranger.token, {})).statusCode;
    expect(refusedStatus).toBe(404);
  });

  it.fails('[G5-F1] a stranger’s refused ack leaves the store’s alert-delivery receipt unacknowledged', async () => {
    const tracked = await sys(() => app.prisma.alertDelivery.findFirstOrThrow({ where: { kind: 'VENDOR_ORDER', subjectId: orderId } }));
    expect(tracked.acknowledgedAt).toBeNull();
  });
});
