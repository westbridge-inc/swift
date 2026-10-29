import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { makeDispatchService, stuckDispatchEligibleWhere, type DispatchService } from '../modules/dispatch/dispatch.service';
import { decideCapacity, waitingForRiderWhere, storeRiderBacklog } from '../modules/dispatch/delivery-capacity';
import { stackableForProbe } from '../modules/dispatch/stack-eligibility';
import { deliveryPausedAt, readDeliveryPause, setDeliveryPause } from '../modules/dispatch/delivery-pause';
import { platformStats } from '../modules/admin/platform-stats';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [RIDER-SAFE · COORD rulings 29 Oct 2026] The delivery safeguard for when
// riders run short — the checkout side:
//   1 honest capacity (free + stackable − waiting orders near the store):
//     GOOD / BUSY (taken, the customer told the extra minutes first, the
//     promise carries the rider wait) / NONE (order for pickup instead);
//   4 a store's own rider backlog pauses its NEW delivery orders by itself;
//   5 Swift's pause switch (platform-wide, or a zone), pickup stays open;
//   6 the dashboard counts only orders a rider should carry.
// Fixtures sit around 2°N in the far south, a different 22 km cell per case,
// so no other suite's movers or orders are ever near.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase();
const FIXTURE = 'rider-safe-capacity-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const DAY = 86_400_000;
const cell = (k: number) => ({ lat: 2.1 + k * 0.2, lng: -59.4 });

let app: FastifyInstance;
let dispatch: DispatchService;
const userIds: string[] = [];
const riderIds: string[] = [];
const vendorIds: string[] = [];
const zoneIds: string[] = [];
let backlogCustomer = '';

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, extra: Record<string, unknown> = {}): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Safe', lastName: `R${RUN}`, roles, activeRole, status: 'ACTIVE',
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
      ...extra,
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `rs-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

/** An online delivery rider `meters` north of a point. busy = no room (a live leg, not available). */
async function makeRider(at: { lat: number; lng: number }, meters: number, opts: { busy?: boolean; vendorId?: string } = {}) {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      floatLimit: 1_000_000, isOnline: true, isAvailable: !opts.busy, locationSessionId: u.sessionId,
      currentLat: at.lat + meters / 111_000, currentLng: at.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
    },
  }));
  riderIds.push(rider.id);
  if (opts.busy && opts.vendorId) {
    const leg = await makeOrder(opts.vendorId, at, { status: 'PICKED_UP', riderId: rider.id });
    await sys(() => app.prisma.rider.update({ where: { id: rider.id }, data: { currentOrderId: leg.id } }));
  }
  return { ...u, riderId: rider.id };
}

async function makeStore(at: { lat: number; lng: number }, name: string) {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ids = await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name, slug: `rs-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926990000',
        addressLine1: '1 Savannah Road', city: 'Aishalton', region: 'Upper Takutu', latitude: at.lat, longitude: at.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
      },
    });
    const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
    const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Rice plate', basePrice: 2000, isAvailable: true } });
    return { vendorId: vendor.id, itemId: item.id };
  });
  vendorIds.push(ids.vendorId);
  return { ...ids, owner };
}

