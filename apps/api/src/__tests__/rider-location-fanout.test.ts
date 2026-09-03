import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [B3] "All customers' maps move, each with its own ETA."
//
// Since #899 a rider may carry two orders. One location ping used to publish
// to `order:${currentOrderId}` — the primary's room only — so the second
// customer's map froze the moment their rider stacked. BUILD_NOW Band B:
// "B3 — realtime fan-out — nothing ships without this."
//
// This drives the real route with a real rider holding two live legs and
// spies on the socket server: both rooms must receive the sample, the second
// with a chained ETA labelled `after_current`, and a leg that completes
// between the read and the publish must receive nothing.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200650';
const PICKUP = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let vendorId: string;
let customerId: string;

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Fan', lastName: `Out${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function makeRider() {
  const user = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'fanout', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      floatLimit: 1_000_000, isOnline: true, isAvailable: true,
      locationSessionId: session.id,
      currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(),
    },
  });
  return { userId: user.id, riderId: rider.id, token };
}

async function makeLeg(riderId: string, status: 'RIDER_EN_ROUTE_PICKUP' | 'EN_ROUTE_DELIVERY', drop: { lat: number; lng: number }, acceptedAt: Date) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `B3-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, riderId, status, acceptedAt,
      fulfillment: 'DELIVERY',
      pickupAddress: 'Vendor HQ', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'Customer place', deliveryLat: drop.lat, deliveryLng: drop.lng,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

type Emit = { room: string; event: string; payload: any };
function spyEmits(): { emits: Emit[]; restore: () => void } {
  const emits: Emit[] = [];
  const ioTo = vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
    emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); return true; },
  })) as never);
  return { emits, restore: () => ioTo.mockRestore() };
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

  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.order.updateMany({ where: { riderId: { in: riders.map((r) => r.id) } }, data: { riderId: null } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  customerId = customer.id;
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Fanout Kitchen', slug: `fanout-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}99`, addressLine1: '1 Main', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: PICKUP.lat, longitude: PICKUP.lng, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, acceptingOrders: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  if (createdOrderIds.length) await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (createdUserIds.length) {
    await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

async function ping(token: string, riderId: string) {
  // Clear the DB-write throttle so this ping takes the refresh branch and
  // computes ETAs rather than reading an empty cache.
  await app.redis.del(`rider:location_db_ts:${riderId}`);
  return app.inject({ method: 'PUT', url: '/api/v1/rider/location', payload: { latitude: PICKUP.lat, longitude: PICKUP.lng }, headers: { authorization: `Bearer ${token}` } });
}

describe('one ping, every customer', () => {
  it('a rider with two live legs publishes to BOTH rooms, the second chained and labelled', async () => {
    const r = await makeRider();
    const first = await makeLeg(r.riderId, 'EN_ROUTE_DELIVERY', { lat: 7.1, lng: -58.4 }, new Date(Date.now() - 60_000));
    const second = await makeLeg(r.riderId, 'RIDER_EN_ROUTE_PICKUP', { lat: PICKUP.lat + 0.001, lng: PICKUP.lng + 0.001 }, new Date());
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentOrderId: first.id } });

    const spy = spyEmits();
    let res: Awaited<ReturnType<typeof app.inject>>;
    try { res = await ping(r.token, r.riderId); } finally { spy.restore(); }
    expect(res.statusCode).toBe(200);

    const toFirst = spy.emits.find((e) => e.room === `order:${first.id}` && e.event === 'rider:location');
    const toSecond = spy.emits.find((e) => e.room === `order:${second.id}` && e.event === 'rider:location');
    expect(toFirst, 'the primary customer still gets the sample').toBeTruthy();
    expect(toSecond, 'THE FIX: the second customer gets it too').toBeTruthy();
    expect(toFirst!.payload.etaBasis).toBe('direct');
    expect(toSecond!.payload.etaBasis).toBe('after_current');
    // The second drop is a few hundred metres from the rider; a straight-line
    // ETA would be ~1 min. Chained through the first delivery it is far more.
    expect(toSecond!.payload.etaMinutes).toBeGreaterThan(toFirst!.payload.etaMinutes);
  });

  it('[MOB-024] each room is told WHICH order the fix is for — with two legs live, that is the only thing telling them apart', async () => {
    const r = await makeRider();
    const first = await makeLeg(r.riderId, 'EN_ROUTE_DELIVERY', { lat: 7.1, lng: -58.4 }, new Date(Date.now() - 60_000));
    const second = await makeLeg(r.riderId, 'RIDER_EN_ROUTE_PICKUP', { lat: PICKUP.lat + 0.001, lng: PICKUP.lng + 0.001 }, new Date());
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentOrderId: first.id } });

    const spy = spyEmits();
    try { await ping(r.token, r.riderId); } finally { spy.restore(); }

    const toFirst = spy.emits.find((e) => e.room === `order:${first.id}` && e.event === 'rider:location');
    const toSecond = spy.emits.find((e) => e.room === `order:${second.id}` && e.event === 'rider:location');
    // The customer's screen has no other way to know a fix is theirs: it used
    // to accept any rider:location it heard, so an event from a room it had
    // not left moved the courier marker on someone else's delivery.
    expect(toFirst!.payload.orderId, 'the first room is told its own order').toBe(first.id);
    expect(toSecond!.payload.orderId, 'the second room is told its own order').toBe(second.id);
    expect(toFirst!.payload.orderId).not.toBe(toSecond!.payload.orderId);
  });

  it('a single leg behaves exactly as before: one room, direct ETA', async () => {
    const r = await makeRider();
    const only = await makeLeg(r.riderId, 'EN_ROUTE_DELIVERY', { lat: PICKUP.lat + 0.01, lng: PICKUP.lng + 0.01 }, new Date());
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentOrderId: only.id } });

    const spy = spyEmits();
    try { await ping(r.token, r.riderId); } finally { spy.restore(); }
    const samples = spy.emits.filter((e) => e.event === 'rider:location');
    expect(samples).toHaveLength(1);
    expect(samples[0]!.room).toBe(`order:${only.id}`);
    expect(samples[0]!.payload.etaBasis).toBe('direct');
  });

  it('a leg that completes BETWEEN the read and the publish receives nothing', async () => {
    // The legs are read before the ETA work; the emit happens after. A leg
    // can complete in between. The under-lock re-read is what stops a
    // just-delivered customer's map twitching with a sample from a rider who
    // has already left. This test parks the ping inside the ETA cache write,
    // completes the second leg, and lets it continue.
    const r = await makeRider();
    const live = await makeLeg(r.riderId, 'EN_ROUTE_DELIVERY', { lat: PICKUP.lat + 0.01, lng: PICKUP.lng + 0.01 }, new Date(Date.now() - 60_000));
    const done = await makeLeg(r.riderId, 'EN_ROUTE_DELIVERY', { lat: PICKUP.lat + 0.02, lng: PICKUP.lng + 0.02 }, new Date());
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentOrderId: live.id } });

    let reached!: () => void;
    const atCacheWrite = new Promise<void>((resolve) => { reached = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const originalSet = app.redis.set.bind(app.redis);
    const setSpy = vi.spyOn(app.redis, 'set').mockImplementation((async (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('mover:eta:')) {
        reached();
        await resumed;
      }
      return originalSet(...(args as [string, string]));
    }) as never);

    const spy = spyEmits();
    try {
      const pingPromise = ping(r.token, r.riderId);
      await atCacheWrite;
      await app.prisma.order.update({ where: { id: done.id }, data: { status: 'DELIVERED' } });
      resume();
      const res = await pingPromise;
      expect(res.statusCode).toBe(200);
    } finally {
      resume();
      setSpy.mockRestore();
      spy.restore();
    }
    const rooms = spy.emits.filter((e) => e.event === 'rider:location').map((e) => e.room);
    expect(rooms).toContain(`order:${live.id}`);
    expect(rooms, 'a leg that completed mid-ping must not be published to').not.toContain(`order:${done.id}`);
  });
});
