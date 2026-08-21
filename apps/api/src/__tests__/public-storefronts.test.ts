import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { registerErrorHandler } from '../middleware/error-handler';
import { publicRoutes } from '../modules/public/public.routes';

// ---------------------------------------------------------------------------
// Public storefronts: the unauthenticated SEO surface. Only ACTIVE + verified
// stores exist; the payload must never leak operational/personal fields.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const marker = `pubsf${nanoid(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
let liveSlug: string;
let hiddenSlug: string;
const vendorIds: string[] = [];
let ownerId: string;
let userId: string;

async function makeVendor(overrides: Record<string, unknown>) {
  const suffix = nanoid(6).toLowerCase();
  const v = await app.prisma.vendor.create({
    data: {
      ownerId,
      name: `${marker} ${suffix}`,
      slug: `${marker}-${suffix}`,
      vendorType: 'RESTAURANT',
      phone: '+5926990000',
      addressLine1: '1 Test Street',
      city: 'Georgetown',
      region: 'Demerara',
      latitude: 6.8,
      longitude: -58.16,
      ...overrides,
    },
  });
  vendorIds.push(v.id);
  return v;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();

  // A vendor needs an owner (User + VendorOwner)
  const user = await app.prisma.user.create({
    data: {
      phone: `+59269${Math.floor(Math.random() * 90000) + 10000}`,
      roles: ['VENDOR_OWNER'] as never[], activeRole: 'VENDOR_OWNER' as never,
      firstName: 'Pub', lastName: 'Test', isPhoneVerified: true,
    },
  });
  userId = user.id;
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  ownerId = owner.id;

  const live = await makeVendor({ status: 'ACTIVE', isVerified: true, description: 'A public place' });
  liveSlug = live.slug;
  const hidden = await makeVendor({ status: 'PENDING_APPROVAL', isVerified: false });
  hiddenSlug = hidden.slug;
  // Suspended-but-verified must also be invisible
  await makeVendor({ status: 'SUSPENDED', isVerified: true });

  // Menu on the live store: one category with an available + an unavailable item
  const cat = await app.prisma.category.create({ data: { vendorId: live.id, name: 'Mains', sortOrder: 0 } });
  await app.prisma.item.create({
    data: { vendorId: live.id, categoryId: cat.id, name: `${marker} plate`, basePrice: 1500, isAvailable: true, sku: 'SECRET-SKU', stockQuantity: 7 },
  });
  await app.prisma.item.create({
    data: { vendorId: live.id, categoryId: cat.id, name: `${marker} gone`, basePrice: 900, isAvailable: false },
  });
  // An empty category must not appear publicly
  await app.prisma.category.create({ data: { vendorId: live.id, name: 'Empty shelf', sortOrder: 1 } });
});

afterAll(async () => {
  // Guard every id: an aborted beforeAll must never turn a scoped cleanup
  // into a table-wide deleteMany({ where: { id: undefined } }).
  if (vendorIds.length > 0) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  }
  if (ownerId) await app.prisma.vendorOwner.deleteMany({ where: { id: ownerId } });
  if (userId) await app.prisma.user.deleteMany({ where: { id: userId } });
  await app.close();
});

