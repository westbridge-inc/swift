import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { DispatchService, EXPRESS_OFFER_TIMEOUT_SECONDS, OFFER_TIMEOUT_SECONDS } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// Full-platform live audit (2026-07-12, every persona driven over HTTP)
// regression net. Each block pins a defect found by RUNNING the platform:
// appointments could never complete (COMPLETED lacked ACCEPTED as a source),
// the customer lost their takeaway pickup code after checkout, courier
// cancel/proof stranded the rider (proof also paid $0 and told nobody),
// vendor reject never restocked, and Express was a badge rather than a
// mechanically faster dispatch.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const AT = { lat: 7.81, lng: -59.81 }; // own patch of map — no other fixtures here

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_300_000_000 + Math.floor(Math.random() * 600_000_000);

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Platform',
      lastName: `Audit${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'platform-audit', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendor() {
  const owned = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Audit Vendor ${seq}`,
      slug: `audit-vendor-${nanoid(10).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `+${phoneBase + 800 + seq}`,
      addressLine1: '1 Audit Ave',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: AT.lat,
      longitude: AT.lng,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  });
  return { ...owned, vendorId: vendor.id };
}

async function makeRider(opts: { online?: boolean } = {}) {
  const owned = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: {
      userId: owned.userId,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      floatLimit: 100_000,
      isOnline: opts.online ?? false,
      isAvailable: true,
      currentLat: AT.lat,
      currentLng: AT.lng,
    },
  });
  return { ...owned, riderId: rider.id };
}

async function makeOrder(
  customerId: string,
  vendorId: string | null,
  status: OrderStatus,
  opts: { riderId?: string; fulfillment?: 'DELIVERY' | 'PICKUP' | 'APPOINTMENT'; orderType?: string; isExpress?: boolean; pickupCode?: string } = {},
) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `PA-${nanoid(10)}`,
      orderType: (opts.orderType as never) ?? 'FOOD_DELIVERY',
      customerId,
      ...(vendorId ? { vendorId } : {}),
      status,
      fulfillment: opts.fulfillment ?? 'DELIVERY',
      isExpress: opts.isExpress ?? false,
      ...(opts.pickupCode ? { pickupCode: opts.pickupCode } : {}),
      pickupAddress: 'Audit Ave',
      pickupLat: AT.lat,
      pickupLng: AT.lng,
      deliveryAddress: 'Audit Home',
      deliveryLat: AT.lat + 0.01,
      deliveryLng: AT.lng + 0.01,
      subtotalBase: 1000,
      subtotalMarkup: 0,
      subtotalCustomer: 1000,
      deliveryFee: 500,
      totalAmount: 1500,
      paymentMethod: 'CASH',
      ...(opts.riderId ? { riderId: opts.riderId } : {}),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

// ---------------------------------------------------------------------------
// 1. Appointments must be completable: ACCEPTED -> COMPLETED
// ---------------------------------------------------------------------------
describe('appointment completion', () => {
  it('vendor completes an ACCEPTED appointment (was always 409)', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const order = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', { fulfillment: 'APPOINTMENT' });

    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/complete-appointment`, {}, vendor.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------
// 2. The customer keeps their pickup code after checkout
// ---------------------------------------------------------------------------
describe('takeaway pickup code visibility', () => {
  it('order detail and list both carry pickupCode', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const order = await makeOrder(customer.userId, vendor.vendorId, 'READY_FOR_PICKUP', {
      fulfillment: 'PICKUP',
      pickupCode: '424242',
    });

    const detail = await inject('GET', `/api/v1/customer/orders/${order.id}`, undefined, customer.token);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.pickupCode).toBe('424242');
    expect(detail.json().data.fulfillment).toBe('PICKUP');

    const list = await inject('GET', '/api/v1/customer/orders', undefined, customer.token);
    const row = list.json().data.find((o: { id: string }) => o.id === order.id);
    expect(row?.pickupCode).toBe('424242');
  });
});

