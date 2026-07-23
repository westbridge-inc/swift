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
import { runWithoutTenant } from '../plugins/tenant-context';

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
const createdTenantIds: string[] = [];
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
  // Carts have a restrict FK to the customer — must go before the user or the
  // whole user.deleteMany fails atomically and strands every fixture.
  await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
async function makeRider(opts: {
  lat?: number; lng?: number; online?: boolean; available?: boolean;
  rating?: number; acceptance?: number; busy?: boolean; tenantId?: string;
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
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
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
  // The HTTP accept tests run authenticate -> enterTenant, whose enterWith
  // leaks a tenant into this async context; without clearing it, purge's
  // findMany is scoped to swift-default and never sees the foreign-tenant rider.
  await runWithoutTenant(async () => {
    await purgeFixtures(); // deletes the fixture users (incl. the foreign-tenant rider) by phone
    // Now that no user points at them, the throwaway tenants can go.
    if (createdTenantIds.length) await app.prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  });
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

  it('never offers across tenants — a mover in another operator is invisible (raw geo query bypasses tenantScope)', async () => {
    // A second operator on the same platform. Both riders sit on the SAME remote
    // spot, far from every other fixture, so tenancy is the ONLY thing that can
    // separate them.
    const FAR = { lat: 6.95, lng: -58.42 };
    const otherTenant = await app.prisma.tenant.create({ data: { name: 'Other Op', slug: `other-${nanoid(6).toLowerCase()}` } });
    createdTenantIds.push(otherTenant.id);
    const foreign = await makeRider({ lat: FAR.lat, lng: FAR.lng, tenantId: otherTenant.id });
    const local = await makeRider({ lat: FAR.lat, lng: FAR.lng }); // swift-default
    const order = await makeDeliveryOrder('ACCEPTED', FAR);        // swift-default

    // Dispatching a swift-default order must see the local rider and NOT the
    // foreign one — even though the foreign rider is an identical, closer-or-equal
    // candidate. This is the assertion that fails without the JOIN+tenant filter.
    const forDefault = await dispatch.findCandidates(order.id, FAR, 5, 'RIDER', 0, null, 'swift-default');
    const defaultIds = forDefault.map((c) => c.riderId);
    expect(defaultIds).toContain(local.riderId);
    expect(defaultIds).not.toContain(foreign.riderId);

    // And the other operator sees only its own rider — never the default one.
    const forOther = await dispatch.findCandidates(order.id, FAR, 5, 'RIDER', 0, null, otherTenant.id);
    const otherIds = forOther.map((c) => c.riderId);
    expect(otherIds).toContain(foreign.riderId);
    expect(otherIds).not.toContain(local.riderId);

    await app.prisma.rider.updateMany({ where: { id: { in: [foreign.riderId, local.riderId] } }, data: { isOnline: false } });
  });
});

describe('Availability — float-aware supply (matches the dispatch cash-float gate)', () => {
  it('a rider without the float headroom to front a cash order is not counted', async () => {
    const SPOT = { lat: 6.42, lng: -57.92 }; // remote — no other fixtures in range
    const r = await makeRider({ lat: SPOT.lat, lng: SPOT.lng });
    // Only 5,000 GYD of free float.
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { floatLimit: 5000, committedFloat: 0 } });

    // Browsing (float 0) and a small order within the rider's headroom: counted.
    expect((await dispatch.getAvailability('RIDER', SPOT, 0)).level).not.toBe('NONE');
    expect((await dispatch.getAvailability('RIDER', SPOT, 5000)).level).not.toBe('NONE');

    // A 12,000 GYD cash order needs more float than the rider has → NONE, the
    // SAME rider dispatch's cash-float gate would skip (no false "yes").
    expect((await dispatch.getAvailability('RIDER', SPOT, 12000)).level).toBe('NONE');

    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false } });
  });
});

