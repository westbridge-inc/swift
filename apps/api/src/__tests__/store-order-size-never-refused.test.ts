import { describe, it, expect, beforeAll, afterAll, afterEach, vi, onTestFinished } from 'vitest';
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
import { makeDispatchService, vehicleCanCarry, DispatchService } from '../modules/dispatch/dispatch.service';
import { goodsSizeCarriableToday } from '../config/vehicle-classes';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { requiredPackageSizeForOrder, readOrderSize, offerLoadFields } from '../utils/load';
import { dispatchOfferKey } from '../modules/dispatch/dispatch-generation-keys';
import { stackVerdict } from '../modules/dispatch/stack-eligibility';

// ---------------------------------------------------------------------------
// [Owner, 31 Oct 2026 — staging test] A one-item food order (an item its store
// had marked bulky) was refused at checkout as "too big for delivery by bike
// or motorbike". The owner: the order is not too big, and "even multiple
// orders too shouldn't". The rule now:
//
//  1. A store order (food, grocery, shop) is NEVER refused for its size alone.
//  2. An item's bulk only ADDS to the order's total (bulk × quantity), banded
//     as before — one bulky line no longer makes the whole order car-only.
//  3. While no vehicle on Swift may carry the largest class (car deliveries
//     off), a store order needs at most what a motorbike carries (LARGE): it is
//     placed and offered to motorbikes, whose offer shows the load. With car
//     deliveries on, the largest class still goes to cars and vans.
//  4. Parcels keep the size the customer chose (and their own refusal); the
//     "no bigger vehicle is free nearby" availability answer is unchanged.
//
// Fixtures: Kamarang, far from every other suite, so only this file's movers
// are ever candidates. Car deliveries are OFF (the default) unless a case
// switches them on.
// ---------------------------------------------------------------------------

const SPOT = { lat: 5.8667, lng: -60.6167 }; // Kamarang
const DAY = 24 * 60 * 60 * 1000;
const FIXTURE = 'store-order-size-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

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
      phone: `+${phoneBase + seq}`, firstName: 'Size', lastName: `S${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `size-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
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

/** A cash food order ready at the kitchen: `quantity` of the bulky item (bulk 4 each, or `bulk`) or of the ordinary one. */
async function makeReadyOrder(customerId: string, bulky: boolean, quantity: number, bulk = 4) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `SIZE-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId, vendorId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
      pickupAddress: 'Size Store', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
      deliveryAddress: 'Kamarang homes', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
      subtotalBase: 500 * quantity, subtotalMarkup: 0, subtotalCustomer: 500 * quantity, deliveryFee: 500, totalAmount: 500 * quantity + 500,
      paymentMethod: 'CASH',
      items: {
        create: [{
          itemId: bulky ? bulkyItemId : plainItemId, name: bulky ? 'Family tray' : 'Roti', quantity,
          basePrice: 500, markedUpPrice: 500, markupAmount: 0, totalBase: 500 * quantity, totalMarkup: 0, totalCustomer: 500 * quantity,
          bulkUnits: bulky ? bulk : null,
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
    data: { isOnline: false, isAvailable: false, locationSessionId: null, currentOrderId: null },
  }));
}

/** Clears this store's orders, so the store's rider backlog and the orders already waiting near it never colour a checkout case. */
async function clearStoreOrders() {
  await sys(async () => {
    const rows = await app.prisma.order.findMany({ where: { vendorId }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    await app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { currentOrderId: null } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
  });
}

async function customerWithHome(): Promise<Actor> {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '2 Kamarang Road', city: 'Kamarang', region: 'Cuyuni-Mazaruni', latitude: SPOT.lat + 0.004, longitude: SPOT.lng, isDefault: true },
  }));
  return customer;
}

const call = (method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
});

async function addToCart(customer: Actor, itemId: string, quantity: number) {
  const add = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity });
  expect([200, 201], add.body).toContain(add.statusCode);
}

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
  await app.ready();
  dispatch = makeDispatchService(app);

  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ids = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Size Store', slug: `size-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926998866',
        addressLine1: '1 Kamarang Road', city: 'Kamarang', region: 'Cuyuni-Mazaruni', latitude: SPOT.lat, longitude: SPOT.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
      },
    });
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
    const bulky = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Family tray', basePrice: 500, isAvailable: true, bulkUnits: 4 } });
    const plain = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Roti', basePrice: 100, isAvailable: true } });
    return { vendorId: vendor.id, bulky: bulky.id, plain: plain.id };
  });
  vendorId = ids.vendorId;
  bulkyItemId = ids.bulky;
  plainItemId = ids.plain;
}, 120_000);