describe('public storefront directory', () => {
  it('lists only ACTIVE + verified stores, without a token', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts?q=${marker}` });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ slug: string }>;
    expect(rows.map((r) => r.slug)).toContain(liveSlug);
    expect(rows).toHaveLength(1); // pending + suspended invisible
  });

  it('never exposes operational or personal fields on the list', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts?q=${marker}` });
    const row = res.json().data[0];
    for (const leak of ['phone', 'email', 'latitude', 'longitude', 'addressLine1', 'totalOrders', 'ownerId']) {
      expect(row).not.toHaveProperty(leak);
    }
  });

  it('filters by type', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts?q=${marker}&type=SUPERMARKET` });
    expect(res.json().data).toHaveLength(0);
  });
});

describe('public storefront page', () => {
  it('serves the live store by slug with its available menu only', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts/${liveSlug}` });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.slug).toBe(liveSlug);
    expect(d.addressLine1).toBe('1 Test Street');
    expect(d.operatingHours).toBeDefined();
    // Menu: only the available item, empty categories pruned
    expect(d.categories).toHaveLength(1);
    expect(d.categories[0].items).toHaveLength(1);
    const item = d.categories[0].items[0];
    expect(item.name).toContain('plate');
    expect(item.basePrice).toBe(1500);
    // Competitive/internal item fields stay private
    for (const leak of ['sku', 'stockQuantity', 'barcode', 'totalOrdered']) {
      expect(item).not.toHaveProperty(leak);
    }
  });

  it('404s a store that is not live commerce (pending or unknown)', async () => {
    const pending = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts/${hiddenSlug}` });
    expect(pending.statusCode).toBe(404);
    const unknown = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts/never-existed-${marker}` });
    expect(unknown.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// [F-027-13] PUBLIC_TENANT_ID is an input, not a fact.
//
// It used to be returned on sight. Public visibility is decided by the
// VENDOR's status alone, so an explicitly configured tenant that had since
// been DEACTIVATED kept its still-ACTIVE vendors publicly listable and
// orderable — deactivating an operator did not take their storefront off the
// internet. An id pointing at nothing produced a silent empty directory
// instead of naming the broken deployment.
//
// These run last and always restore the env var: everything above depends on
// the unset (single-active-tenant) path.
// ---------------------------------------------------------------------------
describe('[F-027-13] the configured public tenant is verified, and failures are loud', () => {
  const restore = process.env['PUBLIC_TENANT_ID'];
  afterEach(() => {
    if (restore === undefined) delete process.env['PUBLIC_TENANT_ID'];
    else process.env['PUBLIC_TENANT_ID'] = restore;
  });

  it('an INACTIVE configured tenant serves nothing — deactivating an operator takes their storefront off the internet', async () => {
    const dead = `pub-dead-${nanoid(6)}`;
    await app.prisma.tenant.create({ data: { id: dead, name: 'Deactivated operator', slug: dead, isActive: false } });
    try {
      process.env['PUBLIC_TENANT_ID'] = dead;
      const list = await app.inject({ method: 'GET', url: '/api/v1/public/storefronts' });
      expect(list.statusCode).toBe(503);
      expect(list.json().error.code).toBe('PUBLIC_TENANT_UNRESOLVED');
      expect(list.json().error.message).toMatch(/INACTIVE/);
      // and the detail page cannot be used to walk around the directory
      const page = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts/${liveSlug}` });
      expect(page.statusCode).toBe(503);
    } finally {
      await app.prisma.tenant.deleteMany({ where: { id: dead } });
    }
  });

  it('a configured tenant that does not exist NAMES the misconfiguration instead of serving an empty catalog', async () => {
    process.env['PUBLIC_TENANT_ID'] = `pub-ghost-${nanoid(6)}`;
    const list = await app.inject({ method: 'GET', url: '/api/v1/public/storefronts' });
    // A silent empty directory reads as "no stores yet" — indistinguishable
    // from a healthy launch day, and nobody investigates it.
    expect(list.statusCode).toBe(503);
    expect(list.json().error.message).toMatch(/does not exist/);
  });

  it('a correction takes effect on the NEXT request — no cache pins a broken deployment', async () => {
    // The old 60s cache stored a topology CONCLUSION, so a corrected
    // deployment stayed broken for up to a minute after the fix.
    process.env['PUBLIC_TENANT_ID'] = `pub-ghost-${nanoid(6)}`;
    expect((await app.inject({ method: 'GET', url: '/api/v1/public/storefronts' })).statusCode).toBe(503);
    delete process.env['PUBLIC_TENANT_ID'];
    const fixed = await app.inject({ method: 'GET', url: '/api/v1/public/storefronts' });
    expect(fixed.statusCode).toBe(200);
  });

  it('an ACTIVE configured tenant still serves normally', async () => {
    const mine = await app.prisma.vendor.findUniqueOrThrow({ where: { slug: liveSlug }, select: { tenantId: true } });
    process.env['PUBLIC_TENANT_ID'] = mine.tenantId;
    const list = await app.inject({ method: 'GET', url: '/api/v1/public/storefronts' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.some((v: { slug: string }) => v.slug === liveSlug)).toBe(true);
  });
});
