import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { OrderStatus, type Prisma } from '@prisma/client';
import { customerRoutes } from '../modules/user/customer.routes';
import { homeCacheKey, invalidateHomeCache } from '../modules/user/home-cache';
import { beginRequestTenantContext, enterTenant, getTenantId, runWithTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';

// Route registration constructs these clients; Home must never call them.
vi.mock('../providers/maps/maps-provider', () => ({ getMapsProvider: () => ({}) }));
vi.mock('../providers/notifications/channels', () => ({ getChannels: () => ({}) }));

const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'RETURNED'];
const LIVE = Object.values(OrderStatus).filter((s) => !TERMINAL.includes(s));
const A = 'home-customer-a';
const B = 'home-customer-b';
const stamp = new Date('2026-09-23T12:00:00.000Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function vendor(n: number, open = true) {
  return {
    id: `vendor-${n}`, name: `Synthetic vendor ${n}`, slug: `synthetic-${n}`,
    vendorType: 'RESTAURANT', latitude: 6.8 + n / 1000, longitude: -58.15,
    estimatedPrepTime: 30, averageRating: 5 - n / 1000, totalOrders: 20,
    isCurrentlyOpen: open, acceptingOrders: true, status: 'ACTIVE', isVerified: true,
    logoUrl: null, categories: [{ id: `category-${n}`, name: `Menu ${n}`, imageUrl: null }],
  };
}
function order(customerId = A, status: OrderStatus = 'PENDING', vendorId = 'vendor-1') {
  return {
    id: `order-${customerId}`, customerId, tenantId: customerId === A ? 'tenant-a' : 'tenant-b',
    orderNumber: `SYNTHETIC-${customerId}`, status, vendorId, orderType: 'FOOD_DELIVERY',
    vendor: { id: vendorId, name: 'Synthetic store', logoUrl: null },
    holdExpiresAt: new Date('2026-09-23T12:05:00Z'), scheduledFor: null as Date | null,
    estimatedDeliveryTime: new Date('2026-09-23T12:42:00Z'), placedAt: stamp,
    promisedAt: new Date('2026-09-23T12:42:00Z'), promiseRevisedAt: null as Date | null,
    promiseRevisionReason: null as string | null, promiseRevisions: 0,
  };
}
type Row = ReturnType<typeof order>;
const copy = <T>(value: T): T => structuredClone(value);

