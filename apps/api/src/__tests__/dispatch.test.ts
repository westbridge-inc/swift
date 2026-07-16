import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { scoreCandidate, rankCandidates } from '../modules/dispatch/scoring';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// dispatch. Hardest paths: the no-acceptance path
// (food cooked, nobody coming — must end in an honest message), riders
// vanishing mid-offer, and duplicate acceptance. The DB compare-and-set is
// the real lock: ten simultaneous accepts produce exactly one winner.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PICKUP = { lat: 6.8, lng: -58.15 };

let app: FastifyInstance;
let dispatch: DispatchService;
const scheduled: Array<{ orderId: string; riderId: string; delayMs: number }> = [];

const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let vendorOwnerUserId: string;
let vendorId: string;
let customerId: string;

/** Idempotent sweep — survives interrupted previous runs. */
async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { OR: [{ phone: { startsWith: '+59200088' } }, { phone: { in: ['+5920009901', '+5920009902'] } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;

  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { rider: { userId: { in: ids } } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
async function makeRider(opts: {
  lat?: number; lng?: number; online?: boolean; available?: boolean;
  rating?: number; acceptance?: number; busy?: boolean;
}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200088${String(seq).padStart(2, '0')}`,
      firstName: 'Dispatch',
      lastName: `Rider${seq}`,
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole],
      activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      // D.3 float gate: a verified, dispatch-eligible rider has float headroom.
      // Production sets this via FloatService.recomputeForUser on rider creation/
      // verification; this helper writes the rider row directly, so set it high
      // enough that CASH offers aren't filtered out by the dispatch float gate.
      floatLimit: 1_000_000,
      isOnline: opts.online ?? true,
      isAvailable: opts.available ?? true,
      currentLat: opts.lat ?? PICKUP.lat,
      currentLng: opts.lng ?? PICKUP.lng,
      averageRating: opts.rating ?? 5,
      acceptanceRate: opts.acceptance ?? 100,
      currentOrderId: opts.busy ? 'busy-elsewhere' : null,
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'step8', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, riderId: rider.id, token };
}

async function makeDeliveryOrder(status: 'ACCEPTED' | 'READY_FOR_PICKUP' = 'ACCEPTED', pickup = PICKUP) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `S8-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      status,
      fulfillment: 'DELIVERY',
      pickupAddress: 'Vendor HQ',
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      deliveryAddress: 'Customer place',
      deliveryLat: pickup.lat + 0.01,
      deliveryLng: pickup.lng + 0.01,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  return order;
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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();

  dispatch = new DispatchService(
    app.prisma,
    app.redis,
    app.io,
    new HaversineMapsProvider(),
    async (orderId, riderId, delayMs) => {
      scheduled.push({ orderId, riderId, delayMs });
    },
  );

  await purgeFixtures();

  // Customer + vendor scaffolding for orders
  const customer = await app.prisma.user.create({
    data: {
      phone: '+5920009901', firstName: 'Dispatch', lastName: 'Customer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  createdUserIds.push(customer.id);
  customerId = customer.id;

  const ownerUser = await app.prisma.user.create({
    data: {
      phone: '+5920009902', firstName: 'Dispatch', lastName: 'Vendor',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(ownerUser.id);
  vendorOwnerUserId = ownerUser.id;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: 'Dispatch Diner', slug: 'dispatch-diner',
      vendorType: 'RESTAURANT', phone: '+5920009903',
      addressLine1: '1 Dispatch Drive', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: PICKUP.lat, longitude: PICKUP.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('Scoring — pure and predictable', () => {
  const base = { riderId: 'r', userId: 'u', etaMinutes: 5, averageRating: 5, acceptanceRate: 100, hasActiveJob: false };

  it('closer beats further, all else equal', () => {
    expect(scoreCandidate({ ...base, etaMinutes: 2 })).toBeLessThan(scoreCandidate({ ...base, etaMinutes: 20 }));
  });

  it('an idle rider beats a loaded one at similar distance', () => {
    expect(scoreCandidate({ ...base, hasActiveJob: false })).toBeLessThan(scoreCandidate({ ...base, hasActiveJob: true }));
  });

  it('chronic decliners drift down', () => {
    expect(scoreCandidate({ ...base, acceptanceRate: 95 })).toBeLessThan(scoreCandidate({ ...base, acceptanceRate: 20 }));
  });

  it('rating breaks ties', () => {
    expect(scoreCandidate({ ...base, averageRating: 4.9 })).toBeLessThan(scoreCandidate({ ...base, averageRating: 3.0 }));
  });

  it('ranks a field deterministically', () => {
    const near = { ...base, riderId: 'near', etaMinutes: 2 };
    const nearButBusy = { ...base, riderId: 'busy', etaMinutes: 2.5, hasActiveJob: true };
    const far = { ...base, riderId: 'far', etaMinutes: 25 };
    expect(rankCandidates([far, nearButBusy, near]).map((c) => c.riderId)).toEqual(['near', 'busy', 'far']);
  });
});

describe('Candidate discovery — PostGIS radius', () => {
  it('finds online riders inside the radius and excludes the rest', async () => {
    const near = await makeRider({ lat: PICKUP.lat + 0.0045 });            // ~0.5 km
    const mid = await makeRider({ lat: PICKUP.lat + 0.018 });              // ~2 km
    const offline = await makeRider({ lat: PICKUP.lat + 0.002, online: false });
    const farAway = await makeRider({ lat: PICKUP.lat + 0.45 });           // ~50 km

    const order = await makeDeliveryOrder();
    const candidates = await dispatch.findCandidates(order.id, PICKUP, 5);
    const ids = candidates.map((c) => c.riderId);

    expect(ids).toContain(near.riderId);
    expect(ids).toContain(mid.riderId);
    expect(ids).not.toContain(offline.riderId);
    expect(ids).not.toContain(farAway.riderId);
    expect(ids[0]).toBe(near.riderId); // ranked: nearest idle first

    // cleanup riders for later scenarios
    await app.prisma.rider.updateMany({
      where: { id: { in: [near.riderId, mid.riderId] } },
      data: { isOnline: false },
    });
  });
});

describe('The offer cascade', () => {
  it('offers best-first, walks the field on decline/timeout, and honest-fails when empty', async () => {
    const a = await makeRider({ lat: PICKUP.lat + 0.0045, acceptance: 100 }); // best
    const b = await makeRider({ lat: PICKUP.lat + 0.018, acceptance: 100 }); // next
    const order = await makeDeliveryOrder();

    // 1) Best candidate gets the offer + a timeout is scheduled
    const first = await dispatch.dispatchOrder(order.id);
    expect(first.offered).toBe(a.riderId);
    expect(scheduled.at(-1)).toMatchObject({ orderId: order.id, riderId: a.riderId, delayMs: 20_000 });

    // 2) A declines -> B is offered; A's acceptance EMA dropped
    await dispatch.declineOffer(order.id, a.userId);
    const offerNow = await app.redis.get(`dispatch:offer:${order.id}`);
    expect(offerNow).toBe(b.riderId);
    const aAfter = await app.prisma.rider.findUniqueOrThrow({ where: { id: a.riderId } });
    expect(aAfter.acceptanceRate).toBeLessThan(100);

    // 3) B times out (goes dark mid-offer) -> nobody left in 5km -> radius
    //    widens -> still nobody -> honest exhaustion to customer AND vendor
    await dispatch.handleOfferTimeout(order.id, b.riderId);

    const customerNote = await app.prisma.notification.findFirst({
      where: { userId: customerId, title: 'No movers available right now' },
    });
    const vendorNote = await app.prisma.notification.findFirst({
      where: { userId: vendorOwnerUserId, title: 'No movers available' },
    });
    expect(customerNote).not.toBeNull();
    expect(vendorNote).not.toBeNull();

    const final = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, riderId: true } });
    expect(final.riderId).toBeNull();
    expect(final.status).toBe('ACCEPTED'); // never a silent hang, never a fake assignment

    await app.prisma.rider.updateMany({ where: { id: { in: [a.riderId, b.riderId] } }, data: { isOnline: false } });
  });

  it('ALERTS_LOUD: an offer lands a push-backed notification with expiry; flag off is silent (alerts spec A2)', async () => {
    const quiet = await makeRider({ lat: PICKUP.lat + 0.0045, acceptance: 100 });
    const loud = await makeRider({ lat: PICKUP.lat + 0.02, acceptance: 100 }); // farther: not offered while quiet is online
    try {
      const orderQuiet = await makeDeliveryOrder();
      delete process.env['ALERTS_LOUD'];
      await dispatch.dispatchOrder(orderQuiet.id);
      expect(await app.prisma.notification.count({ where: { userId: quiet.userId } })).toBe(0);

      // Park quiet; with the flag ON the offer goes to loud and must notify.
      await app.prisma.rider.update({ where: { id: quiet.riderId }, data: { isOnline: false } });
      process.env['ALERTS_LOUD'] = '1';
      const orderLoud = await makeDeliveryOrder();
      await dispatch.dispatchOrder(orderLoud.id);
      const note = await app.prisma.notification.findFirst({
        where: { userId: loud.userId },
        orderBy: { createdAt: 'desc' },
      });
      expect(note).toBeTruthy();
      expect(note!.title).toContain('Order available nearby');
      const data = note!.data as { kind: string; orderId: string; expiresAt: string };
      expect(data.kind).toBe('dispatch_offer');
      expect(data.orderId).toBe(orderLoud.id);
      expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    } finally {
      delete process.env['ALERTS_LOUD'];
      // Park this test's riders so later field-geometry tests stay clean.
      await app.prisma.rider.updateMany({
        where: { id: { in: [quiet.riderId, loud.riderId] } },
        data: { isOnline: false },
      });
    }
  });

  it('a stale timeout for a superseded offer is a no-op', async () => {
    const a = await makeRider({ lat: PICKUP.lat + 0.004 });
    const order = await makeDeliveryOrder();
    await dispatch.dispatchOrder(order.id);

    // Timeout fires with the WRONG rider id (offer already superseded)
    await dispatch.handleOfferTimeout(order.id, 'some-other-rider');
    expect(await app.redis.get(`dispatch:offer:${order.id}`)).toBe(a.riderId);

    await app.prisma.rider.update({ where: { id: a.riderId }, data: { isOnline: false } });
  });

  it('widens the radius when the inner ring is empty', async () => {
    const outer = await makeRider({ lat: PICKUP.lat + 0.072 }); // ~8 km — outside 5, inside 10
    const order = await makeDeliveryOrder();

    const result = await dispatch.dispatchOrder(order.id);
    expect(result.offered).toBe(outer.riderId);
    expect(await app.redis.get(`dispatch:round:${order.id}`)).toBe('1');

    await app.prisma.rider.update({ where: { id: outer.riderId }, data: { isOnline: false } });
  });

  it('never dispatches PICKUP orders', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `S8P-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId, vendorId, status: 'ACCEPTED', fulfillment: 'PICKUP',
        deliveryAddress: 'counter', deliveryLat: PICKUP.lat, deliveryLng: PICKUP.lng,
        pickupLat: PICKUP.lat, pickupLng: PICKUP.lng, pickupAddress: 'counter',
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      },
    });
    createdOrderIds.push(order.id);

    const result = await dispatch.dispatchOrder(order.id);
    expect(result).toEqual({});
  });
});

describe('Atomic acceptance — the concurrency proof', () => {
  it('10 simultaneous claims on one job: exactly 1 winner, 9 clean rejections', async () => {
    const riders = await Promise.all(Array.from({ length: 10 }, () => makeRider({})));
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');

    const results = await Promise.allSettled(
      riders.map((r) => dispatch.claimOrder(order.id, r.riderId)),
    );

    const wins = results.filter((r) => r.status === 'fulfilled');
    const rejections = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'ALREADY_TAKEN',
    );
    expect(wins).toHaveLength(1);
    expect(rejections).toHaveLength(9);

    const db = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { riderId: true, status: true },
    });
    expect(db.status).toBe('RIDER_ASSIGNED');
    expect(db.riderId).not.toBeNull();

    const logs = await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'RIDER_ASSIGNED' } });
    expect(logs).toBe(1);

    await app.prisma.rider.updateMany({
      where: { id: { in: riders.map((r) => r.riderId) } },
      data: { isOnline: false },
    });
  });

  it('accepting through the HTTP endpoint honours the live offer', async () => {
    const a = await makeRider({ lat: PICKUP.lat + 0.003 });
    const b = await makeRider({ lat: PICKUP.lat + 0.02 });
    const order = await makeDeliveryOrder();

    await dispatch.dispatchOrder(order.id); // offers A

    // B tries to take A's offer -> clean 409
    const stolen = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/offers/accept',
      payload: { orderId: order.id },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
    });
    expect(stolen.statusCode).toBe(409);

    // A accepts -> assigned
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/rider/offers/accept',
      payload: { orderId: order.id },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.status).toBe('RIDER_ASSIGNED');

    // Customer got the rider-assigned notification
    const note = await app.prisma.notification.findFirst({
      where: { userId: customerId, data: { path: ['orderId'], equals: order.id } },
      orderBy: { createdAt: 'desc' },
    });
    expect(note).not.toBeNull();

    await app.prisma.rider.updateMany({ where: { id: { in: [a.riderId, b.riderId] } }, data: { isOnline: false } });
  });
});