afterEach(async () => {
  await park();
  delete process.env['DISPATCH_AVAILABILITY'];
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await sys(async () => {
    const placed = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId }] }, select: { id: true } });
    const allOrders = [...new Set([...orderIds, ...placed.map((o) => o.id)])];
    await app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { currentOrderId: null } });
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

describe('[owner 31 Oct] the size rule: an item’s bulk only adds to the total', () => {
  const food = (lines: Array<{ quantity: number; bulkUnits: number | null }>) => ({ orderType: 'FOOD_DELIVERY', courierPackageSize: null, items: lines });
  const grocery = (lines: Array<{ quantity: number; bulkUnits: number | null }>) => ({ orderType: 'GROCERY_DELIVERY', courierPackageSize: null, items: lines });

  // [Owner ruling 31 Oct ~02:40Z] …but an order holding a really bulky item (a line whose one unit is bulkier than an
  // ordinary item, e.g. a 20 kg bag of rice) goes to a MOTORBIKE at least, never a bicycle, while cars carry no goods.
  it('THE OWNER’S CASE: one item its store marked bulky needs a motorbike at least, never a bicycle; its real size stays small', () => {
    const one = readOrderSize(food([{ quantity: 1, bulkUnits: 4 }]));
    expect(one).toEqual({ required: 'LARGE', trueBand: 'SMALL' });
    expect(vehicleCanCarry('BICYCLE', one.required)).toBe(false);
    expect(vehicleCanCarry('MOTORCYCLE', one.required)).toBe(true);
    expect(goodsSizeCarriableToday(one.required)).toBe(true);
    // A very bulky item (8): a motorbike, and its real size is a medium load.
    expect(readOrderSize(grocery([{ quantity: 1, bulkUnits: 8 }]))).toEqual({ required: 'LARGE', trueBand: 'MEDIUM' });
    expect(readOrderSize(grocery([{ quantity: 1, bulkUnits: 8 }, { quantity: 2, bulkUnits: null }]))).toEqual({ required: 'LARGE', trueBand: 'MEDIUM' });
    // Ordinary items go by their total alone, as before: a bicycle carries a small or medium basket.
    expect(requiredPackageSizeForOrder(grocery([{ quantity: 8, bulkUnits: null }]))).toBe('MEDIUM');
    expect(requiredPackageSizeForOrder(grocery([{ quantity: 4, bulkUnits: 1 }]))).toBe('SMALL');
  });

  it('a load past the motorbike band needs only a motorbike while car deliveries are off — never a size no vehicle carries', () => {
    for (const lines of [[{ quantity: 31, bulkUnits: null }], [{ quantity: 8, bulkUnits: 4 }], [{ quantity: 200, bulkUnits: 8 }]]) {
      const size = requiredPackageSizeForOrder(grocery(lines));
      expect(size, JSON.stringify(lines)).toBe('LARGE');
      expect(goodsSizeCarriableToday(size)).toBe(true);
      expect(vehicleCanCarry('MOTORCYCLE', size)).toBe(true);
      expect(vehicleCanCarry('BICYCLE', size)).toBe(false);
    }
    // The bands below it are untouched.
    expect(requiredPackageSizeForOrder(grocery([{ quantity: 30, bulkUnits: null }]))).toBe('LARGE');
    expect(requiredPackageSizeForOrder(grocery([{ quantity: 13, bulkUnits: null }]))).toBe('LARGE');
    expect(requiredPackageSizeForOrder(grocery([{ quantity: 12, bulkUnits: null }]))).toBe('MEDIUM');
    expect(requiredPackageSizeForOrder(grocery([{ quantity: 4, bulkUnits: null }]))).toBe('SMALL');
  });

  it('with car deliveries on, the same load is the largest class again: cars and vans, not motorbikes', () => {
    vi.stubEnv('CAR_DELIVERIES', '1');
    for (const lines of [[{ quantity: 31, bulkUnits: null }], [{ quantity: 8, bulkUnits: 4 }]]) {
      const size = requiredPackageSizeForOrder(grocery(lines));
      expect(size, JSON.stringify(lines)).toBe('EXTRA_LARGE');
      expect(vehicleCanCarry('MOTORCYCLE', size)).toBe(false);
      expect(vehicleCanCarry('CAR', size)).toBe(true);
    }
    // A bulky line keeps today's routing with cars on: cars and vans (owner #20). Its real size is unchanged.
    expect(readOrderSize(food([{ quantity: 1, bulkUnits: 4 }]))).toEqual({ required: 'EXTRA_LARGE', trueBand: 'SMALL' });
    expect(requiredPackageSizeForOrder(grocery([{ quantity: 8, bulkUnits: null }]))).toBe('MEDIUM');
  });

  it('a parcel keeps the size its sender chose, whatever is carriable today; a ride needs none', () => {
    expect(requiredPackageSizeForOrder({ orderType: 'COURIER', courierPackageSize: 'EXTRA_LARGE', items: [] })).toBe('EXTRA_LARGE');
    expect(goodsSizeCarriableToday('EXTRA_LARGE')).toBe(false); // so the parcel's own refusal still answers it
    expect(requiredPackageSizeForOrder({ orderType: 'COURIER', courierPackageSize: 'MEDIUM', items: [{ quantity: 1, bulkUnits: 8 }] })).toBe('MEDIUM');
    expect(requiredPackageSizeForOrder({ orderType: 'TAXI', courierPackageSize: null, items: [] })).toBeNull();
  });
});