// ---------------------------------------------------------------------------
// 3. Courier terminal paths free the rider (and pay them)
// ---------------------------------------------------------------------------
describe('courier terminal effects', () => {
  it('sender cancel frees the assigned rider and tells them', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const job = await makeOrder(customer.userId, null, 'RIDER_ASSIGNED', { orderType: 'COURIER', riderId: rider.riderId });
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isAvailable: false, currentOrderId: job.id },
    });

    const res = await inject('POST', `/api/v1/courier/order/${job.id}/cancel`, { reason: 'changed plans' }, customer.token);
    expect(res.statusCode).toBe(200);

    const freed = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freed.isAvailable).toBe(true);
    expect(freed.currentOrderId).toBeNull();
    const note = await app.prisma.notification.findFirst({
      where: { userId: rider.userId, title: 'Courier job cancelled' },
    });
    expect(note).not.toBeNull();
  });

  it('proof-of-delivery pays the COURIER_FEE, frees the rider, notifies the sender', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider();
    const job = await makeOrder(customer.userId, null, 'PICKED_UP', { orderType: 'COURIER', riderId: rider.riderId });
    await app.prisma.rider.update({
      where: { id: rider.riderId },
      data: { isAvailable: false, currentOrderId: job.id },
    });

    const res = await inject('POST', `/api/v1/courier/order/${job.id}/proof`, { proofPhotoUrl: 'https://x/proof.jpg' }, rider.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');

    const earning = await app.prisma.earning.findFirst({ where: { orderId: job.id, type: 'COURIER_FEE' } });
    expect(earning).not.toBeNull();
    expect(Number(earning!.amount)).toBe(500);

    const freed = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    expect(freed.isAvailable).toBe(true);
    expect(freed.currentOrderId).toBeNull();
    expect(freed.totalDeliveries).toBe(1);

    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.userId, title: 'Parcel delivered' },
    });
    expect(note).not.toBeNull();
    // second proof is refused — no double pay, no double count
    const again = await inject('POST', `/api/v1/courier/order/${job.id}/proof`, { proofPhotoUrl: 'https://x/p2.jpg' }, rider.token);
    expect(again.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 4. Vendor reject restocks the shelf
// ---------------------------------------------------------------------------
describe('vendor reject restock', () => {
  it('tracked stock returns when the vendor rejects', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const category = await app.prisma.category.create({ data: { vendorId: vendor.vendorId, name: 'Audit Menu', sortOrder: 0 } });
    const item = await app.prisma.item.create({
      data: {
        vendorId: vendor.vendorId, categoryId: category.id, name: 'Tracked Audit Plate',
        basePrice: 1000, stockQuantity: 0, isAvailable: false, autoHiddenAt: new Date(),
      },
    });
    const order = await makeOrder(customer.userId, vendor.vendorId, 'PENDING');
    await app.prisma.orderItem.create({
      data: {
        orderId: order.id, itemId: item.id, name: item.name, quantity: 2,
        basePrice: 1000, markedUpPrice: 1000, markupAmount: 0,
        totalBase: 2000, totalMarkup: 0, totalCustomer: 2000,
      },
    });

    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, { reason: 'out of hours' }, vendor.token);
    expect(res.statusCode).toBe(200);

    const restocked = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(restocked.stockQuantity)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Express is mechanically faster, not just a badge
// ---------------------------------------------------------------------------
describe('express dispatch mechanics', () => {
  it('express offers run on the shorter clock; standard keeps 20s', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    await makeRider({ online: true });

    const timeouts: number[] = [];
    const dispatch = new DispatchService(
      app.prisma, app.redis, app.io, new HaversineMapsProvider(),
      async (_orderId, _riderId, delayMs) => { timeouts.push(delayMs); },
    );

    const express = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED', { isExpress: true });
    await dispatch.dispatchOrder(express.id);
    const standard = await makeOrder(customer.userId, vendor.vendorId, 'ACCEPTED');
    // the single rider holds the express offer; standard finds nobody free —
    // use a second rider so both offers land
    await makeRider({ online: true });
    await dispatch.dispatchOrder(standard.id);

    expect(timeouts[0]).toBe(EXPRESS_OFFER_TIMEOUT_SECONDS * 1000);
    expect(timeouts[1]).toBe(OFFER_TIMEOUT_SECONDS * 1000);
    await app.redis.del(`dispatch:offer:${express.id}`, `dispatch:offer:${standard.id}`);
  });

  it('available-jobs lists every express job before any standard one', async () => {
    const vendor = await makeVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const rider = await makeRider({ online: true });
    await makeOrder(customer.userId, vendor.vendorId, 'READY_FOR_PICKUP');
    await makeOrder(customer.userId, vendor.vendorId, 'READY_FOR_PICKUP', { isExpress: true });

    const res = await inject('GET', '/api/v1/rider/orders/available', undefined, rider.token);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ isExpress: boolean }>;
    expect(rows.some((r) => r.isExpress)).toBe(true);
    expect(rows.some((r) => !r.isExpress)).toBe(true);
    const firstStandard = rows.findIndex((r) => !r.isExpress);
    const lastExpress = rows.map((r) => r.isExpress).lastIndexOf(true);
    expect(lastExpress).toBeLessThan(firstStandard);
  });
});
