import { currentTaxiSplitDocuments } from './helpers/current-mover-documents';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole, type VehicleType } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { makeDispatchService } from '../modules/dispatch/dispatch.service';
import { riderStackingCapacity, riderLiveLegCount } from '../modules/dispatch/concurrency-policy';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';
import { desiredPlatformConfig } from '../modules/ops/platform-config';
import { setAppLogger } from '../utils/logger';
import { recordDispatchQueue } from './helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// STK-3 — ONE capacity knob: riders really carry up to 3.
//
// The owner ruled "2b" on 2026-09-24: a rider may hold up to THREE delivery
// orders at once. #1358 raised the founder-gated `stacking.riderCapacity` to
// 3, and every count gate (board, accept, candidate SQL, offer re-check, the
// guarded reservation) read it. The stack gate did not: its rule R2 ("batch
// size") took its limit from the shadow batching engine's default
// `maxOrdersPerRun: 2`, so a rider's third order was refused "R2: 3 vs 2"
// while the board said riders take 3.
//
// Asserted through the REAL mounted rider routes (board accept, offer accept)
// and the real dispatch cascade, on durable rows:
//   · a fresh environment (migrate deploy + seed, CI's build) runs on 3
//   · at 3, a rider with two live legs takes a third through BOTH doors, and
//     is then full: unavailable, an empty board, a fourth refused
//   · at 2, the third is refused — the claim names R2 "3 vs 2"
//   · at 1, nothing stacks and the stack gate is never even asked
//   · at 3, R3 (capacity points) and R4 (cash vs float) still refuse a
//     physically unsafe third leg, and every refusal logs its rule
//
// Every scenario works in its own corner of the interior, more than 15 km
// (the cascade's widest ring) from each other and from Georgetown, so one
// scenario's supply can never answer another scenario's dispatch.
//
// Fixture range: +5920733nnn (this file only; grepped, no other user).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920733';
const FIXTURE = 'stk3-one-knob-fixture';
const KNOB = 'stacking.riderCapacity';
/** This file's own knob rows carry this tag, so cleanup never touches another suite's. */
const TAG = 'stacking-one-knob.test';

type Point = { lat: number; lng: number };
const SITE = {
  boardDoor: { lat: 5.0, lng: -58.8 },
  offerDoor: { lat: 5.0, lng: -59.2 },
  killSwitch: { lat: 5.4, lng: -58.8 },
  noStacking: { lat: 5.4, lng: -59.2 },
  pointsGate: { lat: 4.6, lng: -58.8 },
  cashGate: { lat: 4.6, lng: -59.2 },
} satisfies Record<string, Point>;

let app: FastifyInstance;
let seq = 0;

/** Every `log().info(obj, msg)` the platform writes while this file runs. */
const logged: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const refusalsFor = (orderId: string) => logged.filter((l) => /leg refused/.test(l.msg) && l.obj['orderId'] === orderId);

const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Mover = { userId: string; riderId: string; token: string };

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  return sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName,
      lastName: `Stk3U${seq}`,
      roles,
      activeRole,
      status: 'ACTIVE',
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
}

/** An online, verified delivery rider with a real device session, standing at `at`. */
async function makeMover(at: Point, opts: { vehicleType?: VehicleType; floatLimit?: number } = {}): Promise<Mover> {
  const user = await makeUser('Stack', ['RIDER', 'CUSTOMER'], 'RIDER');
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `stk3-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: user.id,
      riderType: 'DELIVERY',
      vehicleType: opts.vehicleType ?? 'MOTORCYCLE',
      documentsVerified: true,
      floatLimit: opts.floatLimit ?? 1_000_000,
      isOnline: true,
      isAvailable: true,
      locationSessionId: session.id,
      currentLat: at.lat,
      currentLng: at.lng,
      lastLocationUpdate: new Date(),
      averageRating: 5,
      acceptanceRate: 100,
    },
  }));
  if (rider.vehicleType === 'CAR') await sys(() => currentTaxiSplitDocuments(app.prisma, user.id));
  return { userId: user.id, riderId: rider.id, token };
}

/** One kitchen per scenario: every order is collected from it (R5 same-vendor). */
async function makeKitchen(at: Point) {
  const ownerUser = await makeUser('Kitchen', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const owner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Stk3 Kitchen ${seq}`,
      slug: `stk3-kitchen-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: ownerUser.phone,
      addressLine1: '1 Knob Road',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: at.lat,
      longitude: at.lng,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  }));
  const customer = await makeUser('Hungry', ['CUSTOMER'], 'CUSTOMER');
  return { vendorId: vendor.id, customerId: customer.id, at };
}

type Kitchen = Awaited<ReturnType<typeof makeKitchen>>;

/**
 * A CASH food order, ready at the kitchen, dropping ~600 m away (inside every
 * corridor). `bulk` sets its load: 0 → S (1 point), 8 → M (2), 20 → L (3).
 */
async function makeOrder(k: Kitchen, opts: { bulk?: number; subtotal?: number } = {}) {
  const subtotal = opts.subtotal ?? 2000;
  const bulk = opts.bulk ?? 0;
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `STK3-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'DELIVERY',
      customerId: k.customerId,
      vendorId: k.vendorId,
      status: 'READY_FOR_PICKUP',
      pickupAddress: 'Stk3 Kitchen',
      pickupLat: k.at.lat,
      pickupLng: k.at.lng,
      deliveryAddress: 'The customer door',
      deliveryLat: k.at.lat + 0.004,
      deliveryLng: k.at.lng + 0.004,
      subtotalBase: subtotal,
      subtotalMarkup: 0,
      subtotalCustomer: subtotal,
      deliveryFee: 500,
      totalAmount: subtotal + 500,
      paymentMethod: 'CASH',
      ...(bulk > 0 && {
        items: {
          create: [{
            itemId: `stk3-bulk-${nanoid(6)}`,
            name: 'Case of water',
            quantity: bulk,
            bulkUnits: 1,
            basePrice: 100,
            markedUpPrice: 100,
            markupAmount: 0,
            totalBase: 100 * bulk,
            totalMarkup: 0,
            totalCustomer: 100 * bulk,
          }],
        },
      }),
    },
  }));
}

