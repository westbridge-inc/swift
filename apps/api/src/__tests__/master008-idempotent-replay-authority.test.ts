import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { withIdempotency } from '../utils/idempotency';

// ---------------------------------------------------------------------------
// [MASTER-008] An idempotent replay is answered only to the principal that
// made the request, for the same request, on an object it still owns.
//
// The rider handover and delivered routes checked that the order was the
// rider's INSIDE the idempotent callback, and the cached result was keyed by
// order and Idempotency-Key alone. A replay skips the callback, so another
// rider presenting the same order and key received the first rider's stored
// outcome. Now the routes authorize the order before any replay, the cache key
// carries the tenant and the user, and the stored result is bound to the
// request body.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const GPS = { lat: 7.93, lng: -58.41 };
const PHONE_PREFIX = `+59287${String(Math.floor(Math.random() * 900) + 100)}`;
let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;
let vendorId = '';
let customerId = '';

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(4, '0')}`, firstName: 'Replay', lastName: `U${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'm008', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token, sessionId: session.id };
}
async function makeRider() {
  const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await app.prisma.rider.create({
    data: { userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: true, locationSessionId: u.sessionId, currentLat: GPS.lat, currentLng: GPS.lng, lastLocationUpdate: new Date() },
  });
  return { ...u, riderId: rider.id };
}
async function deliveredOrder(riderId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `M008-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, riderId, status: 'DELIVERED',
      deliveryAddress: '8 Replay Road, Georgetown', deliveryLat: GPS.lat, deliveryLng: GPS.lng, pickupLat: GPS.lat, pickupLng: GPS.lng, pickupAddress: 'Vendor corner',
      subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, totalAmount: 3000, paymentMethod: 'CASH', paymentStatus: 'CAPTURED',
    },
  });
  orderIds.push(order.id);
  return order;
}

type Who = { userId: string; token: string };
/** The first rider's earlier, successful call — its stored outcome, written
 *  through the real idempotency layer with that rider's identity and body. */
async function priorSuccess(scope: 'handover' | 'delivered', orderId: string, who: Who, key: string, body: unknown, data: unknown) {
  const request = { headers: { 'idempotency-key': key }, user: { userId: who.userId }, body } as unknown as FastifyRequest;
  await runWithTenant('swift-default', () => withIdempotency(app, request, scope, orderId, async () => data));
}
const call = (method: 'POST' | 'PUT', url: string, who: Who, key: string, payload: unknown) => app.inject({
  method, url, payload: payload as Record<string, unknown>,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}`, 'idempotency-key': key },
});

