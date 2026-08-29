import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prismaPlugin, beginRequestTenantContext } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Cancelling an order must take it off Home.
//
// Reported by the founder from a real phone on 2026-08-29: cancel an order,
// go back to Home, and the live-order card is still there counting down the
// free-cancel window of an order that no longer exists.
//
// Two halves, and this file proves the server half. The Home feed is cached in
// Redis for 60s with `activeOrder` inside it, and the customer cancel route
// never touched that cache — checkout and the favourite toggles did, cancel
// did not. So for a minute after cancelling, every fetch of Home answered from
// the cache with the dead order's hold ring still running. On a five-minute
// window that is a fifth of the whole countdown spent lying.
//
// The cache is invalidated through ONE exported helper now, called from all
// three cancel routes (store order, ride, courier). The invalidator used to be
// private to customer.routes.ts, which is exactly why the other two never
// called it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];

const PHONE_PREFIX = '+59200647';

async function signIn(id: string): Promise<string> {
  const jwt = app.jwt.sign({ userId: id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: id, token: jwt, refreshToken: nanoid(48),
      deviceId: `cancelhome-${nanoid(6)}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return jwt;
}

let seq = 0;
async function makeCustomer(): Promise<{ id: string; token: string }> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Cancel', lastName: `Home${seq}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  return { id: user.id, token: await signIn(user.id) };
}

async function makeHeldOrder(customerId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SW-CHM-${nanoid(8).toUpperCase()}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      status: 'PENDING',
      deliveryAddress: '1 Contract Street, Georgetown',
      deliveryLat: 6.8013, deliveryLng: -58.1551,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000,
      paymentMethod: 'CASH',
      // A live hold: the exact state whose countdown outlived the order.
      holdExpiresAt: new Date(Date.now() + 5 * 60_000),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

async function homeCacheKeys(userId: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'MATCH', `*home:${userId}:*`, 'COUNT', 200);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

async function fetchHome(token: string): Promise<any> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/customer/home', headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return res.json().data;
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
  // Production installs this in server.ts before any auth runs. Without it the
  // GET and the POST here enter different tenant contexts (see home-cache.ts).
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  // Orphans from a crashed earlier run would collide on the phone prefix —
  // and their orders would block the user delete on orders_customerId_fkey.
  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});

afterAll(async () => {
  if (createdOrderIds.length) {
    await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (createdUserIds.length) {
    for (const id of createdUserIds) {
      const keys = await homeCacheKeys(id);
      if (keys.length) await app.redis.del(...keys).catch(() => {});
    }
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('cancelling an order takes it off Home', () => {
  it('the cached feed is dropped by the cancel, so the next Home has no live order', async () => {
    const customer = await makeCustomer();
    const order = await makeHeldOrder(customer.id);

    // Warm the cache the way a real Home visit does, and prove it is warm —
    // otherwise a passing test could be the 60s TTL expiring, not the fix.
    for (const k of await homeCacheKeys(customer.id)) await app.redis.del(k);
    const before = await fetchHome(customer.token);
    expect(before.activeOrder?.id, 'the held order is the live card before cancelling').toBe(order.id);
    expect(before.activeOrder.holdExpiresAt, 'and its countdown is running').toBeTruthy();
    expect((await homeCacheKeys(customer.id)).length, 'the feed is now cached').toBeGreaterThan(0);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/customer/orders/${order.id}/cancel`,
      headers: { authorization: `Bearer ${customer.token}`, 'content-type': 'application/json' },
      payload: { reason: 'Changed my mind' },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    // THE assertion: the cache is gone because of the cancel, not because time
    // passed. Without the route change this array still has the warm entry.
    expect(await homeCacheKeys(customer.id), 'cancel must drop the cached feed').toHaveLength(0);

    // And what the customer actually sees next.
    const after = await fetchHome(customer.token);
    expect(after.activeOrder, 'no live card for a cancelled order').toBeNull();
  });
});

describe('one invalidator, called from every cancel path', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const read = (rel: string) => strip(readFileSync(path.join(__dirname, '..', 'modules', rel), 'utf8'));

  it('customer.routes.ts no longer owns a private copy', () => {
    // The private copy is WHY the ride and courier cancels never invalidated:
    // they could not import what was not exported. One definition, imported.
    const src = read('user/customer.routes.ts');
    expect(src).not.toMatch(/async function invalidateHomeCache/);
    expect(src).toContain("from './home-cache'");
  });

  it('the ride cancel and the courier cancel both invalidate', () => {
    // A ride and a parcel are Orders, and Home's live card shows them too.
    for (const rel of ['rides/rides.routes.ts', 'courier/courier.routes.ts']) {
      const src = read(rel);
      expect(src, `${rel} must import the shared invalidator`).toContain("from '../user/home-cache'");
      const cancelRoute = src.slice(src.search(/app\.post[^\n]*cancel'/));
      const routeBody = cancelRoute.slice(0, cancelRoute.indexOf('\n  app.') > 0 ? cancelRoute.indexOf('\n  app.') : undefined);
      expect(routeBody, `${rel}: the cancel route itself must call it`).toContain('invalidateHomeCache(app, request.user.userId)');
    }
  });

  it('the writer and the invalidator build the key from the same module', () => {
    // The last time these drifted (a tenant prefix added to one and not the
    // other) nothing was invalidated for months and nobody noticed.
    const src = read('user/customer.routes.ts');
    expect(src).toContain('homeCacheKey(userId, lat, lng)');
    expect(src).not.toMatch(/tenantCacheKey\(`home:/);
  });
});
