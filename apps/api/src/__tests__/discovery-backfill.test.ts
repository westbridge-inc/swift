import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { categoryBackfillNotifiedMarker, runCategoryBackfill } from '../modules/discovery/backfill';
import { seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';
import type { CategoryClassifier } from '../modules/discovery/ai-classifier';

// ---------------------------------------------------------------------------
// CAT-I — the backfill movement: Stage A across the live catalog, Stage B for
// the remainder, Stage C derivation, ONE notification per vendor with
// pending suggestions. The law under test: a re-run is a byte-for-byte no-op
// — zero new suggestion rows, zero re-notifications.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_750_000_000 + Math.floor(Math.random() * 9_000_000);
const tenantId = `test-discovery-backfill-${nanoid(8).toLowerCase()}`;
const TEST_NOW = new Date('2084-07-16T08:00:00.000Z');

async function makeVendorWithMenu(names: string[]) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Bf', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
      tenantId,
    },
  });
  createdUserIds.push(user.id);
  const owner = await prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Bf Vendor ${seq}`, slug: `bf-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Backfill Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, tenantId,
    },
  });
  createdVendorIds.push(vendor.id);
  const menuCat = await prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const items = [];
  for (const name of names) {
    items.push(await prisma.item.create({
      data: { vendorId: vendor.id, categoryId: menuCat.id, name, basePrice: 1200, isAvailable: true },
    }));
  }
  return { vendor, ownerUserId: user.id, items };
}

const fakeAi = (map: Record<string, Array<{ slug: string; confidence: number }>>): CategoryClassifier => ({
  enabled: true,
  classifyCategories: async (items) => {
    const out: Record<string, Array<{ slug: string; confidence: number }>> = {};
    for (const i of items) out[i.id] = map[i.name] ?? [];
    return out;
  },
});

beforeAll(async () => {
  await prisma.$connect();
  await prisma.tenant.create({ data: { id: tenantId, name: 'Discovery Backfill Test', slug: tenantId } });
  await seedDiscoveryTaxonomy(prisma, tenantId);
});

afterAll(async () => {
  await prisma.platformConfig.deleteMany({ where: { key: categoryBackfillNotifiedMarker(tenantId) } });
  const itemIds = (await prisma.item.findMany({ where: { vendorId: { in: createdVendorIds } }, select: { id: true } })).map((i) => i.id);
  await prisma.agentAuditEvent.deleteMany({ where: { job: 'categorizer', subjectId: { in: itemIds } } });
  await prisma.discoveryCategorySuggestion.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.discoveryCategory.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
  await prisma.$disconnect();
});

describe('CAT-I: the backfill movement', () => {
  it('A→B→C→notify runs the catalog; a re-run writes zero new rows and never re-notifies', async () => {
    // A menu Stage A can mostly place + one line only the AI can.
    const shop = await makeVendorWithMenu([
      'Chicken chowmein — special', // matcher: chinese
      'Dhalpuri with duck curry', // matcher: roti-curry
      'The Thursday Thing', // matcher blind → AI places it
    ]);
    const notified: string[] = [];
    const opts = {
      tenantId,
      now: TEST_NOW,
      notify: async (userId: string) => { notified.push(userId); },
    };
    const ai = fakeAi({ 'The Thursday Thing': [{ slug: 'local-creole', confidence: 0.7 }] });

    const first = await runCategoryBackfill(prisma, ai, opts);
    expect(first.itemsScanned).toBe(3);
    expect(first.matcherSuggestionsWritten).toBeGreaterThanOrEqual(2);
    expect(first.aiScanned).toBe(1);
    expect(first.aiSuggested).toBe(1);
    expect(first.vendorsNotified).toBe(1);
    expect(notified).toContain(shop.ownerUserId);
    const firstNotifiedCount = notified.length;

    const itemIds = shop.items.map((i) => i.id);
    const rowsAfterFirst = await prisma.discoveryCategorySuggestion.findMany({
      where: { itemId: { in: itemIds } },
      orderBy: [{ itemId: 'asc' }, { categoryId: 'asc' }],
    });
    expect(rowsAfterFirst.length).toBeGreaterThanOrEqual(3);

    // The re-run law: same rows byte-for-byte, nobody re-notified.
    const second = await runCategoryBackfill(prisma, ai, opts);
    const rowsAfterSecond = await prisma.discoveryCategorySuggestion.findMany({
      where: { itemId: { in: itemIds } },
      orderBy: [{ itemId: 'asc' }, { categoryId: 'asc' }],
    });
    expect(JSON.stringify(rowsAfterSecond)).toBe(JSON.stringify(rowsAfterFirst));
    expect(second.vendorsNotified).toBe(0);
    expect(notified.length).toBe(firstNotifiedCount);
  });
});
