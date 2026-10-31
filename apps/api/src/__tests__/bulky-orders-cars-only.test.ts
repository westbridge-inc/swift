import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, VehicleType } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { makeDispatchService, type DispatchService } from '../modules/dispatch/dispatch.service';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { requiredPackageSizeForOrder, readOrderSize } from '../utils/load';
import { stackVerdict } from '../modules/dispatch/stack-eligibility';

// ---------------------------------------------------------------------------
// Owner decision 20 (13 Oct 2026, E18): bulky items are ENFORCED — an order
// holding an item its store marked bulky or very bulky is offered only to a car
// or van; if none can carry it the customer is told at checkout (choose
// pickup) — never an order that silently finds nobody.
//
// The rule is the one that already existed in shadow (utils/load.ts): the size
// class a goods order needs, now with "a bulky line → the largest class, which
// only cars and vans carry". Dispatch offers by it, the rider board shows by
// it, the board grab refuses by it, and checkout probes by it.
//
// Fixtures: Mabaruma, far from every other suite, so only this file's movers
// are ever candidates.
//
// [Owner, 31 Oct 2026] The order's real size is its total bulk (bulk x quantity),
// banded as before. With car deliveries on (this file) a bulky line still
// routes the order to cars and vans, and so does a basket past the motorbike
// band. "Bulky" in this file's dispatch cases is 8 of an item marked bulky
// (bulk 32), past the motorbike band either way.
//
// [Owner ruling 15 Oct 2026 · TAXI CARS = PASSENGERS ONLY] TRANSFORMED: this
// file now pins #1693's behaviour on the switch's re-enable path
// (CAR_DELIVERIES=1, set for the whole file). With the switch OFF, the default,
// no car takes goods work and such a basket needs only a motorbike (never
// refused for size alone): store-order-size-never-refused.test.ts pins that.
// ---------------------------------------------------------------------------
const priorCarDeliveries = process.env['CAR_DELIVERIES'];

const SPOT = { lat: 8.2005, lng: -59.7811 }; // Mabaruma
const DAY = 24 * 60 * 60 * 1000;
const FIXTURE = 'bulky-cars-only-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

let app: FastifyInstance;
let dispatch: DispatchService;
let vendorId = '';
let bulkyItemId = '';
let plainItemId = '';
let seq = 0;
const phoneBase = 592_330_000_000 + Math.floor(Math.random() * 800_000_000);
const userIds: string[] = [];
const riderIds: string[] = [];
const orderIds: string[] = [];

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Bulk', lastName: `B${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `bulk-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** An online, free, freshly located delivery rider, `meters` north of the store. */
async function makeRider(vehicleType: VehicleType, meters: number) {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: u.userId, riderType: 'DELIVERY', vehicleType, documentsVerified: true,
      floatLimit: 1_000_000, isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: SPOT.lat + meters / 111_000, currentLng: SPOT.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
    },
  }));
  riderIds.push(rider.id);
  return { ...u, riderId: rider.id };
}

/** A cash food order ready at the kitchen, waiting for a rider. `bulky` = 8 of an item the store marked bulky (bulk 32). */
async function makeReadyOrder(customerId: string, bulky: boolean) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `BULK-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId, vendorId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
      pickupAddress: 'Bulk Store', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'Mabaruma homes', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
      paymentMethod: 'CASH',
      items: {
        create: [{
          itemId: bulky ? bulkyItemId : plainItemId, name: bulky ? 'Crate of drinks' : 'Rice plate', quantity: bulky ? 8 : 1,
          basePrice: 2000, markedUpPrice: 2000, markupAmount: 0, totalBase: 2000, totalMarkup: 0, totalCustomer: 2000,
          bulkUnits: bulky ? 4 : null,
        }],
      },
    },
  }));
  orderIds.push(order.id);
  return order;
}

async function park() {
  await sys(() => app.prisma.rider.updateMany({
    where: { id: { in: riderIds }, isOnline: true },
    data: { isOnline: false, isAvailable: false, locationSessionId: null },
  }));
}

const call = (method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
});

beforeAll(async () => {
  process.env['CAR_DELIVERIES'] = '1';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  dispatch = makeDispatchService(app);

  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ids = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Bulk Store', slug: `bulk-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926998877',
        addressLine1: '1 Hosororo Road', city: 'Mabaruma', region: 'Barima-Waini', latitude: SPOT.lat, longitude: SPOT.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
      },
    });
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
    // [owner 31 Oct] 1000 so a basket of 8 stays under the high-value ID check, which is not this file's subject.
    const bulky = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Crate of drinks', basePrice: 1000, isAvailable: true, bulkUnits: 4 } });
    const plain = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Rice plate', basePrice: 2000, isAvailable: true } });
    return { vendorId: vendor.id, bulky: bulky.id, plain: plain.id };
  });
  vendorId = ids.vendorId;
  bulkyItemId = ids.bulky;
  plainItemId = ids.plain;
}, 120_000);

