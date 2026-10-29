import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { DispatchService, EXHAUST_CAP, FOOD_RESCAN_MS, FOOD_SLOW_LANE_MAX_MINUTES } from '../modules/dispatch/dispatch.service';
import { dispatchExhaustKey, dispatchExhaustLockKey, dispatchOfferKey } from '../modules/dispatch/dispatch-generation-keys';
import { kickWaitingOrdersNear, KICK_LIMIT } from '../modules/dispatch/supply-kick';
import { measureRidersShort, pageRidersShort } from '../modules/dispatch/riders-short';
import { opsPageOnce } from '../jobs/queue';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [RIDER-SAFE · COORD rulings 29 Oct 2026] The delivery safeguard — the
// dispatch side:
//   3 the FOOD slow lane: past the fast cap a waiting food/grocery order keeps
//     re-sweeping quietly every minute until the food-age cutoff (a parcel
//     does not; an order that never got ready stops at the backstop);
//     a rider who comes online or hands over a bag wakes the oldest waiting
//     orders near them first — and two riders doing so at the same instant
//     still produce exactly ONE live offer (real Postgres + Redis);
//   6 one "riders are short" page per tenant per window;
//   7 with DISPATCH_EXHAUSTION=1 a customer who switches to pickup ends the
//     slow lane: the next sweep offers nobody.
// Fixtures sit around 1.5°N, far from every other suite.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase();
const FIXTURE = 'rider-safe-dispatch-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const DAY = 86_400_000;
const cell = (k: number) => ({ lat: 1.3 + k * 0.2, lng: -58.9 });
const TENANT_RS = `rs-dispatch-${RUN}`;

let app: FastifyInstance;
const userIds: string[] = [];
const riderIds: string[] = [];
const orderIds: string[] = [];
const vendorIds: string[] = [];
let customer: Actor;

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, tenantId = 'swift-default'): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Lane', lastName: `R${RUN}`, roles, activeRole, status: 'ACTIVE', tenantId,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `rsd-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

async function makeRider(at: { lat: number; lng: number }, meters = 0, online = true) {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: u.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      floatLimit: 1_000_000, isOnline: online, isAvailable: online, locationSessionId: online ? u.sessionId : null,
      currentLat: at.lat + meters / 111_000, currentLng: at.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
    },
  }));
  riderIds.push(rider.id);
  return { ...u, riderId: rider.id };
}

