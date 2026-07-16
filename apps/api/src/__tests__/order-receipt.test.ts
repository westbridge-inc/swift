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
// Order receipts (marketplace §12): derived from the ledger on demand,
// customer-scoped, completed orders only.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let strangerToken: string;
const userIds: string[] = [];
let orderId: string;
let pendingOrderId: string;

async function makeUser(first: string) {
  const u = await app.prisma.user.create({
    data: {
      phone: `+59260${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: first, lastName: 'Receipt',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  userIds.push(u.id);
  const t = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: u.id, token: t, refreshToken: nanoid(48),
      deviceId: 'receipt-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  return { id: u.id, token: t };
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

  const me = await makeUser('Rita');
  token = me.token;
  const stranger = await makeUser('Sam');
  strangerToken = stranger.token;

  const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { status: 'ACTIVE' }, select: { id: true } });
  const mk = (status: string) =>
    app.prisma.order.create({
      data: {
        orderNumber: `RCPT-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY' as never,
        customerId: me.id,
        vendorId: vendor.id,
        status: status as never,
        fulfillment: 'DELIVERY' as never,
        deliveryAddress: '5 Receipt Row', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 4500, subtotalMarkup: 0, subtotalCustomer: 4500,
        deliveryFee: 600, tipAmount: 200, discount: 0, totalAmount: 5300,
        paymentMethod: 'CASH' as never,
        items: {
          create: [
            { itemId: 'x1', name: 'Pepperpot', quantity: 1, basePrice: 2500, markedUpPrice: 2500, markupAmount: 0, totalBase: 2500, totalMarkup: 0, totalCustomer: 2500 },
            { itemId: 'x2', name: 'Cook-Up Rice', quantity: 1, basePrice: 2000, markedUpPrice: 2000, markupAmount: 0, totalBase: 2000, totalMarkup: 0, totalCustomer: 2000 },
          ],
        },
      },
    });
  orderId = (await mk('DELIVERED')).id;
  pendingOrderId = (await mk('PENDING')).id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: [orderId, pendingOrderId] } } });
  if (userIds.length > 0) {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('GET /customer/orders/:id/receipt', () => {
  it('returns a print-ready HTML receipt with the ledger numbers', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}/receipt`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = res.body;
    expect(html).toContain('Pepperpot');
    expect(html).toContain('$5,300 GYD'); // total
    expect(html).toContain('$600 GYD'); // delivery fee, labeled to the rider
    expect(html).toContain('100% to the rider'); // tip line
    expect(html).toContain('cash on delivery');
    expect(html).toContain('holds none of this money');
  });

  it("404s another customer's order and 400s an incomplete one", async () => {
    const foreign = await app.inject({
      method: 'GET', url: `/api/v1/customer/orders/${orderId}/receipt`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(foreign.statusCode).toBe(404);

    const early = await app.inject({
      method: 'GET', url: `/api/v1/customer/orders/${pendingOrderId}/receipt`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('ORDER_NOT_COMPLETE');
  });
});
