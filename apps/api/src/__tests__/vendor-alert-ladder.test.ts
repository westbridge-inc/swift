import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService, escalateVendorAlert } from '../modules/notification/notification.service';
import { getChannels, devChannelLog } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [Q10 loud alerts 1/4] THE STORE NEW-ORDER LADDER, fixed where it lied.
//
//  1. It stopped only when the OWNER read the alert row. A staff member
//     accepting the order, or the customer cancelling it, left that row
//     unread, so the owner still got "Order still waiting!" pushes and then
//     an SMS about an order nobody was waiting on.
//  2. The re-alert push carried only { orderId }. The tap-router sends a bare
//     orderId to the CUSTOMER Delivery screen, which the vendor app never
//     mounts: the loudest push in the app opened nothing.
//  3. acknowledgeAlert ran BEFORE the ownership check on ack, accept and
//     reject, so another store (any signed-in account) naming an order id
//     stamped this store alert receipt as acknowledged, and only then got 404.
//
// Fixture range: +5920417nnn (this file only; grep of apps/, packages/ and
// scripts/ found no other use of 5920417).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920417';

let app: FastifyInstance;
let notifications: NotificationService;
const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;

type Actor = { userId: string; phone: string; token: string };
let owner: Actor;
let staff: Actor;
let stranger: Actor;
let customer: Actor;
let vendorId: string;
let ownerDevice: string;

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Ladder',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: `q10-ladder-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, phone: user.phone, token };
}

async function makeStore(storeOwner: Actor, name: string): Promise<string> {
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: storeOwner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name, slug: `q10-ladder-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: storeOwner.phone,
      addressLine1: '4 Ladder Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.81, longitude: -58.16,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  return vendor.id;
}

/** A PENDING pickup order at the store, and its new-order alert to the owner. */
async function pendingOrderWithAlert(respondBy = new Date(Date.now() + 10 * 60_000)) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `Q10L-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId: customer.userId,
      vendorId,
      status: 'PENDING',
      fulfillment: 'PICKUP',
      deliveryAddress: 'counter', deliveryLat: 6.81, deliveryLng: -58.16,
      pickupAddress: 'counter', pickupLat: 6.81, pickupLng: -58.16,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500,
      deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    },
  });
  await notifications.newOrderForVendor(owner.userId, order.orderNumber, 1, 1500, order.id, respondBy);
  return { orderId: order.id, orderNumber: order.orderNumber, respondBy };
}

const pushesTo = (token: string) => devChannelLog.filter((e) => e.channel === 'push' && e.to === token);
const smsTo = (phone: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);
const ownerAlertRow = (orderId: string) => app.prisma.notification.findFirstOrThrow({
  where: { userId: owner.userId, AND: [{ data: { path: ['kind'], equals: 'vendor_order_alert' } }, { data: { path: ['orderId'], equals: orderId } }] },
});
const receipt = (orderId: string) => app.prisma.alertDelivery.findFirstOrThrow({ where: { kind: 'VENDOR_ORDER', subjectId: orderId } });