async function harness(vendors = [vendor(1), vendor(2)]) {
  const cache = new Map<string, string>();
  const state = {
    orders: [] as Row[], vendors,
    vendorsByTenant: new Map<string, typeof vendors>(),
    favorites: new Map([[A, ['vendor-1']], [B, ['vendor-2']]]),
    failOrder: '' as '' | 'active' | 'recent', failGet: false, failSet: false, failDiscovery: false,
    getGate: undefined as ReturnType<typeof deferred> | undefined,
    vendorGate: undefined as ReturnType<typeof deferred> | undefined,
    orderGate: undefined as ReturnType<typeof deferred> | undefined,
    setGate: undefined as ReturnType<typeof deferred> | undefined,
    flipPrincipal: false, principalReads: 0,
  };
  const started = { get: deferred(), vendor: deferred(), active: deferred(), recent: deferred(), set: deferred() };
  const reads: Array<{ kind: string; principal?: string; tenant: string | null; args: unknown }> = [];
  const note = (kind: string, args: unknown, principal?: string) => {
    reads.push({ kind, principal, tenant: getTenantId(), args: copy(args) });
  };
  const rowsFor = (principal: unknown) => state.orders.filter((o) => o.customerId === principal);
  const prisma = {
    customer: { findUnique: vi.fn(async (args: { where: { userId: string } }) => {
      note('customer', args, args.where.userId); return { userId: args.where.userId };
    }) },
    vendor: { findMany: vi.fn(async (args: Prisma.VendorFindManyArgs) => {
      if (args.select?.id && args.where?.favoritedBy) {
        const principal = (args.where.favoritedBy as { some: { userId: string } }).some.userId;
        note('favorites', args, principal);
        return (state.favorites.get(principal) ?? []).map((id) => ({ id }));
      }
      note('vendors', args); started.vendor.resolve();
      const snapshot = copy(state.vendorsByTenant.get(getTenantId() ?? '') ?? state.vendors);
      await state.vendorGate?.promise;
      if (state.failDiscovery) throw new Error('synthetic discovery failure');
      return snapshot.slice(0, args.take ?? 500);
    }) },
    item: { findMany: vi.fn(async (args: Prisma.ItemFindManyArgs) => {
      note('items', args);
      const v = (state.vendorsByTenant.get(getTenantId() ?? '') ?? state.vendors)[0]!;
      return [{ id: 'popular-item', name: 'Synthetic dish', imageUrl: null, basePrice: 1000, vendorId: v.id, vendor: v }];
    }) },
    actorRatingStat: { findMany: vi.fn(async (args: unknown) => { note('ratings', args); return []; }) },
    user: { findUnique: vi.fn(async (args: { where: { id: string } }) => {
      note('country', args, args.where.id); return { countryCode: 'GY' };
    }) },
    countryConfig: { findUnique: vi.fn(async (args: unknown) => { note('pricing', args); return null; }) },
    order: {
      findFirst: vi.fn(async (args: Prisma.OrderFindFirstArgs) => {
        note('active', args, args.where?.customerId as string); started.active.resolve();
        // Fail by semantic query shape, never by invocation number.
        if (state.failOrder === 'active' && args.select?.status) throw new Error('synthetic active read failure');
        const excluded = (args.where?.status as { notIn?: string[] })?.notIn ?? [];
        const row = rowsFor(args.where?.customerId).filter((o) => !excluded.includes(o.status))
          .sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())[0];
        const selected = row ? Object.fromEntries(Object.keys(args.select ?? {}).map((key) => [key, row[key as keyof Row]])) : null;
        const snapshot = copy(selected);
        await state.orderGate?.promise;
        return snapshot;
      }),
      findMany: vi.fn(async (args: Prisma.OrderFindManyArgs) => {
        note('recent', args, args.where?.customerId as string); started.recent.resolve();
        if (state.failOrder === 'recent' && args.select?.vendorId) throw new Error('synthetic recent read failure');
        const statuses = (args.where?.status as { in?: string[] })?.in ?? [];
        const rows = rowsFor(args.where?.customerId).filter((o) => statuses.includes(o.status))
          .sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime());
        const ids = [...new Set(rows.map((o) => o.vendorId))].slice(0, args.take ?? 20);
        const snapshot = ids.map((vendorId) => ({ vendorId }));
        await state.orderGate?.promise;
        return snapshot;
      }),
    },
  };
  const redis = {
    get: vi.fn(async (key: string) => {
      started.get.resolve(); await state.getGate?.promise;
      if (state.failGet) throw new Error('synthetic cache get failure');
      return cache.get(key) ?? null;
    }),
    setex: vi.fn(async (key: string, ttl: number, value: string) => {
      expect(ttl).toBe(60); started.set.resolve(); await state.setGate?.promise;
      if (state.failSet) throw new Error('synthetic cache set failure');
      cache.set(key, value); return 'OK';
    }),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) =>
      ['0', [...cache.keys()].filter((key) => key.startsWith(pattern.slice(0, -1)))]),
    del: vi.fn(async (...keys: string[]) => { keys.forEach((key) => cache.delete(key)); return keys.length; }),
    incr: vi.fn(async () => 1), expire: vi.fn(async () => 1),
  };
  const app = Fastify({ logger: false }); apps.push(app);
  // The single cast boundary installs deliberately partial, keyed dependencies.
  app.decorate('prisma', prisma as unknown as FastifyInstance['prisma']);
  app.decorate('redis', redis as unknown as FastifyInstance['redis']);
  app.decorate('io', {} as FastifyInstance['io']);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  app.decorate('authenticateOptional', async (request: { headers: Record<string, unknown>; user?: unknown }) => {
    const id = request.headers['x-test-principal'] as string | undefined;
    enterTenant(id ? (id === A ? 'tenant-a' : 'tenant-b') : null);
    if (id) {
      const user = { role: 'CUSTOMER' };
      Object.defineProperty(user, 'userId', { get() {
        state.principalReads += 1;
        return state.flipPrincipal && state.principalReads > 1 ? B : id;
      } });
      request.user = user;
    }
  });
  app.decorate('authenticate', async () => { throw new Error('unexpected required auth'); });
  registerErrorHandler(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' }); await app.ready();
  const get = (principal: string | undefined = A, query = '') => app.inject({
    method: 'GET', url: `/api/v1/customer/home${query}`,
    headers: principal ? { 'x-test-principal': principal } : {},
  });
  const home = async (principal = A, query = '') => {
    const response = await get(principal, query);
    expect(response.statusCode, response.body).toBe(200); return response.json().data;
  };
  return { app, cache, state, reads, prisma, redis, started, get, home };
}
const count = (h: Awaited<ReturnType<typeof harness>>, kind: string) => h.reads.filter((r) => r.kind === kind).length;
const ids = (cards: Array<{ id: string }>) => cards.map((v) => v.id);

