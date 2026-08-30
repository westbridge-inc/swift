import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { cleanTrace } from '../modules/dispatch/trace-cleaner';
import { matchOrderRoute } from '../modules/dispatch/route-match';
import { pushTrace, traceKey } from '../modules/dispatch/gps-plausibility';
import { HaversineMapsProvider, OsrmMapsProvider, traceLengthKm } from '../providers/maps/maps-provider';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [ALG-16] Server-side trace cleaning and map matching — once, at completion,
// for money. A teleport never becomes distance; a shaky receiver is smoothed,
// not invented; a provider that cannot match says so; and the result is
// frozen on the order beside the planned distance, never in its place.
// ---------------------------------------------------------------------------

const GT = { lat: 6.8013, lng: -58.1551 };
const T0 = 1_800_000_000_000;
// A believable ride north along a street: ~11 m per second-ish steps at 8 s → ~40 km/h.
const ride = (n: number, jitter = 0) => Array.from({ length: n }, (_, i) => ({
  lat: GT.lat + i * 0.0008, lng: GT.lng + (i % 2 ? jitter : -jitter), at: T0 + i * 8_000,
}));

describe('the trace cleaner', () => {
  it('orders by time and drops exact duplicates', () => {
    const c = cleanTrace([ride(5)[3]!, ride(5)[0]!, ride(5)[0]!, ride(5)[1]!, ride(5)[2]!, ride(5)[4]!]);
    expect(c.points.map((p) => p.at)).toEqual([T0, T0 + 8_000, T0 + 16_000, T0 + 24_000, T0 + 32_000]);
    expect(c.dropped).toBe(1);
  });

  it('a teleport in the middle is dropped — it never becomes kilometres', () => {
    const fixes = ride(6);
    fixes[3] = { lat: GT.lat + 0.2, lng: GT.lng + 0.2, at: fixes[3]!.at }; // ~30 km away in 8 s
    const c = cleanTrace(fixes);
    expect(c.dropped).toBe(1);
    expect(c.points).toHaveLength(5);
    expect(c.cleanKm).toBeLessThan(0.6);
    expect(c.rawKm).toBeGreaterThan(50);
  });

  it('smooths receiver shake with a median, keeping the ends where they were', () => {
    const shaky = ride(9, 0.0003);
    const c = cleanTrace(shaky);
    expect(c.points[0]).toMatchObject({ lat: shaky[0]!.lat, lng: shaky[0]!.lng });
    expect(c.points[8]).toMatchObject({ lat: shaky[8]!.lat });
    expect(c.cleanKm).toBeLessThan(c.rawKm);
    expect(c.dropped).toBe(0);
  });

  it('a trace too short to clean is returned as it came', () => {
    const two = ride(2);
    expect(cleanTrace(two).points).toEqual(two.map((f) => ({ lat: f.lat, lng: f.lng, at: f.at })));
    expect(cleanTrace([]).points).toEqual([]);
  });
});

describe('the maps port matches or says it cannot', () => {
  it('haversine has no road graph: the trace length, unmatched, and says so', async () => {
    const r = await new HaversineMapsProvider().matchTrace(ride(5));
    expect(r.matched).toBe(false);
    expect(r.polyline).toBeNull();
    expect(r.source).toBe('haversine');
    expect(r.km).toBeCloseTo(traceLengthKm(ride(5)), 6);
  });

  it('an OSRM that cannot be reached falls back, unmatched — never a guess', async () => {
    const r = await new OsrmMapsProvider('http://127.0.0.1:9').matchTrace(ride(5));
    expect(r).toMatchObject({ matched: false, source: 'haversine', polyline: null });
  });
});