describe('The offer cascade', () => {
  it('offers best-first, walks the field on decline/timeout, and honest-fails when empty', async () => {
    const a = await makeRider({ lat: PICKUP.lat + 0.0045, acceptance: 100 }); // best
    const b = await makeRider({ lat: PICKUP.lat + 0.018, acceptance: 100 }); // next
    const order = await makeDeliveryOrder();
    // An admin who should be paged when the pool goes dead (SWIFT-AUD-D7-02).
    const admin = await app.prisma.user.create({
      data: { phone: '+5920008899', firstName: 'Ops', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true },
    });
    createdUserIds.push(admin.id);

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

    // Ops is paged too — a dead mover pool must not be invisible (D7-02).
    const adminNote = await app.prisma.notification.findFirst({
      where: { userId: admin.id, title: 'Dispatch exhausted — no mover found' },
    });
    expect(adminNote).not.toBeNull();

    const final = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, riderId: true } });
    expect(final.riderId).toBeNull();
    expect(final.status).toBe('ACCEPTED'); // never a silent hang, never a fake assignment

    await app.prisma.rider.updateMany({ where: { id: { in: [a.riderId, b.riderId] } }, data: { isOnline: false } });
  });

  it('SWIFT-016: accepting via /offers/accept claims, applies the fare, and never a timeout penalty', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false } });
    const rider = await makeRider({ lat: PICKUP.lat + 0.002, acceptance: 100 });
    const order = await makeDeliveryOrder();

    // The offer lands on the rider (offerKey set, alert created, timeout scheduled).
    const offered = await dispatch.dispatchOrder(order.id);
    expect(offered.offered).toBe(rider.riderId);

    // Accept through the OFFER path (what the offer card now calls), undercutting
    // the 500 market fee to 300.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/rider/offers/accept',
      headers: { authorization: `Bearer ${rider.token}`, 'content-type': 'application/json' },
      payload: { orderId: order.id, fare: 300 },
    });
    expect(res.statusCode).toBe(200);

    const claimed = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(claimed.riderId).toBe(rider.riderId);
    expect(claimed.status).toBe('RIDER_ASSIGNED');
    expect(Number(claimed.deliveryFee)).toBe(300); // rider-set fee applied

    // The originally-scheduled offer timeout fires. Because acceptOffer cleared
    // the offer, it must NOT penalise the rider who accepted.
    await dispatch.handleOfferTimeout(order.id, rider.riderId);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.riderId } });
    // RED before SWIFT-016: the offer card hit board-grab, which left the offer
    // live, so this timeout scored a miss and dropped acceptanceRate below 100.
    expect(after.acceptanceRate).toBe(100);
    await app.prisma.rider.updateMany({ where: { id: rider.riderId }, data: { isOnline: false } });
  });

  it('SWIFT-065: exhaustion is terminal — long-TTL marker + admins paged once, not every hour', async () => {
    await app.prisma.rider.updateMany({ data: { isOnline: false } }); // guarantee an empty pool
    const order = await makeDeliveryOrder();
    const admin = await app.prisma.user.create({
      data: { phone: '+5920008877', firstName: 'Ops2', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true },
    });
    createdUserIds.push(admin.id);

    // First full exhaustion (widens through every round, finds no candidate).
    const r1 = await dispatch.dispatchOrder(order.id);
    expect(r1).toMatchObject({ exhausted: true });

    // The attempt marker now persists far longer than the old 1h TTL, so the
    // reconciler leaves this stranded order alone instead of re-cascading hourly.
    const ttl = await app.redis.ttl(`dispatch:exhausts:${order.id}`);
    expect(ttl).toBeGreaterThan(3600);

    const pagedOnce = await app.prisma.notification.count({
      where: { userId: admin.id, title: 'Dispatch exhausted — no mover found' },
    });
    expect(pagedOnce).toBe(1);

    // A second exhaustion of the SAME order must NOT re-page the admins.
    await dispatch.dispatchOrder(order.id);
    const pagedAfter = await app.prisma.notification.count({
      where: { userId: admin.id, title: 'Dispatch exhausted — no mover found' },
    });
    // RED before SWIFT-065: 2 — admins were paged on every re-exhaust.
    expect(pagedAfter).toBe(1);

    await app.redis.del(`dispatch:exhausts:${order.id}`, `ops_page:dispatch_exhausted:${order.id}`);
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

  it('two riders racing the DIRECT accept endpoint: exactly one wins, the loser is not stuck busy', async () => {
    // POST /rider/orders/:id/accept used a plain update-by-id, so two riders who
    // both passed the JS riderId-null check could double-assign AND both mark
    // themselves busy. This proves the compare-and-set fix.
    const a = await makeRider({ lat: PICKUP.lat + 0.003 });
    const b = await makeRider({ lat: PICKUP.lat + 0.004 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');

    const accept = (token: string) => app.inject({
      method: 'POST',
      url: `/api/v1/rider/orders/${order.id}/accept`,
      payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    const [ra, rb] = await Promise.all([accept(a.token), accept(b.token)]);

    // Exactly one winner (200), one clean conflict (409) — never two winners.
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);

    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { riderId: true, status: true } });
    expect(db.status).toBe('RIDER_ASSIGNED');
    expect([a.riderId, b.riderId]).toContain(db.riderId);

    // Only the winner is busy on this order; the loser is free, not stranded.
    const riders = await app.prisma.rider.findMany({ where: { id: { in: [a.riderId, b.riderId] } }, select: { id: true, currentOrderId: true } });
    const busyOnThis = riders.filter((r) => r.currentOrderId === order.id);
    expect(busyOnThis).toHaveLength(1);
    expect(busyOnThis[0]!.id).toBe(db.riderId);

    await app.prisma.rider.updateMany({ where: { id: { in: [a.riderId, b.riderId] } }, data: { isOnline: false } });
  });

  // D.3 cash-exposure parity [debug-ledger P2]: the offer cascade gates
  // candidates on float headroom and commits float on claim — the DIRECT
  // board-grab accept must do the same, or the cash-exposure cap is
  // bypassable through this entrance and a later release decrements float
  // that was never committed.
  it('direct accept REFUSES a CASH order beyond the rider float headroom', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.003 });
    // Order fronts 2,000 GYD of vendor cash; the rider only has 1,000 headroom.
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { floatLimit: 1000, committedFloat: 0 } });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rider/orders/${order.id}/accept`,
      payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('FLOAT_EXCEEDED');

    // Nothing claimed, rider not stuck.
    const db = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { riderId: true } });
    expect(db.riderId).toBeNull();

    await app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, floatLimit: 1_000_000 } });
  });

  it('direct accept COMMITS the CASH float, mirroring dispatch.claimOrder', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.003 });
    const order = await makeDeliveryOrder('READY_FOR_PICKUP');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rider/orders/${order.id}/accept`,
      payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` },
    });
    expect(res.statusCode).toBe(200);

    const rider = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId }, select: { committedFloat: true } });
    expect(Number(rider.committedFloat)).toBe(2000); // = the order's subtotalBase

    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, committedFloat: 0, currentOrderId: null, isAvailable: true },
    });
  });

  it('one rider grabbing TWO cash orders at once cannot exceed the float cap [SWIFT-104]', async () => {
    const r = await makeRider({ lat: PICKUP.lat + 0.003 });
    // Headroom 3,000; each order fronts 2,000 — either fits ALONE, both do NOT.
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { floatLimit: 3000, committedFloat: 0 } });
    const orderA = await makeDeliveryOrder('READY_FOR_PICKUP');
    const orderB = await makeDeliveryOrder('READY_FOR_PICKUP');

    const accept = (orderId: string) => app.inject({
      method: 'POST', url: `/api/v1/rider/orders/${orderId}/accept`, payload: {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` },
    });
    // Fire both grabs concurrently — both pass the stale JS headroom/busy checks;
    // the ATOMIC guarded float commit is the only real gate.
    const [ra, rb] = await Promise.all([accept(orderA.id), accept(orderB.id)]);

    // Exactly one winner; the other is refused for float — never two.
    expect([ra, rb].filter((x) => x.statusCode === 200)).toHaveLength(1);
    const loser = [ra, rb].find((x) => x.statusCode !== 200)!;
    expect(loser.statusCode).toBe(400);
    expect(loser.json().error.code).toBe('FLOAT_EXCEEDED');

    // The cap HELD: float committed exactly once (2,000, not 4,000).
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId }, select: { committedFloat: true } });
    expect(Number(after.committedFloat)).toBe(2000);

    // One order assigned to the rider; the other is back on the board (compensated).
    const orders = await app.prisma.order.findMany({ where: { id: { in: [orderA.id, orderB.id] } }, select: { riderId: true } });
    expect(orders.filter((o) => o.riderId === r.riderId)).toHaveLength(1);
    expect(orders.filter((o) => o.riderId === null)).toHaveLength(1);

    await app.prisma.rider.update({
      where: { id: r.riderId },
      data: { isOnline: false, committedFloat: 0, currentOrderId: null, isAvailable: true, floatLimit: 1_000_000 },
    });
  });
});

