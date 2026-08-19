import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import {
  qualifiesDerived,
  reconcileAllDerived,
  reconcileVendorDerived,
  CAT_DERIVE_MIN_ITEMS,
  CAT_DERIVE_SHARE,
} from '../modules/discovery/derivation';
import { seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';

// ---------------------------------------------------------------------------
// CAT-F — the derivation math: 4 items→no, 5→yes, 25% share→yes, drop
// below→row removed, chosen rows NEVER touched. Stage C writes only
// source=DERIVED, by construction.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_800_000_000 + Math.floor(Math.random() * 9_000_000);
const tenantId = `test-discovery-derive-${nanoid(8).toLowerCase()}`;
const scopedTenantId = `test-discovery-sweep-${nanoid(8).toLowerCase()}`;
const otherTenantId = `test-discovery-other-${nanoid(8).toLowerCase()}`;
const tenantIds = [tenantId, scopedTenantId, otherTenantId];

async function makeVendorWithItems(liveCount: number, targetTenantId = tenantId) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Der', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
      tenantId: targetTenantId,
    },
  });
  createdUserIds.push(user.id);
  const owner = await prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Der Vendor ${seq}`, slug: `der-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Derive Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, tenantId: targetTenantId,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const items = [];
  for (let i = 0; i < liveCount; i += 1) {
    items.push(await prisma.item.create({
      data: { vendorId: vendor.id, categoryId: category.id, name: `Dish ${i}`, basePrice: 1000, isAvailable: true },
    }));
  }
  return { vendor, items };
}

async function tag(itemIds: string[], slug: string, targetTenantId = tenantId) {
  const cat = await prisma.discoveryCategory.findUniqueOrThrow({
    where: { tenantId_slug: { tenantId: targetTenantId, slug } },
  });
  for (const itemId of itemIds) {
    await prisma.itemDiscoveryCategory.upsert({
      where: { itemId_categoryId: { itemId, categoryId: cat.id } },
      create: { tenantId: targetTenantId, itemId, categoryId: cat.id, source: 'VENDOR' },
      update: {},
    });
  }
  return cat;
}

beforeAll(async () => {
  await prisma.$connect();
  for (const id of tenantIds) {
    await prisma.tenant.create({ data: { id, name: `Discovery Derivation ${id}`, slug: id } });
    await seedDiscoveryTaxonomy(prisma, id);
  }
});

afterAll(async () => {
  const itemIds = (await prisma.item.findMany({ where: { vendorId: { in: createdVendorIds } }, select: { id: true } })).map((i) => i.id);
  await prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.discoveryCategory.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe('the threshold table (pure)', () => {
  it('4 items → no; 5 → yes; 25% share → yes; below both → no', () => {
    expect(CAT_DERIVE_MIN_ITEMS).toBe(5);
    expect(CAT_DERIVE_SHARE).toBe(0.25);
    expect(qualifiesDerived(4, 40)).toBe(false); // 4 < 5 and 10% < 25%
    expect(qualifiesDerived(5, 40)).toBe(true); // count wins
    expect(qualifiesDerived(3, 12)).toBe(true); // 25% share wins
    expect(qualifiesDerived(2, 12)).toBe(false);
    expect(qualifiesDerived(0, 0)).toBe(false);
  });
});

describe('reconcile writes ONLY derived rows', () => {
  it('qualifies in, drops out when items fall below, and never touches chosen rows', async () => {
    const { vendor, items } = await makeVendorWithItems(12);
    const vegan = await tag(items.slice(0, 3).map((i) => i.id), 'vegan-vegetarian'); // 3/12 = 25% → qualifies

    // A CHOSEN row for another category exists and must survive everything.
    const chinese = await prisma.discoveryCategory.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId, slug: 'chinese' } },
    });
    const chosen = await prisma.vendorDiscoveryCategory.create({
      data: { tenantId, vendorId: vendor.id, categoryId: chinese.id, role: 'PRIMARY', source: 'VENDOR' },
    });

    let r = await reconcileVendorDerived(prisma, vendor.id, tenantId);
    expect(r.added).toBe(1);
    const derived = await prisma.vendorDiscoveryCategory.findFirst({
      where: { vendorId: vendor.id, categoryId: vegan.id },
    });
    expect(derived?.source).toBe('DERIVED');

    // Idempotent second run: nothing changes.
    r = await reconcileVendorDerived(prisma, vendor.id, tenantId);
    expect(r).toEqual({ added: 0, removed: 0 });

    // Items go unavailable → share falls → the DERIVED row (and only it) goes.
    await prisma.item.updateMany({ where: { id: { in: items.slice(0, 2).map((i) => i.id) } }, data: { isAvailable: false } });
    r = await reconcileVendorDerived(prisma, vendor.id, tenantId); // 1 tagged / 10 live = 10%, count 1 < 5
    expect(r.removed).toBe(1);
    expect(await prisma.vendorDiscoveryCategory.count({ where: { vendorId: vendor.id, categoryId: vegan.id } })).toBe(0);

    const chosenAfter = await prisma.vendorDiscoveryCategory.findUniqueOrThrow({ where: { id: chosen.id } });
    expect(chosenAfter.source).toBe('VENDOR'); // untouched, byte-for-byte role
    expect(chosenAfter.role).toBe('PRIMARY');
  });

  it('a chosen category never gains a duplicate DERIVED row', async () => {
    const { vendor, items } = await makeVendorWithItems(6);
    const cat = await tag(items.map((i) => i.id), 'pizza'); // 6 ≥ 5 qualifies
    await prisma.vendorDiscoveryCategory.create({
      data: { tenantId, vendorId: vendor.id, categoryId: cat.id, role: 'PRIMARY', source: 'VENDOR' },
    });
    const r = await reconcileVendorDerived(prisma, vendor.id, tenantId);
    expect(r.added).toBe(0);
    expect(await prisma.vendorDiscoveryCategory.count({ where: { vendorId: vendor.id, categoryId: cat.id } })).toBe(1);
  });
});

describe('tenant-scoped sweep', () => {
  it('reconciles only the requested tenant; the scheduler must enumerate tenants explicitly', async () => {
    const scoped = await makeVendorWithItems(5, scopedTenantId);
    const other = await makeVendorWithItems(5, otherTenantId);
    await tag(scoped.items.map((item) => item.id), 'pizza', scopedTenantId);
    await tag(other.items.map((item) => item.id), 'pizza', otherTenantId);

    const report = await reconcileAllDerived(prisma, scopedTenantId);
    expect(report).toMatchObject({ vendors: 1, added: 1, removed: 0 });
    expect(await prisma.vendorDiscoveryCategory.count({
      where: { vendorId: scoped.vendor.id, source: 'DERIVED' },
    })).toBe(1);
    expect(await prisma.vendorDiscoveryCategory.count({
      where: { vendorId: other.vendor.id, source: 'DERIVED' },
    })).toBe(0);

    const crossTenantAttempt = await reconcileVendorDerived(prisma, other.vendor.id, scopedTenantId);
    expect(crossTenantAttempt).toEqual({ added: 0, removed: 0 });
    expect(await prisma.vendorDiscoveryCategory.count({
      where: { vendorId: other.vendor.id, source: 'DERIVED' },
    })).toBe(0);
  });
});
