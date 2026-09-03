import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { marketRoutes } from '../modules/market/market.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { searchScopeCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-003] The public market and the search routes, end to end, with a
// hostile second tenant: two ACTIVE operators share the SAME category slug
// (the taxonomy is unique per tenant, so this is legal) with distinct items;
// a third operator is disabled. Whatever the deployment names as the public
// tenant is the only catalogue a guest can receive — by category, by cursor,
// on every page; a cursor minted under one operator cannot walk another's;
// an unresolvable or disabled public tenant is a loud 503, never an empty grid.
// An authenticated customer's search — the index unavailable, so the DB
// fallback — sees only their own tenant across /search, suggestions, trending
// and nearby.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const TENANT_A = `tenant-ms-a-${RUN}`;
const TENANT_B = `tenant-ms-b-${RUN}`;
const TENANT_DEAD = `tenant-ms-dead-${RUN}`;
const SLUG = `shared-tools-${RUN}`;
const userIds: string[] = []; const vendorIds: string[] = []; const itemIds: string[] = []; const categoryIds: string[] = []; const discoveryIds: string[] = [];
let seq = 0;
const phoneBase = 592_760_000_000 + Math.floor(Math.random() * 100_000_000);

async function makeUser(tenantId: string, roles: Array<'VENDOR_OWNER' | 'CUSTOMER'>) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'MS', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, tenantId,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeCatalogue(tenantId: string, name: string) {
  const owner = await makeUser(tenantId, ['VENDOR_OWNER']);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `ms-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${RUN}`, vendorType: 'STORE', phone: `+${phoneBase + 800_000 + seq}`,
      addressLine1: '1 Scope St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true,
      description: `${name} sells hammers`, tenantId,
    },
  });
  vendorIds.push(vendor.id);
  const shelf = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 1 } });
  categoryIds.push(shelf.id);
  // the SAME slug in every tenant — legal, and exactly the collision the spec names
  const discovery = await app.prisma.discoveryCategory.create({
    data: { tenantId, slug: SLUG, name: 'Hardware & tools', kind: 'RETAIL', vertical: 'RETAIL', emoji: '\u{1F528}', status: 'ACTIVE', sortWeight: 1 },
  });
  discoveryIds.push(discovery.id);
  const items = [] as Array<{ id: string; name: string }>;
  for (const n of [1, 2, 3]) {
    const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: shelf.id, name: `${name} Hammer ${n}`, basePrice: 1000 + n, isAvailable: true, totalOrdered: 10 - n } });
    itemIds.push(item.id);
    await app.prisma.itemDiscoveryCategory.create({ data: { tenantId, itemId: item.id, categoryId: discovery.id, source: 'ADMIN' } });
    items.push({ id: item.id, name: item.name });
  }
  return { vendor, items };
}

async function customerToken(tenantId: string) {
  const user = await makeUser(tenantId, ['CUSTOMER']);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ms', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return token;
}

const count = async (outcome: string) => (await searchScopeCounter.get()).values.find((v) => v.labels['outcome'] === outcome)?.value ?? 0;
const market = (url: string) => app.inject({ method: 'GET', url: `/api/v1/market${url}` });
const search = (url: string, token: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });

let a: Awaited<ReturnType<typeof makeCatalogue>>;
let b: Awaited<ReturnType<typeof makeCatalogue>>;
let tokenA: string;
let tokenB: string;
const restoreEnv = process.env['PUBLIC_TENANT_ID'];

beforeAll(async () => {
  // the index is provably unavailable, so the routes exercise their DB fallback
  process.env['MEILISEARCH_URL'] = 'http://127.0.0.1:9';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.ready();
  for (const [id, isActive] of [[TENANT_A, true], [TENANT_B, true], [TENANT_DEAD, false]] as const) {
    await app.prisma.tenant.create({ data: { id, name: `Scope ${id}`, slug: id, isActive } });
  }
  a = await makeCatalogue(TENANT_A, 'Alpha Tools');
  b = await makeCatalogue(TENANT_B, 'Bravo Tools');
  await makeCatalogue(TENANT_DEAD, 'Dead Tools');
  tokenA = await customerToken(TENANT_A);
  tokenB = await customerToken(TENANT_B);
});
afterEach(() => {
  if (restoreEnv === undefined) delete process.env['PUBLIC_TENANT_ID']; else process.env['PUBLIC_TENANT_ID'] = restoreEnv;
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    for (const id of [TENANT_A, TENANT_B, TENANT_DEAD]) await app.prisma.tenant.updateMany({ where: { id }, data: { isActive: false } }).catch(() => {});
    await app.prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: itemIds } } }).catch(() => {});
    await app.prisma.item.deleteMany({ where: { id: { in: itemIds } } }).catch(() => {});
    await app.prisma.category.deleteMany({ where: { id: { in: categoryIds } } }).catch(() => {});
    await app.prisma.discoveryCategory.deleteMany({ where: { id: { in: discoveryIds } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B, TENANT_DEAD] } } }).catch(() => {});
  }, 'test-cleanup:market-search-tenancy');
  await app.close();
});

const idsOf = (res: { json: () => { data: { items: Array<{ id: string }> } } }) => res.json().data.items.map((i) => i.id).sort();