async function makeOrder(at: { lat: number; lng: number }, over: Record<string, unknown> = {}) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `RSD-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId: customer.userId, status: 'READY_FOR_PICKUP', readyAt: new Date(Date.now() - 5 * 60_000),
      acceptedAt: new Date(Date.now() - 15 * 60_000), placedAt: new Date(Date.now() - 20 * 60_000),
      pickupAddress: 'Lane Kitchen', pickupLat: at.lat, pickupLng: at.lng,
      deliveryAddress: 'Lane homes', deliveryLat: at.lat + 0.004, deliveryLng: at.lng + 0.004,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500,
      serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0, paymentMethod: 'CASH',
      ...over,
    },
  }));
  orderIds.push(order.id);
  return order;
}

function makeDispatch(redispatches: Array<{ orderId: string; delayMs: number }> = []) {
  return new DispatchService(
    app.prisma, app.redis, app.io, new HaversineMapsProvider(),
    async () => {},
    async (orderId: string, delayMs: number) => { redispatches.push({ orderId, delayMs }); return true; },
  );
}

async function purgeRedis() {
  const wanted = new Set([...orderIds, ...riderIds]);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'MATCH', 'dispatch:*', 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

/** Every rider this file made goes offline, so the next case sees only its own. */
async function park() {
  await sys(() => app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { isOnline: false, isAvailable: false, locationSessionId: null } }));
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
  await app.ready();
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_RS, name: 'Rider Safe Tenant', slug: TENANT_RS, isActive: true } }));
}, 120_000);

afterEach(async () => {
  await park();
  delete process.env['DISPATCH_EXHAUSTION'];
});

afterAll(async () => {
  await purgeRedis();
  await app.redis.del(`ops_page:riders_short:${TENANT_RS}`);
  await sys(async () => {
    const all = await app.prisma.order.findMany({ where: { OR: [{ id: { in: orderIds } }, { customerId: { in: userIds } }] }, select: { id: true } });
    const ids = all.map((o) => o.id);
    await app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { currentOrderId: null } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_RS } }).catch(() => {});
  });
  await app.close();
}, 120_000);

describe('[RIDER-SAFE 3] the FOOD slow lane past the fast cap', () => {
  it('keeps re-sweeping every minute, quietly: one "no movers" notice however many cycles', async () => {
    const order = await makeOrder(cell(0));
    await app.redis.set(dispatchExhaustKey(order.id, order.fulfillmentModeVersion), String(EXHAUST_CAP));
    const redispatches: Array<{ orderId: string; delayMs: number }> = [];
    const dispatch = makeDispatch(redispatches);

    expect(await sys(() => dispatch.dispatchOrder(order.id))).toMatchObject({ exhausted: true });
    expect(redispatches).toEqual([{ orderId: order.id, delayMs: FOOD_RESCAN_MS }]);
    // The next sweep, a minute on (the 10 s single-flight lock long gone): still nobody, still re-sweeping, nothing new told.
    await app.redis.del(dispatchExhaustLockKey(order.id, order.fulfillmentModeVersion));
    expect(await sys(() => dispatch.dispatchOrder(order.id))).toMatchObject({ exhausted: true });
    expect(redispatches).toHaveLength(2);
    expect(redispatches[1]).toEqual({ orderId: order.id, delayMs: FOOD_RESCAN_MS });
    const told = await sys(() => app.prisma.notification.count({ where: { userId: customer.userId, data: { path: ['orderId'], equals: order.id }, AND: { data: { path: ['kind'], equals: 'dispatch_exhausted' } } } }));
    expect(told).toBe(1);
    const row = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, riderId: true } }));
    expect(row).toEqual({ status: 'READY_FOR_PICKUP', riderId: null });
  });

  it('a grocery order rides it too; a parcel does not (its sender may cancel free while nobody has it)', async () => {
    const grocery = await makeOrder(cell(1), { orderType: 'GROCERY_DELIVERY' });
    const parcel = await makeOrder(cell(1), { orderType: 'COURIER', readyAt: null, courierPayer: 'SENDER', courierPackageSize: 'SMALL', courierTrackingToken: nanoid(16) });
    for (const o of [grocery, parcel]) await app.redis.set(dispatchExhaustKey(o.id, o.fulfillmentModeVersion), String(EXHAUST_CAP));
    const redispatches: Array<{ orderId: string; delayMs: number }> = [];
    const dispatch = makeDispatch(redispatches);
    await sys(() => dispatch.dispatchOrder(grocery.id));
    await sys(() => dispatch.dispatchOrder(parcel.id));
    expect(redispatches).toEqual([{ orderId: grocery.id, delayMs: FOOD_RESCAN_MS }]);
  });

  it(`stops at the backstop: no re-sweep for an order placed more than ${FOOD_SLOW_LANE_MAX_MINUTES} min ago`, async () => {
    const stale = await makeOrder(cell(2), {
      status: 'ACCEPTED', readyAt: null,
      placedAt: new Date(Date.now() - (FOOD_SLOW_LANE_MAX_MINUTES + 1) * 60_000),
      acceptedAt: new Date(Date.now() - FOOD_SLOW_LANE_MAX_MINUTES * 60_000),
    });
    await app.redis.set(dispatchExhaustKey(stale.id, stale.fulfillmentModeVersion), String(EXHAUST_CAP));
    const redispatches: Array<{ orderId: string; delayMs: number }> = [];
    expect(await sys(() => makeDispatch(redispatches).dispatchOrder(stale.id))).toMatchObject({ exhausted: true });
    expect(redispatches).toHaveLength(0);
  });

  it('[RIDER-SAFE 7 · DISPATCH_EXHAUSTION=1] a customer who switches to pickup ends the lane: the next sweep offers nobody', async () => {
    const at = cell(3);
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const vendorId = await sys(async () => {
      const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
      const v = await app.prisma.vendor.create({
        data: {
          ownerId: vo.id, name: 'Lane Kitchen', slug: `rsd-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926990001',
          addressLine1: '1 Lane Road', city: 'Lane', region: 'Upper Takutu', latitude: at.lat, longitude: at.lng,
          status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
        },
      });
      vendorIds.push(v.id);
      return v.id;
    });
    const order = await makeOrder(at, { customerId: c.userId, vendorId });
    await app.redis.set(dispatchExhaustKey(order.id, order.fulfillmentModeVersion), String(EXHAUST_CAP));
    const redispatches: Array<{ orderId: string; delayMs: number }> = [];
    const dispatch = makeDispatch(redispatches);
    await sys(() => dispatch.dispatchOrder(order.id));
    expect(redispatches).toHaveLength(1);

    process.env['DISPATCH_EXHAUSTION'] = '1';
    const converted = await app.inject({ method: 'POST', url: `/api/v1/customer/orders/${order.id}/convert-to-pickup`, headers: { authorization: `Bearer ${c.token}` } });
    expect(converted.statusCode, converted.body).toBe(200);
    expect(converted.json().data).toMatchObject({ fulfillment: 'PICKUP', deliveryFee: '0' });

    await makeRider(at, 100);
    await app.redis.del(dispatchExhaustLockKey(order.id, order.fulfillmentModeVersion));
    expect(await sys(() => dispatch.dispatchOrder(order.id))).toEqual({});
    expect(await app.redis.get(dispatchOfferKey(order.id))).toBeNull();
    expect(redispatches).toHaveLength(1);
  });
});