afterEach(async () => {
  await park();
  delete process.env['DISPATCH_AVAILABILITY'];
});

afterAll(async () => {
  if (priorCarDeliveries === undefined) delete process.env['CAR_DELIVERIES']; else process.env['CAR_DELIVERIES'] = priorCarDeliveries;
  await sys(async () => {
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    const placed = await app.prisma.order.findMany({ where: { customerId: { in: userIds } }, select: { id: true } });
    const allOrders = [...new Set([...orderIds, ...placed.map((o) => o.id)])];
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: allOrders } } });
    await app.prisma.order.deleteMany({ where: { id: { in: allOrders } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId } });
    await app.prisma.category.deleteMany({ where: { vendorId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
}, 120_000);

describe('[owner #20 · owner 31 Oct] the size rule: a basket past the motorbike band means a car or van (cars on)', () => {
  const order = (lines: Array<{ quantity: number; bulkUnits: number | null }>) => ({ orderType: 'FOOD_DELIVERY', courierPackageSize: null, items: lines });

  it('one item marked bulky or very bulky, or bulk × quantity past the motorbike band → the largest class (cars and vans)', () => {
    expect(requiredPackageSizeForOrder(order([{ quantity: 1, bulkUnits: 4 }]))).toBe('EXTRA_LARGE');
    expect(requiredPackageSizeForOrder(order([{ quantity: 1, bulkUnits: 8 }, { quantity: 2, bulkUnits: null }]))).toBe('EXTRA_LARGE');
    expect(requiredPackageSizeForOrder(order([{ quantity: 8, bulkUnits: 4 }]))).toBe('EXTRA_LARGE');
    expect(requiredPackageSizeForOrder(order([{ quantity: 31, bulkUnits: null }]))).toBe('EXTRA_LARGE');
    // [owner 31 Oct] The real size stays the total bulk: one crate is a small load, a bag of rice and two sachets medium.
    expect(readOrderSize(order([{ quantity: 1, bulkUnits: 4 }])).trueBand).toBe('SMALL');
    expect(readOrderSize(order([{ quantity: 1, bulkUnits: 8 }, { quantity: 2, bulkUnits: null }])).trueBand).toBe('MEDIUM');
  });

  it('ordinary items keep their bands; a parcel keeps its declared size; a ride needs none', () => {
    expect(requiredPackageSizeForOrder(order([{ quantity: 3, bulkUnits: null }]))).toBe('SMALL');
    expect(requiredPackageSizeForOrder(order([{ quantity: 20, bulkUnits: null }]))).toBe('LARGE');
    expect(requiredPackageSizeForOrder({ orderType: 'COURIER', courierPackageSize: 'MEDIUM', items: [{ quantity: 1, bulkUnits: 8 }] })).toBe('MEDIUM');
    expect(requiredPackageSizeForOrder({ orderType: 'TAXI', courierPackageSize: null, items: [] })).toBeNull();
  });
});

describe('[owner #20] dispatch, the board and the grab all follow it', () => {
  it('a bulky order is offered to the car, not the nearer motorbike; an ordinary one to the nearer motorbike', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const car = await makeRider('CAR', 600);
    const bulky = await makeReadyOrder(customer.userId, true);
    expect((await dispatch.dispatchOrder(bulky.id)).offered).toBe(car.riderId);
    const plain = await makeReadyOrder(customer.userId, false);
    expect((await dispatch.dispatchOrder(plain.id)).offered).toBe(bike.riderId);
  });

  it('with only a motorbike near, a bulky order is offered to nobody', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await makeRider('MOTORCYCLE', 100);
    const bulky = await makeReadyOrder(customer.userId, true);
    expect((await dispatch.dispatchOrder(bulky.id)).offered).toBeUndefined();
  });

  it('the motorbike’s board leaves the bulky order out; the car’s shows it; the motorbike cannot grab it', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const car = await makeRider('CAR', 200);
    const bulky = await makeReadyOrder(customer.userId, true);
    const plain = await makeReadyOrder(customer.userId, false);

    const bikeBoard = await call('GET', '/api/v1/rider/orders/available', bike.token);
    expect(bikeBoard.statusCode, bikeBoard.body).toBe(200);
    const bikeIds = (bikeBoard.json().data as Array<{ id: string }>).map((o) => o.id);
    expect(bikeIds).toContain(plain.id);
    expect(bikeIds).not.toContain(bulky.id);
    const carBoard = await call('GET', '/api/v1/rider/orders/available', car.token);
    const carRows = carBoard.json().data as Array<{ id: string; itemCount: number }>;
    expect(carRows.map((o) => o.id)).toContain(bulky.id);
    // The load integer never leaves the server. [TRANSFORMED after #1567: the
    // pre-accept board sends no item lines at all, only a count, so the
    // property is asserted on the whole row instead of on one item line.]
    const bulkyRow = carRows.find((o) => o.id === bulky.id)!;
    expect(bulkyRow.itemCount).toBe(8); // [owner 31 Oct] the basket is 8 of the bulky item (was 1)
    expect(JSON.stringify(bulkyRow)).not.toMatch(/bulkUnits|bulkClass/);

    const grab = await call('POST', `/api/v1/rider/orders/${bulky.id}/accept`, bike.token, {});
    expect(grab.statusCode, grab.body).toBe(400);
    expect(grab.json().error).toMatchObject({ code: 'VEHICLE_TOO_SMALL', message: 'This order needs a car or van — it is too big for your motorcycle.' });
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: bulky.id } }))).riderId).toBeNull();
  });
});

