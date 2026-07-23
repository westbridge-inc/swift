import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// MMG Phase 4 — admin sees the money story without touching money: the
// MMG-vs-cash mix, delivery-fee cash-ledger rows + per-status totals, and
// how many delivered MMG orders were never confirmed by the vendor.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];
let vendorId: string;
let riderId: string;

async function buildTestApp() {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.ready();
  return server;
}

let seq = 0;
async function makeUser(roles: ('CUSTOMER' | 'VENDOR_OWNER' | 'MOVER')[], activeRole: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200751${String(seq).padStart(2, '0')}`,
      firstName: 'AdminVis', lastName: `U${seq}`,
      roles: roles as any, activeRole: activeRole as any, isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeOrder(opts: { payment: 'CASH' | 'MOBILE_MONEY'; captured?: boolean; customerId: string }) {
  return app.prisma.order.create({
    data: {
      orderNumber: `AVIS-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
      customerId: opts.customerId, vendorId, riderId, status: 'DELIVERED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 300, totalAmount: 1300,
      paymentMethod: opts.payment,
      paymentStatus: opts.captured ? 'CAPTURED' : 'PENDING',
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'AdminVis Diner', slug: `adminvis-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920075100', addressLine1: '5 Deal St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE',
    },
  });
  vendorId = vendor.id;
  const mover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
  const rider = await app.prisma.rider.create({ data: { userId: mover.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  riderId = rider.id;

  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  // Two MMG orders (one confirmed, one the vendor never confirmed) + one cash.
  const mmgConfirmed = await makeOrder({ payment: 'MOBILE_MONEY', captured: true, customerId: customer.id });
  await makeOrder({ payment: 'MOBILE_MONEY', captured: false, customerId: customer.id });
  await makeOrder({ payment: 'CASH', captured: true, customerId: customer.id });
  // Ledger rows in two states.
  await app.prisma.deliveryCashSettlement.create({
    data: { orderId: mmgConfirmed.id, riderId, vendorId, amount: 300, status: 'OWED' },
  });
});

afterAll(async () => {
  await app.prisma.deliveryCashSettlement.deleteMany({ where: { vendorId } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

function get(url: string, token = adminToken) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('GET /admin/finance/cash-settlements', () => {
  it('lists ledger rows with order/vendor/rider context + per-status totals', async () => {
    const res = await get('/api/v1/admin/finance/cash-settlements?limit=50');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const mine = body.data.find((r: any) => r.vendor?.id === vendorId);
    expect(mine).toBeTruthy();
    expect(mine.amount).toBe(300);
    expect(mine.status).toBe('OWED');
    expect(mine.orderNumber).toMatch(/^AVIS-/);
    expect(mine.rider?.name).toContain('AdminVis');
    expect(body.summary.OWED.count).toBeGreaterThanOrEqual(1);
    expect(body.summary.OWED.total).toBeGreaterThanOrEqual(300);
  });

  it('filters by status', async () => {
    const res = await get('/api/v1/admin/finance/cash-settlements?status=SETTLED&limit=50');
    expect(res.statusCode).toBe(200);
    for (const r of res.json().data) expect(r.status).toBe('SETTLED');
  });

  it('rejects a non-admin', async () => {
    // The CUSTOMER user created in beforeAll (seq 3).
    const outsider = await loginWithOtp(app, '+5920075103');
    const token = outsider.json().data.tokens.accessToken;
    const res = await get('/api/v1/admin/finance/cash-settlements', token);
    expect([401, 403]).toContain(res.statusCode);
  });
});

describe('PUT /admin/orders/:id/cancel — journal close [SWIFT-095]', () => {
  it('closes an open dispatch search instead of leaving it SEARCHING forever', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `AVIS-C-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
        customerId: customer.id, vendorId, status: 'ACCEPTED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
      },
    });
    // As if the order were mid-dispatch when the admin cancels it.
    const search = await app.prisma.dispatchSearch.create({
      data: { vertical: 'DELIVERY', subjectId: order.id, status: 'SEARCHING', radiusKm: 5 },
    });

    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { reason: 'ops override' },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    // RED before SWIFT-095: the search journal stayed SEARCHING — a ghost on the ops board.
    const after = await app.prisma.dispatchSearch.findUniqueOrThrow({ where: { id: search.id } });
    expect(after.status).toBe('CANCELLED');

    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: order.id } });
  });
});

describe('GET /admin/finance/payment-mix', () => {
  it('splits completed orders by payment method and counts unconfirmed MMG', async () => {
    const res = await get('/api/v1/admin/finance/payment-mix');
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    const mmg = data.byMethod.find((m: any) => m.method === 'MOBILE_MONEY');
    const cash = data.byMethod.find((m: any) => m.method === 'CASH');
    expect(mmg.count).toBeGreaterThanOrEqual(2);
    expect(cash.count).toBeGreaterThanOrEqual(1);
    // The MMG order the vendor never confirmed shows up as follow-up work.
    expect(data.mmgUnconfirmed).toBeGreaterThanOrEqual(1);
  });
});