describe('[owner 31 Oct] checkout never refuses a store order for its size alone (car deliveries off)', () => {
  it('THE OWNER’S CASE: one bulky item for delivery is placed', async () => {
    await clearStoreOrders();
    const customer = await customerWithHome();
    await addToCart(customer, bulkyItemId, 1);
    const res = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('too big');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId, fulfillment: 'DELIVERY' } }))).toBe(1);
  });

  it('a big basket (31 items) is placed, and the order needs a motorbike', async () => {
    await clearStoreOrders();
    const customer = await customerWithHome();
    await addToCart(customer, plainItemId, 31);
    const res = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(res.statusCode, res.body).toBe(200);
    const order = await sys(() => app.prisma.order.findFirstOrThrow({
      where: { customerId: customer.userId },
      select: { orderType: true, courierPackageSize: true, items: { select: { quantity: true, bulkUnits: true } } },
    }));
    expect(requiredPackageSizeForOrder(order)).toBe('LARGE');
  });

  it('with the availability check on, a motorbike near is enough: the cart says GOOD and checkout places it', async () => {
    await clearStoreOrders();
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const customer = await customerWithHome();
    await addToCart(customer, bulkyItemId, 8); // bulk 32: past the motorbike band
    await makeRider('MOTORCYCLE', 200);
    const keys = await app.redis.keys(`*avail:DELIVERY:${vendorId}*`);
    if (keys.length) await app.redis.del(...keys);
    const avail = await call('GET', `/api/v1/customer/delivery-availability?vendorId=${vendorId}&paymentMethod=CASH`, customer.token);
    expect(avail.statusCode, avail.body).toBe(200);
    expect(avail.json().data.level).toBe('GOOD');
    const res = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the availability answer is unchanged: with only a bicycle near, it still says no bigger vehicle is free nearby', async () => {
    await clearStoreOrders();
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const customer = await customerWithHome();
    await addToCart(customer, bulkyItemId, 8);
    await makeRider('BICYCLE', 100);
    const refused = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('DELIVERY_TOO_BIG');
    expect(refused.json().error.message).toBe('This order is too big for delivery by bike, and no bigger vehicle is free nearby right now. Choose Pickup, or try delivery again later.');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);
  });
});

