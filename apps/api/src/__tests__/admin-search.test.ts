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
// Global ⌘K search: one query fans out across orders / users / vendors.
// Read-only + capped; the console's jump-to-anything box rides on it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];
const marker = `zqx${nanoid(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;

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

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = await buildTestApp();
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;

  // One of each entity carrying the same unique marker in its searchable field.
  const customer = await app.prisma.user.create({
    data: {
      phone: '+5920076101',
      firstName: `Search${marker}`, lastName: 'Person',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
    },
  });
  userIds.push(customer.id);
  const owner = await app.prisma.user.create({
    data: {
      phone: '+5920076102',
      firstName: 'Owner', lastName: 'Search',
      roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  userIds.push(owner.id);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Diner ${marker}`, slug: `diner-${marker}-${nanoid(4)}`, vendorType: 'RESTAURANT',
      phone: '+5920076100', addressLine1: '5 Deal St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE',
    },
  });
  await app.prisma.order.create({
    data: {
      orderNumber: `SRCH-${marker.toUpperCase()}`, orderType: 'FOOD_DELIVERY',
      customerId: customer.id, status: 'DELIVERED',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
      paymentMethod: 'CASH',
    },
  });
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

function search(q: string, token = adminToken) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/admin/search?q=${encodeURIComponent(q)}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /admin/search', () => {
  it('finds orders, users and vendors from one query', async () => {
    const res = await search(marker);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.orders.some((o: any) => o.orderNumber === `SRCH-${marker.toUpperCase()}`)).toBe(true);
    expect(data.users.some((u: any) => u.firstName === `Search${marker}`)).toBe(true);
    expect(data.vendors.some((v: any) => v.name === `Diner ${marker}`)).toBe(true);
    // Wire shape the console renders
    const order = data.orders.find((o: any) => o.orderNumber === `SRCH-${marker.toUpperCase()}`);
    expect(typeof order.totalAmount).toBe('number');
  });

  it('finds a user by phone fragment', async () => {
    const res = await search('20076101');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.users.some((u: any) => u.phone === '+5920076101')).toBe(true);
  });

  it('rejects a sub-2-character query', async () => {
    const res = await search('a');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a bearer-less request', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/search?q=test' });
    expect(res.statusCode).toBe(401);
  });
});
