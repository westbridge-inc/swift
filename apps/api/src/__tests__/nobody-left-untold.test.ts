// [BUG-HUNT-2 G07 + G10 + G09 + G17] Swift acts, and the people it touches are told. Through the real routes and the real
// watchdog on a real database.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { recoverStrandedTaxiRides } from '../modules/dispatch/dispatch.service';
import { walkOrderStatus } from './helpers/order-status-walk';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

const MIN = 60_000;
const DAY = 86_400_000;
const REASON = 'Support checked this and decided to act on it.';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:nobody-left-untold');
type Actor = { id: string; token: string };

let app: FastifyInstance;
let admin: Actor; let owner: Actor;
let vendorId = '';
const people: string[] = [];
const driverIds: string[] = [];
const orderIds: string[] = [];

async function actor(roles: UserRole[], active: UserRole, adminRow = false): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Lee', lastName: 'Told', roles, activeRole: active, status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}), ...(adminRow ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  people.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: active, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'told', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: user.id, token };
}

async function shop(): Promise<string> {
  const person = await actor(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  owner = person;
  return sys(async () => {
    const row = await app.prisma.vendorOwner.create({ data: { userId: person.id } });
    return (await app.prisma.vendor.create({ data: {
      ownerId: row.id, name: `Told Shop ${wordFreeTag(4)}`, slug: `told-${nanoid(10).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '1 Told Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1, status: 'ACTIVE', isVerified: true,
    } })).id;
  });
}

async function storeOrder(customer: Actor, status: OrderStatus, over: Record<string, unknown> = {}) {
  const row = await sys(async () => {
    const created = await app.prisma.order.create({ data: {
      orderNumber: `TLD-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId: customer.id, vendorId, status: 'PENDING', paymentMethod: 'CASH', placedAt: new Date(Date.now() - 60 * MIN),
      deliveryAddress: 'Fixture', deliveryLat: 6.8, deliveryLng: -58.15, subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000, ...over,
    } as never });
    await walkOrderStatus(app.prisma, created.id, status, { acceptedAt: new Date(Date.now() - 50 * MIN), readyAt: status === 'READY_FOR_PICKUP' ? new Date(Date.now() - 10 * MIN) : null });
    return app.prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  });
  orderIds.push(row.id);
  return row;
}

async function driver(lastSeenAgoMs: number): Promise<Actor & { driverId: string }> {
  const person = await actor(['MOVER', 'CUSTOMER'], 'MOVER');
  const row = await sys(() => app.prisma.driver.create({ data: {
    userId: person.id, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleColor: 'White', vehicleYear: 2015, licensePlate: `T ${nanoid(6)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
    currentLat: 6.8, currentLng: -58.15, lastLocationUpdate: new Date(Date.now() - lastSeenAgoMs),
  } as never }));
  driverIds.push(row.id);
  return { ...person, driverId: row.id };
}

async function ride(status: OrderStatus, lastSeenAgoMs: number, over: Record<string, unknown> = {}) {
  const customer = await actor(['CUSTOMER'], 'CUSTOMER');
  const mover = await driver(lastSeenAgoMs);
  const order = await sys(async () => {
    const created = await app.prisma.order.create({ data: {
      orderNumber: `TLD-${nanoid(10)}`, customerId: customer.id, orderType: 'TAXI', status: 'PENDING', pickupAddress: 'Pickup', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'Drop', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 800, subtotalMarkup: 0, subtotalCustomer: 800, deliveryFee: 0, totalAmount: 800, paymentMethod: 'CASH', ridePin: '1234',
    } as never });
    await walkOrderStatus(app.prisma, created.id, status, { driverId: mover.driverId, acceptedAt: new Date() });
    await app.prisma.order.update({ where: { id: created.id }, data: over });
    await app.prisma.driver.update({ where: { id: mover.driverId }, data: { currentRideId: created.id, isAvailable: false } });
    return created;
  });
  orderIds.push(order.id);
  return { order, customer, mover };
}

function call(method: 'GET' | 'POST' | 'PUT', url: string, as: Actor, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${as.token}`, ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}
const notices = (userId: string, orderId?: string) => sys(() => app.prisma.notification.findMany({ where: { userId, ...(orderId ? { data: { path: ['orderId'], equals: orderId } } : {}) } }));
const suspend = (reason = 'Food safety complaint under review') => call('PUT', `/api/v1/admin/vendors/${vendorId}/suspend`, admin, { reason }, { 'x-swift-reason': REASON });
const adminCancel = (id: string, reason = 'Support note about this ride') => call('PUT', `/api/v1/admin/orders/${id}/cancel`, admin, { refund: false, reason }, { 'x-swift-reason': REASON });
const sweep = () => sys(() => recoverStrandedTaxiRides(app.prisma, app.redis, app.io, async () => undefined));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  admin = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: people } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: people } } });
    await purgeAuditLogs(app.prisma, { userId: { in: people } }, 'test-cleanup:nobody-left-untold');
    await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  });
  await app.close();
  vi.unstubAllEnvs();
});

