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
import courierRoutes from '../modules/courier/courier.routes';
import { makeDispatchService, type DispatchService } from '../modules/dispatch/dispatch.service';
import { reserveRiderLeg } from '../modules/dispatch/concurrency-policy';
import * as vehicleClasses from '../config/vehicle-classes';
import { recordDispatchQueue } from './helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// [Owner ruling 15 Oct 2026 ~04:25Z, criminal-liability decisions] TAXI CARS =
// PASSENGERS ONLY until counsel confirms the hire-car licence conditions cover
// goods. This reverses the 8 Oct "cars can deliver" for H-plate taxis:
// deliveries go to riders. A server switch re-enables car deliveries later:
// CAR_DELIVERIES, OFF unless it is exactly '1'.
//
// While it is OFF no passenger vehicle (car, wagon car, bus: every vehicle a
// taxi Driver works) takes goods work at any door: dispatch offers, the rider
// board, the board grab, every claim (offer accept, grab, relay), and checkout
// never accepts a bulky delivery that no vehicle can carry (owner #20, #1693):
// it says so before anything is placed. A parcel no vehicle can carry is
// refused at its quote and at its request.
//
// The switch's names are read through a lookup so that on the old code each
// case fails on its own assertion, not on an import.
//
// Fixtures: Lethem, far from every other suite, so only this file's movers are
// ever candidates.
// ---------------------------------------------------------------------------

const SPOT = { lat: 3.3803, lng: -59.7969 }; // Lethem
const DAY = 24 * 60 * 60 * 1000;
const FIXTURE = 'taxi-cars-passengers-only-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const vc = vehicleClasses as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;

let app: FastifyInstance;
let dispatch: DispatchService;
let vendorId = '';
let bulkyItemId = '';
let plainItemId = '';
let seq = 0;
const phoneBase = 592_340_000_000 + Math.floor(Math.random() * 800_000_000);
const userIds: string[] = [];
const riderIds: string[] = [];
const orderIds: string[] = [];

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Taxi', lastName: `T${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `taxi-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** An online, free, freshly located goods mover, `meters` north of the store. A car carries an H-series plate. */
async function makeRider(vehicleType: VehicleType, meters: number) {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const car = vehicleType === 'CAR' || vehicleType === 'WAGON_CAR';
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: u.userId, riderType: 'BOTH', vehicleType, documentsVerified: true,
      ...(car ? { licensePlate: `HC ${1000 + seq}` } : {}),
      floatLimit: 1_000_000, isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
      currentLat: SPOT.lat + meters / 111_000, currentLng: SPOT.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
    },
  }));
  riderIds.push(rider.id);
  return { ...u, riderId: rider.id };
}

/** A cash food order ready at the kitchen. `bulky` = one line the store marked bulky (owner #20: car or van only). */
async function makeReadyOrder(customerId: string, bulky: boolean) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `TAXI-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId, vendorId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
      pickupAddress: 'Lethem Store', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'Lethem homes', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
      paymentMethod: 'CASH',
      items: {
        create: [{
          itemId: bulky ? bulkyItemId : plainItemId, name: bulky ? 'Crate of drinks' : 'Rice plate', quantity: 1,
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

const priorSwitch = process.env['CAR_DELIVERIES'];

beforeAll(async () => {
  delete process.env['CAR_DELIVERIES'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
  dispatch = makeDispatchService(app);

  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ids = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Lethem Store', slug: `lethem-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5927728877',
        addressLine1: '1 Lethem Road', city: 'Lethem', region: 'Upper Takutu-Upper Essequibo', latitude: SPOT.lat, longitude: SPOT.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
      },
    });
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
    const bulky = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Crate of drinks', basePrice: 2000, isAvailable: true, bulkUnits: 4 } });
    const plain = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Rice plate', basePrice: 2000, isAvailable: true } });
    return { vendorId: vendor.id, bulky: bulky.id, plain: plain.id };
  });
  vendorId = ids.vendorId;
  bulkyItemId = ids.bulky;
  plainItemId = ids.plain;
}, 120_000);

