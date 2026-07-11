import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// GET /vendor/analytics/ops — operational quality from real order timestamps.
// The hard rules: acceptance judged only on DECIDED orders (customer
// cancellations pre-acceptance don't count against the store), averages null
// (not zero) when there is no data, negative timestamp pairs discarded.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

let app: FastifyInstance;
let ownerToken: string;
let vendorId: string;
const createdUserIds: string[] = [];

async function makeUser(roles: ('VENDOR_OWNER' | 'CUSTOMER')[], activeRole: 'VENDOR_OWNER' | 'CUSTOMER') {
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200211${String(createdUserIds.length).padStart(2, '0')}`,
      firstName: 'Ops',
      lastName: `User${createdUserIds.length}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ops-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

function order(customerId: string, data: Record<string, unknown>) {
  return app.prisma.order.create({
    data: {
      orderNumber: `OPS-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      deliveryAddress: 'ops', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
      ...data,
    } as never,
  });
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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  ownerToken = owner.token;
  const ownerRow = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id,
      name: 'Ops Test Kitchen',
      slug: `ops-test-${nanoid(6)}`,
      vendorType: 'RESTAURANT',
      phone: '+5920021199',
      addressLine1: '1 Ops Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, acceptingOrders: true,
    },
  });
  vendorId = vendor.id;

  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  // Firmly 3 days back so the days=1 "empty window" test can never catch
  // these fixtures regardless of the wall-clock hour the suite runs at.
  const base = Date.now() - 3 * DAY;

  // A: accepted in 4 min, prep 20 min (quoted 15), delivered
  await order(customer.userId, {
    status: 'DELIVERED',
    placedAt: new Date(base),
    acceptedAt: new Date(base + 4 * MIN),
    readyAt: new Date(base + 24 * MIN),
    estimatedPrepTime: 15,
  });
  // B: accepted in 2 min, prep 10 min (quoted 20), delivered
  await order(customer.userId, {
    status: 'DELIVERED',
    placedAt: new Date(base + 60 * MIN),
    acceptedAt: new Date(base + 62 * MIN),
    readyAt: new Date(base + 72 * MIN),
    estimatedPrepTime: 20,
  });
  // C: the store killed it before accepting
  await order(customer.userId, {
    status: 'CANCELLED',
    placedAt: new Date(base + 120 * MIN),
    cancelledBy: 'VENDOR',
    cancellationReason: 'Out of stock',
  });
  // D: customer cancelled before the store decided — not held against the store
  await order(customer.userId, {
    status: 'CANCELLED',
    placedAt: new Date(base + 180 * MIN),
    cancelledBy: 'CUSTOMER',
    cancellationReason: 'Changed my mind',
  });
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('GET /vendor/analytics/ops', () => {
  it('computes acceptance, cancellation and timing from real timestamps', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor/analytics/ops?days=7',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;

    expect(d.placedOrders).toBe(4);
    // Decided = 2 accepted + 1 vendor-cancelled; 2/3 accepted
    expect(d.acceptanceRate).toBe(67);
    // 2 of 4 placed orders died
    expect(d.cancellationRate).toBe(50);
    expect(d.vendorCancellations).toBe(1);
    expect(d.avgAcceptMinutes).toBe(3);
    expect(d.avgPrepMinutes).toBe(15);
    expect(d.avgQuotedPrepMinutes).toBe(17.5);
  });

  it('returns nulls (not zeros) when the window has no data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/vendor/analytics/ops?days=1',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.placedOrders).toBe(0);
    expect(d.acceptanceRate).toBeNull();
    expect(d.cancellationRate).toBeNull();
    expect(d.avgAcceptMinutes).toBeNull();
    expect(d.avgPrepMinutes).toBeNull();
  });
});
