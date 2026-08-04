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
import { DiscoveryService } from '../modules/discovery/discovery.service';
import { seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';

// ---------------------------------------------------------------------------
// FIND-BY-CRAVING — vendor surface (CAT-B) + the sticky-choice law (CAT-C):
// one PRIMARY survives a concurrent-write race; curated-only everywhere; ≤3
// item tags with an honest counter error; accept/dismiss/manual tags survive
// repeated engine re-runs byte-for-byte; removing AUTO writes DISMISSED so it
// never comes back; requests rate-limit at 5/day.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let discovery: DiscoveryService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_810_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeOwnerWithVendor() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Cat', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'cat-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Cat Vendor ${seq}`, slug: `cat-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Rail Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, acceptingOrders: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({
    data: {
      vendorId: vendor.id, categoryId: category.id,
      name: 'Chicken chowmein — large', basePrice: 1500, isAvailable: true,
    },
  });
  return { token, vendorId: vendor.id, itemId: item.id };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "one_primary_discovery_category_per_vendor" ON "vendor_discovery_categories"("vendorId") WHERE role = 'PRIMARY'`,
  );
  await seedDiscoveryTaxonomy(app.prisma);
  discovery = new DiscoveryService(app.prisma);
});

afterAll(async () => {
  await app.prisma.discoveryCategorySuggestion.deleteMany({ where: { itemId: { in: (await app.prisma.item.findMany({ where: { vendorId: { in: createdVendorIds } }, select: { id: true } })).map((i) => i.id) } } });
  await app.prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: (await app.prisma.item.findMany({ where: { vendorId: { in: createdVendorIds } }, select: { id: true } })).map((i) => i.id) } } });
  await app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.discoveryCategoryRequest.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('CAT-B: store picks', () => {
  it('sets 1 PRIMARY + 2 secondary over HTTP; free-text slugs refuse; the race leaves exactly one PRIMARY', async () => {
    const ctx = await makeOwnerWithVendor();
    const auth = { authorization: `Bearer ${ctx.token}` };

    const ok = await app.inject({
      method: 'PUT', url: '/api/v1/vendor/store-categories', headers: auth,
      payload: { primarySlug: 'chinese', secondarySlugs: ['fried-chicken', 'juices-smoothies'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.primary.slug).toBe('chinese');
    expect(ok.json().data.secondary).toHaveLength(2);

    const freeText = await app.inject({
      method: 'PUT', url: '/api/v1/vendor/store-categories', headers: auth,
      payload: { primarySlug: 'BURGRZ🍔' },
    });
    expect(freeText.statusCode).toBe(400);

    // The race: two concurrent replaces → afterwards exactly ONE PRIMARY row.
    await Promise.allSettled([
      discovery.setVendorCategories(ctx.vendorId, 'local-creole', ['seafood']),
      discovery.setVendorCategories(ctx.vendorId, 'bbq-grill', []),
    ]);
    const primaries = await app.prisma.vendorDiscoveryCategory.count({
      where: { vendorId: ctx.vendorId, role: 'PRIMARY' },
    });
    expect(primaries).toBe(1);
  });
});

describe('item tags + the counter law', () => {
  it('tags ≤3 with an honest counter error on the 4th; curated only', async () => {
    const ctx = await makeOwnerWithVendor();
    const auth = { authorization: `Bearer ${ctx.token}` };
    const add = (slug: string) =>
      app.inject({ method: 'POST', url: `/api/v1/vendor/items/${ctx.itemId}/categories`, headers: auth, payload: { slug } });

    expect((await add('chinese')).statusCode).toBe(200);
    expect((await add('fried-chicken')).statusCode).toBe(200);
    expect((await add('fast-food')).statusCode).toBe(200);
    const fourth = await add('pizza');
    expect(fourth.statusCode).toBe(400);
    expect(fourth.json().error.message).toContain('3 of 3');

    expect((await add('not-a-category')).statusCode).toBe(400);
  });
});

describe('CAT-C: the sticky human choice', () => {
  it('accept/dismiss/manual survive repeated engine re-runs byte-for-byte; removed AUTO never returns', async () => {
    const ctx = await makeOwnerWithVendor();
    const auth = { authorization: `Bearer ${ctx.token}` };
    const item = await app.prisma.item.findUniqueOrThrow({ where: { id: ctx.itemId } });

    // Engine run files suggestions for the chowmein item.
    await discovery.runMatcherForItem(item);
    const pending = (await app.inject({ method: 'GET', url: `/api/v1/vendor/items/${ctx.itemId}/category-suggestions`, headers: auth })).json().data as Array<{ id: string; slug: string }>;
    expect(pending.length).toBeGreaterThan(0);
    const chinese = pending.find((s) => s.slug === 'chinese')!;
    expect(chinese).toBeTruthy();

    // ACCEPT chinese → tag exists; DISMISS another if present.
    await app.inject({ method: 'POST', url: `/api/v1/vendor/category-suggestions/${chinese.id}/accept`, headers: auth });
    const other = pending.find((s) => s.slug !== 'chinese');
    if (other) await app.inject({ method: 'POST', url: `/api/v1/vendor/category-suggestions/${other.id}/dismiss`, headers: auth });

    const snapshot = async () => ({
      tags: await app.prisma.itemDiscoveryCategory.findMany({ where: { itemId: ctx.itemId }, orderBy: { categoryId: 'asc' } }),
      suggestions: await app.prisma.discoveryCategorySuggestion.findMany({ where: { itemId: ctx.itemId }, orderBy: { categoryId: 'asc' } }),
    });
    const before = await snapshot();

    // The engine re-runs — twice — and resolved ground is untouched.
    await discovery.runMatcherForItem(item);
    await discovery.runMatcherForItem(item);
    const after = await snapshot();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    // AUTO tag removed by the vendor → DISMISSED memory → engine never re-adds.
    const wings = await app.prisma.discoveryCategory.findUniqueOrThrow({ where: { tenantId_slug: { tenantId: 'swift-default', slug: 'wings' } } });
    await app.prisma.itemDiscoveryCategory.create({
      data: { tenantId: 'swift-default', itemId: ctx.itemId, categoryId: wings.id, source: 'AUTO', confidence: 0.9 },
    });
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/vendor/items/${ctx.itemId}/categories/wings`, headers: auth });
    expect(del.statusCode).toBe(200);
    const memory = await app.prisma.discoveryCategorySuggestion.findUnique({
      where: { itemId_categoryId: { itemId: ctx.itemId, categoryId: wings.id } },
    });
    expect(memory?.status).toBe('DISMISSED');
    await discovery.runMatcherForItem(item);
    expect(await app.prisma.itemDiscoveryCategory.count({ where: { itemId: ctx.itemId, categoryId: wings.id } })).toBe(0);
  });
});