const HANDOVER = { outcome: 'paid', gps: GPS };
const SECRET = { orderId: 'stored', status: 'DELIVERED', claim: { id: 'claim-of-rider-a', status: 'OPEN', amount: 3000, flags: ['rider-a-only'] } };
let riderA: Awaited<ReturnType<typeof makeRider>>;
let riderB: Awaited<ReturnType<typeof makeRider>>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  // The production request lifecycle (app.ts): a fresh tenant store per
  // request, which authentication then binds to the user's tenant.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const slug = `m008-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;
  vendorId = (await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: `M008 ${slug}`, slug, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}9999`, addressLine1: '1 Replay St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: GPS.lat, longitude: GPS.lng, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  })).id;
  customerId = (await makeUser(['CUSTOMER'], 'CUSTOMER')).userId;
  riderA = await makeRider();
  riderB = await makeRider();
});

afterAll(async () => {
  for (const id of orderIds) {
    const keys = await app.redis.keys(`*:idem:${id}:*`);
    if (keys.length > 0) await app.redis.del(...keys);
  }
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[MASTER-008] the rider handover replay', () => {
  it('another rider with the same order and key gets a refusal, never the stored outcome', async () => {
    const order = await deliveredOrder(riderA.riderId);
    const key = `m008-h-${nanoid(12)}`;
    await priorSuccess('handover', order.id, riderA, key, HANDOVER, SECRET);
    const res = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, riderB, key, HANDOVER);
    expect(res.statusCode).toBe(404); // the cash handover's own answer to a non-owner
    expect(res.body).not.toContain('claim-of-rider-a');
  });

  it('the same rider retrying the same request gets the stored outcome back, without re-running it', async () => {
    const order = await deliveredOrder(riderA.riderId);
    const key = `m008-h-${nanoid(12)}`;
    await priorSuccess('handover', order.id, riderA, key, HANDOVER, SECRET);
    const res = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, riderA, key, HANDOVER);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: SECRET, replayed: true });
  });

  it('the same rider and key with a DIFFERENT body is refused, not answered with the stored outcome', async () => {
    const order = await deliveredOrder(riderA.riderId);
    const key = `m008-h-${nanoid(12)}`;
    await priorSuccess('handover', order.id, riderA, key, HANDOVER, SECRET);
    const res = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, riderA, key, { ...HANDOVER, outcome: 'no_show' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(res.body).not.toContain('claim-of-rider-a');
  });

  it('after the order is reassigned, the first rider’s replay is refused', async () => {
    const order = await deliveredOrder(riderA.riderId);
    const key = `m008-h-${nanoid(12)}`;
    await priorSuccess('handover', order.id, riderA, key, HANDOVER, SECRET);
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: riderB.riderId } });
    const res = await call('POST', `/api/v1/rider/orders/${order.id}/handover`, riderA, key, HANDOVER);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('claim-of-rider-a');
  });
});

describe('[MASTER-008] the rider delivered replay', () => {
  const STORED = { success: true, data: { orderId: 'stored', status: 'DELIVERED', note: 'delivered-by-rider-a' } };
  it('another rider with the same order and key gets a refusal, never the stored outcome', async () => {
    const order = await deliveredOrder(riderA.riderId);
    const key = `m008-d-${nanoid(12)}`;
    await priorSuccess('delivered', order.id, riderA, key, {}, STORED);
    const res = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, riderB, key, {});
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('delivered-by-rider-a');
  });

  it('after the order is reassigned, the first rider’s delivered replay is refused', async () => {
    const order = await deliveredOrder(riderA.riderId);
    const key = `m008-d-${nanoid(12)}`;
    await priorSuccess('delivered', order.id, riderA, key, {}, STORED);
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: riderB.riderId } });
    const res = await call('PUT', `/api/v1/rider/orders/${order.id}/delivered`, riderA, key, {});
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('delivered-by-rider-a');
  });
});

describe('[MASTER-008] the idempotency layer itself', () => {
  function mockRedis() {
    const store = new Map<string, string>();
    return {
      store,
      set: vi.fn(async (k: string, v: string, _ex?: string, _ttl?: number, nx?: string) => { if (nx === 'NX' && store.has(k)) return null; store.set(k, v); return 'OK'; }),
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
    };
  }
  const req = (userId: string, body: unknown) => ({ headers: { 'idempotency-key': 'key-abcdef12' }, user: { userId }, body }) as unknown as FastifyRequest;

  it('a stored result is replayed to its own principal only; another principal runs its own effect', async () => {
    const redis = mockRedis();
    const fake = { redis } as unknown as FastifyInstance;
    let ran = 0;
    const run = async () => { ran += 1; return { n: ran }; };
    expect(await withIdempotency(fake, req('user-a', { x: 1 }), 'op', 'o1', run)).toEqual({ data: { n: 1 }, replayed: false });
    expect(await withIdempotency(fake, req('user-a', { x: 1 }), 'op', 'o1', run)).toEqual({ data: { n: 1 }, replayed: true });
    expect(await withIdempotency(fake, req('user-b', { x: 1 }), 'op', 'o1', run)).toEqual({ data: { n: 2 }, replayed: false });
  });

  it('the same principal in another tenant is another principal', async () => {
    const redis = mockRedis();
    const fake = { redis } as unknown as FastifyInstance;
    let ran = 0;
    const run = async () => { ran += 1; return { n: ran }; };
    await runWithTenant('tenant-a', () => withIdempotency(fake, req('user-a', {}), 'op', 'o1', run));
    const other = await runWithTenant('tenant-b', () => withIdempotency(fake, req('user-a', {}), 'op', 'o1', run));
    expect(other).toEqual({ data: { n: 2 }, replayed: false });
  });

  it('a keyed request with no authenticated user is refused — there is no shared anonymous principal — and runs nothing', async () => {
    const redis = mockRedis();
    const fake = { redis } as unknown as FastifyInstance;
    let ran = 0;
    const anonymous = { headers: { 'idempotency-key': 'key-abcdef12' }, body: {} } as unknown as FastifyRequest;
    await expect(withIdempotency(fake, anonymous, 'op', 'o1', async () => { ran += 1; return {}; })).rejects.toMatchObject({ code: 'IDEMPOTENCY_PRINCIPAL_REQUIRED' });
    const blank = { headers: { 'idempotency-key': 'key-abcdef12' }, user: { userId: '' }, body: {} } as unknown as FastifyRequest;
    await expect(withIdempotency(fake, blank, 'op', 'o1', async () => { ran += 1; return {}; })).rejects.toMatchObject({ code: 'IDEMPOTENCY_PRINCIPAL_REQUIRED' });
    expect(ran).toBe(0);
    expect(redis.store.size).toBe(0);
    // without a key nothing is stored or replayed, so nothing is refused either
    const unkeyed = { headers: {}, body: {} } as unknown as FastifyRequest;
    expect(await withIdempotency(fake, unkeyed, 'op', 'o1', async () => ({ ok: true }))).toEqual({ data: { ok: true }, replayed: false });
  });

  it('key order in the body does not matter; a changed value does', async () => {
    const redis = mockRedis();
    const fake = { redis } as unknown as FastifyInstance;
    const run = async () => ({ ok: true });
    await withIdempotency(fake, req('user-a', { a: 1, b: { c: 2, d: 3 } }), 'op', 'o1', run);
    expect((await withIdempotency(fake, req('user-a', { b: { d: 3, c: 2 }, a: 1 }), 'op', 'o1', run)).replayed).toBe(true);
    await expect(withIdempotency(fake, req('user-a', { a: 1, b: { c: 2, d: 4 } }), 'op', 'o1', run)).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