describe('[RIDER-SAFE 3] a rider who frees up is offered the oldest waiting order near them first', () => {
  it('wakes the oldest waiting orders near the rider, oldest first, skipping one with a live offer and one far away', async () => {
    const at = cell(4);
    const ages = [40, 30, 25, 20, 10];
    const waiting = [];
    for (const age of ages) waiting.push(await makeOrder(at, { acceptedAt: new Date(Date.now() - age * 60_000) }));
    await makeOrder(cell(5), { acceptedAt: new Date(Date.now() - 90 * 60_000) }); // oldest, but 22 km away
    await app.redis.set(dispatchOfferKey(waiting[1]!.id), `someone:${nanoid(6)}`, 'EX', 60);
    const rider = await makeRider(at, 200);
    const enqueued: Array<{ orderId: string; jobId: string; priority: number }> = [];
    const kicked = await sys(() => kickWaitingOrdersNear({ prisma: app.prisma, redis: app.redis, enqueue: async (orderId, o) => { enqueued.push({ orderId, ...o }); } }, rider.riderId));
    expect(KICK_LIMIT).toBe(3);
    expect(kicked).toEqual([waiting[0]!.id, waiting[2]!.id, waiting[3]!.id]);
    expect(enqueued.map((e) => e.priority)).toEqual([1, 2, 3]);
    expect(enqueued[0]!.jobId).toMatch(new RegExp(`^supply-kick-${waiting[0]!.id}-\\d+$`));
    await app.redis.del(dispatchOfferKey(waiting[1]!.id));
  });

  it('an offline or full rider wakes nothing', async () => {
    const at = cell(6);
    await makeOrder(at);
    const off = await makeRider(at, 100, false);
    const enqueued: string[] = [];
    expect(await sys(() => kickWaitingOrdersNear({ prisma: app.prisma, redis: app.redis, enqueue: async (id) => { enqueued.push(id); } }, off.riderId))).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it('two riders freeing up at the same instant beside one waiting order: exactly ONE live offer (real Postgres + Redis)', async () => {
    const at = cell(7);
    const order = await makeOrder(at);
    const a = await makeRider(at, 100);
    const b = await makeRider(at, 150);
    const dispatch = makeDispatch();
    const runNow = async (orderId: string) => { await sys(() => dispatch.dispatchOrder(orderId)); };
    const [ka, kb] = await Promise.all([
      sys(() => kickWaitingOrdersNear({ prisma: app.prisma, redis: app.redis, enqueue: runNow }, a.riderId)),
      sys(() => kickWaitingOrdersNear({ prisma: app.prisma, redis: app.redis, enqueue: runNow }, b.riderId)),
    ]);
    expect([...ka, ...kb]).toContain(order.id);
    const raw = await app.redis.get(dispatchOfferKey(order.id));
    expect(raw).not.toBeNull();
    const holder = raw!.slice(0, raw!.indexOf(':'));
    expect([a.riderId, b.riderId]).toContain(holder);
    const other = holder === a.riderId ? b.riderId : a.riderId;
    expect(await app.redis.get(`dispatch:mover-offer:${other}`)).toBeNull();
    expect((await app.redis.get(`dispatch:mover-offer:${holder}`))?.startsWith(order.id)).toBe(true);
    const row = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { riderId: true } }));
    expect(row.riderId).toBeNull(); // offered, not assigned: the rider still decides
  });
});

