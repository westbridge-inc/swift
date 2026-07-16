import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { RatingService } from '../modules/rating/rating.service';

// ---------------------------------------------------------------------------
// Double-blind ratings (marketplace §1): the written rating hides from the
// ratee until BOTH sides rated — or the sweep window expires. Aggregates
// update immediately; retaliation gets nothing to aim at.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let svc: RatingService;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
const orderIds: string[] = [];
let customerId: string;
let riderUserId: string;
let riderId: string;

async function makeUser(first: string) {
  const u = await app.prisma.user.create({
    data: {
      phone: `+59261${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: first, lastName: `DB${marker}`,
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  userIds.push(u.id);
  return u;
}

async function makeDeliveredOrder() {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `DBL-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId,
      riderId,
      status: 'DELIVERED' as never,
      fulfillment: 'DELIVERY' as never,
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
      paymentMethod: 'CASH' as never,
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();

  const customer = await makeUser('Cust');
  customerId = customer.id;
  const riderUser = await makeUser('Rider');
  riderUserId = riderUser.id;
  const rider = await app.prisma.rider.create({
    data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' },
  });
  riderId = rider.id;

  svc = new RatingService(app.prisma);
});

afterAll(async () => {
  if (orderIds.length > 0) await app.prisma.rating.deleteMany({ where: { orderId: { in: orderIds } } });
  if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { id: riderId } });
  if (userIds.length > 0) {
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('double-blind release', () => {
  it('one side rated → hidden; both sides rated → both released', async () => {
    const order = await makeDeliveredOrder();

    const first = await svc.rate({
      orderId: order.id, raterId: customerId, rateeId: riderUserId,
      type: 'CUSTOMER_TO_RIDER' as never, score: 5, comment: 'quick and kind',
    });
    let row = await app.prisma.rating.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.visibleAt).toBeNull(); // blind while the counterpart hasn't rated

    const second = await svc.rate({
      orderId: order.id, raterId: riderUserId, rateeId: customerId,
      type: 'RIDER_TO_CUSTOMER' as never, score: 4, comment: 'paid exact, no fuss',
    });

    row = await app.prisma.rating.findUniqueOrThrow({ where: { id: first.id } });
    const row2 = await app.prisma.rating.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.visibleAt).not.toBeNull(); // both released together
    expect(row2.visibleAt).not.toBeNull();
  });

  it('the sweep releases a lone rating after the window — never before', async () => {
    const order = await makeDeliveredOrder();
    const lone = await svc.rate({
      orderId: order.id, raterId: customerId, rateeId: riderUserId,
      type: 'CUSTOMER_TO_RIDER' as never, score: 2, comment: 'left it at the wrong gate',
    });

    // Inside the window: nothing releases.
    expect(await svc.releaseDoubleBlind(72)).toBe(0);
    let row = await app.prisma.rating.findUniqueOrThrow({ where: { id: lone.id } });
    expect(row.visibleAt).toBeNull();

    // Age it past the window: the sweep releases it.
    await app.prisma.$executeRaw`UPDATE ratings SET "createdAt" = NOW() - INTERVAL '73 hours' WHERE id = ${lone.id}`;
    expect(await svc.releaseDoubleBlind(72)).toBeGreaterThanOrEqual(1);
    row = await app.prisma.rating.findUniqueOrThrow({ where: { id: lone.id } });
    expect(row.visibleAt).not.toBeNull();
  });

  it('public vendor reviews list only released ratings', async () => {
    // A vendor-targeted blind rating must not appear on the storefront list.
    const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true, owner: { select: { userId: true } } } });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `DBLV-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY' as never,
        customerId,
        vendorId: vendor.id,
        status: 'DELIVERED' as never,
        fulfillment: 'DELIVERY' as never,
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
        paymentMethod: 'CASH' as never,
      },
    });
    orderIds.push(order.id);

    const blind = await svc.rate({
      orderId: order.id, raterId: customerId, vendorId: vendor.id,
      type: 'CUSTOMER_TO_VENDOR' as never, score: 1, comment: `terrible ${marker}`,
    });

    const before = await svc.getVendorReviews(vendor.id, 100, 0);
    expect(before.reviews.some((r: { id: string }) => r.id === blind.id)).toBe(false);

    await app.prisma.rating.update({ where: { id: blind.id }, data: { visibleAt: new Date() } });
    const after = await svc.getVendorReviews(vendor.id, 100, 0);
    expect(after.reviews.some((r: { id: string }) => r.id === blind.id)).toBe(true);
  });
});