describe('[owner 31 Oct] dispatch, the board and the grab read the same size (car deliveries off)', () => {
  it('a big order and one bulky item go to the motorbike, never the nearer bicycle; ordinary items go to the nearer bicycle', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await makeRider('BICYCLE', 100);
    const bike = await makeRider('MOTORCYCLE', 600);
    const big = await makeReadyOrder(customer.userId, true, 8);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(bike.riderId);
    await park(); // the motorbike now holds a live offer: fresh riders for the next two
    const bicycle2 = await makeRider('BICYCLE', 100);
    const bike2 = await makeRider('MOTORCYCLE', 600);
    const one = await makeReadyOrder(customer.userId, true, 1);
    expect((await dispatch.dispatchOrder(one.id)).offered).toBe(bike2.riderId);
    const plain = await makeReadyOrder(customer.userId, false, 3);
    expect((await dispatch.dispatchOrder(plain.id)).offered).toBe(bicycle2.riderId);
  });

  it('the motorbike’s board shows the big order; the bicycle’s leaves it out and its grab is refused', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bicycle = await makeRider('BICYCLE', 100);
    const bike = await makeRider('MOTORCYCLE', 200);
    const big = await makeReadyOrder(customer.userId, true, 8);
    const one = await makeReadyOrder(customer.userId, true, 1);
    const plain = await makeReadyOrder(customer.userId, false, 3);

    const bikeBoard = await call('GET', '/api/v1/rider/orders/available', bike.token);
    expect(bikeBoard.statusCode, bikeBoard.body).toBe(200);
    expect((bikeBoard.json().data as Array<{ id: string }>).map((o) => o.id)).toEqual(expect.arrayContaining([big.id, one.id, plain.id]));
    const bicycleBoard = await call('GET', '/api/v1/rider/orders/available', bicycle.token);
    const bicycleIds = (bicycleBoard.json().data as Array<{ id: string }>).map((o) => o.id);
    expect(bicycleIds).toContain(plain.id);
    expect(bicycleIds).not.toContain(big.id);
    expect(bicycleIds).not.toContain(one.id);

    for (const order of [big, one]) {
      const grab = await call('POST', `/api/v1/rider/orders/${order.id}/accept`, bicycle.token, {});
      expect(grab.statusCode, grab.body).toBe(400);
      expect(grab.json().error).toMatchObject({ code: 'VEHICLE_TOO_SMALL', message: 'This order is too big for your bicycle.' });
    }
  });

  it('with car deliveries on, the big order goes to the car again, not the nearer motorbike', async () => {
    await clearStoreOrders();
    vi.stubEnv('CAR_DELIVERIES', '1'); onTestFinished(() => { vi.unstubAllEnvs(); });
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await makeRider('MOTORCYCLE', 100);
    const car = await makeRider('CAR', 600);
    const big = await makeReadyOrder(customer.userId, true, 8);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(car.riderId);
  });
});