describe('candidate selection at scale [SWIFT-142]', () => {
  it('with >50 movers in range, the pool is the NEAREST 50 — not an arbitrary 50', async () => {
    // Isolate the pool: take every other test's residual riders offline first.
    await app.prisma.rider.updateMany({ data: { isOnline: false } });

    const nearIds: string[] = [];
    const farIds: string[] = [];
    const localUserIds: string[] = [];
    const phoneBase = 592_800_000_000 + Math.floor(Math.random() * 90_000_000);
    let n = 0;
    const mk = async (lat: number, lng: number, bucket: string[]) => {
      n += 1;
      const u = await app.prisma.user.create({
        data: { phone: `+${phoneBase + n}`, firstName: 'Cand', lastName: `${n}`, roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER', isPhoneVerified: true },
      });
      const r = await app.prisma.rider.create({
        data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, isAvailable: true, currentLat: lat, currentLng: lng, floatLimit: 1_000_000, committedFloat: 0 },
      });
      bucket.push(r.id);
      localUserIds.push(u.id);
    };
    // FAR first, then NEAR — so nothing but the ORDER BY puts the near ones in
    // the pool (insertion order alone would keep the far ones). 20 FAR (~4.8 km,
    // still inside the 5 km radius) + 50 NEAR (≤ ~555 m): any 50-of-70 that isn't
    // distance-ordered admits far riders and drops near ones.
    for (let i = 0; i < 20; i += 1) await mk(PICKUP.lat + 0.043, PICKUP.lng + 0.00001 * i, farIds);
    for (let i = 0; i < 50; i += 1) await mk(PICKUP.lat + 0.0001 * (i + 1), PICKUP.lng, nearIds);

    try {
      const candidates = await dispatch.findCandidates(`s142-${nanoid(6)}`, PICKUP, 5, 'RIDER', 0, null);
      const ids = new Set(candidates.map((c) => (c as { riderId: string }).riderId));
      expect(candidates.length).toBeLessThanOrEqual(50);
      // Every NEAR rider made the cut...
      expect(nearIds.every((id) => ids.has(id))).toBe(true);
      // ...and no FAR rider did. (Pre-fix, an arbitrary 50 of the 55 in range
      // would almost surely drop a near rider and admit a far one.)
      expect(farIds.some((id) => ids.has(id))).toBe(false);
    } finally {
      await app.prisma.rider.deleteMany({ where: { id: { in: [...nearIds, ...farIds] } } });
      await app.prisma.user.deleteMany({ where: { id: { in: localUserIds } } });
    }
  });
});
