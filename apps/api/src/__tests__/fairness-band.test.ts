import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { DispatchService, offersSentKey, offerOutcomeKey } from '../modules/dispatch/dispatch.service';
import { ALGO_DEFAULTS, invalidateAlgoConfig } from '../modules/algo/algo-config';

// ---------------------------------------------------------------------------
// [ALG-01] The fairness band, against the real candidate finder and Redis.
//
// The build document's proof: three riders at equal ETA, twenty offers →
// offer counts within ±1. Graded here twice — with the band LIVE the counts
// spread; with the band in SHADOW (the shipped default) the pure ranking
// stands, the same rider is offered every time, and every reorder the band
// WOULD have made is a shadow row. The offer log the band reads is written
// by the dispatch loop itself, with declines and expiries logged apart.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200668';
const DAY = 24 * 60 * 60 * 1000;
const PICKUP = { lat: 6.8, lng: -58.15 };

let app: FastifyInstance;
let dispatch: DispatchService;
let customerId: string;
let vendorId: string;
const userIds: string[] = [];
const riderIds: string[] = [];
let seq = 0;

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  for (const r of riders) await app.redis.del(offersSentKey(r.id), offerOutcomeKey(r.id, 'declines'), offerOutcomeKey(r.id, 'expiries'));
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-01', subjectId: { in: orders.map((o) => o.id) } } });
  for (const o of orders) await app.redis.del(`dispatch:declined:${o.id}`, `dispatch:offer:${o.id}`);
  await app.prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeRider() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Fair', lastName: `Rider${seq}`,
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole], activeRole: 'RIDER' as UserRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'fair', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000,
      isOnline: true, isAvailable: true, locationSessionId: session.id,
      currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(), averageRating: 5, acceptanceRate: 100, currentOrderId: null,
    },
  });
  riderIds.push(rider.id);
  return rider.id;
}

