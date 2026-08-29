import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import {
  riderStackingCapacity,
  riderLiveLegCount,
  reserveRiderLeg,
  capacityPredicateSql,
} from '../modules/dispatch/concurrency-policy';
import { stackVerdict } from '../modules/dispatch/stack-eligibility';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';

// ---------------------------------------------------------------------------
// STK-1 / B5 — riders and delivery stack; taxis never.
//
// The founder's law (2026-08-29): "riders and delivery guys can accept
// multiple orders, only taxis can't." These tests bind that law to the seam:
// capacity comes from AlgoConfig, every gate counts live legs from the orders
// table, the batching rulebook judges every pairing, and the DRIVER pool
// cannot be widened by any configuration.
// ---------------------------------------------------------------------------

const GEO = { lat: 6.8013, lng: -58.1553 }; // Georgetown

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;

async function setCapacity(value: number) {
  const latest = await app.prisma.algoConfig.findFirst({
    where: { tenantId: 'swift-default', key: 'stacking.riderCapacity' },
    orderBy: { version: 'desc' },
  });
  await app.prisma.algoConfig.create({
    data: {
      tenantId: 'swift-default',
      key: 'stacking.riderCapacity',
      value,
      version: (latest?.version ?? 0) + 1,
      updatedBy: 'stacking.test',
    },
  });
  invalidateAlgoConfig();
}