afterEach(async () => {
  await park();
  delete process.env['CAR_DELIVERIES'];
  delete process.env['DISPATCH_AVAILABILITY'];
});

afterAll(async () => {
  if (priorSwitch === undefined) delete process.env['CAR_DELIVERIES']; else process.env['CAR_DELIVERIES'] = priorSwitch;
  await sys(async () => {
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

describe('[owner 15 Oct] the switch: car deliveries are OFF unless CAR_DELIVERIES is exactly 1', () => {
  it('a taxi car, wagon car or bus carries no goods by default; a bike or motorbike does; only "1" turns cars back on', () => {
    expect(typeof vc['carDeliveriesEnabled']).toBe('function');
    expect(vc['carDeliveriesEnabled']!({})).toBe(false);
    expect(vc['carDeliveriesEnabled']!({ CAR_DELIVERIES: 'true' })).toBe(false);
    expect(vc['carDeliveriesEnabled']!({ CAR_DELIVERIES: '1' })).toBe(true);
    for (const t of ['CAR', 'WAGON_CAR', 'BUS_9', 'BUS_15']) {
      expect(vc['carriesGoods']!(t, {}), t).toBe(false);
      expect(vc['carriesGoods']!(t, { CAR_DELIVERIES: '1' }), t).toBe(true);
    }
    for (const t of ['BICYCLE', 'MOTORCYCLE']) expect(vc['carriesGoods']!(t, {}), t).toBe(true);
    // A bulky load (the largest class) has no vehicle Swift takes on today while cars are off.
    expect(vc['goodsSizeCarriableToday']!('EXTRA_LARGE', {})).toBe(false);
    expect(vc['goodsSizeCarriableToday']!('EXTRA_LARGE', { CAR_DELIVERIES: '1' })).toBe(true);
    expect(vc['goodsSizeCarriableToday']!('LARGE', {})).toBe(true);
  });
});

describe('[owner 15 Oct] switch OFF: a taxi car gets no delivery or courier work at any door', () => {
  it('dispatch offers an ordinary order to the farther motorbike, never the nearer taxi car; a bulky one to nobody', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const car = await makeRider('CAR', 100);
    const bike = await makeRider('MOTORCYCLE', 600);
    const plain = await makeReadyOrder(customer.userId, false);
    const offered = (await dispatch.dispatchOrder(plain.id)).offered;
    expect(offered).toBe(bike.riderId);
    expect(offered).not.toBe(car.riderId);
    const bulky = await makeReadyOrder(customer.userId, true);
    expect((await dispatch.dispatchOrder(bulky.id)).offered).toBeUndefined();
  });

  it('a taxi car’s board shows no goods work, and its grab is refused in plain words with nothing written', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const car = await makeRider('CAR', 200);
    const plain = await makeReadyOrder(customer.userId, false);
    const bulky = await makeReadyOrder(customer.userId, true);
    const board = await call('GET', '/api/v1/rider/orders/available', car.token);
    expect(board.statusCode, board.body).toBe(200);
    const ids = (board.json().data as Array<{ id: string }>).map((o) => o.id);
    expect(ids).not.toContain(plain.id);
    expect(ids).not.toContain(bulky.id);
    const grab = await call('POST', `/api/v1/rider/orders/${plain.id}/accept`, car.token, {});
    expect(grab.statusCode, grab.body).toBe(403);
    expect(grab.json().error.code).toBe('VEHICLE_PASSENGERS_ONLY');
    expect(grab.json().error.message).toContain('passengers only');
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: plain.id } }))).riderId).toBeNull();
  });

  it('every claim door (offer accept, grab, relay) refuses a taxi car under lock', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const car = await makeRider('WAGON_CAR', 300);
    const plain = await makeReadyOrder(customer.userId, false);
    await expect(sys(() => app.prisma.$transaction((tx) => reserveRiderLeg(tx, car.riderId, plain.id, 1))))
      .rejects.toMatchObject({ code: 'VEHICLE_PASSENGERS_ONLY' });
    expect((await sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: car.riderId } }))).currentOrderId).toBeNull();
  });

  it('a parcel no vehicle can carry today is refused at its quote and at its request, before anything is written', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const trip = { pickup: SPOT, dropoff: { lat: SPOT.lat + 0.01, lng: SPOT.lng + 0.01 } };
    const quote = await call('POST', '/api/v1/courier/estimate', sender.token, { ...trip, packageSize: 'EXTRA_LARGE', speed: 'STANDARD' });
    expect(quote.statusCode, quote.body).toBe(409);
    expect(quote.json().error.code).toBe('PARCEL_TOO_BIG');
    const order = await call('POST', '/api/v1/courier/order', sender.token, {
      ...trip, pickupAddress: '1 Lethem Road', dropoffAddress: '9 Lethem Road', packageSize: 'EXTRA_LARGE', packageDescription: 'A wardrobe',
      recipientName: 'Synthetic Recipient', recipientPhone: `+${phoneBase + 900}`,
    });
    expect(order.statusCode, order.body).toBe(409);
    expect(order.json().error.code).toBe('PARCEL_TOO_BIG');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: sender.userId } }))).toBe(0);
  });
});