function call(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
  });
}

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
  const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
  const orderIds = (await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }] },
    select: { id: true },
  })).map((o) => o.id);
  await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.deviceToken.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  notifications = new NotificationService(app.prisma, ioStub);
  await purgeFixtures();

  owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
  stranger = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  vendorId = await makeStore(owner, 'Ladder Kitchen');
  await makeStore(stranger, 'Other Kitchen');
  await app.prisma.vendorStaff.create({ data: { vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } });
  ownerDevice = `ExponentPushToken[q10l${nanoid(12)}]`;
  await app.prisma.deviceToken.create({ data: { userId: owner.userId, token: ownerDevice, platform: 'android' } });
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('[Q10] the ladder stops once nobody is waiting, whoever ended the wait', () => {
  it('a STAFF member accepting stops it: no "still waiting" push and no SMS to the owner', async () => {
    const o = await pendingOrderWithAlert();
    const accepted = await call('PUT', `/api/v1/vendor/orders/${o.orderId}/accept`, staff.token);
    expect(accepted.statusCode, accepted.body).toBe(200);
    // The old stop signal never fired: the owner never touched the alert.
    expect((await ownerAlertRow(o.orderId)).isRead).toBe(false);

    const pushes = pushesTo(ownerDevice).length;
    const texts = smsTo(owner.phone).length;
    expect(await escalateVendorAlert(app.prisma, ioStub, getChannels(), o.orderId, 0)).toBe('stopped');
    expect(await escalateVendorAlert(app.prisma, ioStub, getChannels(), o.orderId, 1)).toBe('stopped');
    expect(pushesTo(ownerDevice)).toHaveLength(pushes);
    expect(smsTo(owner.phone)).toHaveLength(texts);
  });

  it('the CUSTOMER cancelling stops it: no "still waiting" push and no SMS', async () => {
    const o = await pendingOrderWithAlert();
    const cancelled = await call('POST', `/api/v1/customer/orders/${o.orderId}/cancel`, customer.token, { reason: 'Changed my mind' });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('CANCELLED');
    expect((await ownerAlertRow(o.orderId)).isRead).toBe(false);

    const pushes = pushesTo(ownerDevice).length;
    const texts = smsTo(owner.phone).length;
    expect(await escalateVendorAlert(app.prisma, ioStub, getChannels(), o.orderId, 0)).toBe('stopped');
    expect(await escalateVendorAlert(app.prisma, ioStub, getChannels(), o.orderId, 1)).toBe('stopped');
    expect(pushesTo(ownerDevice)).toHaveLength(pushes);
    expect(smsTo(owner.phone)).toHaveLength(texts);
  });

  it('an order still waiting keeps escalating: re-alert, then the SMS fallback', async () => {
    const o = await pendingOrderWithAlert();
    expect(await escalateVendorAlert(app.prisma, ioStub, getChannels(), o.orderId, 0)).toBe('realerted');
    const texts = smsTo(owner.phone).length;
    expect(await escalateVendorAlert(app.prisma, ioStub, getChannels(), o.orderId, 1)).toBe('sms_sent');
    expect(smsTo(owner.phone).map((s) => s.body).slice(texts)).toEqual([
      `Swift: order ${o.orderNumber} is still waiting for your response. Open your dashboard now.`,
    ]);
  });
});

describe('[Q10] the "still waiting" push opens the order on the store desk', () => {
  it('carries what the tap-router needs for VendorOrderDetail, and rings until the response deadline', async () => {
    const o = await pendingOrderWithAlert();
    // The new-order alert itself: a business push that rings until respondBy.
    const first = pushesTo(ownerDevice).at(-1)!;
    expect({ title: first.title, data: first.data, options: first.options }).toEqual({
      title: 'New Order!',
      data: { orderId: o.orderId, orderNumber: o.orderNumber, status: 'PENDING', kind: 'vendor_order_alert', respondBy: o.respondBy.toISOString(), audience: 'business' },
      options: { alertClass: 'ring_order', priority: 'high', sound: 'default', deadlineMs: o.respondBy.getTime() },
    });

    expect(await escalateVendorAlert(app.prisma, ioStub, getChannels(), o.orderId, 0)).toBe('realerted');
    const again = pushesTo(ownerDevice).at(-1)!;
    // The mobile census pins that exactly this payload opens VendorOrderDetail
    // for this order (notification-router.test.ts). It used to be { orderId }.
    expect({ title: again.title, data: again.data, options: again.options }).toEqual({
      title: 'Order still waiting!',
      data: { kind: 'vendor_order_alert', orderId: o.orderId, orderNumber: o.orderNumber, audience: 'business', respondBy: o.respondBy.toISOString() },
      options: { alertClass: 'ring_order', priority: 'high', sound: 'default', deadlineMs: o.respondBy.getTime() },
    });
  });
});

describe('[Q10] a store cannot acknowledge another store alert', () => {
  it.each(['ack', 'accept', 'reject'] as const)('%s by another store is refused and leaves the receipt unacknowledged', async (action) => {
    const o = await pendingOrderWithAlert();
    const foreign = await call('PUT', `/api/v1/vendor/orders/${o.orderId}/${action}`, stranger.token, { reason: 'Not ours' });
    expect(foreign.statusCode).toBe(404);
    const tracked = await receipt(o.orderId);
    expect({ recipient: tracked.recipientId, ack: tracked.acknowledgedAt }).toEqual({ recipient: owner.userId, ack: null });
    expect((await ownerAlertRow(o.orderId)).isRead).toBe(false);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('PENDING');

    // Control: the store's own acknowledgement still stamps it.
    const own = await call('PUT', `/api/v1/vendor/orders/${o.orderId}/ack`, owner.token);
    expect(own.statusCode, own.body).toBe(200);
    expect((await receipt(o.orderId)).acknowledgedAt).toBeInstanceOf(Date);
  });
});
