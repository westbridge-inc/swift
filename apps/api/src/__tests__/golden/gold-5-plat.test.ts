import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerErrorHandler } from '../../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../../plugins/empty-json';
import { authRoutes } from '../../modules/auth/auth.routes';
import { customerRoutes } from '../../modules/user/customer.routes';
import { vendorRoutes } from '../../modules/vendor/vendor.routes';
import { riderRoutes } from '../../modules/rider/rider.routes';
import { adminRoutes } from '../../modules/admin/admin.routes';
import { rateLimitKey } from '../../utils/rate-limit-key';
import { devChannelLog, getChannels } from '../../providers/notifications/channels';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../../lib/audit-immutability';

// ---------------------------------------------------------------------------
// GOLD-5 · PLAT-01 / PLAT-03 — the platform boundary, through the REAL mounted
// routes as real sessions, on real orders placed through the real checkout:
//
//   PLAT-01  the denial matrix. CROSS-ROLE: a customer is refused vendor,
//            rider and admin work. CROSS-ACCOUNT: another customer and another
//            store in the SAME tenant cannot read or act on the order.
//            CROSS-TENANT: a tenant-B customer, store, rider and admin cannot
//            reach a tenant-A order, and the reverse. FORGED OBJECT IDS in a
//            body: another person's address, another person's order on a
//            support ticket, another store's item under a different store.
//            SELF-OWN: a rider cannot take the delivery of an order placed by
//            their own account. Every refusal is followed by a durable
//            "unchanged" check on the row it aimed at.
//   PLAT-03  the PRODUCTION rate limiter (app.ts's Redis-backed store and key
//            generator, option for option — bound to app.ts below) across
//            separate app instances and a restart: five wrong codes never open
//            a session, the sixth attempt is refused by the shared route
//            ceiling, the phone's attempt ceiling then refuses even the RIGHT
//            code from another address, and the throttle survives a restart;
//            sends are throttled per caller across instances while another
//            caller is not, and the per-phone cooldown holds across callers.
//   G5-F2    [it.fails] an anonymous caller that invents a new
//            "Authorization: Bearer …" per request gets a fresh limiter bucket
//            each time and is never throttled (utils/rate-limit-key.ts).
//   G5-F3    [it.fails] app.ts promises the production limiter "must fail
//            OPEN, never … crash a request if Redis blips"; with its store
//            unreachable every request answers 500 instead.
//
// Fixture range: +5920352nnn (this file only; audited range-aware). The
// PLAT-03 instances use the limiter namespace production uses; nothing else in
// the suite writes it (dev/test builds keep the in-memory store). Redis keys
// this file adds are removed and the shared SMS day counter it bumps is put
// back as it was found.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5920352';
const FIXTURE = 'gold5-plat-fixture';
const TENANT_SLUG_PREFIX = 'gold5-plat-';
const TENANT_B = `${TENANT_SLUG_PREFIX}${nanoid(6).toLowerCase()}`;
const RL_NAMESPACE = 'swift-rl:';
const STORE_AT = { lat: 6.80131, lng: -58.15512 };
const HOME_AT = { lat: 6.80455, lng: -58.15533 };
const smsDayKey = () => `sms_global_day:${new Date().toISOString().slice(0, 10)}`;

let app: FastifyInstance;
let seq = 0;
let redisKeysBefore = new Set<string>();
let smsDayBefore: { key: string; value: string | null; ttl: number } | null = null;
// Ops pages carry only their kind on the tracking row; files run one at a
// time, so the ones this file raised are those of its kinds inside its window
// on the database clock.
let windowStart: Date | null = null;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; phone: string };
type Store = { vendorId: string; itemId: string; ownerToken: string };

const nextPhone = () => { seq += 1; return `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`; };