describe('Home authoritative order projection through real Fastify registration/inject', () => {
  it.each(LIVE)('warm discovery observes live status %s, including recovery', async (status) => {
    const h = await harness(); h.state.orders = [order(A, 'RIDER_ASSIGNED')];
    expect((await h.home()).activeOrder.status).toBe('RIDER_ASSIGNED');
    h.state.orders[0]!.status = status;
    expect((await h.home()).activeOrder.status).toBe(status);
    expect(count(h, 'active')).toBe(2); expect(count(h, 'recent')).toBe(2);
    for (const kind of ['vendors', 'favorites', 'items', 'ratings', 'country', 'pricing']) expect(count(h, kind), kind).toBe(1);
  });
  it.each(TERMINAL)('warm discovery excludes %s without masking an older live row', async (status) => {
    const h = await harness(); h.state.orders = [order()]; await h.home();
    h.state.orders[0]!.status = status as OrderStatus;
    expect((await h.home()).activeOrder).toBeNull();
    h.state.orders.push({ ...order(), id: 'older-live', placedAt: new Date(stamp.getTime() - 1000) });
    expect((await h.home()).activeOrder.id).toBe('older-live');
    expect(count(h, 'vendors')).toBe(1);
  });
  it('observes creation after a warm empty Home and refreshed hold/schedule/promise metadata', async () => {
    const h = await harness(); expect((await h.home()).activeOrder).toBeNull();
    const row = order(); h.state.orders.push(row);
    expect((await h.home()).activeOrder.id).toBe(row.id);
    row.holdExpiresAt = new Date('2026-09-23T12:06:00Z'); row.scheduledFor = new Date('2026-09-24T12:00:00Z');
    row.promisedAt = new Date('2026-09-23T12:52:00Z'); row.promiseRevisedAt = stamp;
    row.promiseRevisionReason = 'Synthetic delay'; row.promiseRevisions = 1;
    row.estimatedDeliveryTime = new Date('2026-09-23T12:51:00Z');
    const active = (await h.home()).activeOrder;
    expect(active).toMatchObject({ orderType: 'FOOD_DELIVERY', holdExpiresAt: '2026-09-23T12:06:00.000Z', scheduledFor: '2026-09-24T12:00:00.000Z', estimatedDeliveryTime: '2026-09-23T12:51:00.000Z', placedAt: stamp.toISOString() });
    expect(active.promise).toEqual({ at: '2026-09-23T12:52:00.000Z', windowStart: '2026-09-23T12:45:00.000Z', windowEnd: '2026-09-23T13:05:00.000Z', revisedAt: stamp.toISOString(), revisionReason: 'Synthetic delay', revisions: 1 });
  });
  it('preserves both exact customer predicates, terminality, projection and recent query limits', async () => {
    const h = await harness(); h.state.orders = [order()]; await h.home(); await h.home();
    for (const { args, principal, tenant } of h.reads.filter((r) => ['active', 'recent'].includes(r.kind))) {
      expect(principal).toBe(A); expect(tenant).toBe('tenant-a');
      expect((args as Prisma.OrderFindManyArgs).where?.customerId).toBe(A);
    }
    expect(h.prisma.order.findFirst.mock.calls[0]![0]).toEqual({ where: { customerId: A, status: { notIn: expect.arrayContaining(TERMINAL) } }, select: {
      id: true, orderNumber: true, status: true, orderType: true, vendor: { select: { id: true, name: true, logoUrl: true } },
      holdExpiresAt: true, scheduledFor: true, estimatedDeliveryTime: true, placedAt: true,
      promisedAt: true, promiseRevisedAt: true, promiseRevisionReason: true, promiseRevisions: true,
    }, orderBy: { placedAt: 'desc' } });
    expect((h.prisma.order.findFirst.mock.calls[0]![0].where!.status as { notIn: string[] }).notIn).toHaveLength(5);
    expect(h.prisma.order.findMany.mock.calls[0]![0]).toEqual({ where: { customerId: A, status: { in: ['DELIVERED', 'COMPLETED'] } }, select: { vendorId: true }, orderBy: { placedAt: 'desc' }, take: 20, distinct: ['vendorId'] });
  });
  it('separates two principals at the same coordinates and binds a changing session once', async () => {
    const h = await harness(); h.state.orders = [order(A), order(B), { ...order(A, 'COMPLETED', 'vendor-1'), id: 'recent-a' }, { ...order(B, 'DELIVERED', 'vendor-2'), id: 'recent-b' }];
    h.state.vendorsByTenant.set('tenant-a', [vendor(1)]);
    h.state.vendorsByTenant.set('tenant-b', [vendor(2)]);
    const query = '?lat=6.8&lng=-58.15';
    for (const principal of [A, B, A, B]) {
      const feed = await h.home(principal, query);
      expect(feed.activeOrder.id).toBe(`order-${principal}`);
      for (const rail of ['openVendors', 'nearby', 'featured']) expect(ids(feed[rail])).toEqual([principal === A ? 'vendor-1' : 'vendor-2']);
      expect(feed.popularItems[0].vendorId).toBe(principal === A ? 'vendor-1' : 'vendor-2');
      expect(ids(feed.categories)).toEqual([principal === A ? 'category-1' : 'category-2']);
      expect(ids(feed.orderAgain)).toEqual([principal === A ? 'vendor-1' : 'vendor-2']);
      expect(ids(feed.openVendors.filter((v: { isFavorite: boolean }) => v.isFavorite))).toEqual([principal === A ? 'vendor-1' : 'vendor-2']);
    }
    await h.home(A, '?lat=7&lng=-58.15'); expect(h.cache.size).toBe(3);
    h.state.flipPrincipal = true; h.state.principalReads = 0;
    const feed = await h.home(A, '?lat=8&lng=-58.15');
    expect(feed.activeOrder.id).toBe(`order-${A}`); expect(ids(feed.orderAgain)).toEqual(['vendor-1']);
    expect(h.state.principalReads).toBe(1);
    expect(h.reads.filter((r) => r.principal).every((r) => r.tenant === (r.principal === A ? 'tenant-a' : 'tenant-b'))).toBe(true);
  });
  it('concurrent principals retain their own context across a delayed cold discovery', async () => {
    const h = await harness(); h.state.orders = [order(A), order(B)];
    h.state.vendorsByTenant.set('tenant-a', [vendor(1)]);
    h.state.vendorsByTenant.set('tenant-b', [vendor(2)]);
    h.state.vendorGate = deferred();
    const first = h.get(A).then((res) => res); const second = h.get(B).then((res) => res);
    try {
      await vi.waitFor(() => expect(count(h, 'vendors')).toBe(2));
    } finally { h.state.vendorGate.resolve(); }
    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    expect(a.json().data.activeOrder.id).toBe(`order-${A}`);
    expect(b.json().data.activeOrder.id).toBe(`order-${B}`);
    expect(ids(a.json().data.openVendors)).toEqual(['vendor-1']);
    expect(ids(b.json().data.openVendors)).toEqual(['vendor-2']);
    expect(h.reads.filter((r) => r.principal).every((r) => r.tenant === (r.principal === A ? 'tenant-a' : 'tenant-b'))).toBe(true);
  });
  it('guests execute zero order reads and keep public visibility and response keys', async () => {
    const h = await harness(); h.state.orders = [order()];
    // Empty string intentionally means anonymous; undefined is the helper default.
    const cold = await h.home(''); const hot = await h.home('');
    expect(hot).toEqual(cold); expect(cold.activeOrder).toBeNull(); expect(cold.orderAgain).toEqual([]);
    expect(Object.keys(cold).sort()).toEqual(['activeOrder', 'popularItems', 'featured', 'nearby', 'orderAgain', 'categories', 'openVendors', 'closedVendors'].sort());
    for (const kind of ['active', 'recent', 'favorites', 'customer', 'country']) expect(count(h, kind), kind).toBe(0);
    expect(count(h, 'vendors')).toBe(1); expect(count(h, 'items')).toBe(1);
    expect(h.prisma.vendor.findMany.mock.calls[0]![0]).toMatchObject({ where: { status: 'ACTIVE', isVerified: true, tenant: { isActive: true, kind: 'PRODUCTION' }, items: { some: { isAvailable: true } } }, orderBy: { averageRating: 'desc' }, take: 500 });
    expect(h.prisma.item.findMany.mock.calls[0]![0]).toMatchObject({ where: { isAvailable: true, vendor: { status: 'ACTIVE', isVerified: true, tenant: { isActive: true, kind: 'PRODUCTION' } } }, orderBy: { totalOrdered: 'desc' }, take: 10 });
  });
  it.each(['DELIVERED', 'COMPLETED'] as const)('fresh %s history preserves candidate order, exact six cards and beyond-visible candidates', async (status) => {
    const vendors = Array.from({ length: 60 }, (_, i) => vendor(i + 1, i < 40));
    const h = await harness(vendors); expect((await h.home()).orderAgain).toEqual([]);
    // Reverse recency deliberately: output follows candidate rating/distance order.
    h.state.orders = [60, 59, 52, 51, 39, 38, 37, 36].map((n, i) => ({ ...order(A, status, `vendor-${n}`), id: `history-${n}`, placedAt: new Date(stamp.getTime() - i * 1000) }));
    const feed = await h.home();
    expect(ids(feed.orderAgain)).toEqual(['vendor-36', 'vendor-37', 'vendor-38', 'vendor-39', 'vendor-51', 'vendor-52']);
    expect(ids(feed.openVendors)).toEqual(vendors.slice(0, 30).map((v) => v.id));
    expect(ids(feed.closedVendors)).toEqual(vendors.slice(40, 50).map((v) => v.id));
    expect(count(h, 'vendors')).toBe(1);
    // Near the far end of the pool: distance order wins over the DB rating order.
    const located = await h.home(A, '?lat=6.86&lng=-58.15');
    expect(ids(located.orderAgain)).toEqual(['vendor-60', 'vendor-59', 'vendor-52', 'vendor-51', 'vendor-39', 'vendor-38']);
  });
  it.each(['active', 'recent'] as const)('hot %s read failure is an honest error even with legacy order fragments', async (failure) => {
    const h = await harness(); h.state.orders = [order()]; const legacy = await h.home();
    h.cache.set(`home:${A}:x:x`, JSON.stringify(legacy)); h.state.failOrder = failure;
    const response = await h.get(); expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
    expect(response.body).not.toMatch(/activeOrder|recentOrders|orderAgain|SYNTHETIC/);
  });
  it.each(['get', 'set'] as const)('Redis %s failure still resolves authoritative orders', async (failure) => {
    const h = await harness(); h.state.orders = [order()]; await h.home();
    if (failure === 'get') h.state.failGet = true;
    else { h.cache.clear(); h.state.failSet = true; }
    h.state.orders[0]!.status = 'PREPARING';
    expect((await h.home()).activeOrder.status).toBe('PREPARING');
    expect(count(h, 'active')).toBe(2); expect(count(h, 'vendors')).toBe(2);
  });
  it('Redis plus cold discovery failure returns an honest error', async () => {
    const h = await harness(); h.state.failGet = true; h.state.failDiscovery = true;
    const response = await h.get(); expect(response.statusCode).toBe(500);
    expect(response.json().data).toBeUndefined(); expect(h.cache.size).toBe(0);
    expect(count(h, 'active')).toBe(1); expect(count(h, 'recent')).toBe(1);
  });
  it('a legacy key is never read or overwritten; versioned keys still match per-user invalidation', async () => {
    const h = await harness(); h.state.orders = [order()];
    const old = `home:${A}:x:x`; h.cache.set(old, JSON.stringify({ activeOrder: { id: 'old-order' }, orderAgain: [] }));
    const feed = await h.home(); expect(feed.activeOrder.id).toBe(`order-${A}`);
    const key = homeCacheKey(A, undefined, undefined);
    expect(key).toBe(`home:${A}:discovery:v2:x:x`); expect(h.redis.get.mock.calls[0]![0]).toBe(key);
    expect(h.cache.get(old)).toContain('old-order');
    expect(await runWithTenant('other-context', async () => homeCacheKey(A, undefined, undefined))).toBe(key);
    expect(await runWithTenant('guest-context', async () => homeCacheKey(undefined, undefined, undefined))).toBe('t:guest-context:home:guest:discovery:v2:x:x');
    await h.home(B); await h.home(A, '?lat=7&lng=8');
    await runWithTenant('invalidation-context', () => invalidateHomeCache(h.app, A));
    expect([...h.cache.keys()]).toEqual([homeCacheKey(B, undefined, undefined)]);
    expect(h.redis.scan).toHaveBeenCalledWith('0', 'MATCH', `home:${A}:*`, 'COUNT', 100);
  });
  it.each(['{', 'null', '[]', '{"version":1}', '{"activeOrder":{"id":"poison"},"orderAgain":[]}', '{"vendors":[],"popularItems":[null],"categories":[]}'])('malformed/old discovery %s is a miss', async (bad) => {
    const h = await harness(); h.cache.set(homeCacheKey(A, undefined, undefined), bad); h.state.orders = [order()];
    expect((await h.home()).activeOrder.id).toBe(`order-${A}`); expect(count(h, 'vendors')).toBe(1);
  });
  it('cache contents contain discovery only; nested malformed cards are misses', async () => {
    const h = await harness(); h.state.orders = [order()]; await h.home();
    const key = homeCacheKey(A, undefined, undefined); const raw = h.cache.get(key)!;
    expect(raw).not.toMatch(/activeOrder|recentOrders|orderAgain|SYNTHETIC|holdExpiresAt|promisedAt/);
    const parsed = JSON.parse(raw); parsed.vendors = [null]; h.cache.set(key, JSON.stringify(parsed));
    expect((await h.home()).openVendors[0].id).toBe('vendor-1'); expect(count(h, 'vendors')).toBe(2);
  });
  it('order reads start while Redis lookup is pending, and cold discovery runs while orders are pending', async () => {
    const h = await harness(); h.state.getGate = deferred(); h.state.orderGate = deferred();
    const pending = h.get().then((res) => res);
    await h.started.get.promise;
    try {
      await vi.waitFor(() => expect(count(h, 'active')).toBe(1), { timeout: 500 });
      expect(count(h, 'recent')).toBe(1);
      h.state.getGate.resolve(); await h.started.vendor.promise;
      expect(count(h, 'vendors')).toBe(1);
    } finally { h.state.getGate.resolve(); h.state.orderGate.resolve(); await pending; }
  });
  it('delayed discovery fill never stores the old order snapshot after a commit', async () => {
    const h = await harness(); h.state.orders = [order()]; h.state.setGate = deferred();
    const pending = h.get().then((res) => res); await h.started.set.promise;
    h.state.orders[0]!.status = 'CANCELLED'; h.state.setGate.resolve();
    const old = await pending; expect(old.json().data.activeOrder.status).toBe('PENDING');
    expect((await h.home()).activeOrder).toBeNull(); expect(count(h, 'vendors')).toBe(1);
  });
  it('synthetic transaction model exposes only committed state, not staged or rolled-back rows', async () => {
    const h = await harness(); h.state.orders = [order()]; await h.home();
    const staged = copy(h.state.orders); staged[0]!.status = 'CANCELLED';
    // This models a transaction; it does not prove PostgreSQL isolation.
    expect((await h.home()).activeOrder.status).toBe('PENDING');
    staged.splice(0); // rollback discards the staged write
    expect((await h.home()).activeOrder.status).toBe('PENDING');
    h.state.orders[0]!.status = 'CANCELLED'; // committed external writer
    expect((await h.home()).activeOrder).toBeNull();
  });
  it.each([40, 500])('measures synthetic JSON cache size at %i candidates', async (size) => {
    const h = await harness(Array.from({ length: size }, (_, i) => vendor(i + 1, i % 4 !== 0)));
    h.state.orders = [order()]; const feed = await h.home(A, '?lat=6.8&lng=-58.15');
    const legacyBytes = Buffer.byteLength(JSON.stringify(feed));
    const discoveryBytes = Buffer.byteLength(h.cache.get(homeCacheKey(A, 6.8, -58.15))!);
    // Measurement, not a production-memory or latency claim.
    process.stdout.write(JSON.stringify({ candidates: size, legacyBytes, discoveryBytes, ratio: Number((discoveryBytes / legacyBytes).toFixed(3)) }) + '\n');
    expect(count(h, 'vendors')).toBe(1);
  });
});