async function makeRider(vehicleType: 'MOTORCYCLE' | 'CAR' | 'BICYCLE' = 'MOTORCYCLE') {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200088${String(seq).padStart(2, '0')}`,
      firstName: 'Stack',
      lastName: `Rider${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[],
      activeRole: 'MOVER' as UserRole,
      countryCode: 'GY',
      isPhoneVerified: true,
      status: 'ACTIVE',
    },
  });
  createdUserIds.push(user.id);
  const session = await app.prisma.session.create({
    data: { userId: user.id, token: nanoid(24), refreshToken: nanoid(24), deviceId: `stk-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3600_000) },
  });
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id,
      riderType: 'DELIVERY',
      vehicleType,
      documentsVerified: true,
      isOnline: true,
      isAvailable: true,
      locationSessionId: session.id,
      currentLat: GEO.lat,
      currentLng: GEO.lng,
      floatLimit: 40_000,
    },
  });
  return { user, rider };
}

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200089${String(seq).padStart(2, '0')}`,
      firstName: 'Cust',
      lastName: `Omer${seq}`,
      roles: ['CUSTOMER'] as UserRole[],
      activeRole: 'CUSTOMER' as UserRole,
      countryCode: 'GY',
      isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

let vendorId: string;

async function makeOrder(opts: { customerId: string; status?: string; riderId?: string | null; dropLat?: number; dropLng?: number; total?: number }) {
  seq += 1;
  return app.prisma.order.create({
    data: {
      orderNumber: `STK-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'DELIVERY',
      customerId: opts.customerId,
      vendorId,
      status: (opts.status ?? 'READY_FOR_PICKUP') as never,
      paymentMethod: 'CASH',
      subtotalBase: 3000,
      subtotalMarkup: 0,
      subtotalCustomer: 3000,
      deliveryFee: 500,
      serviceFee: 0,
      taxAmount: 0,
      tipAmount: 0,
      discount: 0,
      totalAmount: opts.total ?? 3500,
      deliveryAddress: '1 Test St',
      deliveryLat: opts.dropLat ?? GEO.lat + 0.004,
      deliveryLng: opts.dropLng ?? GEO.lng + 0.004,
      ...(opts.riderId !== undefined ? { riderId: opts.riderId } : {}),
      ...(opts.riderId ? { acceptedAt: new Date() } : {}),
    },
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();

  // Decimal columns reject `{ not: null }` in this Prisma version — filter in JS.
  const vendors = await app.prisma.vendor.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, latitude: true, longitude: true },
    take: 10,
  });
  const vendor = vendors.find((v) => v.latitude != null && v.longitude != null);
  if (!vendor) throw new Error('seeded ACTIVE vendor with coords required');
  vendorId = vendor.id;
});

afterAll(async () => {
  await app.prisma.algoConfig.deleteMany({ where: { key: 'stacking.riderCapacity', updatedBy: 'stacking.test' } });
  invalidateAlgoConfig();
  await app.prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'STK-' } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('the capacity resolver', () => {
  it('reads the founder-seeded value and clamps insanity', async () => {
    invalidateAlgoConfig();
    const seeded = await riderStackingCapacity(app.prisma);
    expect(seeded).toBeGreaterThanOrEqual(1);
    expect(seeded).toBeLessThanOrEqual(3);

    await setCapacity(99);
    expect(await riderStackingCapacity(app.prisma)).toBe(3);
    await setCapacity(0);
    expect(await riderStackingCapacity(app.prisma)).toBe(1);
    await setCapacity(2);
    expect(await riderStackingCapacity(app.prisma)).toBe(2);
  });

  it('S7 — the DRIVER pool cannot be widened by configuration: the predicate ignores capacity', () => {
    const sqlAt3 = capacityPredicateSql('DRIVER', 3);
    const sqlAt1 = capacityPredicateSql('DRIVER', 1);
    expect(String(sqlAt3.sql ?? sqlAt3)).toContain('"currentRideId" IS NULL');
    expect(String(sqlAt3.sql ?? sqlAt3)).toEqual(String(sqlAt1.sql ?? sqlAt1));
  });
});

describe('S2/S5/S11 — the guarded reservation', () => {
  it('a rider stacks to capacity, is refused beyond it, and the pointer COALESCEs', async () => {
    await setCapacity(2);
    const { rider } = await makeRider();
    const customer = await makeCustomer();

    const a = await makeOrder({ customerId: customer.id, riderId: rider.id });
    expect(await riderLiveLegCount(app.prisma, rider.id)).toBe(1);
    expect(await reserveRiderLeg(app.prisma, rider.id, a.id, 2)).toBe(true);

    let r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(r.currentOrderId).toBe(a.id);
    expect(r.isAvailable).toBe(true); // room for one more at capacity 2

    const b = await makeOrder({ customerId: customer.id, riderId: rider.id });
    expect(await riderLiveLegCount(app.prisma, rider.id)).toBe(2);
    expect(await reserveRiderLeg(app.prisma, rider.id, b.id, 2)).toBe(true);

    r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(r.currentOrderId).toBe(a.id); // primary pointer untouched by leg 2
    expect(r.isAvailable).toBe(false); // full

    // A third leg is refused BY THE STATEMENT, not by a read-then-check.
    const c = await makeOrder({ customerId: customer.id, riderId: rider.id });
    expect(await reserveRiderLeg(app.prisma, rider.id, c.id, 2)).toBe(false);
    await app.prisma.order.delete({ where: { id: c.id } });

    // S11 — the kill switch: capacity 1 refuses a second leg outright.
    const { rider: solo } = await makeRider();
    const d = await makeOrder({ customerId: customer.id, riderId: solo.id });
    expect(await reserveRiderLeg(app.prisma, solo.id, d.id, 1)).toBe(true);
    const e = await makeOrder({ customerId: customer.id, riderId: solo.id });
    expect(await reserveRiderLeg(app.prisma, solo.id, e.id, 1)).toBe(false);
    await app.prisma.order.delete({ where: { id: e.id } });
  });
});

describe('S4 — the rulebook judges every pairing', () => {
  it('a nearby same-vendor pair is eligible; a cross-town pair is refused with the rule named', async () => {
    await setCapacity(2);
    const { rider } = await makeRider('MOTORCYCLE');
    const customer = await makeCustomer();

    const legA = await makeOrder({ customerId: customer.id, riderId: rider.id });
    await reserveRiderLeg(app.prisma, rider.id, legA.id, 2);

    const near = await makeOrder({ customerId: customer.id, dropLat: GEO.lat + 0.006, dropLng: GEO.lng + 0.006 });
    const vNear = await stackVerdict(app.prisma, rider.id, near.id);
    expect(vNear).toMatchObject({ eligible: true, legs: 1 });

    // ~20 km away: outside any 1.5 km corridor.
    const far = await makeOrder({ customerId: customer.id, dropLat: GEO.lat + 0.2, dropLng: GEO.lng + 0.2 });
    const vFar = await stackVerdict(app.prisma, rider.id, far.id);
    expect(vFar.eligible).toBe(false);
    if (!vFar.eligible) {
      expect(vFar.rule).toBe('R6'); // drop-off corridor
      expect(vFar.detail).toMatch(/vs 1500/);
    }
  });

  it('R4 — summed cash beyond the float cap refuses the stack, naming R4', async () => {
    await setCapacity(2);
    const { rider } = await makeRider('CAR');
    await app.prisma.rider.update({ where: { id: rider.id }, data: { floatLimit: 5000 } });
    const customer = await makeCustomer();

    const legA = await makeOrder({ customerId: customer.id, riderId: rider.id, total: 4000 });
    await reserveRiderLeg(app.prisma, rider.id, legA.id, 2);
    const big = await makeOrder({ customerId: customer.id, total: 3000 });
    const v = await stackVerdict(app.prisma, rider.id, big.id);
    expect(v.eligible).toBe(false);
    if (!v.eligible) expect(v.rule).toBe('R4');
  });

  it('a first leg is never judged — the gate exists only between legs', async () => {
    await setCapacity(2);
    const { rider } = await makeRider();
    const customer = await makeCustomer();
    const solo = await makeOrder({ customerId: customer.id });
    expect(await stackVerdict(app.prisma, rider.id, solo.id)).toEqual({ eligible: true, legs: 0 });
  });
});

describe('S6 — per-leg release: finish one, keep the other', () => {
  it('terminating leg A repoints the primary to leg B, restores availability, and leaves B untouched', async () => {
    await setCapacity(2);
    const { rider } = await makeRider();
    const customer = await makeCustomer();

    const a = await makeOrder({ customerId: customer.id, riderId: rider.id, status: 'PICKED_UP' });
    await reserveRiderLeg(app.prisma, rider.id, a.id, 2);
    const b = await makeOrder({ customerId: customer.id, riderId: rider.id, status: 'PICKED_UP' });
    await reserveRiderLeg(app.prisma, rider.id, b.id, 2);

    const { OrderService } = await import('../modules/order/order.service');
    const { NotificationService } = await import('../modules/notification/notification.service');
    const orderService = new OrderService(app.prisma, app.io ?? ({ to: () => ({ emit: () => {} }) } as never));
    void NotificationService;

    await orderService.transitionOrderAtomically({
      orderId: a.id,
      target: 'DELIVERED',
      allowedFrom: ['PICKED_UP'] as never,
      changedBy: 'stacking.test',
      note: 'S6',
    } as never);

    const r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(r.currentOrderId).toBe(b.id); // re-pointed, not nulled
    expect(r.isAvailable).toBe(true); // room again at capacity 2
    const bRow = await app.prisma.order.findUniqueOrThrow({ where: { id: b.id } });
    expect(bRow.status).toBe('PICKED_UP'); // sibling untouched
    expect(await riderLiveLegCount(app.prisma, rider.id)).toBe(1);
  });
});