describe('category requests', () => {
  it('files into the founder queue; 6th of the day rate-limits at 429', async () => {
    const ctx = await makeOwnerWithVendor();
    const auth = { authorization: `Bearer ${ctx.token}` };
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/vendor/store-categories/request', headers: auth,
        payload: { proposedName: `Fusion ${i}`, note: 'please' },
      });
      expect(res.statusCode).toBe(200);
    }
    const sixth = await app.inject({
      method: 'POST', url: '/api/v1/vendor/store-categories/request', headers: auth,
      payload: { proposedName: 'One more' },
    });
    expect(sixth.statusCode).toBe(429);

    const mine = (await app.inject({ method: 'GET', url: '/api/v1/vendor/store-categories/requests', headers: auth })).json().data;
    expect(mine).toHaveLength(5);
    expect(mine[0].status).toBe('PENDING');
  });
});

describe('cross-vendor isolation (CAT-A probes)', () => {
  it('a foreign vendor cannot read or tag another store\'s items or suggestions', async () => {
    const shopA = await makeOwnerWithVendor();
    const shopB = await makeOwnerWithVendor();
    const authB = { authorization: `Bearer ${shopB.token}` };

    expect((await app.inject({ method: 'GET', url: `/api/v1/vendor/items/${shopA.itemId}/category-suggestions`, headers: authB })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/vendor/items/${shopA.itemId}/categories`, headers: authB, payload: { slug: 'chinese' } })).statusCode).toBe(404);

    const itemA = await app.prisma.item.findUniqueOrThrow({ where: { id: shopA.itemId } });
    await discovery.runMatcherForItem(itemA);
    const sug = await app.prisma.discoveryCategorySuggestion.findFirst({ where: { itemId: shopA.itemId } });
    if (sug) {
      expect((await app.inject({ method: 'POST', url: `/api/v1/vendor/category-suggestions/${sug.id}/accept`, headers: authB })).statusCode).toBe(404);
    }
  });
});