async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; admin?: boolean } = {}): Promise<Actor> {
  const phone = nextPhone();
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone, firstName: 'Gold5', lastName: `Plat${seq}`, roles, activeRole,
      tenantId: opts.tenantId ?? 'swift-default',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: ['*'] } } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `gold5-plat-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, phone };
}

async function makeStore(tenantId = 'swift-default'): Promise<Store & { owner: Actor }> {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER', { tenantId });
  const vendorOwner = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  const vendor = await sys(() => app.prisma.vendor.create({
    data: {
      tenantId, ownerId: vendorOwner.id, name: `Gold5 Boundary ${seq}`, slug: `gold5-plat-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: owner.phone, addressLine1: '1 Golden Boundary Way', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE_AT.lat, longitude: STORE_AT.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 10,
    },
  }));
  const category = await sys(() => app.prisma.category.create({ data: { tenantId, vendorId: vendor.id, name: 'Mains', sortOrder: 0 } }));
  const item = await sys(() => app.prisma.item.create({ data: { tenantId, vendorId: vendor.id, categoryId: category.id, name: 'Cook-up rice', basePrice: 1800, isAvailable: true } }));
  return { vendorId: vendor.id, itemId: item.id, ownerToken: owner.token, owner };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
}

async function addressFor(customer: Actor) {
  return sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: `${seq} Golden Boundary Street`, city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME_AT.lat, longitude: HOME_AT.lng, isDefault: true },
  }));
}

/** A real cash order through the mounted cart and checkout routes. */
async function placeOrder(customer: Actor, store: Store, addressId: string): Promise<string> {
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBeLessThan(300);
  const addressed = await call('PUT', '/api/v1/customer/cart/address', customer.token, { addressId });
  expect(addressed.statusCode, addressed.body).toBe(200);
  const checkout = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': `gold5-plat-${nanoid(12)}` });
  expect(checkout.statusCode, checkout.body).toBe(200);
  const orders = checkout.json().data.orders as Array<{ id: string }>;
  expect(orders).toHaveLength(1);
  return orders[0]!.id;
}

const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
/** The fields any unauthorised write would have to move. */
const orderFacts = async (id: string) => {
  const o = await orderRow(id);
  return { status: o.status, riderId: o.riderId, cancelledAt: o.cancelledAt, cancelledBy: o.cancelledBy, updatedAt: o.updatedAt.toISOString() };
};

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
      const ownerIds = (await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
      const vendorIds = (await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
      const orderIds = (await app.prisma.order.findMany({
        where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }, { riderId: { in: riderIds } }] },
        select: { id: true },
      })).map((o) => o.id);
      await app.prisma.supportTicket.deleteMany({ where: { OR: [{ userId: { in: ids } }, { orderId: { in: orderIds } }] } });
      await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
      await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
      await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
      if (orderIds.length > 0) {
        await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
      }
      await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
      await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
      await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: ids } }, 'test-cleanup:gold-5-plat fixture reads');
      await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
      await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await app.prisma.tenant.deleteMany({ where: { slug: { startsWith: TENANT_SLUG_PREFIX } } });
  });
}

/** Admin audit and sensitive-read rows are written in onResponse hooks, which
 *  can land just after a response resolves: sweep them once more by the ids
 *  this file created, after a moment, so the last request cannot outrun the
 *  purge. */
async function sweepLateAuditRows(ids: string[], reason: string) {
  if (ids.length === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await sys(async () => {
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] }, reason);
    await purgeSensitiveReadLogs(app.prisma, { OR: [{ actorUserId: { in: ids } }, { subjectId: { in: ids } }] }, reason);
  });
}

/** Every id this file's fixtures own right now (users, their stores and orders). */
async function fixtureIds(): Promise<string[]> {
  return sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const vendors = await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } });
    const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendors.map((v) => v.id) } }] }, select: { id: true } });
    return [...ids, ...vendors.map((v) => v.id), ...orders.map((o) => o.id)];
  });
}

async function allRedisKeys(client: Pick<Redis, 'scan'>): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'COUNT', 1000);
    cursor = next;
    for (const k of batch) keys.add(k);
  } while (cursor !== '0');
  return keys;
}

/**
 * The limiter PLAT-03 composes IS production's: app.ts's two statements —
 * the store client and the registration — must read exactly as below
 * (comments and layout aside). Any change to them fails here first, so the
 * replica and G5-F3 are revisited rather than going quietly stale.
 */