describe('[owner #20 · DS1323 S3] stacking weighs a bulky order by the same rule', () => {
  it('a bulky order is never stacked onto a car already carrying a leg (XL never batches); an ordinary one is not refused for size', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const car = await makeRider('CAR', 100);
    const first = await makeReadyOrder(customer.userId, false);
    // The car already holds one live leg (the gate counts the rider's live orders).
    await sys(() => app.prisma.order.update({ where: { id: first.id }, data: { riderId: car.riderId, acceptedAt: new Date() } }));
    const bulky = await makeReadyOrder(customer.userId, true);
    expect(await sys(() => stackVerdict(app.prisma, car.riderId, bulky.id, 2))).toMatchObject({ eligible: false, rule: 'R3' });
    const plain = await makeReadyOrder(customer.userId, false);
    const v = await sys(() => stackVerdict(app.prisma, car.riderId, plain.id, 2));
    expect(v.eligible || v.rule !== 'R3').toBe(true);
  });
});

describe('[owner #20] checkout tells the customer before placing', () => {
  it('a bulky delivery with only a motorbike near is refused before anything is placed; with a car near it goes ahead', async () => {
    // [RIDER-SAFE 1] Checkout now counts the orders already waiting near the
    // store against the free riders. This case measures the SIZE rule, so the
    // earlier cases' ready orders (still waiting at this store) are cleared
    // first: the car below is free for this order alone.
    await sys(async () => {
      await app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { currentOrderId: null } });
      await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    });
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await sys(() => app.prisma.address.create({
      data: { userId: customer.userId, label: 'Home', addressLine1: '2 Hosororo Road', city: 'Mabaruma', region: 'Barima-Waini', latitude: SPOT.lat + 0.004, longitude: SPOT.lng, isDefault: true },
    }));
    const add = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId: bulkyItemId, quantity: 8 });
    expect([200, 201], add.body).toContain(add.statusCode);
    await makeRider('MOTORCYCLE', 100);
    process.env['DISPATCH_AVAILABILITY'] = '1';

    const refused = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('DELIVERY_TOO_BIG');
    expect(refused.json().error.message).toContain('Choose Pickup');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);

    await makeRider('CAR', 300);
    const placed = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(placed.statusCode, placed.body).toBe(200);
  });
});