describe('matchOrderRoute — once, at completion, frozen on the order', () => {
  const PHONE_PREFIX = '+59200662';
  let app: FastifyInstance;
  const userIds: string[] = [];
  let vendorId: string;
  let customerId: string;

  async function purge() {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    for (const r of riders) await app.redis.del(traceKey('RIDER', r.id));
    await app.prisma.order.deleteMany({ where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riders.map((r) => r.id) } }] } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
    process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.ready();
    await purge();
    const owner = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}90`, firstName: 'Match', lastName: 'Owner', roles: ['VENDOR_OWNER' as UserRole], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(owner.id);
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    vendorId = (await app.prisma.vendor.create({ data: { ownerId: vo.id, name: 'Match Kitchen', slug: `match-kitchen-${nanoid(5)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}91`, addressLine1: '1 Match St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: GT.lat, longitude: GT.lng, status: 'ACTIVE' } })).id;
    const customer = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}92`, firstName: 'Match', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } } });
    userIds.push(customer.id);
    customerId = customer.id;
  });

  afterAll(async () => {
    await purge();
    await app.close();
  });

  async function riderWithOrder(n: number, status: 'DELIVERED' | 'PICKED_UP', deliveredAt: Date | null) {
    const user = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}${String(n).padStart(2, '0')}`, firstName: 'Match', lastName: `Rider${n}`, roles: ['RIDER'], activeRole: 'RIDER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    userIds.push(user.id);
    const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', locationSessionId: syntheticLocationOwner('route-match') } });
    const acceptedAt = new Date(Date.now() - 20 * 60_000);
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `RM-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, riderId: rider.id, status, fulfillment: 'DELIVERY', acceptedAt, deliveredAt,
        pickupAddress: 'Store', pickupLat: GT.lat, pickupLng: GT.lng, deliveryAddress: 'Home', deliveryLat: GT.lat + 0.02, deliveryLng: GT.lng,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH', billableKm: 2.3, billableKmSource: 'haversine',
      },
    });
    return { rider, order, acceptedAt };
  }

  it('cleans the rider trace between acceptance and completion, matches it, and freezes the result — once', async () => {
    const { rider, order, acceptedAt } = await riderWithOrder(1, 'DELIVERED', new Date(Date.now() - 5 * 60_000));
    const start = acceptedAt.getTime() + 60_000;
    for (let i = 0; i < 20; i++) {
      const fix = { lat: GT.lat + i * 0.001, lng: GT.lng, at: new Date(start + i * 8_000) };
      await pushTrace(app.redis, traceKey('RIDER', rider.id), fix);
    }
    // a teleport in the middle, which the cleaner must drop
    await pushTrace(app.redis, traceKey('RIDER', rider.id), { lat: GT.lat + 0.3, lng: GT.lng + 0.3, at: new Date(start + 10 * 8_000 + 4_000) });

    const res = await matchOrderRoute({ prisma: app.prisma, redis: app.redis }, order.id);
    expect(['matched', 'unmatched']).toContain(res.outcome);
    expect(res.dropped).toBe(1);
    expect(res.points).toBe(20);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { routeMatchedKm: true, routeMatchSource: true, routeMatchedAt: true, billableKm: true } });
    expect(row.routeMatchedAt).not.toBeNull();
    expect(['osrm', 'haversine:unmatched']).toContain(row.routeMatchSource);
    const km = Number(row.routeMatchedKm);
    // A synthetic straight line is not a road: a real OSRM (the local
    // container) matches the part of it that lies on one and may return less
    // than the trace; without OSRM the unmatched trace length (~2.1 km) is
    // recorded as such. Either way the 30 km teleport is not in it.
    expect(km).toBeGreaterThan(0.3);
    expect(km).toBeLessThan(6);
    if (row.routeMatchSource === 'haversine:unmatched') expect(km).toBeGreaterThan(1.5);
    // The planned distance the customer was priced on is untouched.
    expect(Number(row.billableKm)).toBe(2.3);
    // Idempotent: a second run leaves it alone.
    expect((await matchOrderRoute({ prisma: app.prisma, redis: app.redis }, order.id)).outcome).toBe('already');
  });

  it('no trace is no match — recorded as absence, never a straight line', async () => {
    const { order } = await riderWithOrder(2, 'DELIVERED', new Date(Date.now() - 60_000));
    expect((await matchOrderRoute({ prisma: app.prisma, redis: app.redis }, order.id)).outcome).toBe('no-trace');
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { routeMatchedAt: true, routeMatchedKm: true } });
    expect(row.routeMatchedAt).toBeNull();
    expect(row.routeMatchedKm).toBeNull();
  });

  it('a live order is not matched — completion is the moment', async () => {
    const { order } = await riderWithOrder(3, 'PICKED_UP', null);
    expect((await matchOrderRoute({ prisma: app.prisma, redis: app.redis }, order.id)).outcome).toBe('not-complete');
    expect((await matchOrderRoute({ prisma: app.prisma, redis: app.redis }, 'no-such-order')).outcome).toBe('no-order');
  });
});