/** A delivery order at a store, by default ACCEPTED with no rider (waiting). */
async function makeOrder(
  vendorId: string,
  at: { lat: number; lng: number },
  opts: { status?: 'ACCEPTED' | 'PICKED_UP' | 'READY_FOR_PICKUP' | 'PENDING'; riderId?: string; acceptedMinAgo?: number; orderType?: 'FOOD_DELIVERY' | 'TAXI'; fulfillment?: 'DELIVERY' | 'PICKUP'; vendorDelivers?: boolean } = {},
) {
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `RS-${nanoid(10)}`, orderType: opts.orderType ?? 'FOOD_DELIVERY', fulfillment: opts.fulfillment ?? 'DELIVERY',
      customerId: backlogCustomer, vendorId: opts.orderType === 'TAXI' ? null : vendorId, status: opts.status ?? 'ACCEPTED',
      riderId: opts.riderId ?? null,
      acceptedAt: new Date(Date.now() - (opts.acceptedMinAgo ?? 10) * 60_000),
      placedAt: new Date(Date.now() - ((opts.acceptedMinAgo ?? 10) + 2) * 60_000),
      ...(opts.vendorDelivers ? { fulfillmentMode: 'VENDOR_DELIVERY' as const } : {}),
      pickupAddress: 'Store', pickupLat: at.lat, pickupLng: at.lng,
      deliveryAddress: 'Homes', deliveryLat: at.lat + 0.004, deliveryLng: at.lng + 0.004,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
      paymentMethod: 'CASH',
    },
  }));
}

async function customerAt(at: { lat: number; lng: number }) {
  const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: c.userId, label: 'Home', addressLine1: '2 Savannah Road', city: 'Aishalton', region: 'Upper Takutu', latitude: at.lat + 0.004, longitude: at.lng, isDefault: true },
  }));
  return c;
}

const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
});

async function addToCart(c: Actor, vendorId: string, itemId: string) {
  const res = await call('POST', '/api/v1/customer/cart/items', c.token, { vendorId, itemId, quantity: 1 });
  expect([200, 201], res.body).toContain(res.statusCode);
}

async function clearAvailabilityCache(vendorId: string) {
  const keys = await app.redis.keys(`*avail:DELIVERY:${vendorId}:*`);
  if (keys.length > 0) await app.redis.del(...keys);
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  dispatch = makeDispatchService(app);
  backlogCustomer = (await makeUser(['CUSTOMER'], 'CUSTOMER')).userId;
}, 120_000);

afterEach(() => {
  delete process.env['DISPATCH_AVAILABILITY'];
  vi.useRealTimers();
});