// [COORD 31 Oct, security review] The cap decides only WHO may be offered the
// order. The load itself is never shrunk: the rider sees its real size class
// beside the unchanged `estLoad`, and stacking weighs the real size, so an
// order past a motorbike's band (XL) still never batches (R3).
describe('[owner 31 Oct] the real size stays visible: the rider sees it, stacking weighs it', () => {
  it('one reading, both halves: the size a vehicle must carry (capped) and the true band', () => {
    const big = { orderType: 'GROCERY_DELIVERY', courierPackageSize: null, items: [{ quantity: 31, bulkUnits: null }] };
    expect(readOrderSize(big)).toEqual({ required: 'LARGE', trueBand: 'EXTRA_LARGE' });
    expect(readOrderSize({ ...big, items: [{ quantity: 1, bulkUnits: 4 }] })).toEqual({ required: 'LARGE', trueBand: 'SMALL' });
    expect(readOrderSize({ ...big, items: [{ quantity: 3, bulkUnits: null }] })).toEqual({ required: 'SMALL', trueBand: 'SMALL' });
    expect(readOrderSize({ orderType: 'COURIER', courierPackageSize: 'EXTRA_LARGE', items: [] })).toEqual({ required: 'EXTRA_LARGE', trueBand: 'EXTRA_LARGE' });
    vi.stubEnv('CAR_DELIVERIES', '1');
    expect(readOrderSize(big)).toEqual({ required: 'EXTRA_LARGE', trueBand: 'EXTRA_LARGE' });
  });

  it('the live offer and the recovered card carry the real size (loadSize, oversize), and estLoad says the bulk too', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
    const spy = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ room, event, payload }); return true; },
    })) as never);
    onTestFinished(() => { spy.mockRestore(); });
    const big = await makeReadyOrder(customer.userId, true, 8);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(bike.riderId);
    const live = emitted.find((e) => e.event === 'dispatch:offer' && e.room === `user:${bike.userId}`)?.payload;
    expect(live, 'the live card was emitted').toBeTruthy();
    expect(live).toMatchObject({ estLoad: 'large', loadSize: 'EXTRA_LARGE', oversize: true });
    const rebuilt = await call('GET', '/api/v1/rider/offers/current', bike.token);
    expect(rebuilt.statusCode, rebuilt.body).toBe(200);
    expect(rebuilt.json().data.offer).toMatchObject({ orderId: big.id, estLoad: 'large', loadSize: 'EXTRA_LARGE', oversize: true });

    await park();
    const bike2 = await makeRider('MOTORCYCLE', 100);
    const one = await makeReadyOrder(customer.userId, true, 1);
    expect((await dispatch.dispatchOrder(one.id)).offered).toBe(bike2.riderId);
    const small = emitted.find((e) => e.event === 'dispatch:offer' && e.room === `user:${bike2.userId}`)?.payload;
    expect(small).toMatchObject({ estLoad: 'small', loadSize: 'SMALL', oversize: false });
  });

  it('the board row carries the real size too', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const big = await makeReadyOrder(customer.userId, true, 8);
    const one = await makeReadyOrder(customer.userId, true, 1);
    const board = await call('GET', '/api/v1/rider/orders/available', bike.token);
    expect(board.statusCode, board.body).toBe(200);
    const rows = board.json().data as Array<{ id: string; estLoad: string; loadSize: string; oversize: boolean }>;
    expect(rows.find((r) => r.id === big.id)).toMatchObject({ estLoad: 'large', loadSize: 'EXTRA_LARGE', oversize: true });
    expect(rows.find((r) => r.id === one.id)).toMatchObject({ estLoad: 'small', loadSize: 'SMALL', oversize: false });
  });

  it('stacking (dispatch): an order past the motorbike band is never stacked onto a motorbike already carrying a leg (XL never batches)', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const first = await makeReadyOrder(customer.userId, false, 1);
    await sys(() => app.prisma.order.update({ where: { id: first.id }, data: { riderId: bike.riderId, acceptedAt: new Date() } }));
    const big = await makeReadyOrder(customer.userId, true, 8);
    expect(await sys(() => stackVerdict(app.prisma, bike.riderId, big.id, 2))).toMatchObject({ eligible: false, rule: 'R3' });
    const one = await makeReadyOrder(customer.userId, true, 1);
    const v = await sys(() => stackVerdict(app.prisma, bike.riderId, one.id, 2));
    expect(v.eligible || v.rule !== 'R3').toBe(true);
  });

  it('checkout and the cart ask the capacity read with both halves: the capped size for who, the true band for stacking', async () => {
    await clearStoreOrders();
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const probes: Array<{ packageSize: string | null; loadBand: string | null }> = [];
    const real = DispatchService.prototype.getDeliveryCapacity;
    const capture = vi.spyOn(DispatchService.prototype, 'getDeliveryCapacity').mockImplementation(function (this: DispatchService, probe) {
      probes.push({ packageSize: probe.packageSize, loadBand: probe.loadBand });
      return real.call(this, probe);
    });
    onTestFinished(() => { capture.mockRestore(); });
    const customer = await customerWithHome();
    await addToCart(customer, bulkyItemId, 8);
    await makeRider('MOTORCYCLE', 200);
    const keys = await app.redis.keys(`*avail:DELIVERY:${vendorId}*`);
    if (keys.length) await app.redis.del(...keys);
    const avail = await call('GET', `/api/v1/customer/delivery-availability?vendorId=${vendorId}&paymentMethod=CASH`, customer.token);
    expect(avail.statusCode, avail.body).toBe(200);
    const res = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' });
    expect(res.statusCode, res.body).toBe(200);
    expect(probes).toHaveLength(2);
    for (const p of probes) expect(p).toEqual({ packageSize: 'LARGE', loadBand: 'EXTRA_LARGE' });
  });

  it('stacking (checkout probe): a busy motorbike counts as a stack for a small basket (GOOD), never for one past its band (it waits: BUSY)', async () => {
    await clearStoreOrders();
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const bike = await makeRider('MOTORCYCLE', 100);
    const other = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const leg = await makeReadyOrder(other.userId, false, 1);
    await sys(() => app.prisma.order.update({ where: { id: leg.id }, data: { riderId: bike.riderId, acceptedAt: new Date() } }));
    await sys(() => app.prisma.rider.update({ where: { id: bike.riderId }, data: { currentOrderId: leg.id } }));
    const availability = async (customer: Actor) => {
      const keys = await app.redis.keys(`*avail:DELIVERY:${vendorId}*`);
      if (keys.length) await app.redis.del(...keys);
      const res = await call('GET', `/api/v1/customer/delivery-availability?vendorId=${vendorId}&paymentMethod=CASH`, customer.token);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().data.level as string;
    };
    const small = await customerWithHome();
    await addToCart(small, bulkyItemId, 1);
    expect(await availability(small)).toBe('GOOD');
    const big = await customerWithHome();
    await addToCart(big, bulkyItemId, 8);
    // Not a stack: the only motorbike must finish its leg first, so the answer carries a rider wait.
    expect(await availability(big)).toBe('BUSY');
  });
});

