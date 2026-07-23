import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';

// ---------------------------------------------------------------------------
// DASH-05 — the vendor overview "orders today" must not count DEAD orders
// (cancelled/refunded); its paired revenue already excludes them. In-progress
// orders still count. Reconcile the count against the seeded order mix.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let ownerUserId: string;
let customerUserId: string;
let vendorId: string;
const orderIds: string[] = [];

async function makeOrder(status: string) {
  const o = await app.prisma.order.create({
    data: {
      orderNumber: `OVT-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: customerUserId, vendorId,
      status: status as never, deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    },
  });
  orderIds.push(o.id);
  return o;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const owner = await app.prisma.user.create({
    data: { phone: '+5920074701', firstName: 'OvT', lastName: 'Own', roles: ['VENDOR_OWNER'] as never[], activeRole: 'VENDOR_OWNER' as never, isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  ownerUserId = owner.id;
  token = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: owner.id, token, refreshToken: nanoid(48), deviceId: 'ovt', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: `OvT ${nanoid(5)}`, slug: `ovt-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920074701', addressLine1: '1 OvT St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true },
  });
  vendorId = vendor.id;
  const cust = await app.prisma.user.create({
    data: { phone: '+5920074702', firstName: 'OvT', lastName: 'Cust', roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, isPhoneVerified: true, customer: { create: {} } },
  });
  customerUserId = cust.id;

  // Two live orders (one delivered, one preparing) + one cancelled + one refunded.
  await makeOrder('DELIVERED');
  await makeOrder('PREPARING');
  await makeOrder('CANCELLED');
  await makeOrder('REFUNDED');
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: ownerUserId } });
  await app.prisma.session.deleteMany({ where: { userId: ownerUserId } });
  await app.prisma.customer.deleteMany({ where: { userId: customerUserId } });
  await app.prisma.user.deleteMany({ where: { id: { in: [ownerUserId, customerUserId] } } });
  await app.close();
});

describe('vendor overview order counts [DASH-05]', () => {
  it('today.orders counts live orders (delivered + preparing), NOT cancelled/refunded', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/analytics/overview',
      headers: { authorization: `Bearer ${token}`, 'x-vendor-id': vendorId },
    });
    expect(res.statusCode).toBe(200);
    const today = res.json().data.today;
    // 2 live orders; the cancelled + refunded are NOT counted (was 4 before).
    expect(today.orders).toBe(2);
    // revenue is from the 1 DELIVERED only — count >= revenue-producing orders, never below.
    expect(today.revenue).toBe(1000);
  });

  it('SWIFT-040: revenue is net of discount (matches the statement), not pre-discount base', async () => {
    const overview = async () =>
      (await app.inject({ method: 'GET', url: '/api/v1/vendor/analytics/overview', headers: { authorization: `Bearer ${token}`, 'x-vendor-id': vendorId } })).json().data.today.revenue as number;

    const before = await overview();
    // A delivered order the customer got 400 off: they paid 600, not 1000.
    const o = await app.prisma.order.create({
      data: {
        orderNumber: `OVT-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: customerUserId, vendorId,
        status: 'DELIVERED' as never, deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, discount: 400,
        deliveryFee: 300, totalAmount: 900, paymentMethod: 'CASH',
      },
    });
    orderIds.push(o.id);

    // RED before SWIFT-040: revenue summed subtotalBase, so it rose by the full
    // 1000 and disagreed with the statement (which nets the discount).
    expect(await overview()).toBe(before + 600);
  });
});