describe('[RIDER-SAFE 6] one "riders are short" page per tenant per window', () => {
  it('pages once when orders wait past the threshold, with the numbers; never twice in the window', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER', TENANT_RS);
    for (let i = 0; i < 5; i += 1) await makeOrder(cell(8), { customerId: c.userId, tenantId: TENANT_RS });
    const reading = (await sys(() => measureRidersShort(app.prisma))).find((r) => r.tenantId === TENANT_RS);
    expect(reading).toMatchObject({ waiting: 5, short: true });

    const pages: Array<{ tenantId: string | null; data: Record<string, unknown>; title: string }> = [];
    const deps = {
      prisma: app.prisma,
      pageOnce: (key: string, ttl: number, page: () => Promise<unknown>) => opsPageOnce({ redis: app.redis }, key, ttl, page),
      notifyAdmins: async (input: { tenantId: string | null; data: Record<string, unknown>; title: string }) => { pages.push(input); return 1; },
    };
    expect(await sys(() => pageRidersShort(deps))).toContain(TENANT_RS);
    expect(await sys(() => pageRidersShort(deps))).not.toContain(TENANT_RS);
    const mine = pages.filter((p) => p.tenantId === TENANT_RS);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Riders are short', data: { kind: 'ops_riders_short', waiting: 5 } });
  });

  it('searches that ran out of riders in the last 10 minutes count too, below the waiting threshold', async () => {
    await app.redis.del(`ops_page:riders_short:${TENANT_RS}`);
    await sys(() => app.prisma.order.updateMany({ where: { tenantId: TENANT_RS }, data: { status: 'CANCELLED' } }));
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER', TENANT_RS);
    for (let i = 0; i < 3; i += 1) {
      const o = await makeOrder(cell(8), { customerId: c.userId, tenantId: TENANT_RS, status: 'CANCELLED' });
      await sys(() => app.prisma.dispatchSearch.create({ data: { vertical: 'DELIVERY', subjectId: o.id, status: 'EXHAUSTED', radiusKm: 15, exhaustedAt: new Date() } }));
    }
    const reading = (await sys(() => measureRidersShort(app.prisma))).find((r) => r.tenantId === TENANT_RS);
    expect(reading).toMatchObject({ waiting: 0, exhaustedRecently: 3, short: true });
  });
});