async function makeOrder() {
  return app.prisma.order.create({
    data: {
      orderNumber: `FAIR-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'ACCEPTED', fulfillment: 'DELIVERY',
      pickupAddress: 'Store', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng, deliveryAddress: 'Home', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
    },
  });
}

async function setFairness(enabled: boolean) {
  const latest = await app.prisma.algoConfig.findFirst({ where: { tenantId: 'swift-default', key: 'fairness.enabled' }, orderBy: { version: 'desc' } });
  await app.prisma.algoConfig.create({ data: { tenantId: 'swift-default', key: 'fairness.enabled', value: enabled, version: (latest?.version ?? 0) + 1, updatedBy: 'fairness-band.test' } });
  invalidateAlgoConfig();
}

/** Twenty rounds: the candidate finder ranks, the top rider "receives" the offer the way the dispatch loop logs it. */
async function twentyOffers(): Promise<Map<string, number>> {
  const counts = new Map<string, number>(riderIds.map((id) => [id, 0]));
  for (let i = 0; i < 20; i += 1) {
    const order = await makeOrder();
    const ranked = await dispatch.findCandidates(order.id, PICKUP, 5, 'RIDER');
    const top = ranked[0]!;
    counts.set(top.riderId, (counts.get(top.riderId) ?? 0) + 1);
    await app.redis.zadd(offersSentKey(top.riderId), Date.now() + i, `${order.id}:t${i}`);
  }
  return counts;
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
  await app.ready();
  await purge();
  dispatch = new DispatchService(app.prisma, app.redis, app.io, new HaversineMapsProvider(), async () => {});

  const customer = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}90`, firstName: 'Fair', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  customerId = customer.id;
  userIds.push(customer.id);
  const ownerUser = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}91`, firstName: 'Fair', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  userIds.push(ownerUser.id);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  vendorId = (await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Fair Diner', slug: `fair-diner-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}92`,
      addressLine1: '1 Fair St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: PICKUP.lat, longitude: PICKUP.lng,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  })).id;
  for (let i = 0; i < 3; i += 1) await makeRider();
});

afterAll(async () => {
  await app.prisma.algoConfig.deleteMany({ where: { key: 'fairness.enabled', updatedBy: 'fairness-band.test' } });
  invalidateAlgoConfig();
  await purge();
  await app.close();
});

describe('three riders at equal ETA, twenty offers', () => {
  it('ships in SHADOW: the pure ranking stands, one rider takes every offer, and each reorder the band would have made is a shadow row', async () => {
    expect(ALGO_DEFAULTS['fairness.enabled']).toBe(false);
    const counts = await twentyOffers();
    const sorted = [...counts.values()].sort((a, b) => b - a);
    expect(sorted[0]).toBe(20);
    const rows = await app.prisma.algoDecision.findMany({ where: { algo: 'ALG-01', outcome: 'WOULD_REORDER', shadow: true } });
    // The first offer finds nobody with an offer yet — nothing to reorder; from the second on the band would have moved it.
    expect(rows.length).toBeGreaterThanOrEqual(18);
    const inputs = rows[0]!.inputs as Record<string, unknown>;
    expect(inputs['band']).toBe(0.05);
    expect((inputs['groups'] as Array<{ size: number }>)[0]?.size).toBe(3);
    expect(rows[0]!.sentence).toMatch(/^Shadow: the fairness band moved the first offer to the rider with fewer offers this hour \(1 tied group\)\.$/);
  });

  it('LIVE: the offers spread within ±1, the reorders are live rows, and the log is what the band read', async () => {
    for (const id of riderIds) await app.redis.del(offersSentKey(id));
    await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-01' } });
    await setFairness(true);
    try {
      const counts = await twentyOffers();
      const values = [...counts.values()];
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      expect(values.reduce((a, b) => a + b, 0)).toBe(20);
      const live = await app.prisma.algoDecision.count({ where: { algo: 'ALG-01', outcome: 'REORDERED', shadow: false } });
      expect(live).toBeGreaterThanOrEqual(10);
      for (const id of riderIds) {
        expect(await app.redis.zcard(offersSentKey(id))).toBe(counts.get(id));
      }
    } finally {
      await setFairness(false);
    }
  });

  it('a pure ranking with nothing tied is never touched, and reports nothing', async () => {
    await app.prisma.algoDecision.deleteMany({ where: { algo: 'ALG-01' } });
    const lone = await makeRider();
    await app.prisma.rider.updateMany({ where: { id: { in: riderIds.filter((id) => id !== lone) } }, data: { isAvailable: false } });
    const order = await makeOrder();
    const ranked = await dispatch.findCandidates(order.id, PICKUP, 5, 'RIDER');
    expect(ranked.map((c) => c.riderId)).toEqual([lone]);
    expect(await app.prisma.algoDecision.count({ where: { algo: 'ALG-01' } })).toBe(0);
    await app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { isAvailable: true } });
  });
});

describe('the dispatch loop writes the log the band reads — offers, declines and expiries kept apart', () => {
  const src = readFileSync(path.join(__dirname, '..', 'modules', 'dispatch', 'dispatch.service.ts'), 'utf8');

  it('every emitted offer is logged to the rider before the socket emit', () => {
    const emit = src.indexOf("this.io.to(`user:${top.userId}`).emit('dispatch:offer', {");
    const logged = src.indexOf('await this.redis.zadd(offersSentKey(top.riderId), Date.now(), `${orderId}:${attemptId}`)');
    expect(logged).toBeGreaterThan(-1);
    expect(logged).toBeLessThan(emit);
  });

  it('a decline and an expiry are two different logs, and neither is a gate anywhere', () => {
    expect(src).toContain("offerOutcomeKey(mover.id, 'declines')");
    expect(src).toContain("offerOutcomeKey(moverId, 'expiries')");
    // The band reads offers received, never declines or expiries.
    const band = src.slice(src.indexOf('private async fairnessBand'), src.indexOf("log().warn({ err, orderId }, 'dispatch: fairness band skipped"));
    expect(band).toContain('offersSentKey(c.riderId)');
    expect(band).not.toContain('offerOutcomeKey');
  });

  it('the band sits after the pure ranking in findCandidates and is the only thing between it and the caller', () => {
    expect(src).toContain('const ranked = rankCandidates(candidates, profile);\n    return this.fairnessBand(orderId, ranked, profile);');
  });
});
