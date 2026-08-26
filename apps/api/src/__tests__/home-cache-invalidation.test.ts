import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, beginRequestTenantContext } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// The Home feed is CACHED under a tenant-prefixed key
// (`t:<tenant>:home:<userId>:<lat>:<lng>`) but was INVALIDATED with a
// hand-written, un-prefixed pattern (`home:<userId>:*`) at all three call
// sites. The two halves stopped agreeing the day [SWIFT-SEC-CACHE] added the
// prefix to the writer alone, and nothing has matched since: favouriting a
// store, un-favouriting it, and placing an order all left the customer's Home
// feed stale for the full 60s TTL while telling them the action succeeded.
//
// This grades the only thing that matters: after the mutation, is the cached
// feed actually GONE? Written to fail against the un-prefixed pattern — that
// is the regression it exists to stop.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let userId: string;
let token: string;
let vendorId: string;
let tenantId: string;
const createdUserIds: string[] = [];

/**
 * A token alone is NOT a signed-in customer. `authenticateOptional` looks the
 * raw JWT up in `sessions` and silently falls back to GUEST when it misses —
 * so a session-less token makes /home cache under `home:guest:...` and every
 * assertion below would grade the guest feed instead. (That is exactly how the
 * first draft of this test passed its request and cached nothing.)
 */
async function signIn(id: string): Promise<string> {
  const jwt = app.jwt.sign({ userId: id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: id, token: jwt, refreshToken: nanoid(48),
      deviceId: `cachefix-${nanoid(6)}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return jwt;
}

/** Every Home key for this customer, whatever prefix scheme is in use. */
async function homeKeysFor(id: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'MATCH', `*home:${id}:*`, 'COUNT', 200);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // Production installs this in server.ts BEFORE any auth runs: a fresh
  // per-request tenant store, so `enterTenant` mutates that store instead of
  // falling back to `enterWith`. Without it the first request read
  // `_notenant` and the second inherited a LEAKED `swift-default` — the same
  // customer's feed cached under two prefixes, and the invalidation (which
  // can only build one) provably could not reach both.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerErrorHandler(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  // Idempotent purge of an interrupted run (house pattern: one fixture phone
  // prefix per file — this file owns +59200797).
  const stale = await app.prisma.user.findMany({ where: { phone: { startsWith: '+59200797' } }, select: { id: true } });
  if (stale.length) {
    const staleIds = stale.map((u) => u.id);
    const staleOwners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: staleIds } }, select: { id: true } });
    const staleVendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: staleOwners.map((o) => o.id) } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: staleVendors.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: staleOwners.map((o) => o.id) } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: staleIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: staleIds } } });
  }

  const customer = await app.prisma.user.create({
    data: {
      phone: '+59200797001', firstName: 'Cache', lastName: 'Customer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  userId = customer.id;
  createdUserIds.push(customer.id);
  token = await signIn(customer.id);

  // User.tenantId defaults to 'swift-default', so the authenticated request
  // binds that tenant and every tenant-scoped read is filtered to it. The
  // vendor must live in the SAME tenant or POST /favorites 404s on a lookup
  // the scope extension has already filtered away.
  tenantId = 'swift-default';

  const ownerUser = await app.prisma.user.create({
    data: {
      phone: '+59200797002', firstName: 'Cache', lastName: 'Owner',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, tenantId,
      name: 'Cache Fix Kitchen', slug: `cachefix-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: '+59200797003',
      addressLine1: '1 Cache Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  for (const id of createdUserIds) {
    const keys = await homeKeysFor(id);
    if (keys.length) await app.redis.del(...keys);
  }
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('Home cache invalidation reaches the key the feed was written to', () => {
  it('favouriting a store drops the cached Home feed', async () => {
    const auth = { authorization: `Bearer ${token}` };

    const warm = await app.inject({ method: 'GET', url: '/api/v1/customer/home', headers: auth });
    expect(warm.statusCode).toBe(200);
    // The feed must really be cached under THIS customer, or "it's gone
    // afterwards" proves nothing — a guest fallback would cache elsewhere.
    expect(await homeKeysFor(userId)).toHaveLength(1);

    const fav = await app.inject({ method: 'POST', url: `/api/v1/customer/favorites/${vendorId}`, headers: auth });
    expect(fav.statusCode).toBe(201);

    expect(await homeKeysFor(userId)).toEqual([]);
  });

  it('un-favouriting drops it too — the same helper, the same key', async () => {
    const auth = { authorization: `Bearer ${token}` };

    const warm = await app.inject({ method: 'GET', url: '/api/v1/customer/home', headers: auth });
    expect(warm.statusCode).toBe(200);
    expect(await homeKeysFor(userId)).toHaveLength(1);

    const unfav = await app.inject({ method: 'DELETE', url: `/api/v1/customer/favorites/${vendorId}`, headers: auth });
    expect(unfav.statusCode).toBe(200);

    expect(await homeKeysFor(userId)).toEqual([]);
  });

  it("one customer's invalidation never reaches another's feed", async () => {
    const other = await app.prisma.user.create({
      data: {
        phone: '+59200797004', firstName: 'Other', lastName: 'Customer',
        roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
        isPhoneVerified: true, selfieCapturedAt: new Date(),
      },
    });
    createdUserIds.push(other.id);
    const otherToken = await signIn(other.id);

    await app.inject({ method: 'GET', url: '/api/v1/customer/home', headers: { authorization: `Bearer ${otherToken}` } });
    await app.inject({ method: 'GET', url: '/api/v1/customer/home', headers: { authorization: `Bearer ${token}` } });
    expect(await homeKeysFor(other.id)).toHaveLength(1);
    expect(await homeKeysFor(userId)).toHaveLength(1);

    await app.inject({ method: 'POST', url: `/api/v1/customer/favorites/${vendorId}`, headers: { authorization: `Bearer ${token}` } });

    expect(await homeKeysFor(userId)).toEqual([]);
    expect(await homeKeysFor(other.id)).toHaveLength(1);
  });
});
