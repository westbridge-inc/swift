import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';

// ---------------------------------------------------------------------------
// The category FEED (#17 6.3) = the existing store-list endpoint + category=.
// Membership (chosen + derived) filters; MERGED slugs follow their redirect
// (edge 4 — old links never die); open stores order first; DISH/DIETARY/AISLE
// rows carry the "{n} items" truth; unknown slugs = honest empty, no error.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_770_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeVendor(slug: string | null, over: { open?: boolean; source?: 'VENDOR' | 'DERIVED' } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Feed', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Feed Vendor ${seq}`, slug: `feed-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Feed Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true,
      isCurrentlyOpen: over.open ?? true,
    },
  });
  createdVendorIds.push(vendor.id);
  const menuCat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: menuCat.id, name: `Dish ${seq}`, basePrice: 1000, isAvailable: true },
  });
  if (slug) {
    const cat = await app.prisma.discoveryCategory.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: 'swift-default', slug } },
    });
    await app.prisma.vendorDiscoveryCategory.create({
      data: { tenantId: 'swift-default', vendorId: vendor.id, categoryId: cat.id, role: 'PRIMARY', source: over.source ?? 'VENDOR' },
    });
  }
  return { vendor, item };
}

const feed = (slug: string) => app.inject({ method: 'GET', url: `/api/v1/customer/vendors?category=${slug}` });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await seedDiscoveryTaxonomy(app.prisma);
});

afterAll(async () => {
  const itemIds = (await app.prisma.item.findMany({ where: { vendorId: { in: createdVendorIds } }, select: { id: true } })).map((i) => i.id);
  await app.prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: itemIds } } });
  await app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.discoveryCategory.deleteMany({ where: { slug: { startsWith: 'feed-merged-' } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('the category feed', () => {
  it('filters by membership (chosen AND derived), orders open first, metadata counts items', async () => {
    const a = await makeVendor('vegan-vegetarian', { open: true }); // chosen
    const b = await makeVendor('vegan-vegetarian', { open: false, source: 'DERIVED' }); // derived + closed
    await makeVendor('pizza'); // other category — must not appear

    // Tag A's item so the DIETARY metadata line has truth to count.
    const vegan = await app.prisma.discoveryCategory.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: 'swift-default', slug: 'vegan-vegetarian' } },
    });
    await app.prisma.itemDiscoveryCategory.create({
      data: { tenantId: 'swift-default', itemId: a.item.id, categoryId: vegan.id, source: 'VENDOR' },
    });

    const res = await feed('vegan-vegetarian');
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; isCurrentlyOpen: boolean; itemsInCategory: number | null }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.vendor.id);
    expect(ids).toContain(b.vendor.id); // derived membership counts
    expect(ids).toHaveLength(2);
    expect(rows[0]!.id).toBe(a.vendor.id); // open first
    expect(rows.find((r) => r.id === a.vendor.id)!.itemsInCategory).toBe(1);
  });

  it('a MERGED slug follows its redirect; unknown slugs are an honest empty', async () => {
    const target = await app.prisma.discoveryCategory.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: 'swift-default', slug: 'chinese' } },
    });
    const merged = await app.prisma.discoveryCategory.create({
      data: {
        tenantId: 'swift-default', slug: `feed-merged-${nanoid(6).toLowerCase()}`,
        name: 'Old Wok', kind: 'CUISINE', vertical: 'FOOD', emoji: '🥡',
        aliases: [], status: 'MERGED', mergedIntoId: target.id,
      },
    });
    const member = await makeVendor('chinese');

    const viaMerged = await feed(merged.slug);
    expect((viaMerged.json().data as Array<{ id: string }>).map((r) => r.id)).toContain(member.vendor.id);

    const unknown = await feed('never-existed');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().data).toEqual([]);
  });
});
