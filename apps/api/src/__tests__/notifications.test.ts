import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService, escalateVendorAlert } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { getChannels, devChannelLog } from '../providers/notifications/channels';
import { notificationFailuresCounter } from '../plugins/observability';
import { requestOtp } from './helpers/otp';

async function failuresCount(channel: string, stage: string): Promise<number> {
  const metric = await notificationFailuresCounter.get();
  return metric.values.find((v) => v.labels.channel === channel && v.labels.stage === stage)?.value ?? 0;
}

// ---------------------------------------------------------------------------
// every event through one interface. The vendor order alert is the
// loud one: cannot be swiped away (unread row = banner state), re-alerts,
// then the SMS fallback fires — and the dev adapter logs all of it locally.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const OTP_PHONE = '+5920014401';

let app: FastifyInstance;
let notifications: NotificationService;
let orders: OrderService;

const createdUserIds: string[] = [];

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: '+59200144' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const ord = await app.prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  const orderIds = ord.map((o) => o.id);
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 1;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200144${String(seq).padStart(2, '0')}`,
      firstName: 'Notify',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'step11', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, phone: user.phone, token };
}

function smsEntriesTo(phone: string) {
  return devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);
}
function pushEntriesTo(token: string) {
  return devChannelLog.filter((e) => e.channel === 'push' && e.to === token);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  notifications = new NotificationService(app.prisma, ioStub);
  orders = new OrderService(app.prisma, ioStub);

  await purgeFixtures();
  await app.redis.del(`otp:${OTP_PHONE}`, `otp_rate:${OTP_PHONE}`, `otp_hr:${OTP_PHONE}`, `otp_attempt:${OTP_PHONE}`, `otp_verified:${OTP_PHONE}`);
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('Channels — one interface, dev adapter logs everything', () => {
  it('OTPs go out through the SMS channel', async () => {
    await requestOtp(app, OTP_PHONE);
    const sms = smsEntriesTo(OTP_PHONE);
    expect(sms.length).toBeGreaterThan(0);
    // Codes are hashed at rest now, so the helper can't return the real one —
    // assert the SMS carried A six-digit code through the channel.
    expect(sms.at(-1)!.body).toMatch(/code is: \d{6}/);
  });

  it('send() fans out to device tokens and honours prefs', async () => {
    const user = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const deviceToken = `dev-token-${nanoid(8)}`;
    await app.prisma.deviceToken.create({
      data: { userId: user.userId, token: deviceToken, platform: 'android' },
    });

    await notifications.send({
      userId: user.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Hello',
      body: 'Push goes through the interface',
    });
    expect(pushEntriesTo(deviceToken)).toHaveLength(1);

    // Turn push off — the same send produces nothing new
    await app.prisma.user.update({
      where: { id: user.userId },
      data: { notificationPrefs: { push: false } },
    });
    await notifications.send({
      userId: user.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Quiet',
      body: 'Should not push',
    });
    expect(pushEntriesTo(deviceToken)).toHaveLength(1);
  });

  it('customers can flip their prefs over HTTP', async () => {
    const user = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/customer/notifications/prefs',
      payload: { push: false, email: true },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ push: false, sms: true, email: true });
  });
});

// ---------------------------------------------------------------------------
// [REPORT-034 #30] send() idempotency. Every BullMQ job retries with backoff,
// so any notification sent inside one could land twice — same inbox row, same
// push, twice. A deterministic dedupeKey collapses the retry into the first
// delivery; keyless sends keep today's behavior exactly (NULLs never collide).
// ---------------------------------------------------------------------------
describe('send() dedupeKey — a retried job never pages a person twice', () => {
  it('the same key collapses: one inbox row, one push, both calls return the first id', async () => {
    const user = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const deviceToken = `dev-token-${nanoid(8)}`;
    await app.prisma.deviceToken.create({ data: { userId: user.userId, token: deviceToken, platform: 'android' } });

    const key = `test-fact:${nanoid(6)}`;
    const first = await notifications.send({
      userId: user.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Once', body: 'Retried jobs land once', dedupeKey: key,
    });
    const second = await notifications.send({
      userId: user.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Once', body: 'Retried jobs land once', dedupeKey: key,
    });

    expect(first).not.toBe('');
    expect(second).toBe(first); // the retry got the FIRST delivery's receipt
    expect(await app.prisma.notification.count({ where: { userId: user.userId, dedupeKey: key } })).toBe(1);
    expect(pushEntriesTo(deviceToken)).toHaveLength(1); // and exactly one push
  });

  it('different keys are different facts — two rows', async () => {
    const user = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const a = await notifications.send({ userId: user.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'A', body: 'a', dedupeKey: `fact-a:${nanoid(6)}` });
    const b = await notifications.send({ userId: user.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'B', body: 'b', dedupeKey: `fact-b:${nanoid(6)}` });
    expect(a).not.toBe(b);
    expect(await app.prisma.notification.count({ where: { userId: user.userId } })).toBe(2);
  });

  it('keyless sends never collide — existing callers are untouched', async () => {
    const user = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const a = await notifications.send({ userId: user.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'X', body: 'x' });
    const b = await notifications.send({ userId: user.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'X', body: 'x' });
    expect(a).not.toBe(b);
    expect(await app.prisma.notification.count({ where: { userId: user.userId } })).toBe(2);
  });

  it('the same key for DIFFERENT users never collapses — the key is per person', async () => {
    const u1 = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const u2 = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const key = 'shared-fact:deadline-2026-08-26T20:00:00Z';
    const a = await notifications.send({ userId: u1.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'S', body: 's', dedupeKey: key });
    const b = await notifications.send({ userId: u2.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'S', body: 's', dedupeKey: key });
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(a).not.toBe(b);
  });
});

describe('THE vendor order alert — unmissable until acknowledged', () => {
  let vendorUser: { userId: string; phone: string; token: string };
  let vendorId: string;
  let orderId: string;
  let vendorDeviceToken: string;
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;

  beforeAll(async () => {
    vendorUser = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const owner = await app.prisma.vendorOwner.create({ data: { userId: vendorUser.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id, name: 'Alert Diner', slug: `alert-diner-${nanoid(6)}`,
        vendorType: 'RESTAURANT', phone: vendorUser.phone,
        addressLine1: '1 Alert Avenue', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 7.31, longitude: -58.72,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
    vendorId = vendor.id;
    vendorDeviceToken = `vendor-token-${nanoid(8)}`;
    await app.prisma.deviceToken.create({
      data: { userId: vendorUser.userId, token: vendorDeviceToken, platform: 'android' },
    });

    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `S11-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: customer.userId,
        vendorId,
        status: 'PENDING',
        fulfillment: 'PICKUP',
        deliveryAddress: 'counter', deliveryLat: 7.31, deliveryLng: -58.72,
        pickupAddress: 'counter', pickupLat: 7.31, pickupLng: -58.72,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
        deliveryFee: 0, totalAmount: 2000, paymentMethod: 'CASH',
      },
    });
    orderId = order.id;
  });

  it('a new order creates the persistent alert (unread = banner state)', async () => {
    await notifications.newOrderForVendor(vendorUser.userId, 'S11-TEST', 2, 2000, orderId);

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor/alerts/pending',
      headers: { authorization: `Bearer ${vendorUser.token}` },
    });
    expect(pending.statusCode).toBe(200);
    const alerts = pending.json().data;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].data.orderId).toBe(orderId);
  });

  it('unacknowledged: re-alert fires, then the SMS fallback', async () => {
    const first = await escalateVendorAlert(app.prisma, ioStub, getChannels(), orderId, 0);
    expect(first).toBe('realerted');
    expect(pushEntriesTo(vendorDeviceToken).some((e) => e.title === 'Order still waiting!')).toBe(true);

    const second = await escalateVendorAlert(app.prisma, ioStub, getChannels(), orderId, 1);
    expect(second).toBe('sms_sent');
    const sms = smsEntriesTo(vendorUser.phone);
    expect(sms.at(-1)!.body).toContain('still waiting');
  });

  it('a failed escalation SMS is counted, never swallowed silently [SWIFT-100]', async () => {
    // The last rung fails at the provider. It must NOT throw (the ladder still
    // "completes"), but the failure must be visible — the counter moves.
    const failingChannels = {
      sms: { sendSms: async () => { throw new Error('SMS provider 500'); } },
      push: { sendPush: async () => ({ invalidTokens: [] }) },
    } as unknown as ReturnType<typeof getChannels>;

    const before = await failuresCount('sms', 'escalation');
    const outcome = await escalateVendorAlert(app.prisma, ioStub, failingChannels, orderId, 1);
    expect(outcome).toBe('sms_sent'); // fail-soft — never throws
    expect((await failuresCount('sms', 'escalation')) - before).toBe(1); // but no longer silent
  });

  it('acknowledging clears the banner and silences the escalation', async () => {
    const ack = await app.inject({
      method: 'PUT',
      url: `/api/v1/vendor/orders/${orderId}/ack`,
      headers: { authorization: `Bearer ${vendorUser.token}` },
    });
    expect(ack.statusCode).toBe(200);

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor/alerts/pending',
      headers: { authorization: `Bearer ${vendorUser.token}` },
    });
    expect(pending.json().data).toHaveLength(0);

    const before = devChannelLog.length;
    const outcome = await escalateVendorAlert(app.prisma, ioStub, getChannels(), orderId, 0);
    expect(outcome).toBe('stopped');
    expect(devChannelLog.length).toBe(before); // nothing new sent
  });

  it('accepting an order acknowledges its alert automatically', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `S11B-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: customer.userId,
        vendorId,
        status: 'PENDING',
        fulfillment: 'PICKUP',
        deliveryAddress: 'counter', deliveryLat: 7.31, deliveryLng: -58.72,
        pickupAddress: 'counter', pickupLat: 7.31, pickupLng: -58.72,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      },
    });
    await notifications.newOrderForVendor(vendorUser.userId, order.orderNumber, 1, 1000, order.id);

    const accept = await app.inject({
      method: 'PUT',
      url: `/api/v1/vendor/orders/${order.id}/accept`,
      headers: { authorization: `Bearer ${vendorUser.token}` },
    });
    expect(accept.statusCode).toBe(200);

    const outcome = await escalateVendorAlert(app.prisma, ioStub, getChannels(), order.id, 0);
    expect(outcome).toBe('stopped');
  });
});

describe('Event audit — every state change emits through the interface', () => {
  it('an order walk leaves one notification per customer-facing transition', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const vendorUser = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const owner = await app.prisma.vendorOwner.create({ data: { userId: vendorUser.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id, name: 'Audit Diner', slug: `audit-diner-${nanoid(6)}`,
        vendorType: 'RESTAURANT', phone: vendorUser.phone,
        addressLine1: '2 Audit Avenue', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 7.32, longitude: -58.73,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });

    const order = await app.prisma.order.create({
      data: {
        orderNumber: `S11C-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: customer.userId,
        vendorId: vendor.id,
        status: 'PENDING',
        deliveryAddress: 'audit street', deliveryLat: 7.32, deliveryLng: -58.73,
        pickupAddress: 'audit corner', pickupLat: 7.32, pickupLng: -58.73,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
        deliveryFee: 500, totalAmount: 2000, paymentMethod: 'CASH',
      },
    });

    const chain = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED'] as const;
    for (const status of chain) {
      await orders.updateStatus(order.id, status, 'audit-test');
    }

    const rows = await app.prisma.notification.findMany({
      where: { userId: customer.userId, data: { path: ['orderId'], equals: order.id } },
    });
    const statuses = rows.map((r) => (r.data as { status?: string }).status);
    for (const status of chain) {
      expect(statuses).toContain(status);
    }
  });
});