/** The founder turns the knob: a higher-version row, exactly as production does it. */
async function setCapacity(value: number) {
  await sys(async () => {
    const latest = await app.prisma.algoConfig.findFirst({
      where: { tenantId: 'swift-default', key: KNOB },
      orderBy: { version: 'desc' },
    });
    await app.prisma.algoConfig.create({
      data: { tenantId: 'swift-default', key: KNOB, value, version: (latest?.version ?? 0) + 1, founderGated: true, updatedBy: TAG },
    });
  });
  invalidateAlgoConfig();
}

function call(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${token}`,
    },
  });
}

/** The board grab — the rider taps "Accept" on an open job. */
const boardAccept = (m: Mover, orderId: string) => call('POST', `/api/v1/rider/orders/${orderId}/accept`, m.token, {});
/** The offer card — the rider taps "Accept" on the job dispatch sent them. */
const offerAccept = (m: Mover, orderId: string) => call('POST', '/api/v1/rider/offers/accept', m.token, { orderId });

const riderRow = (riderId: string) => sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id: riderId } }));
const orderRow = (orderId: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: orderId } }));

/** Two live legs, taken through the real board door at the current knob. */
async function holdTwoLegs(m: Mover, k: Kitchen, loads: [number, number] = [0, 0]) {
  const first = await makeOrder(k, { bulk: loads[0] });
  const second = await makeOrder(k, { bulk: loads[1] });
  for (const o of [first, second]) {
    const res = await boardAccept(m, o.id);
    expect(res.statusCode, res.body).toBe(200);
  }
  expect(await riderLiveLegCount(app.prisma, m.riderId)).toBe(2);
  return [first, second] as const;
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }] },
      select: { id: true },
    })).map((o) => o.id);
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    // Exhaustion pages reach admins outside this file's range; find them by order.
    if (orderIds.length > 0) {
      await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    }
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: owners.map((o) => o.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await purgeRedis([...ids, ...riderIds, ...orderIds]);
  });
}

/** Redis bookkeeping keyed by this file's ids (offers, declines, rounds,
 *  exhaustion markers, debounce stamps) — removed so a re-run starts clean. */
async function purgeRedis(ids: string[]) {
  if (ids.length === 0) return;
  const wanted = new Set(ids);
  let cursor = '0';
  do {
    const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const mine = keys.filter((k) => k.split(/[:]/).some((part) => wanted.has(part)));
    if (mine.length > 0) await app.redis.del(...mine);
  } while (cursor !== '0');
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  // The production composition root gives every request a fresh tenant store
  // before auth (app.ts) — replicated here.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  await purgeFixtures();
  // A crashed earlier run of THIS file may have left its own knob rows behind.
  await sys(() => app.prisma.algoConfig.deleteMany({ where: { key: KNOB, updatedBy: TAG } }));
  invalidateAlgoConfig();
  setAppLogger({
    info: ((obj: unknown, msg?: unknown) => {
      if (obj && typeof obj === 'object' && typeof msg === 'string') logged.push({ obj: obj as Record<string, unknown>, msg });
    }) as never,
    warn: (() => {}) as never,
    error: (() => {}) as never,
    debug: (() => {}) as never,
  });
});

afterAll(async () => {
  setAppLogger(console);
  // Delete only this file's knob rows: the value in force returns to the
  // seed's (or whatever another suite restored), never to this file's era.
  await sys(() => app.prisma.algoConfig.deleteMany({ where: { key: KNOB, updatedBy: TAG } }));
  invalidateAlgoConfig();
  await purgeFixtures();
  await app.close();
});

describe('STK-3 · the knob in a fresh environment', () => {
  it('migrate deploy + seed (how CI builds its database) leaves the owner\'s 3 in the store the reader reads', async () => {
    // What the seed writes: ONE founder-gated row, for exactly the key and
    // tenant the reader resolves (riderStackingCapacity reads swift-default).
    const planned = desiredPlatformConfig().algoConfig.filter((a) => a.key === KNOB);
    expect(planned).toEqual([expect.objectContaining({ tenantId: 'swift-default', key: KNOB, value: 3, founderGated: true })]);

    // What the reader answers on this database. Runs before this file writes a
    // row; every suite that pins the knob deletes or restores its own rows, so
    // the value in force here is the seed's.
    invalidateAlgoConfig();
    expect(await riderStackingCapacity(app.prisma)).toBe(3);
  });
});

describe('STK-3 · at capacity 3 a rider carries three', () => {
  it('the board door: a rider with two live legs takes a third, and is then full — unavailable, an empty board, a fourth refused', async () => {
    await setCapacity(3);
    const k = await makeKitchen(SITE.boardDoor);
    const m = await makeMover(SITE.boardDoor);
    const [first] = await holdTwoLegs(m, k);
    expect((await riderRow(m.riderId)).isAvailable).toBe(true); // 2 of 3: room for one more

    const third = await makeOrder(k);
    const res = await boardAccept(m, third.id);
    // RED before STK-3: 409 "This job can't be stacked with your current delivery (R2: 3 vs 2)".
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ orderId: third.id, status: 'RIDER_ASSIGNED' });
    expect(refusalsFor(third.id)).toEqual([]);

    const row = await riderRow(m.riderId);
    expect({ available: row.isAvailable, primary: row.currentOrderId }).toEqual({ available: false, primary: first.id });
    expect(await riderLiveLegCount(app.prisma, m.riderId)).toBe(3);
    expect(await orderRow(third.id)).toMatchObject({ riderId: m.riderId, status: 'RIDER_ASSIGNED' });

    // The rider's own device sees the whole run.
    const legs = await call('GET', '/api/v1/rider/orders/active-legs', m.token);
    expect(legs.statusCode, legs.body).toBe(200);
    expect(legs.json().data.legs).toHaveLength(3);
    expect(legs.json().data.run).toMatchObject({ drops: 3 });

    // Full means full: the board is empty and says why, and a fourth is refused.
    const board = await call('GET', '/api/v1/rider/orders/available', m.token);
    expect(board.statusCode, board.body).toBe(200);
    expect(board.json()).toMatchObject({ data: [], message: 'You are at your delivery limit — finish one to take another' });
    const fourth = await makeOrder(k);
    const refused = await boardAccept(m, fourth.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe('You are at your delivery limit — finish one before accepting another.');
    expect(await orderRow(fourth.id)).toMatchObject({ riderId: null, status: 'READY_FOR_PICKUP' });
  });

  it('the offer door: dispatch offers the third job to a rider holding two, and the offer card claims it', async () => {
    await setCapacity(3);
    const k = await makeKitchen(SITE.offerDoor);
    const m = await makeMover(SITE.offerDoor);
    await holdTwoLegs(m, k);

    const third = await makeOrder(k);
    const dispatched = await makeDispatchService(app).dispatchOrder(third.id);
    // RED before STK-3: the cascade asked the stack gate, R2 refused "3 vs 2",
    // the offer was withdrawn and the only rider in range was marked declined.
    expect(dispatched).toEqual({ offered: m.riderId });
    expect(refusalsFor(third.id)).toEqual([]);

    const res = await offerAccept(m, third.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ orderId: third.id, status: 'RIDER_ASSIGNED' });
    expect(await riderLiveLegCount(app.prisma, m.riderId)).toBe(3);
    expect((await riderRow(m.riderId)).isAvailable).toBe(false);
  });
});

describe('STK-3 · the knob turns down as well as up', () => {
  it('at capacity 2 the third is refused: the board by count, and the claim names R2 "3 vs 2" and rolls back', async () => {
    // An offer goes out while the knob is at 3 …
    await setCapacity(3);
    const k = await makeKitchen(SITE.killSwitch);
    const m = await makeMover(SITE.killSwitch);
    await holdTwoLegs(m, k);
    const third = await makeOrder(k);
    expect(await makeDispatchService(app).dispatchOrder(third.id)).toEqual({ offered: m.riderId });

    // … and the founder turns it down to 2 before the rider taps.
    await setCapacity(2);
    const res = await offerAccept(m, third.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('STACK_INELIGIBLE');
    expect(res.json().error.message).toContain('(R2: 3 vs 2)');
    expect(refusalsFor(third.id)).toContainEqual(expect.objectContaining({
      obj: expect.objectContaining({ riderId: m.riderId, rule: 'R2', detail: '3 vs 2', legs: 2, capacity: 2 }),
    }));
    // The claim rolled back whole: the job is still open, the rider still holds two.
    expect(await orderRow(third.id)).toMatchObject({ riderId: null, status: 'READY_FOR_PICKUP' });
    expect(await riderLiveLegCount(app.prisma, m.riderId)).toBe(2);

    // The board door refuses the same third job by count, before any claim.
    const board = await boardAccept(m, third.id);
    expect(board.statusCode).toBe(409);
    expect(board.json().error.message).toBe('You are at your delivery limit — finish one before accepting another.');
  });

  it('at capacity 1 nothing stacks: one job makes the rider full, and the stack gate is never asked', async () => {
    await setCapacity(1);
    const k = await makeKitchen(SITE.noStacking);
    const m = await makeMover(SITE.noStacking);
    const first = await makeOrder(k);
    const took = await boardAccept(m, first.id);
    expect(took.statusCode, took.body).toBe(200);
    expect((await riderRow(m.riderId)).isAvailable).toBe(false);

    const second = await makeOrder(k);
    const board = await call('GET', '/api/v1/rider/orders/available', m.token);
    expect(board.json()).toMatchObject({ data: [], message: 'Complete your current delivery first' });
    const refused = await boardAccept(m, second.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe('You already have an active delivery. Complete it before accepting a new one.');
    // Dispatch does not offer it to the only rider in range either.
    const dispatched = await makeDispatchService(app).dispatchOrder(second.id);
    expect(dispatched.offered).toBeUndefined();
    expect(await riderLiveLegCount(app.prisma, m.riderId)).toBe(1);
    expect(refusalsFor(second.id)).toEqual([]);
  });
});

describe('STK-3 · at capacity 3 the physical rules still refuse an unsafe third leg', () => {
  it('R3 capacity points: a motorbike (4 points) holding S+M is refused an L third, and still takes an S third', async () => {
    await setCapacity(3);
    const k = await makeKitchen(SITE.pointsGate);
    const m = await makeMover(SITE.pointsGate, { vehicleType: 'MOTORCYCLE' });
    await holdTwoLegs(m, k, [0, 8]); // S (1) + M (2) = 3 of 4 points

    const large = await makeOrder(k, { bulk: 20 }); // L (3): 6 of 4
    const refused = await boardAccept(m, large.id);
    expect(refused.statusCode, refused.body).toBe(409);
    // RED before STK-3: R2 ("3 vs 2") refused first and hid the physical rule.
    expect(refused.json().error.message).toContain('(R3: 6 vs 4)');
    expect(refusalsFor(large.id)).toContainEqual(expect.objectContaining({
      obj: expect.objectContaining({ riderId: m.riderId, rule: 'R3', detail: '6 vs 4', legs: 2, capacity: 3 }),
    }));
    expect(await orderRow(large.id)).toMatchObject({ riderId: null, status: 'READY_FOR_PICKUP' });

    const small = await makeOrder(k); // S (1): 4 of 4 — fits exactly
    const took = await boardAccept(m, small.id);
    expect(took.statusCode, took.body).toBe(200);
    expect(await riderLiveLegCount(app.prisma, m.riderId)).toBe(3);
    expect((await riderRow(m.riderId)).isAvailable).toBe(false);
  });

  it('R4 cash vs float: a third CASH leg that takes the summed cash past the float cap is refused, naming R4', async () => {
    await setCapacity(3);
    const k = await makeKitchen(SITE.cashGate);
    // Three 2,500 cash drops = 7,500 to carry; this rider's float cap is 7,000.
    const m = await makeMover(SITE.cashGate, { vehicleType: 'CAR', floatLimit: 7_000 });
    await holdTwoLegs(m, k);

    const third = await makeOrder(k);
    const refused = await boardAccept(m, third.id);
    expect(refused.statusCode, refused.body).toBe(409);
    // RED before STK-3: R2 ("3 vs 2") refused first.
    expect(refused.json().error.message).toContain('(R4: 7500 vs 7000)');
    expect(refusalsFor(third.id)).toContainEqual(expect.objectContaining({
      obj: expect.objectContaining({ riderId: m.riderId, rule: 'R4', detail: '7500 vs 7000', legs: 2, capacity: 3 }),
    }));
    expect(await orderRow(third.id)).toMatchObject({ riderId: null, status: 'READY_FOR_PICKUP' });
    expect(await riderLiveLegCount(app.prisma, m.riderId)).toBe(2);
  });
});