function assertProductionLimiterBinding() {
  const appTs = path.resolve(process.cwd(), 'src', 'app.ts');
  expect(existsSync(appTs), 'tests run from apps/api').toBe(true);
  const code = readFileSync(appTs, 'utf8').replace(/^\s*\/\/[^\n]*$/gm, '').replace(/\s+/g, ' ');
  const between = (start: string, end: string) => {
    const from = code.indexOf(start);
    expect(from, `app.ts still contains "${start}"`).toBeGreaterThanOrEqual(0);
    return code.slice(from, code.indexOf(end, from) + end.length);
  };
  expect(between('const rateLimitRedis =', ': undefined;')).toBe(
    "const rateLimitRedis = isProduction() ? new Redis(process.env['REDIS_URL'] || 'redis://localhost:6379', { connectionName: 'swift-rate-limit', maxRetriesPerRequest: 1, enableOfflineQueue: false, }) : undefined;",
  );
  expect(between('await app.register(rateLimit, {', '});')).toBe(
    `await app.register(rateLimit, { ...(rateLimitRedis ? { redis: rateLimitRedis, nameSpace: '${RL_NAMESPACE}' } : {}), keyGenerator: rateLimitKey, max: parseInt(process.env['RATE_LIMIT_MAX'] || '200', 10), timeWindow: '1 minute', });`,
  );
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // Dispatch is not under test here: the acknowledged recording double.
  app.decorate('dispatchQueue', { add: async () => ({ id: 'recorded' }) } as never);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  // Every SMS this file causes must land in the dev adapter's log, never a
  // provider: the configured channel is the dev one, proved before any send.
  expect(process.env['NOTIFICATION_PROVIDER'] ?? 'dev').toBe('dev');
  const probe = `${PHONE_PREFIX}999`;
  await getChannels().sms.sendSms(probe, 'gold5 channel probe');
  expect(devChannelLog.filter((e) => e.channel === 'sms' && e.to === probe)).toHaveLength(1);
  await purgeFixtures();
  const dbNow = (await app.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`)[0]!.now;
  windowStart = new Date(Math.min(dbNow.getTime(), Date.now()) - 2_000); // whichever clock stamps the row
  redisKeysBefore = await allRedisKeys(app.redis);
  const key = smsDayKey();
  smsDayBefore = { key, value: await app.redis.get(key), ttl: await app.redis.ttl(key) };
  await sys(() => app.prisma.tenant.create({ data: { id: TENANT_B, name: 'Gold5 Boundary Tenant B', slug: TENANT_B } }));
}, 60_000);

afterAll(async () => {
  const owned = await fixtureIds();
  await purgeFixtures();
  await sweepLateAuditRows(owned, 'test-cleanup:gold-5-plat late audit rows');
  if (windowStart) {
    await sys(() => app.prisma.alertDelivery.deleteMany({ where: { kind: 'ADMIN_OPS', subjectId: 'support_ticket', sentAt: { gte: windowStart! } } }));
  }
  const now = await allRedisKeys(app.redis);
  const added = [...now].filter((k) => !redisKeysBefore.has(k));
  if (added.length > 0) await app.redis.del(...added);
  if (smsDayBefore) {
    if (smsDayBefore.value === null) await app.redis.del(smsDayBefore.key);
    else if (smsDayBefore.ttl > 0) await app.redis.set(smsDayBefore.key, smsDayBefore.value, 'EX', smsDayBefore.ttl);
    else await app.redis.set(smsDayBefore.key, smsDayBefore.value);
  }
  await app.close();
}, 60_000);

// ---------------------------------------------------------------------------
// PLAT-01 — the tenant-isolation and IDOR denial matrix
// ---------------------------------------------------------------------------

describe('GOLD-5 · PLAT-01 — tenant isolation and the IDOR denial matrix', () => {
  let custA: Actor;
  let custA2: Actor;
  let custB: Actor;
  let rider: Actor;
  let riderB: Actor;
  let adminB: Actor;
  let storeA: Store & { owner: Actor };
  let storeA2: Store & { owner: Actor };
  let storeB: Store & { owner: Actor };
  let addrA = '';
  let addrA2 = '';
  let orderA = '';
  let orderB = '';
  let selfOrder = '';

  beforeAll(async () => {
    custA = await makeUser(['CUSTOMER'], 'CUSTOMER');
    custA2 = await makeUser(['CUSTOMER'], 'CUSTOMER');
    custB = await makeUser(['CUSTOMER'], 'CUSTOMER', { tenantId: TENANT_B });
    adminB = await makeUser(['ADMIN'], 'ADMIN', { tenantId: TENANT_B, admin: true });
    storeA = await makeStore();
    storeA2 = await makeStore();
    storeB = await makeStore(TENANT_B);
    addrA = (await addressFor(custA)).id;
    addrA2 = (await addressFor(custA2)).id;
    orderA = await placeOrder(custA, storeA, addrA);
    orderB = await placeOrder(custB, storeB, (await addressFor(custB)).id);

    // A rider who also shops: verified, online through the real route.
    rider = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
    await sys(() => app.prisma.rider.create({ data: { userId: rider.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000 } }));
    riderB = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER', { tenantId: TENANT_B });
    await sys(() => app.prisma.rider.create({ data: { userId: riderB.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000 } }));
    for (const r of [rider, riderB]) {
      const go = await call('POST', '/api/v1/rider/go-online', r.token, { latitude: STORE_AT.lat, longitude: STORE_AT.lng });
      expect(go.statusCode, go.body).toBe(200);
    }
    // The rider's own order as a customer, accepted by the store so it is
    // genuinely waiting for a rider.
    selfOrder = await placeOrder(rider, storeA, (await addressFor(rider)).id);
    const accepted = await call('PUT', `/api/v1/vendor/orders/${selfOrder}/accept`, storeA.ownerToken, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await orderRow(orderA)).tenantId).toBe('swift-default');
    expect((await orderRow(orderB)).tenantId).toBe(TENANT_B);
  }, 60_000);

  it('CROSS-ROLE: a customer is refused store, rider and admin work, and the order does not move', async () => {
    const before = await orderFacts(orderA);
    expect((await call('GET', '/api/v1/vendor/orders', custA2.token)).statusCode).toBe(403);
    expect((await call('PUT', `/api/v1/vendor/orders/${orderA}/accept`, custA2.token, {})).statusCode).toBe(403);
    expect((await call('PUT', `/api/v1/vendor/orders/${orderA}/reject`, custA2.token, { reason: 'not mine to reject' })).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/rider/orders/${orderA}/accept`, custA2.token, {})).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/admin/orders', custA2.token)).statusCode).toBe(403);
    expect((await call('PUT', `/api/v1/admin/orders/${orderA}/cancel`, custA2.token, { reason: 'a customer pretending to be ops' })).statusCode).toBe(403);
    // …and a store owner is refused admin work on its OWN order.
    expect((await call('PUT', `/api/v1/admin/orders/${orderA}/cancel`, storeA.ownerToken, { reason: 'a store pretending to be ops' })).statusCode).toBe(403);
    expect(await orderFacts(orderA)).toEqual(before);
  });

  it('CROSS-ACCOUNT: another customer and another store in the same tenant cannot read or act on the order', async () => {
    const before = await orderFacts(orderA);
    // the owner's own reads, as controls
    expect((await call('GET', `/api/v1/customer/orders/${orderA}`, custA.token)).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/vendor/orders/${orderA}`, storeA.ownerToken)).statusCode).toBe(200);

    expect((await call('GET', `/api/v1/customer/orders/${orderA}`, custA2.token)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/customer/orders/${orderA}/cancel`, custA2.token, { reason: 'not my order' })).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/customer/orders/${orderA}/receipt`, custA2.token)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/vendor/orders/${orderA}`, storeA2.ownerToken)).statusCode).toBe(404);
    expect((await call('PUT', `/api/v1/vendor/orders/${orderA}/accept`, storeA2.ownerToken, {})).statusCode).toBe(404);
    expect((await call('PUT', `/api/v1/vendor/orders/${orderA}/reject`, storeA2.ownerToken, { reason: 'not my store' })).statusCode).toBe(404);
    const board = await call('GET', '/api/v1/vendor/orders', storeA2.ownerToken);
    expect(board.statusCode).toBe(200);
    expect((board.json().data as Array<{ id: string }>).map((o) => o.id)).not.toContain(orderA);
    expect(await orderFacts(orderA)).toEqual(before);
  });

  it('CROSS-TENANT: tenant-B customers, stores, riders and admins cannot reach a tenant-A order, nor tenant A theirs', async () => {
    const beforeA = await orderFacts(orderA);
    const beforeB = await orderFacts(orderB);
    // controls: each side reads its own
    expect((await call('GET', `/api/v1/customer/orders/${orderB}`, custB.token)).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/admin/orders/${orderB}`, adminB.token, undefined, { 'x-swift-reason': 'GOLD-5 cross-tenant control read' })).statusCode).toBe(200);

    expect((await call('GET', `/api/v1/customer/orders/${orderA}`, custB.token)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/customer/orders/${orderB}`, custA.token)).statusCode).toBe(404);
    expect((await call('PUT', `/api/v1/vendor/orders/${orderA}/accept`, storeB.ownerToken, {})).statusCode).toBe(404);
    expect((await call('PUT', `/api/v1/vendor/orders/${orderB}/accept`, storeA.ownerToken, {})).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/rider/orders/${selfOrder}/accept`, riderB.token, {})).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/admin/orders/${orderA}`, adminB.token, undefined, { 'x-swift-reason': 'GOLD-5 cross-tenant read attempt' })).statusCode).toBe(404);
    expect((await call('PUT', `/api/v1/admin/orders/${orderA}/cancel`, adminB.token, { reason: 'another operator trying to cancel' })).statusCode).toBe(404);
    const list = await call('GET', '/api/v1/admin/orders', adminB.token);
    expect(list.statusCode).toBe(200);
    const listed = (list.json().data as Array<{ id: string }>).map((o) => o.id);
    expect(listed).toContain(orderB);
    expect(listed).not.toContain(orderA);
    expect(await orderFacts(orderA)).toEqual(beforeA);
    expect(await orderFacts(orderB)).toEqual(beforeB);
  });

  it('FORGED OBJECT IDS in a body: another person’s address, another person’s order on a ticket, another store’s item', async () => {
    // custA2's own cart, delivering to custA2's own address, through the real routes.
    expect((await call('POST', '/api/v1/customer/cart/items', custA2.token, { vendorId: storeA2.vendorId, itemId: storeA2.itemId, quantity: 1 })).statusCode).toBeLessThan(300);
    expect((await call('PUT', '/api/v1/customer/cart/address', custA2.token, { addressId: addrA2 })).statusCode).toBe(200);
    const cartBefore = await sys(() => app.prisma.cart.findFirstOrThrow({ where: { customerId: custA2.userId }, select: { id: true, deliveryAddressId: true } }));
    expect(cartBefore.deliveryAddressId).toBe(addrA2);
    const forgedAddress = await call('PUT', '/api/v1/customer/cart/address', custA2.token, { addressId: addrA });
    expect(forgedAddress.statusCode).toBe(404);
    const cartAfter = await sys(() => app.prisma.cart.findFirstOrThrow({ where: { customerId: custA2.userId }, select: { id: true, deliveryAddressId: true } }));
    expect(cartAfter).toEqual(cartBefore);

    const ticket = await call('POST', '/api/v1/customer/support', custA2.token, { category: 'ORDER_ISSUE', subject: 'Where is it', message: 'This order is late', orderId: orderA });
    expect(ticket.statusCode).toBe(403);
    expect(ticket.json().error.code).toBe('NOT_YOUR_ORDER');
    expect(await sys(() => app.prisma.supportTicket.count({ where: { OR: [{ userId: custA2.userId }, { orderId: orderA }] } }))).toBe(0);
    // control: the order's own customer can raise it
    const own = await call('POST', '/api/v1/customer/support', custA.token, { category: 'ORDER_ISSUE', subject: 'Where is it', message: 'This order is late', orderId: orderA });
    expect(own.statusCode, own.body).toBe(200);
    expect(await sys(() => app.prisma.supportTicket.count({ where: { orderId: orderA } }))).toBe(1);

    const itemsBefore = await sys(() => app.prisma.cartItem.count({ where: { cart: { customerId: custA2.userId } } }));
    const mismatched = await call('POST', '/api/v1/customer/cart/items', custA2.token, { vendorId: storeA2.vendorId, itemId: storeA.itemId, quantity: 1 });
    expect(mismatched.statusCode).toBe(404);
    expect(mismatched.json().error.code).toBe('ITEM_NOT_FOUND');
    expect(await sys(() => app.prisma.cartItem.count({ where: { cart: { customerId: custA2.userId } } }))).toBe(itemsBefore);
    // another tenant's item, named by id
    const foreignItem = await call('POST', '/api/v1/customer/cart/items', custA2.token, { vendorId: storeB.vendorId, itemId: storeB.itemId, quantity: 1 });
    expect(foreignItem.statusCode).toBe(404);
    expect(foreignItem.json().error.code).toBe('ITEM_NOT_FOUND');
    expect(await sys(() => app.prisma.cartItem.count({ where: { cart: { customerId: custA2.userId } } }))).toBe(itemsBefore);
  });

  it('SELF-OWN: a rider cannot take the delivery of an order placed by their own account', async () => {
    const before = await orderFacts(selfOrder);
    expect(before.status).toBe('ACCEPTED');
    expect(before.riderId).toBeNull();
    const grab = await call('POST', `/api/v1/rider/orders/${selfOrder}/accept`, rider.token, {});
    expect(grab.statusCode).toBe(409);
    expect(grab.json().error.code).toBe('SELF_OWN_ORDER');
    expect(await orderFacts(selfOrder)).toEqual(before);
    const r = await sys(() => app.prisma.rider.findUniqueOrThrow({ where: { userId: rider.userId } }));
    expect({ current: r.currentOrderId, available: r.isAvailable, online: r.isOnline }).toEqual({ current: null, available: true, online: true });
    const offline = await call('POST', '/api/v1/rider/go-offline', rider.token, {});
    expect(offline.statusCode, offline.body).toBe(200);
    const offlineB = await call('POST', '/api/v1/rider/go-offline', riderB.token, {});
    expect(offlineB.statusCode, offlineB.body).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PLAT-03 — OTP and rate-limit abuse on the production limiter composition
// ---------------------------------------------------------------------------

describe('GOLD-5 · PLAT-03 — OTP and rate-limit abuse', () => {
  const instances: FastifyInstance[] = [];
  const stores: Redis[] = [];
  let fixture: Actor;

  /** One API instance: app.ts's PRODUCTION limiter (its Redis store, its
   *  namespace, its key generator, its global ceiling) in front of the REAL
   *  auth routes and their own per-route OTP ceilings. */
  async function buildInstance(label: string): Promise<FastifyInstance> {
    const server = Fastify({ logger: false });
    registerErrorHandler(server);
    registerEmptyJsonBodyParser(server);
    const store = new Redis(process.env['REDIS_URL'] as string, { connectionName: `gold5-rl-${label}`, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    stores.push(store);
    if (store.status !== 'ready') await new Promise<void>((resolve) => store.once('ready', () => resolve()));
    await server.register(rateLimit, {
      redis: store,
      nameSpace: RL_NAMESPACE,
      keyGenerator: rateLimitKey,
      max: parseInt(process.env['RATE_LIMIT_MAX'] || '200', 10),
      timeWindow: '1 minute',
    });
    await server.register(prismaPlugin);
    await server.register(redisPlugin);
    await server.register(authPlugin);
    server.addHook('onRequest', async () => { beginRequestTenantContext(); });
    await server.register(authRoutes, { prefix: '/api/v1/auth' });
    await server.ready();
    instances.push(server);
    return server;
  }

  function post(target: FastifyInstance, url: string, body: Record<string, unknown>, from: string, headers: Record<string, string> = {}) {
    return target.inject({ method: 'POST', url: `/api/v1/auth/${url}`, payload: body, remoteAddress: from, headers: { 'content-type': 'application/json', ...headers } });
  }
  const codeSentTo = (phone: string) => {
    const texts = devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);
    return texts.map((t) => t.body.match(/code is: (\d{6})/)?.[1] ?? null);
  };
  const noCredential = (res: LightMyRequestResponse) => {
    expect(res.body).not.toContain('accessToken');
    expect(res.body).not.toContain('refreshToken');
    expect(res.body).not.toContain('registrationProof');
  };
  async function clearLimiterNamespace() {
    const keys = [...await allRedisKeys(app.redis)].filter((k) => k.startsWith(RL_NAMESPACE));
    if (keys.length > 0) await app.redis.del(...keys);
  }

  beforeAll(async () => {
    assertProductionLimiterBinding();
    await clearLimiterNamespace();
    fixture = await makeUser(['CUSTOMER'], 'CUSTOMER');
  });

  afterAll(async () => {
    for (const server of instances) await server.close();
    for (const store of stores) store.disconnect();
    await clearLimiterNamespace();
  });

  it('five wrong codes never open a session; the shared ceiling refuses the sixth; the phone’s ceiling refuses even the right code; the throttle survives a restart', async () => {
    const a = await buildInstance('a');
    const b = await buildInstance('b');
    const attacker = '10.35.1.1';
    const sent = await post(a, 'send-otp', { phone: fixture.phone }, '10.35.1.2');
    expect(sent.statusCode, sent.body).toBe(200);
    const [code] = codeSentTo(fixture.phone);
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === '000000' ? '111111' : '000000';

    const answers: Array<{ status: number; message?: string }> = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await post(i % 2 === 0 ? a : b, 'verify-otp', { phone: fixture.phone, code: wrong }, attacker);
      noCredential(res);
      answers.push({ status: res.statusCode, message: res.json().error?.message });
    }
    expect(answers).toEqual(Array.from({ length: 5 }, () => ({ status: 400, message: 'Invalid OTP code' })));
    // Instance A saw three attempts and B two: only a SHARED counter refuses the sixth.
    const sixth = await post(b, 'verify-otp', { phone: fixture.phone, code: wrong }, attacker);
    expect(sixth.statusCode).toBe(429);
    noCredential(sixth);

    // From a fresh address the route lets it through — and the phone's own
    // ceiling refuses the RIGHT code: the budget belongs to the number.
    const right = await post(a, 'verify-otp', { phone: fixture.phone, code }, '10.35.1.3');
    expect(right.statusCode).toBe(400);
    expect(right.json().error.message).toBe('Too many attempts. Request a new OTP.');
    noCredential(right);

    // A restarted instance reads the same store: still throttled.
    const c = await buildInstance('c');
    const afterRestart = await post(c, 'verify-otp', { phone: fixture.phone, code: wrong }, attacker);
    expect(afterRestart.statusCode).toBe(429);
    noCredential(afterRestart);
    expect(await sys(() => app.prisma.session.count({ where: { userId: fixture.userId, authMethod: 'OTP', deviceId: { not: { startsWith: 'gold5-plat-' } } } }))).toBe(0);
    expect(await sys(() => app.prisma.session.count({ where: { userId: fixture.userId } }))).toBe(1); // only the fixture's own
  });

  it('sends: one caller shares one ceiling across instances and a restart; another caller is not throttled; the per-phone cooldown holds across callers', async () => {
    await clearLimiterNamespace();
    const [a, b] = instances;
    const caller = '10.35.2.1';
    const phones = Array.from({ length: 6 }, () => nextPhone());
    for (let i = 0; i < 5; i += 1) {
      const res = await post(i % 2 === 0 ? a! : b!, 'send-otp', { phone: phones[i]! }, caller);
      expect(res.statusCode, res.body).toBe(200);
      expect(codeSentTo(phones[i]!)).toHaveLength(1);
    }
    const sixth = await post(b!, 'send-otp', { phone: phones[5]! }, caller);
    expect(sixth.statusCode).toBe(429);
    expect(codeSentTo(phones[5]!)).toHaveLength(0);
    const restarted = await buildInstance('d');
    expect((await post(restarted, 'send-otp', { phone: phones[5]! }, caller)).statusCode).toBe(429);
    expect(codeSentTo(phones[5]!)).toHaveLength(0);

    // Not a global switch: a different caller is served.
    const other = await post(restarted, 'send-otp', { phone: phones[5]! }, '10.35.2.2');
    expect(other.statusCode, other.body).toBe(200);
    expect(codeSentTo(phones[5]!)).toHaveLength(1);

    // The per-phone cooldown is the number's, whoever asks and wherever.
    const again = await post(a!, 'send-otp', { phone: phones[0]! }, '10.35.2.3');
    expect(again.statusCode).toBe(429);
    expect(again.json().error.message).toBe('Please wait before requesting another OTP');
    expect(codeSentTo(phones[0]!)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// G5-F2 — an invented bearer token buys a fresh limiter bucket
// ---------------------------------------------------------------------------
//
// utils/rate-limit-key.ts keys every request that carries "Authorization:
// Bearer <anything longer than 4 chars>" by a hash of that string, before any
// verification. send-otp and verify-otp need no session, so an anonymous
// caller that invents a new bearer per request gets a new bucket per request:
// the 5-per-minute OTP ceilings (and the global one) never apply. The phone's
// own cooldowns still hold, which is why each request names a new number.
// The five setup sends run in beforeAll, so this can only fail on the sixth.
describe('GOLD-5 · PLAT-03 — G5-F2', () => {
  let server: FastifyInstance;
  let store: Redis;
  let sixthPhone = '';
  const caller = '10.35.3.1';
  const invented = () => ({ authorization: `Bearer invented-${nanoid(24)}` });

  beforeAll(async () => {
    assertProductionLimiterBinding();
    server = Fastify({ logger: false });
    registerErrorHandler(server);
    registerEmptyJsonBodyParser(server);
    store = new Redis(process.env['REDIS_URL'] as string, { connectionName: 'gold5-rl-f2', maxRetriesPerRequest: 1, enableOfflineQueue: false });
    if (store.status !== 'ready') await new Promise<void>((resolve) => store.once('ready', () => resolve()));
    await server.register(rateLimit, { redis: store, nameSpace: RL_NAMESPACE, keyGenerator: rateLimitKey, max: parseInt(process.env['RATE_LIMIT_MAX'] || '200', 10), timeWindow: '1 minute' });
    await server.register(prismaPlugin);
    await server.register(redisPlugin);
    await server.register(authPlugin);
    server.addHook('onRequest', async () => { beginRequestTenantContext(); });
    await server.register(authRoutes, { prefix: '/api/v1/auth' });
    await server.ready();
    for (let i = 0; i < 5; i += 1) {
      const phone = nextPhone();
      const res = await server.inject({ method: 'POST', url: '/api/v1/auth/send-otp', payload: { phone }, remoteAddress: caller, headers: { 'content-type': 'application/json', ...invented() } });
      expect(res.statusCode, res.body).toBe(200);
    }
    sixthPhone = nextPhone();
  });

  afterAll(async () => {
    await server?.close();
    store?.disconnect();
    const keys = [...await allRedisKeys(app.redis)].filter((k) => k.startsWith(RL_NAMESPACE));
    if (keys.length > 0) await app.redis.del(...keys);
  });

  it.fails('[G5-F2] a caller inventing a new bearer per request is still held to the 5-per-minute send ceiling', async () => {
    const sixth = await server.inject({ method: 'POST', url: '/api/v1/auth/send-otp', payload: { phone: sixthPhone }, remoteAddress: caller, headers: { 'content-type': 'application/json', ...invented() } });
    expect(sixth.statusCode).toBe(429);
    expect(devChannelLog.filter((e) => e.channel === 'sms' && e.to === sixthPhone)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// G5-F3 — the production limiter fails CLOSED (500) when its store blips
// ---------------------------------------------------------------------------
//
// app.ts, over the limiter it composes in production: "A rate-limit store
// must fail OPEN, never queue or crash a request if Redis blips — the plugin
// degrades gracefully on a store error." @fastify/rate-limit 10.3 only does
// that with `skipOnError: true`, which app.ts does not pass; with the offline
// queue disabled, a lost connection rejects the INCR at once and the global
// hook turns EVERY route into a 500. The limiter is composed as above; the
// healthy control and the connection loss run in beforeAll, so this can only
// fail on the request made while the store is unreachable.
describe('GOLD-5 · PLAT-03 — G5-F3', () => {
  let server: FastifyInstance;
  let store: Redis;
  const namespace = `${RL_NAMESPACE}gold5-f3:`;

  beforeAll(async () => {
    assertProductionLimiterBinding();
    server = Fastify({ logger: false });
    registerErrorHandler(server);
    store = new Redis(process.env['REDIS_URL'] as string, { connectionName: 'gold5-rl-f3', maxRetriesPerRequest: 1, enableOfflineQueue: false });
    if (store.status !== 'ready') await new Promise<void>((resolve) => store.once('ready', () => resolve()));
    await server.register(rateLimit, { redis: store, nameSpace: namespace, keyGenerator: rateLimitKey, max: parseInt(process.env['RATE_LIMIT_MAX'] || '200', 10), timeWindow: '1 minute' });
    server.get('/ping', async () => ({ ok: true }));
    await server.ready();
    const healthy = await server.inject({ method: 'GET', url: '/ping', remoteAddress: '10.35.4.1' });
    expect(healthy.statusCode).toBe(200);
    const gone = new Promise<void>((resolve) => store.once('end', () => resolve()));
    store.disconnect(); // the blip: the store's connection is gone
    await gone;
    expect(store.status).toBe('end');
  });

  afterAll(async () => {
    await server?.close();
    const keys = [...await allRedisKeys(app.redis)].filter((k) => k.startsWith(namespace));
    if (keys.length > 0) await app.redis.del(...keys);
  });

  it.fails('[G5-F3] with the limiter’s store unreachable an ordinary request is still served', async () => {
    const during = await server.inject({ method: 'GET', url: '/ping', remoteAddress: '10.35.4.1' });
    expect(during.statusCode).toBe(200);
  });
});