afterAll(async () => {
  await sys(async () => {
    const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { currentOrderId: null } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.algoConfig.deleteMany({ where: { key: 'delivery.pause', updatedBy: { in: userIds } } });
    await app.prisma.algoConfig.deleteMany({ where: { key: 'delivery.pause', tenantId: { startsWith: `rs-${RUN}` } } });
    await app.prisma.zone.deleteMany({ where: { id: { in: zoneIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });
  await app.close();
}, 120_000);

describe('[RIDER-SAFE 1] the decision, from the measured numbers', () => {
  const base = { legMinutes: 25, maxWaitMinutes: 30 };
  it('a free slot left over is GOOD; no rider near at all is NONE', () => {
    expect(decideCapacity({ ...base, free: 2, stackable: 0, ridersNear: 2, backlog: 1 })).toEqual({ level: 'GOOD', reason: null, riderWaitMinutes: 0 });
    expect(decideCapacity({ ...base, free: 0, stackable: 1, ridersNear: 1, backlog: 0 })).toMatchObject({ level: 'GOOD' });
    expect(decideCapacity({ ...base, free: 0, stackable: 0, ridersNear: 0, backlog: 0 })).toEqual({ level: 'NONE', reason: 'NO_RIDERS', riderWaitMinutes: 0 });
  });

  it('every rider spoken for but riders working is BUSY with the honest wait: position x leg / (riders + 1)', () => {
    // 1 free rider, 2 orders already waiting: this order is 2nd in line for 1 rider -> 2*25/2 = 25 min.
    expect(decideCapacity({ ...base, free: 1, stackable: 0, ridersNear: 1, backlog: 2 })).toEqual({ level: 'BUSY', reason: null, riderWaitMinutes: 25 });
    // All 4 riders carrying a bag, nobody waiting: first in line, 1*25/5 = 5 min.
    expect(decideCapacity({ ...base, free: 0, stackable: 0, ridersNear: 4, backlog: 0 })).toEqual({ level: 'BUSY', reason: null, riderWaitMinutes: 5 });
  });

  it('a wait past the cap is NONE (riders too busy), never a promise nobody can keep', () => {
    expect(decideCapacity({ ...base, free: 1, stackable: 0, ridersNear: 1, backlog: 3 })).toEqual({ level: 'NONE', reason: 'RIDERS_BUSY', riderWaitMinutes: 38 });
    expect(decideCapacity({ ...base, maxWaitMinutes: 40, free: 1, stackable: 0, ridersNear: 1, backlog: 3 })).toMatchObject({ level: 'BUSY', riderWaitMinutes: 38 });
  });
});

describe('[RIDER-SAFE 1] the backlog is exactly the work the reconciler re-drives', () => {
  it('waitingForRiderWhere equals the food/grocery/courier branch of stuckDispatchEligibleWhere', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T17:00:00Z'));
    const stuck = stuckDispatchEligibleWhere(new Date('2026-10-29T16:57:00Z'));
    const { updatedAt: _u, ...rest } = stuck as { updatedAt: unknown; OR: unknown[] };
    const branch = (rest.OR as Record<string, unknown>[])[0]!;
    expect(waitingForRiderWhere(new Date())).toEqual(branch);
  });
});

describe('[RIDER-SAFE 1] honest capacity, measured on real rows', () => {
  it('counts the orders already waiting near the store against the free riders, and riders busy with a bag as supply', async () => {
    const at = cell(0);
    const store = await makeStore(at, 'Capacity Kitchen');
    const other = await makeStore({ lat: at.lat + 0.002, lng: at.lng }, 'Next Door Kitchen');
    const probe = { tenantId: 'swift-default', store: { id: store.vendorId, ...at }, orderType: 'FOOD_DELIVERY', dropoff: { lat: at.lat + 0.004, lng: at.lng }, floatRequired: 2000, cashToCollect: 2000, packageSize: 'SMALL' };

    expect(await sys(() => dispatch.getDeliveryCapacity(probe))).toMatchObject({ level: 'NONE', reason: 'NO_RIDERS' });

    await makeRider(at, 200);
    expect(await sys(() => dispatch.getDeliveryCapacity(probe))).toMatchObject({ level: 'GOOD', riderWaitMinutes: 0 });

    // One order already waiting next door takes that rider: this one waits.
    await makeOrder(other.vendorId, { lat: at.lat + 0.002, lng: at.lng });
    const busy = await sys(() => dispatch.getDeliveryCapacity(probe));
    expect(busy).toMatchObject({ level: 'BUSY', reason: null, riderWaitMinutes: 13 });
    expect(busy.counts).toEqual({ free: 1, stackable: 0, ridersNear: 1, backlog: 1 });

    // A second rider busy with a bag frees up too: more riders, a shorter wait.
    await makeRider(at, 300, { busy: true, vendorId: other.vendorId });
    const two = await sys(() => dispatch.getDeliveryCapacity(probe));
    expect(two.counts).toMatchObject({ free: 1, ridersNear: 2, backlog: 1 });
    expect(two).toMatchObject({ level: 'BUSY', riderWaitMinutes: 9 });

    // An order waiting 30 km away is not this store's backlog.
    await makeOrder(other.vendorId, cell(9));
    expect((await sys(() => dispatch.getDeliveryCapacity(probe))).counts.backlog).toBe(1);
  });

  it('a stacked rider counts only where the stacking rules pass for THIS store (same store yes, a far store no)', async () => {
    const at = cell(1);
    const store = await makeStore(at, 'Stack Kitchen');
    const far = { lat: at.lat + 0.03, lng: at.lng }; // ~3.3 km: inside the 5 km search, outside the 400 m pickup rule
    const farStore = await makeStore(far, 'Far Kitchen');
    const near = await makeRider(at, 100);
    const leg = await makeOrder(store.vendorId, at, { status: 'PICKED_UP', riderId: near.riderId });
    const away = await makeRider(at, 150);
    const farLeg = await makeOrder(farStore.vendorId, far, { status: 'PICKED_UP', riderId: away.riderId });
    const probe = { vertical: 'FOOD' as const, sizeClass: 'S' as const, cashToCollect: 2000, pickup: { ...at, vendorId: store.vendorId }, dropoff: { lat: at.lat + 0.004, lng: at.lng } };
    const ok = await sys(() => stackableForProbe(app.prisma, [near.riderId, away.riderId], probe, 3));
    expect([...ok]).toEqual([near.riderId]);
    // The one knob: at capacity 1 nobody stacks.
    expect((await sys(() => stackableForProbe(app.prisma, [near.riderId, away.riderId], probe, 1))).size).toBe(0);
    expect(leg.id && farLeg.id).toBeTruthy();
  });
});

describe('[RIDER-SAFE 1/2] checkout: BUSY is taken with the wait in the promise; NONE is refused for pickup', () => {
  it('BUSY places the order and its promise carries the rider wait; past the cap it is refused and pickup still works', async () => {
    const at = cell(2);
    const store = await makeStore(at, 'Busy Kitchen');
    const other = await makeStore({ lat: at.lat + 0.002, lng: at.lng }, 'Busy Neighbour');
    await makeRider(at, 200);
    process.env['DISPATCH_AVAILABILITY'] = '1';

    const first = await customerAt(at);
    await addToCart(first, store.vendorId, store.itemId);
    const good = await call('POST', '/api/v1/customer/checkout', first.token, { paymentMethod: 'CASH' });
    expect(good.statusCode, good.body).toBe(200);
    const goodOrder = await sys(() => app.prisma.order.findFirstOrThrow({ where: { customerId: first.userId }, select: { promiseBaseSeconds: true } }));

    // Two orders already waiting next door: 2nd in line for 1 rider -> 25 min.
    await makeOrder(other.vendorId, { lat: at.lat + 0.002, lng: at.lng });
    await makeOrder(other.vendorId, { lat: at.lat + 0.002, lng: at.lng });
    const second = await customerAt(at);
    await addToCart(second, store.vendorId, store.itemId);
    await clearAvailabilityCache(store.vendorId);
    const shown = await call('GET', `/api/v1/customer/delivery-availability?vendorId=${store.vendorId}`, second.token);
    expect(shown.statusCode, shown.body).toBe(200);
    expect(shown.json().data).toEqual({ level: 'BUSY', reason: null, extraMinutes: 25, message: 'Riders are busy — about 25 min extra for delivery.', gate: true });
    expect(shown.body).not.toMatch(/backlog|ridersNear|free|stackable/);

    const busy = await call('POST', '/api/v1/customer/checkout', second.token, { paymentMethod: 'CASH' });
    expect(busy.statusCode, busy.body).toBe(200);
    const busyOrder = await sys(() => app.prisma.order.findFirstOrThrow({ where: { customerId: second.userId }, select: { promiseBaseSeconds: true } }));
    expect(Number(busyOrder.promiseBaseSeconds) - Number(goodOrder.promiseBaseSeconds)).toBe(25 * 60);

    // A third waiting order: 3rd in line, 38 min > 30 -> refused, pickup instead.
    await makeOrder(other.vendorId, { lat: at.lat + 0.002, lng: at.lng });
    const third = await customerAt(at);
    await addToCart(third, store.vendorId, store.itemId);
    await clearAvailabilityCache(store.vendorId);
    expect((await call('GET', `/api/v1/customer/delivery-availability?vendorId=${store.vendorId}`, third.token)).json().data)
      .toMatchObject({ level: 'NONE', reason: 'RIDERS_BUSY', extraMinutes: null });
    const refused = await call('POST', '/api/v1/customer/checkout', third.token, { paymentMethod: 'CASH' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'DELIVERY_NO_RIDERS', details: { reason: 'RIDERS_BUSY' } });
    expect(refused.json().error.message).toContain('Pickup');
    expect(await sys(() => app.prisma.order.count({ where: { customerId: third.userId } }))).toBe(0);
    const pickup = await call('POST', '/api/v1/customer/checkout', third.token, { paymentMethod: 'CASH', fulfillmentSelections: { [store.vendorId]: 'PICKUP' } });
    expect(pickup.statusCode, pickup.body).toBe(200);
  });

  it('with the availability flag off nothing is refused on riders, and the GET says gate:false', async () => {
    const at = cell(3);
    const store = await makeStore(at, 'Flag Off Kitchen');
    const c = await customerAt(at);
    await addToCart(c, store.vendorId, store.itemId);
    expect((await call('GET', `/api/v1/customer/delivery-availability?vendorId=${store.vendorId}`, c.token)).json().data)
      .toMatchObject({ level: 'NONE', reason: 'NO_RIDERS', gate: false });
    const placed = await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH' });
    expect(placed.statusCode, placed.body).toBe(200);
  });
});

describe('[RIDER-SAFE 4] a store with orders waiting for riders pauses its NEW delivery orders by itself', () => {
  it('at 3 waiting (past the grace) delivery is refused, pickup is not, the store sees why — and it resumes when a rider takes one', async () => {
    const at = cell(4);
    const store = await makeStore(at, 'Backlog Kitchen');
    const w1 = await makeOrder(store.vendorId, at, { acceptedMinAgo: 6 });
    await makeOrder(store.vendorId, at, { acceptedMinAgo: 6 });
    const fresh = await makeOrder(store.vendorId, at, { acceptedMinAgo: 1 });
    // Self-delivered, taxi-shaped or pickup orders are never "waiting for a rider".
    await makeOrder(store.vendorId, at, { acceptedMinAgo: 6, vendorDelivers: true });
    await makeOrder(store.vendorId, at, { acceptedMinAgo: 6, fulfillment: 'PICKUP' });
    expect(await sys(() => storeRiderBacklog(app.prisma, store.vendorId, 'swift-default'))).toEqual({ waiting: 2, cap: 3, paused: false });

    const c = await customerAt(at);
    await addToCart(c, store.vendorId, store.itemId);
    await sys(() => app.prisma.order.update({ where: { id: fresh.id }, data: { acceptedAt: new Date(Date.now() - 6 * 60_000) } }));
    expect(await sys(() => storeRiderBacklog(app.prisma, store.vendorId, 'swift-default'))).toEqual({ waiting: 3, cap: 3, paused: true });

    const refused = await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'DELIVERY_NO_RIDERS', details: { reason: 'STORE_BUSY' } });
    expect((await call('GET', `/api/v1/customer/delivery-availability?vendorId=${store.vendorId}`, c.token)).json().data)
      .toMatchObject({ level: 'PAUSED', reason: 'STORE_BUSY', extraMinutes: null });
    const status = await call('GET', '/api/v1/vendor/vendor/delivery-status', store.owner.token, undefined, { 'x-vendor-id': store.vendorId });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json().data).toMatchObject({ deliveryOpen: false, reason: 'STORE_BUSY', waitingForRider: 3, backlogCap: 3 });
    expect(status.json().data.message).toContain('restart by themselves');

    // A rider takes one: the store is below the cap, delivery is open again.
    const r = await makeRider(cell(14), 0);
    await sys(() => app.prisma.order.update({ where: { id: w1.id }, data: { riderId: r.riderId, status: 'RIDER_ASSIGNED' } }));
    expect((await call('GET', '/api/v1/vendor/vendor/delivery-status', store.owner.token, undefined, { 'x-vendor-id': store.vendorId })).json().data)
      .toMatchObject({ deliveryOpen: true, reason: null, waitingForRider: 2 });
    const placed = await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH' });
    expect(placed.statusCode, placed.body).toBe(200);
  });
});