describe('[R048-003] the public market is one operator’s catalogue', () => {
  it('the same category slug in two tenants resolves to the PUBLIC tenant’s category and items — and only theirs', async () => {
    process.env['PUBLIC_TENANT_ID'] = TENANT_A;
    const ra = await market(`/items?category=${SLUG}&limit=10`);
    expect(ra.statusCode).toBe(200);
    expect(idsOf(ra)).toEqual(a.items.map((i) => i.id).sort());
    process.env['PUBLIC_TENANT_ID'] = TENANT_B;
    const rb = await market(`/items?category=${SLUG}&limit=10`);
    expect(rb.statusCode).toBe(200);
    expect(idsOf(rb)).toEqual(b.items.map((i) => i.id).sort());
    // the uncategorised feed too: every page is one tenant's
    const all = await market('/items?limit=50');
    const got = idsOf(all);
    for (const i of a.items) expect(got).not.toContain(i.id);
    for (const i of b.items) expect(got).toContain(i.id);
  });

  it('pagination stays inside the tenant, and a cursor minted under one operator is refused under another', async () => {
    process.env['PUBLIC_TENANT_ID'] = TENANT_A;
    const p1 = await market(`/items?category=${SLUG}&limit=2&sort=popular`);
    expect(p1.statusCode).toBe(200);
    const cursor = p1.json().data.nextCursor as string;
    expect(cursor).toBeTruthy();
    const p2 = await market(`/items?category=${SLUG}&limit=2&sort=popular&cursor=${encodeURIComponent(cursor)}`);
    expect(p2.statusCode).toBe(200);
    const seen = [...idsOf(p1), ...idsOf(p2)].sort();
    expect(seen).toEqual(a.items.map((i) => i.id).sort());
    // the same cursor, presented to the other operator's catalogue
    process.env['PUBLIC_TENANT_ID'] = TENANT_B;
    const before = await count('cross_tenant_cursor');
    const foreign = await market(`/items?category=${SLUG}&limit=2&sort=popular&cursor=${encodeURIComponent(cursor)}`);
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('BAD_CURSOR');
    expect(await count('cross_tenant_cursor')).toBe(before + 1);
  });

  it('an unresolvable public tenant is loud: two active operators and no PUBLIC_TENANT_ID, a disabled operator, an id pointing at nothing — 503, never an empty grid', async () => {
    delete process.env['PUBLIC_TENANT_ID'];
    const ambiguous = await market('/items?limit=5');
    expect(ambiguous.statusCode).toBe(503);
    expect(ambiguous.json().error.code).toBe('PUBLIC_TENANT_UNRESOLVED');
    const before = await count('disabled_tenant_hit');
    process.env['PUBLIC_TENANT_ID'] = TENANT_DEAD;
    const dead = await market(`/items?category=${SLUG}&limit=5`);
    expect(dead.statusCode).toBe(503);
    expect(dead.json().error.message).toMatch(/INACTIVE/);
    expect(await count('disabled_tenant_hit')).toBe(before + 1);
    process.env['PUBLIC_TENANT_ID'] = `nope-${RUN}`;
    const nothing = await market('/items?limit=5');
    expect(nothing.statusCode).toBe(503);
  });
});

describe('[R048-003] an authenticated search is the caller’s tenant, on the database fallback', () => {
  it('/search returns only the caller’s vendors and items; the other operator’s identical catalogue is invisible', async () => {
    const ra = await search('/search?q=hammer&limit=20', tokenA);
    expect(ra.statusCode).toBe(200);
    const vendorsA = (ra.json().data.vendors as Array<{ id: string }>).map((v) => v.id);
    const itemsA = (ra.json().data.items as Array<{ id: string }>).map((i) => i.id);
    expect(vendorsA).toContain(a.vendor.id);
    expect(vendorsA).not.toContain(b.vendor.id);
    for (const i of a.items) expect(itemsA).toContain(i.id);
    for (const i of b.items) expect(itemsA).not.toContain(i.id);
    const rb = await search('/search?q=hammer&limit=20', tokenB);
    const itemsB = (rb.json().data.items as Array<{ id: string }>).map((i) => i.id);
    for (const i of b.items) expect(itemsB).toContain(i.id);
    for (const i of a.items) expect(itemsB).not.toContain(i.id);
  });

  it('suggestions, trending and nearby are the caller’s tenant too', async () => {
    const sug = await search('/search/suggestions?q=hammer', tokenA);
    expect(sug.statusCode).toBe(200);
    const texts = (sug.json().data as Array<{ text: string }>).map((s) => s.text);
    expect(texts.some((t) => t.startsWith('Alpha Tools'))).toBe(true);
    expect(texts.some((t) => t.startsWith('Bravo Tools'))).toBe(false);
    const trending = await search('/search/trending', tokenB);
    expect(trending.statusCode).toBe(200);
    const trendingIds = (trending.json().data as Array<{ id: string }>).map((i) => i.id);
    for (const i of a.items) expect(trendingIds).not.toContain(i.id);
    const nearby = await search('/search/nearby?lat=6.8013&lng=-58.1551&radius=5', tokenA);
    expect(nearby.statusCode).toBe(200);
    const nearIds = (nearby.json().data as Array<{ id: string }>).map((v) => v.id);
    expect(nearIds).toContain(a.vendor.id);
    expect(nearIds).not.toContain(b.vendor.id);
  });
});