// [REVIEW-G 02:37Z S3-1] A bulky load now reaches bicycles and motorbikes, so the
// load the rider is shown BEFORE accepting must count the bulk, not just the
// number of items. `estLoad` (the pill every rider build already shows, builds
// 9/11 included) is the larger of the item-count reading and the order's real
// size band, in the same small / medium / large words.
describe('[owner 31 Oct] the rider sees a bulky load before accepting (estLoad counts bulk)', () => {
  it('ONE 20 kg bag of rice (very bulky, 8) goes to the motorbike, never the nearer bicycle, and says MEDIUM, not "1 item · small"', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await makeRider('BICYCLE', 50);
    const bike = await makeRider('MOTORCYCLE', 100);
    const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
    const spy = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ room, event, payload }); return true; },
    })) as never);
    onTestFinished(() => { spy.mockRestore(); });
    const rice = await makeReadyOrder(customer.userId, true, 1, 8);
    expect((await dispatch.dispatchOrder(rice.id)).offered).toBe(bike.riderId);
    const live = emitted.find((e) => e.event === 'dispatch:offer' && e.room === `user:${bike.userId}`)?.payload;
    expect(live).toMatchObject({ itemCount: 1, estLoad: 'medium', loadSize: 'MEDIUM', oversize: false });
    const rebuilt = await call('GET', '/api/v1/rider/offers/current', bike.token);
    expect(rebuilt.json().data.offer).toMatchObject({ orderId: rice.id, estLoad: 'medium', loadSize: 'MEDIUM', oversize: false });
    const board = await call('GET', '/api/v1/rider/orders/available', bike.token);
    const row = (board.json().data as Array<{ id: string }>).find((r) => r.id === rice.id);
    expect(row).toMatchObject({ estLoad: 'medium', loadSize: 'MEDIUM', oversize: false });
  });

  it('TWO bags (16) offered to a motorbike say LARGE; ordinary items keep the item-count reading', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const rice = await makeReadyOrder(customer.userId, true, 2, 8);
    const roti = await makeReadyOrder(customer.userId, false, 4); // 4 ordinary items: bulk SMALL, count medium
    const board = await call('GET', '/api/v1/rider/orders/available', bike.token);
    const rows = board.json().data as Array<{ id: string }>;
    expect(rows.find((r) => r.id === rice.id)).toMatchObject({ itemCount: 2, estLoad: 'large', loadSize: 'LARGE', oversize: false });
    expect(rows.find((r) => r.id === roti.id)).toMatchObject({ itemCount: 4, estLoad: 'medium', loadSize: 'SMALL', oversize: false });
  });

  it('"Very big load" (oversize) is only a load past what it is offered by: never for a car with car deliveries on, never for one bulky item', () => {
    const big = { orderType: 'GROCERY_DELIVERY', courierPackageSize: null, items: [{ quantity: 31, bulkUnits: null }] };
    const rice = { orderType: 'GROCERY_DELIVERY', courierPackageSize: null, items: [{ quantity: 1, bulkUnits: 8 }] };
    expect(offerLoadFields(big)).toEqual({ loadSize: 'EXTRA_LARGE', oversize: true });
    // One bag needs a motorbike (LARGE) but is a medium load: not "very big".
    expect(offerLoadFields(rice)).toEqual({ loadSize: 'MEDIUM', oversize: false });
    vi.stubEnv('CAR_DELIVERIES', '1');
    expect(offerLoadFields(big)).toEqual({ loadSize: 'EXTRA_LARGE', oversize: false });
    expect(offerLoadFields(rice)).toEqual({ loadSize: 'MEDIUM', oversize: false });
  });

  it('with car deliveries on, the car driver offered the XL order sees its size but no "Very big load"', async () => {
    await clearStoreOrders();
    vi.stubEnv('CAR_DELIVERIES', '1'); onTestFinished(() => { vi.unstubAllEnvs(); });
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const car = await makeRider('CAR', 100);
    const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = [];
    const spy = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ room, event, payload }); return true; },
    })) as never);
    onTestFinished(() => { spy.mockRestore(); });
    const big = await makeReadyOrder(customer.userId, true, 8);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(car.riderId);
    const live = emitted.find((e) => e.event === 'dispatch:offer' && e.room === `user:${car.userId}`)?.payload;
    expect(live).toMatchObject({ estLoad: 'large', loadSize: 'EXTRA_LARGE', oversize: false });
    const board = await call('GET', '/api/v1/rider/orders/available', car.token);
    const row = (board.json().data as Array<{ id: string }>).find((r) => r.id === big.id);
    expect(row).toMatchObject({ estLoad: 'large', loadSize: 'EXTRA_LARGE', oversize: false });
  });
});

