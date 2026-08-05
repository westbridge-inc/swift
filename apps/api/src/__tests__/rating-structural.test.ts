import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { RatingService } from '../modules/rating/rating.service';
import { RATING_AFFECTS_DISPATCH } from '../modules/rating/rating-math';

// ---------------------------------------------------------------------------
// Movement R — RAT-A (structural integrity: the five rejections + the race),
// RAT-B (every matrix direction files once, wrong-party attempts refused),
// RAT-D sliver (R-Law 4 pinned: ratings CANNOT touch dispatch — the constant
// is false and the dispatch sources reference nothing from the new system).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let ratings: RatingService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_770_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Struct', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  return u;
}

/** Full cast: vendor (owner), rider, driver, customer — one order carrying all. */
async function makeCast() {
  const ownerU = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.upsert({ where: { userId: ownerU.id }, create: { userId: ownerU.id }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Struct Vendor ${seq}`, slug: `struct-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Matrix Way', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const riderU = await makeUser(['MOVER'], 'MOVER');
  const rider = await app.prisma.rider.create({
    data: { userId: riderU.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
  const driverU = await makeUser(['MOVER'], 'MOVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: driverU.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020,
      vehicleColor: 'Silver', licensePlate: `HB ${1000 + seq}`, documentsVerified: true,
      driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
    },
  });
  const customerU = await makeUser(['CUSTOMER'], 'CUSTOMER');
  return { ownerU, vendor, riderU, rider, driverU, driver, customerU };
}

async function makeOrder(opts: {
  customerId: string; vendorId: string; riderId?: string; driverId?: string;
  status?: string; deliveredHoursAgo?: number; orderType?: string;
}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `STR-${nanoid(10)}`, orderType: (opts.orderType ?? 'FOOD_DELIVERY') as never,
      customerId: opts.customerId, vendorId: opts.vendorId,
      riderId: opts.riderId, driverId: opts.driverId,
      status: (opts.status ?? 'DELIVERED') as never,
      deliveryAddress: 'str', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 900, subtotalMarkup: 0, subtotalCustomer: 900,
      deliveryFee: 0, totalAmount: 900, paymentMethod: 'CASH',
      deliveredAt: new Date(Date.now() - (opts.deliveredHoursAgo ?? 1) * 3600_000),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  ratings = new RatingService(app.prisma);
}, 30_000);

afterAll(async () => {
  await app.prisma.rating.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: [...createdVendorIds, ...createdUserIds] } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('RAT-A — structural integrity', () => {
  it('rejects non-party, non-terminal, duplicate, out-of-window, self and cross-subject attempts; race yields one row', async () => {
    const c = await makeCast();
    const order = await makeOrder({ customerId: c.customerU.id, vendorId: c.vendor.id, riderId: c.rider.id });

    // Non-party: a stranger participated in nothing.
    const stranger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await expect(
      ratings.rate({ orderId: order.id, raterId: stranger.id, vendorId: c.vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 }),
    ).rejects.toMatchObject({ code: 'NOT_A_PARTICIPANT' });

    // Non-terminal: still cooking.
    const cooking = await makeOrder({ customerId: c.customerU.id, vendorId: c.vendor.id, status: 'PREPARING' });
    await expect(
      ratings.rate({ orderId: cooking.id, raterId: c.customerU.id, vendorId: c.vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 }),
    ).rejects.toMatchObject({ code: 'ORDER_NOT_COMPLETE' });

    // Out-of-window: delivered 8 days ago (window is 7).
    const stale = await makeOrder({ customerId: c.customerU.id, vendorId: c.vendor.id, deliveredHoursAgo: 8 * 24 });
    await expect(
      ratings.rate({ orderId: stale.id, raterId: c.customerU.id, vendorId: c.vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 }),
    ).rejects.toMatchObject({ code: 'RATING_WINDOW_CLOSED' });

    // Self-rating: the vendor owner is a participant — but CUSTOMER_TO_VENDOR
    // is not their direction (the party-to-type matrix refuses).
    await expect(
      ratings.rate({ orderId: order.id, raterId: c.ownerU.id, vendorId: c.vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 }),
    ).rejects.toMatchObject({ code: 'WRONG_PARTY' });

    // Cross-subject: rating a vendor that was never on this order.
    const otherCast = await makeCast();
    await expect(
      ratings.rate({ orderId: order.id, raterId: c.customerU.id, vendorId: otherCast.vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 }),
    ).rejects.toMatchObject({ code: 'WRONG_SUBJECT' });

    // The race: two simultaneous submissions — exactly one row survives.
    const attempt = () =>
      ratings.rate({ orderId: order.id, raterId: c.customerU.id, vendorId: c.vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const rows = await app.prisma.rating.count({
      where: { orderId: order.id, raterId: c.customerU.id, type: 'CUSTOMER_TO_VENDOR' },
    });
    expect(rows).toBe(1);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    // Duplicate (sequential): refused cleanly.
    await expect(attempt()).rejects.toMatchObject({ code: 'ALREADY_RATED' });
  });
});

describe('RAT-B — every matrix direction files once', () => {
  it('all seven directions succeed for the right party and refuse the wrong one', async () => {
    const c = await makeCast();
    const delivery = await makeOrder({ customerId: c.customerU.id, vendorId: c.vendor.id, riderId: c.rider.id });
    const taxi = await makeOrder({ customerId: c.customerU.id, vendorId: c.vendor.id, driverId: c.driver.id, orderType: 'TAXI' });

    // Customer-outbound.
    await ratings.rate({ orderId: delivery.id, raterId: c.customerU.id, vendorId: c.vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 });
    await ratings.rate({ orderId: delivery.id, raterId: c.customerU.id, rateeId: c.riderU.id, type: 'CUSTOMER_TO_RIDER', score: 5 });
    await ratings.rate({ orderId: taxi.id, raterId: c.customerU.id, rateeId: c.driverU.id, type: 'CUSTOMER_TO_DRIVER', score: 5 });
    await ratings.rate({ orderId: delivery.id, raterId: c.customerU.id, rateeId: c.ownerU.id, type: 'CUSTOMER_TO_PROVIDER', score: 5 });
    // Counterparty-inbound.
    await ratings.rate({ orderId: delivery.id, raterId: c.riderU.id, rateeId: c.customerU.id, type: 'RIDER_TO_CUSTOMER', score: 5 });
    await ratings.rate({ orderId: taxi.id, raterId: c.driverU.id, rateeId: c.customerU.id, type: 'DRIVER_TO_CUSTOMER', score: 5 });
    await ratings.rate({ orderId: delivery.id, raterId: c.ownerU.id, rateeId: c.customerU.id, type: 'PROVIDER_TO_CUSTOMER', score: 5 });

    expect(await app.prisma.rating.count({ where: { orderId: { in: [delivery.id, taxi.id] } } })).toBe(7);

    // Wrong party per direction: the rider cannot file the customer's rating,
    // the customer cannot file the rider's.
    await expect(
      ratings.rate({ orderId: delivery.id, raterId: c.riderU.id, vendorId: c.vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 1 }),
    ).rejects.toMatchObject({ code: 'WRONG_PARTY' });
    await expect(
      ratings.rate({ orderId: taxi.id, raterId: c.customerU.id, rateeId: c.customerU.id, type: 'DRIVER_TO_CUSTOMER', score: 1 }),
    ).rejects.toMatchObject({ code: 'WRONG_PARTY' });
  });
});

describe('RAT-D — R-Law 4 pinned: ratings never touch dispatch', () => {
  it('the constant is false and dispatch sources reference nothing from the new rating system', () => {
    expect(RATING_AFFECTS_DISPATCH).toBe(false);
    for (const file of ['dispatch.service.ts', 'scoring.ts']) {
      const src = readFileSync(join(__dirname, '../modules/dispatch', file), 'utf8');
      // The new system's names must be absent — ActorRatingStat, displayRating,
      // standing bands. (Legacy raw-mean averageRating predates Movement R and
      // is documented divergence; it is NOT the new system.)
      expect(src).not.toMatch(/ActorRatingStat|displayRating|standingBand|AT_RISK/);
    }
  });
});
