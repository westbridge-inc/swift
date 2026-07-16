import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { customerRoutes } from '../modules/user/customer.routes';

// ---------------------------------------------------------------------------
// IDOR sweep (launch-readiness spec §1.2): user A must NEVER reach user B's
// order, address, receipt, or trigger a mutation on them by guessing the ID.
// The only acceptable answers are 403/404 — a 2xx is a P0 defect.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let tokenA: string;
let userA: string;
let userB: string;
let orderB: string;
let addressB: string;
const userIds: string[] = [];
const orderIds: string[] = [];
let vendorId: string;

async function makeCustomer() {
  const u = await app.prisma.user.create({
    data: {
      phone: `+59263${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Id', lastName: 'Or',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: u.id, token, refreshToken: nanoid(48),
      deviceId: 'idor-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  return { id: u.id, token };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const a = await makeCustomer();
  tokenA = a.token;
  userA = a.id;
  const b = await makeCustomer();
  userB = b.id;

  const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } });
  vendorId = vendor.id;

  // B's order and B's address — A must never touch them.
  const o = await app.prisma.order.create({
    data: {
      orderNumber: `IDOR-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId: userB,
      vendorId,
      status: 'DELIVERED' as never,
      fulfillment: 'DELIVERY' as never,
      deliveryAddress: 'B secret address', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000,
      deliveryFee: 500, totalAmount: 3500, paymentMethod: 'CASH' as never,
    },
  });
  orderB = o.id;
  orderIds.push(o.id);

  const addr = await app.prisma.address.create({
    data: {
      userId: userB, label: 'Home', addressLine1: "B's private street", city: 'Georgetown',
      region: 'Demerara', latitude: 6.8, longitude: -58.15, isDefault: true,
    },
  });
  addressB = addr.id;
});

afterAll(async () => {
  if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const asA = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }, payload: payload ?? undefined });

describe('IDOR — user A cannot reach user B by ID (§1.2)', () => {
  it("cannot READ B's order detail", async () => {
    const res = await asA('GET', `/api/v1/customer/orders/${orderB}`);
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('B secret address');
  });

  it("cannot READ B's receipt", async () => {
    const res = await asA('GET', `/api/v1/customer/orders/${orderB}/receipt`);
    expect([403, 404]).toContain(res.statusCode);
  });

  it("cannot CANCEL B's order", async () => {
    const res = await asA('POST', `/api/v1/customer/orders/${orderB}/cancel`, { reason: 'nope' });
    expect([400, 403, 404]).toContain(res.statusCode);
    const untouched = await app.prisma.order.findUniqueOrThrow({ where: { id: orderB } });
    expect(untouched.status).toBe('DELIVERED'); // A's request changed nothing
  });

  it("cannot RATE B's order", async () => {
    const res = await asA('POST', `/api/v1/customer/orders/${orderB}/rate`, { vendorScore: 1 });
    expect([400, 403, 404]).toContain(res.statusCode);
  });

  it("cannot REORDER B's order into A's cart", async () => {
    const res = await asA('POST', `/api/v1/customer/orders/${orderB}/reorder`, {});
    expect([400, 403, 404]).toContain(res.statusCode);
  });

  it("cannot EDIT B's address", async () => {
    const res = await asA('PUT', `/api/v1/customer/addresses/${addressB}`, { label: 'hijacked' });
    expect([400, 403, 404]).toContain(res.statusCode);
    const untouched = await app.prisma.address.findUniqueOrThrow({ where: { id: addressB } });
    expect(untouched.label).toBe('Home');
  });

  it("cannot DELETE B's address", async () => {
    const res = await asA('DELETE', `/api/v1/customer/addresses/${addressB}`);
    expect([400, 403, 404]).toContain(res.statusCode);
    const stillThere = await app.prisma.address.findUnique({ where: { id: addressB } });
    expect(stillThere).not.toBeNull();
  });

  it("B's order never appears in A's own order list", async () => {
    const res = await asA('GET', '/api/v1/customer/orders');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(orderB);
    expect(res.body).not.toContain('B secret address');
  });

  it('a forged/garbage order id is a clean 4xx, never a 500', async () => {
    const res = await asA('GET', '/api/v1/customer/orders/not-a-real-id-☠️');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