// [COORD 02:35Z, Round 2] An oversize offer (past a motorbike's band, offered
// to a motorbike only because cars carry no goods today) is the rider's to
// turn down freely: a decline, a lapse or a go-offline release of one never
// lowers their acceptance rate. An ordinary offer still does.
describe('[owner 31 Oct] turning down a very big load never counts against the rider', () => {
  const rate = async (riderId: string) => Number((await sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: riderId }, select: { acceptanceRate: true } }))).acceptanceRate);
  const liveAttempt = async (orderId: string) => {
    const live = await app.redis.get(dispatchOfferKey(orderId));
    expect(live, 'a live offer').not.toBeNull();
    return live!.slice(live!.indexOf(':') + 1);
  };

  it('declining an oversize offer leaves the acceptance rate alone; declining an ordinary one lowers it', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const big = await makeReadyOrder(customer.userId, true, 8);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(bike.riderId);
    const bigAttempt = await liveAttempt(big.id);
    await dispatch.markOfferSeen(big.id, bike.userId, bigAttempt);
    await dispatch.declineOffer(big.id, bike.userId, bigAttempt);
    expect(await rate(bike.riderId)).toBe(50);

    await clearStoreOrders();
    await sys(() => app.prisma.rider.update({ where: { id: bike.riderId }, data: { isOnline: true, isAvailable: true, currentOrderId: null } }));
    const one = await makeReadyOrder(customer.userId, true, 1);
    expect((await dispatch.dispatchOrder(one.id)).offered).toBe(bike.riderId);
    const oneAttempt = await liveAttempt(one.id);
    await dispatch.markOfferSeen(one.id, bike.userId, oneAttempt);
    await dispatch.declineOffer(one.id, bike.userId, oneAttempt);
    expect(await rate(bike.riderId)).toBeCloseTo(40, 5);
  });

  it('letting a SEEN oversize offer lapse leaves the rate alone; a seen ordinary one lapsing lowers it', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const big = await makeReadyOrder(customer.userId, true, 8);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(bike.riderId);
    const bigAttempt = await liveAttempt(big.id);
    await dispatch.markOfferSeen(big.id, bike.userId, bigAttempt);
    await dispatch.handleOfferTimeout(big.id, bike.riderId, bigAttempt);
    expect(await rate(bike.riderId)).toBe(50);

    await clearStoreOrders();
    await sys(() => app.prisma.rider.update({ where: { id: bike.riderId }, data: { isOnline: true, isAvailable: true, currentOrderId: null } }));
    const one = await makeReadyOrder(customer.userId, true, 1);
    expect((await dispatch.dispatchOrder(one.id)).offered).toBe(bike.riderId);
    const oneAttempt = await liveAttempt(one.id);
    await dispatch.markOfferSeen(one.id, bike.userId, oneAttempt);
    await dispatch.handleOfferTimeout(one.id, bike.riderId, oneAttempt);
    expect(await rate(bike.riderId)).toBeCloseTo(40, 5);
  });

  it('going offline while holding a SEEN oversize offer leaves the rate alone; an ordinary one lowers it', async () => {
    await clearStoreOrders();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bike = await makeRider('MOTORCYCLE', 100);
    const big = await makeReadyOrder(customer.userId, true, 8);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(bike.riderId);
    await dispatch.markOfferSeen(big.id, bike.userId, await liveAttempt(big.id));
    await dispatch.releaseHeldOffer(bike.riderId);
    expect(await rate(bike.riderId)).toBe(50);

    await clearStoreOrders();
    await sys(() => app.prisma.rider.update({ where: { id: bike.riderId }, data: { isOnline: true, isAvailable: true, currentOrderId: null } }));
    const one = await makeReadyOrder(customer.userId, true, 1);
    expect((await dispatch.dispatchOrder(one.id)).offered).toBe(bike.riderId);
    await dispatch.markOfferSeen(one.id, bike.userId, await liveAttempt(one.id));
    await dispatch.releaseHeldOffer(bike.riderId);
    expect(await rate(bike.riderId)).toBeCloseTo(40, 5);
  });
});