describe('[owner 15 Oct + owner #20] checkout never accepts a bulky delivery no vehicle can carry', () => {
  it('with a taxi car right there, a bulky delivery is refused before placing (whatever the availability flag); an ordinary one is placed', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await sys(() => app.prisma.address.create({
      data: { userId: customer.userId, label: 'Home', addressLine1: '2 Lethem Road', city: 'Lethem', region: 'Upper Takutu-Upper Essequibo', latitude: SPOT.lat + 0.004, longitude: SPOT.lng, isDefault: true },
    }));
    await makeRider('CAR', 100);
    await makeRider('MOTORCYCLE', 300);
    const add = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId: bulkyItemId, quantity: 1 });
    expect([200, 201], add.body).toContain(add.statusCode);

    const refused = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('DELIVERY_TOO_BIG');
    expect(refused.json().error.message).toContain('no vehicle on Swift can carry this right now');
    expect(refused.json().error.message).toContain('Choose Pickup');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);

    await sys(() => app.prisma.cart.deleteMany({ where: { customerId: customer.userId } }));
    const plain = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId: plainItemId, quantity: 1 });
    expect([200, 201], plain.body).toContain(plain.statusCode);
    const placed = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(placed.statusCode, placed.body).toBe(200);
  });
});

describe('[owner 15 Oct] the checkout supply probe counts only vehicles that carry goods', () => {
  it('with only a taxi car near, an ordinary delivery is refused at checkout (no delivery rider), never placed to strand', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await sys(() => app.prisma.address.create({
      data: { userId: customer.userId, label: 'Home', addressLine1: '3 Lethem Road', city: 'Lethem', region: 'Upper Takutu-Upper Essequibo', latitude: SPOT.lat + 0.004, longitude: SPOT.lng, isDefault: true },
    }));
    await makeRider('CAR', 100);
    const add = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId: plainItemId, quantity: 1 });
    expect([200, 201], add.body).toContain(add.statusCode);
    const refused = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('DELIVERY_NO_RIDERS');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);
  });
});

describe('[owner 15 Oct] switch ON (CAR_DELIVERIES=1): cars deliver again, exactly as #1693 built it', () => {
  it('a bulky order is offered to the car again, and the car’s board shows it', async () => {
    process.env['CAR_DELIVERIES'] = '1';
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const car = await makeRider('CAR', 600);
    await makeRider('MOTORCYCLE', 100);
    const bulky = await makeReadyOrder(customer.userId, true);
    expect((await dispatch.dispatchOrder(bulky.id)).offered).toBe(car.riderId);
    const board = await call('GET', '/api/v1/rider/orders/available', car.token);
    expect((board.json().data as Array<{ id: string }>).map((o) => o.id)).toContain(bulky.id);
  });
});