describe('[G07] Swift suspends a store with live orders', () => {
  it('every customer with a live order is told once, in words true for their order; a finished order hears nothing', async () => {
    vendorId = await shop();
    const a = await actor(['CUSTOMER'], 'CUSTOMER');
    const b = await actor(['CUSTOMER'], 'CUSTOMER');
    const c = await actor(['CUSTOMER'], 'CUSTOMER');
    const waiting = await storeOrder(a, 'ACCEPTED');
    const ready = await storeOrder(b, 'READY_FOR_PICKUP');
    const done = await storeOrder(c, 'COMPLETED');
    const res = await suspend();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.liveOrders).toBe(2);
    const toA = await notices(a.id, waiting.id);
    expect(toA).toHaveLength(1);
    expect(toA[0]!.body).toContain('contact Swift support');
    expect(toA[0]!.body).not.toContain('Food safety');
    const toB = await notices(b.id, ready.id);
    expect(toB).toHaveLength(1);
    expect(toB[0]!.body).toContain('You can cancel it for free');
    expect(await notices(c.id, done.id)).toHaveLength(0);
    expect((await suspend()).statusCode).toBe(200);
    expect(await notices(a.id, waiting.id)).toHaveLength(1);
  });

  it('the store owner reads what happened, not a label', async () => {
    const told = await notices(owner.id);
    expect(told.some((notice) => notice.title === 'Store suspended' && notice.body.includes('Food safety complaint under review'))).toBe(true);
    expect(told.some((notice) => notice.title === 'Vendor Suspended')).toBe(false);
  });

  it('a ready cash pickup at a store Swift suspended is free to cancel at once, and it is only that', async () => {
    const buyer = await actor(['CUSTOMER'], 'CUSTOMER');
    vendorId = await shop();
    const ready = await storeOrder(buyer, 'READY_FOR_PICKUP');
    const accepted = await storeOrder(buyer, 'ACCEPTED', { promisedAt: new Date(Date.now() + 60 * MIN) });
    const view = async (id: string) => (await call('GET', `/api/v1/customer/orders/${id}`, buyer)).json().data;
    expect((await view(ready.id)).canCancel).toBe(false);
    expect((await suspend()).statusCode).toBe(200);
    const seen = await view(ready.id);
    expect(seen.canCancel).toBe(true);
    expect(seen.cancellationMessage).toContain('Swift paused this store');
    expect((await view(accepted.id)).canCancel).toBe(false);
    const res = await call('POST', `/api/v1/customer/orders/${ready.id}/cancel`, buyer, {});
    expect(res.statusCode, res.body).toBe(200);
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: ready.id } }))).status).toBe('CANCELLED');
  });

  it('a paid MMG ready pickup is not freed this way: support closes it, and the customer is told so', async () => {
    const buyer = await actor(['CUSTOMER'], 'CUSTOMER');
    vendorId = await shop();
    const ready = await storeOrder(buyer, 'READY_FOR_PICKUP', { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', mmgAttestedRef: `PAY${nanoid(12).replace(/[^a-zA-Z0-9]/g, '0')}`, mmgAttestedAt: new Date(), mmgAttestedAmount: 1000 });
    expect((await suspend()).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/customer/orders/${ready.id}`, buyer)).json().data.canCancel).toBe(false);
    const told = await notices(buyer.id, ready.id);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('Swift support');
    expect(told[0]!.body).not.toContain('cancel it for free');
  });
});

describe('[G10] support cancels a ride', () => {
  it.each(['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'] as const)('the driver at %s is told and sent back online', async (status) => {
    const { order, customer, mover } = await ride(status, 0);
    const res = await adminCancel(order.id);
    expect(res.statusCode, res.body).toBe(200);
    const told = await notices(mover.id, order.id);
    expect(told.map((notice) => notice.title)).toEqual(['Ride cancelled']);
    expect(told[0]!.body).toContain('Swift support cancelled this ride');
    expect(told[0]!.data).toMatchObject({ status: 'CANCELLED', audience: 'earner' });
    const passenger = await notices(customer.id, order.id);
    expect(passenger.map((notice) => notice.title)).toEqual(['Ride cancelled']);
    expect(passenger[0]!.body).not.toContain('Support note');
    expect(passenger[0]!.body).not.toContain('Order');
  });

  it('a store order keeps its words and its reason', async () => {
    vendorId = await shop();
    const buyer = await actor(['CUSTOMER'], 'CUSTOMER');
    const order = await storeOrder(buyer, 'ACCEPTED');
    expect((await adminCancel(order.id, 'The store called us')).statusCode).toBe(200);
    const told = await notices(buyer.id, order.id);
    expect(told[0]).toMatchObject({ title: 'Order Cancelled' });
    expect(told[0]!.body).toContain('The store called us');
  });
});

describe('[G09] the driver loses signal with a passenger aboard', () => {
  it('the passenger is told once for one loss, however many sweeps', async () => {
    const { order, customer } = await ride('RIDE_IN_PROGRESS', 20 * MIN);
    await sweep();
    await sweep();
    await sweep();
    const told = await notices(customer.id, order.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'Your driver lost signal' });
    expect(told[0]!.body).not.toContain('reaching out');
  });

  it('a new loss is a new notice', async () => {
    const { order, customer, mover } = await ride('RIDE_IN_PROGRESS', 20 * MIN);
    await sweep();
    await sys(() => app.prisma.driver.update({ where: { id: mover.driverId }, data: { lastLocationUpdate: new Date(Date.now() - 19 * MIN) } }));
    await sweep();
    expect(await notices(customer.id, order.id)).toHaveLength(2);
  });
});

describe('[G17] the watchdog takes a ride from a driver out of signal', () => {
  it('the driver is told once, in words that say why and what to do', async () => {
    const { order, mover } = await ride('DRIVER_EN_ROUTE', 20 * MIN);
    const out = await sweep();
    expect(out.recovered).toContain(order.id);
    const told = await notices(mover.id, order.id);
    expect(told.map((notice) => notice.title)).toEqual(['Ride released']);
    expect(told[0]!.body).toContain('lost your signal');
    expect(told[0]!.data).toMatchObject({ audience: 'earner', status: 'PENDING' });
  });
});
