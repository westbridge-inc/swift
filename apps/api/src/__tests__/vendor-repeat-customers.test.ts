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

// GET /vendor/analytics/repeat-customers — a repeat customer has >=2 COMPLETED/
// DELIVERED orders here; the rate is repeat/total. Finished orders only.

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let c1 = '';
let c2 = '';

// Collision-proof phones: one random per-run base + a sequence. The old
// scheme drew owner AND both customers from the same 900-number pool — a
// birthday flake (unique-phone-prefix rule; its sibling hit CI on 2026-07-30).
const phoneBase = 592_009_100_000 + Math.floor(Math.random() * 800_000);
let pseq = 0;
const nextPhone = () => `+${phoneBase + (pseq += 1)}`;

async function makeCustomer(): Promise<string> {
  const u = await app.prisma.user.create({
    data: { phone: nextPhone(), firstName: 'RC', lastName: 'Cust', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(u.id);
  return u.id;
}

async function makeOrder(customerId: string, status: string) {
  await app.prisma.order.create({
    data: {
      orderNumber: `RC-${nanoid(8)}`, orderType: 'FOOD_DELIVERY' as never, customerId, vendorId,
      status: status as never, fulfillment: 'DELIVERY' as never,
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH' as never,
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
    data: { phone: nextPhone(), firstName: 'RC', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(owner.id);
  vendorToken = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: owner.id, token: vendorToken, refreshToken: nanoid(48), deviceId: 'rc', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'RC Diner', slug: `rc-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920091000', addressLine1: '7 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  vendorId = vendor.id;

  c1 = await makeCustomer();
  c2 = await makeCustomer();
  // c1 came back (2 finished) — a repeat; c2 ordered once. A PENDING order never
  // counts (not a completed visit).
  await makeOrder(c1, 'DELIVERED');
  await makeOrder(c1, 'COMPLETED');
  await makeOrder(c2, 'DELIVERED');
  await makeOrder(c1, 'PENDING');
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('GET /vendor/analytics/repeat-customers', () => {
  it('counts customers who came back (>=2 finished orders), excluding pending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/vendor/analytics/repeat-customers', headers: { authorization: `Bearer ${vendorToken}`, 'x-vendor-id': vendorId } });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.totalCustomers).toBe(2);   // c1 + c2 (both have finished orders)
    expect(d.repeatCustomers).toBe(1);  // only c1 came back
    expect(d.totalOrders).toBe(3);      // 2 (c1) + 1 (c2) finished; the PENDING is excluded
    expect(d.repeatRate).toBe(50);      // 1 of 2
  });
});
