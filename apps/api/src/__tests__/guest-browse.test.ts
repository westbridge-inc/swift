import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// Browsing is open to everyone; only ordering/personal data needs an account.
// Guests (no token) must see Home / vendors / menus / reviews, but be 401'd on
// cart, profile, favourites, orders, etc.
let app: FastifyInstance;
let vendorId: string;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const v = await app.prisma.vendor.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } });
  vendorId = v!.id;
});

afterAll(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('guest browsing (no account)', () => {
  it('lets guests see Home', async () => {
    expect((await get('/api/v1/customer/home')).statusCode).toBe(200);
  });
  it('lets guests see the vendor list', async () => {
    expect((await get('/api/v1/customer/vendors')).statusCode).toBe(200);
  });
  it('lets guests open a vendor (menu)', async () => {
    expect((await get(`/api/v1/customer/vendors/${vendorId}`)).statusCode).toBe(200);
  });
  it('lets guests read reviews', async () => {
    expect((await get(`/api/v1/customer/vendors/${vendorId}/reviews`)).statusCode).toBe(200);
  });

  it('still blocks the cart for guests (401)', async () => {
    expect((await get('/api/v1/customer/cart')).statusCode).toBe(401);
  });
  it('still blocks profile for guests (401)', async () => {
    expect((await get('/api/v1/customer/profile')).statusCode).toBe(401);
  });
  it('still blocks orders for guests (401)', async () => {
    expect((await get('/api/v1/customer/orders')).statusCode).toBe(401);
  });
  it('still blocks favouriting for guests (401)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/customer/favorites/${vendorId}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(401);
  });
});