describe("[RIDER-SAFE 5] Swift's delivery pause switch", () => {
  it('platform-wide: paused and lifted as versions, each with an audit row; a stale screen cannot overwrite a newer decision', async () => {
    const tenantId = `rs-${RUN}-t`;
    const actor = (await makeUser(['CUSTOMER'], 'CUSTOMER')).userId;
    expect(await sys(() => deliveryPausedAt(app.prisma, tenantId, cell(5)))).toEqual({ paused: false, scope: null, zoneName: null });
    const on = await sys(() => setDeliveryPause(app.prisma, { tenantId, platform: true, zoneIds: [], actorUserId: actor, reason: 'Storm: no riders can go out', expectedVersion: 0 }));
    expect(on).toMatchObject({ platform: true, version: 1, updatedBy: actor });
    expect(await sys(() => deliveryPausedAt(app.prisma, tenantId, cell(5)))).toMatchObject({ paused: true, scope: 'PLATFORM' });
    await expect(sys(() => setDeliveryPause(app.prisma, { tenantId, platform: false, zoneIds: [], actorUserId: actor, reason: 'stale screen', expectedVersion: 0 })))
      .rejects.toMatchObject({ code: 'PAUSE_CHANGED' });
    const off = await sys(() => setDeliveryPause(app.prisma, { tenantId, platform: false, zoneIds: [], actorUserId: actor, reason: 'Storm passed', expectedVersion: 1 }));
    expect(off).toMatchObject({ platform: false, version: 2 });
    expect(await sys(() => deliveryPausedAt(app.prisma, tenantId, cell(5)))).toMatchObject({ paused: false });
    const audits = await sys(() => app.prisma.auditLog.findMany({ where: { action: 'DELIVERY_PAUSE_SET', entityId: `${tenantId}:delivery.pause` }, orderBy: { createdAt: 'asc' } }));
    expect(audits.map((a) => (a.changes as { reason: string }).reason)).toEqual(['Storm: no riders can go out', 'Storm passed']);
  });

  it('two admins at the same instant: exactly one write wins', async () => {
    const tenantId = `rs-${RUN}-race`;
    const actor = (await makeUser(['CUSTOMER'], 'CUSTOMER')).userId;
    const results = await Promise.allSettled([0, 1, 2, 3].map((i) => sys(() => setDeliveryPause(app.prisma, { tenantId, platform: i % 2 === 0, zoneIds: [], actorUserId: actor, reason: `race ${i}` }))));
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won.length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'PAUSE_CHANGED' });
    const rows = await sys(() => app.prisma.algoConfig.findMany({ where: { tenantId, key: 'delivery.pause' }, select: { version: true } }));
    expect(rows.map((r) => r.version).sort()).toEqual(Array.from({ length: won.length }, (_, i) => i + 1));
  });

  it('by zone, through the admin console: delivery from a store inside the zone is refused, pickup is not; a reason is required', async () => {
    const at = cell(6);
    const d = 0.02;
    const zone = await sys(() => app.prisma.zone.create({
      data: { name: `Rider Safe Zone ${RUN}`, tenantId: 'swift-default', countryCode: 'GY', priority: -50,
        boundary: { type: 'Polygon', coordinates: [[[at.lng - d, at.lat - d], [at.lng + d, at.lat - d], [at.lng + d, at.lat + d], [at.lng - d, at.lat + d], [at.lng - d, at.lat - d]]] } },
    }));
    zoneIds.push(zone.id);
    const inside = await makeStore(at, 'Zone Kitchen');
    const outsideAt = cell(7);
    const outside = await makeStore(outsideAt, 'Outside Kitchen');
    const admin = await makeUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { admin: { create: { permissions: ['*'] } } });

    const noReason = await call('PUT', '/api/v1/admin/delivery-pause', admin.token, { platform: false, zoneIds: [zone.id] });
    expect(noReason.statusCode, noReason.body).toBe(400);
    const before = await call('GET', '/api/v1/admin/delivery-pause', admin.token);
    expect(before.statusCode, before.body).toBe(200);
    const set = await call('PUT', '/api/v1/admin/delivery-pause', admin.token, {
      platform: false, zoneIds: [zone.id], reason: 'Only two riders left in the south today', expectedVersion: before.json().data.version,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().data).toMatchObject({ platform: false, zoneIds: [zone.id] });
    const unknown = await call('PUT', '/api/v1/admin/delivery-pause', admin.token, { platform: false, zoneIds: ['no-such-zone'], reason: 'A zone that does not exist here' });
    expect(unknown.statusCode, unknown.body).toBe(400);

    const c = await customerAt(at);
    await addToCart(c, inside.vendorId, inside.itemId);
    const refused = await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'DELIVERY_NO_RIDERS', details: { reason: 'SWIFT_PAUSED' } });
    expect((await call('GET', `/api/v1/customer/delivery-availability?vendorId=${inside.vendorId}`, c.token)).json().data)
      .toMatchObject({ level: 'PAUSED', reason: 'SWIFT_PAUSED' });
    expect((await call('GET', '/api/v1/vendor/vendor/delivery-status', inside.owner.token, undefined, { 'x-vendor-id': inside.vendorId })).json().data)
      .toMatchObject({ deliveryOpen: false, reason: 'SWIFT_PAUSED' });
    const pickup = await call('POST', '/api/v1/customer/checkout', c.token, { paymentMethod: 'CASH', fulfillmentSelections: { [inside.vendorId]: 'PICKUP' } });
    expect(pickup.statusCode, pickup.body).toBe(200);

    const o = await customerAt(outsideAt);
    await addToCart(o, outside.vendorId, outside.itemId);
    expect((await call('POST', '/api/v1/customer/checkout', o.token, { paymentMethod: 'CASH' })).statusCode).toBe(200);

    // Lifted: the zone's store delivers again.
    const lifted = await call('PUT', '/api/v1/admin/delivery-pause', admin.token, { platform: false, zoneIds: [], reason: 'Riders are back in the south' });
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(await readDeliveryPause(app.prisma, 'swift-default')).toMatchObject({ platform: false, zoneIds: [] });
    const c2 = await customerAt(at);
    await addToCart(c2, inside.vendorId, inside.itemId);
    expect((await call('POST', '/api/v1/customer/checkout', c2.token, { paymentMethod: 'CASH' })).statusCode).toBe(200);
  });
});

describe('[RIDER-SAFE 6] the dashboard counts only orders a rider should carry', () => {
  it('a taxi, a pickup and a store-delivered order are not "unassigned"; free riders and waiting orders are reported', async () => {
    const at = cell(8);
    const store = await makeStore(at, 'Stats Kitchen');
    const today = new Date(Date.now() - DAY);
    const read = () => sys(() => platformStats(app.prisma, { tenantId: 'swift-default', today, subscriptionScope: {} }));
    const before = await read();
    await makeOrder(store.vendorId, at, { acceptedMinAgo: 20 }); // counts: a delivery waiting for a rider
    await makeOrder(store.vendorId, at, { acceptedMinAgo: 20, orderType: 'TAXI', status: 'PENDING' });
    await makeOrder(store.vendorId, at, { acceptedMinAgo: 20, fulfillment: 'PICKUP' });
    await makeOrder(store.vendorId, at, { acceptedMinAgo: 20, vendorDelivers: true });
    await makeRider(at, 100);
    const after = await read();
    expect(after.unassignedOrders - before.unassignedOrders).toBe(1);
    expect(after.waitingForRider - before.waitingForRider).toBe(1);
    expect(after.freeRiders - before.freeRiders).toBe(1);
  });
});
