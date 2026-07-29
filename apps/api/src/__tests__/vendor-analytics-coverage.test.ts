import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// Characterization tests for two analytics endpoints that had NO coverage:
//   GET /analytics/revenue        — day-bucketed, net-of-discount sales
//   GET /analytics/popular-items  — items by lifetime totalOrdered + 30d trend
// These pin the current contract so the endpoints can be refactored (extracted
// to a service) behavior-preservingly, and so a regression in the money/ordering
// math goes red.

let app: FastifyInstance;
const userIds: string[] = [];
let token = '';
let vendorId = '';
let customerId = '';

async function makeOrder(status: string, subtotalCustomer: number, discount: number, totalAmount: number) {
  return app.prisma.order.create({
    data: {
      orderNumber: `AC-${nanoid(8)}`, orderType: 'FOOD_DELIVERY' as never, customerId, vendorId,
      status: status as never, fulfillment: 'DELIVERY' as never,
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: subtotalCustomer, subtotalMarkup: 0, subtotalCustomer, discount,
      deliveryFee: 0, totalAmount, paymentMethod: 'CASH' as never,
      // 2 days ago: unambiguously inside the revenue window's day bars (which
      // run [since, since+days) = N days ago through yesterday).
      placedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const owner = await app.prisma.user.create({
    data: { phone: `+59200911${String(Math.floor(Math.random() * 900) + 100)}`, firstName: 'AC', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(owner.id);
  token = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: owner.id, token, refreshToken: nanoid(48), deviceId: 'ac', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'AC Diner', slug: `ac-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920091100', addressLine1: '7 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  vendorId = vendor.id;
  const cust = await app.prisma.user.create({
    data: { phone: `+59200911${String(Math.floor(Math.random() * 900) + 100)}`, firstName: 'AC', lastName: 'Cust', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(cust.id);
  customerId = cust.id;

  // Two finished sales today: net-of-discount revenue = (1000-100) + (1500-0).
  await makeOrder('DELIVERED', 1000, 100, 1300);
  await makeOrder('COMPLETED', 1500, 0, 1800);
  // A cancelled order must NOT count toward revenue.
  await makeOrder('CANCELLED', 9999, 0, 9999);

  // Catalogue for popular-items: totalOrdered drives the ranking.
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0 } });
  for (const [name, totalOrdered, price] of [['Pepperpot', 30, 1800], ['Chowmein', 20, 1600], ['Bakes', 10, 800]] as const) {
    await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name, basePrice: price, totalOrdered, isAvailable: true, dietaryTags: [], allergens: [] } });
  }
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, 'x-vendor-id': vendorId } });

describe('GET /analytics/revenue', () => {
  it('buckets net-of-discount sales by day, pre-fills gaps, and excludes dead orders', async () => {
    const res = await get('/api/v1/vendor/analytics/revenue?days=7');
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.days).toBe(7);
    expect(d.daily).toHaveLength(7); // gaps pre-filled with zeros
    // Revenue = Σ(subtotalCustomer − discount) over finished orders only:
    // (1000−100) + (1500−0) = 2400; the CANCELLED order is excluded.
    expect(d.totals.orders).toBe(2);
    expect(d.totals.revenue).toBe(2400);
    // The per-day bars sum to the totals.
    expect(d.daily.reduce((s: number, x: any) => s + x.revenue, 0)).toBe(2400);
    expect(d.daily.reduce((s: number, x: any) => s + x.orders, 0)).toBe(2);
  });
});

describe('GET /analytics/popular-items', () => {
  it('ranks items by lifetime totalOrdered, honors the limit, and numbers the price', async () => {
    const res = await get('/api/v1/vendor/analytics/popular-items?limit=2');
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d).toHaveLength(2); // limit respected
    expect(d[0].name).toBe('Pepperpot'); // 30 > 20 > 10
    expect(d[1].name).toBe('Chowmein');
    expect(typeof d[0].basePrice).toBe('number'); // Decimal serialized to a number
    expect(d[0]).toHaveProperty('recentOrders'); // 30-day trend field present
    expect(d[0].category.name).toBe('Mains');
  });
});
