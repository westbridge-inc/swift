import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { DiscoveryGovernanceService } from '../modules/discovery/admin-governance';
import { seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';

// ---------------------------------------------------------------------------
// CAT-J + the request queue: a merge repoints every tag/suggestion row in one
// transaction with dedupe on the uniques — before === after + dedupes, zero
// orphans, source marked MERGED (the feed already proves redirects). Requests
// dispose exactly once (approve → ACTIVE category; map → existing + ADMIN
// secondary; reject → reason kept verbatim).
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});
const gov = new DiscoveryGovernanceService(prisma);

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdCategoryIds: string[] = [];
let seq = 0;
const phoneBase = 592_760_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeVendorWithItem() {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Gov', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  const owner = await prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Gov Vendor ${seq}`, slug: `gov-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Queue Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const menuCat = await prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const item = await prisma.item.create({
    data: { vendorId: vendor.id, categoryId: menuCat.id, name: `Gov Dish ${seq}`, basePrice: 900, isAvailable: true },
  });
  return { vendor, item };
}

async function makeCategory(slug: string) {
  const c = await prisma.discoveryCategory.create({
    data: {
      tenantId: 'swift-default', slug, name: slug, kind: 'DISH', vertical: 'FOOD',
      emoji: '🍽️', aliases: [], status: 'ACTIVE',
    },
  });
  createdCategoryIds.push(c.id);
  return c;
}

beforeAll(async () => {
  await prisma.$connect();
  await seedDiscoveryTaxonomy(prisma);
});

afterAll(async () => {
  const itemIds = (await prisma.item.findMany({ where: { vendorId: { in: createdVendorIds } }, select: { id: true } })).map((i) => i.id);
  await prisma.discoveryCategorySuggestion.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.discoveryCategoryRequest.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.discoveryCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await prisma.discoveryCategory.deleteMany({ where: { slug: { startsWith: 'fusion-' } } });
  await prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe('CAT-J: the merge law', () => {
  it('repoints every row with dedupe; before === after + dedupes; zero orphans; source MERGED', async () => {
    const source = await makeCategory(`merge-src-${nanoid(6).toLowerCase()}`);
    const target = await makeCategory(`merge-tgt-${nanoid(6).toLowerCase()}`);
    const a = await makeVendorWithItem(); // member of BOTH (dedupe case)
    const b = await makeVendorWithItem(); // member of source only (repoint case)

    for (const [vendorId, cats] of [[a.vendor.id, [source.id, target.id]], [b.vendor.id, [source.id]]] as const) {
      for (const categoryId of cats) {
        await prisma.vendorDiscoveryCategory.create({
          data: { tenantId: 'swift-default', vendorId, categoryId, role: 'SECONDARY', source: 'VENDOR' },
        });
      }
    }
    await prisma.itemDiscoveryCategory.create({
      data: { tenantId: 'swift-default', itemId: a.item.id, categoryId: source.id, source: 'VENDOR' },
    });
    await prisma.itemDiscoveryCategory.create({
      data: { tenantId: 'swift-default', itemId: a.item.id, categoryId: target.id, source: 'VENDOR' },
    });
    await prisma.itemDiscoveryCategory.create({
      data: { tenantId: 'swift-default', itemId: b.item.id, categoryId: source.id, source: 'VENDOR' },
    });

    const result = await gov.mergeCategories(source.id, target.id);
    // Vendors: before 3 (a×2 + b×1) = after 2 (a,b on target) + 1 dedupe.
    expect(result.beforeCounts.vendor).toBe(3);
    expect(result.afterCounts.vendor).toBe(2);
    expect(result.dedupes.vendor).toBe(1);
    // Items: before 3 = after 2 + 1 dedupe.
    expect(result.beforeCounts.item).toBe(3);
    expect(result.afterCounts.item).toBe(2);
    expect(result.dedupes.item).toBe(1);

    const orphans = await prisma.vendorDiscoveryCategory.count({ where: { categoryId: source.id } })
      + await prisma.itemDiscoveryCategory.count({ where: { categoryId: source.id } });
    expect(orphans).toBe(0);

    const merged = await prisma.discoveryCategory.findUniqueOrThrow({ where: { id: source.id } });
    expect(merged.status).toBe('MERGED');
    expect(merged.mergedIntoId).toBe(target.id);

    // Self-merge and re-merge refuse.
    await expect(gov.mergeCategories(target.id, target.id)).rejects.toMatchObject({ code: 'SELF_MERGE' });
    await expect(gov.mergeCategories(source.id, target.id)).rejects.toMatchObject({ code: 'ALREADY_MERGED' });
  });
});

describe('the request queue', () => {
  it('approve births an ACTIVE category; map tags the store as ADMIN secondary; reject keeps the reason; each disposes once', async () => {
    const { vendor } = await makeVendorWithItem();
    const mk = (name: string) =>
      prisma.discoveryCategoryRequest.create({
        data: { tenantId: 'swift-default', vendorId: vendor.id, proposedName: name },
      });

    // APPROVE
    const r1 = await mk('Fusion Kitchen');
    const approved = await gov.approveRequest(r1.id, { emoji: '🍱', kind: 'CUISINE', vertical: 'FOOD', resolvedBy: 'admin-1' });
    createdCategoryIds.push(approved.category.id);
    expect(approved.category.status).toBe('ACTIVE');
    expect(approved.category.slug).toBe('fusion-kitchen');
    expect((await prisma.discoveryCategoryRequest.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe('APPROVED');
    await expect(gov.approveRequest(r1.id, { emoji: '🍱', kind: 'CUISINE', vertical: 'FOOD', resolvedBy: 'admin-1' }))
      .rejects.toMatchObject({ code: 'ALREADY_RESOLVED' });

    // MAP → the store gains an ADMIN secondary for the target.
    const r2 = await mk('Chow Main');
    await gov.mapRequest(r2.id, 'chinese', 'admin-1');
    const chinese = await prisma.discoveryCategory.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: 'swift-default', slug: 'chinese' } },
    });
    const membership = await prisma.vendorDiscoveryCategory.findUnique({
      where: { vendorId_categoryId: { vendorId: vendor.id, categoryId: chinese.id } },
    });
    expect(membership?.source).toBe('ADMIN');
    expect(membership?.role).toBe('SECONDARY');

    // REJECT — the reason survives verbatim (the vendor reads it).
    const r3 = await mk('BURGRZ');
    await gov.rejectRequest(r3.id, 'Covered by Burgers — use that category.', 'admin-1');
    const rejected = await prisma.discoveryCategoryRequest.findUniqueOrThrow({ where: { id: r3.id } });
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.resolvedNote).toBe('Covered by Burgers — use that category.');
  });
});
