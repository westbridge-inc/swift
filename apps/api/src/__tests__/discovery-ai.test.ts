import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { runAiClassifierBatch, catAiHallucinatedTotal, type CategoryClassifier } from '../modules/discovery/ai-classifier';
import { seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';

// ---------------------------------------------------------------------------
// CAT-E — AI stage discipline: hallucinated slugs are dropped and counted
// (never stored); the daily budget makes the queue WAIT, silently; disabled =
// no-op; every classified item leaves an audit row; already-placed items are
// never candidates (law C by query).
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_790_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeVendorWithItems(names: string[]) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Ai', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  const owner = await prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Ai Vendor ${seq}`, slug: `ai-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Model Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const items = [];
  for (const name of names) {
    items.push(await prisma.item.create({
      data: { vendorId: vendor.id, categoryId: category.id, name, basePrice: 1000, isAvailable: true },
    }));
  }
  return { vendor, items };
}

const fake = (
  responses: Record<string, Array<{ slug: string; confidence: number }>>,
  enabled = true,
): CategoryClassifier => ({
  enabled,
  classifyCategories: async (items) => {
    const out: Record<string, Array<{ slug: string; confidence: number }>> = {};
    for (const i of items) out[i.id] = responses[i.name] ?? [];
    return out;
  },
});

beforeAll(async () => {
  await prisma.$connect();
  await seedDiscoveryTaxonomy(prisma);
});

afterAll(async () => {
  const itemIds = (await prisma.item.findMany({ where: { vendorId: { in: createdVendorIds } }, select: { id: true } })).map((i) => i.id);
  await prisma.agentAuditEvent.deleteMany({ where: { job: 'categorizer', subjectId: { in: itemIds } } });
  await prisma.discoveryCategorySuggestion.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe('CAT-E: AI stage discipline', () => {
  it('valid slugs land as stage=AI suggestions; hallucinations dropped + counted; audit rows written', async () => {
    const { items } = await makeVendorWithItems(['Mystery platter one', 'Mystery platter two']);
    const before = catAiHallucinatedTotal();

    const r = await runAiClassifierBatch(prisma, fake({
      'Mystery platter one': [
        { slug: 'local-creole', confidence: 0.9 },
        { slug: 'not-a-real-category', confidence: 0.99 }, // hallucination
      ],
      'Mystery platter two': [{ slug: 'seafood', confidence: 0.7 }],
    }), { limit: 10, vendorId: items[0]!.vendorId });

    expect(r.scanned).toBe(2);
    expect(r.suggested).toBe(2);
    expect(r.dropped).toBe(1);
    expect(catAiHallucinatedTotal()).toBe(before + 1);

    const s1 = await prisma.discoveryCategorySuggestion.findMany({ where: { itemId: items[0]!.id } });
    expect(s1).toHaveLength(1); // the hallucination was never stored
    expect(s1[0]!.stage).toBe('AI');
    expect(s1[0]!.status).toBe('PENDING');

    const audits = await prisma.agentAuditEvent.count({ where: { job: 'categorizer', subjectId: { in: items.map((i) => i.id) } } });
    expect(audits).toBe(2);
  });

  it('already-suggested items are never candidates again (law C by query)', async () => {
    const { items } = await makeVendorWithItems(['Once only dish']);
    await runAiClassifierBatch(prisma, fake({ 'Once only dish': [{ slug: 'pizza', confidence: 0.8 }] }), { limit: 10, vendorId: items[0]!.vendorId });
    const r2 = await runAiClassifierBatch(prisma, fake({ 'Once only dish': [{ slug: 'wings', confidence: 0.9 }] }), { limit: 10, vendorId: items[0]!.vendorId });
    const rows = await prisma.discoveryCategorySuggestion.findMany({ where: { itemId: items[0]!.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe('AI');
    void r2;
  });

  it('disabled classifier = silent no-op', async () => {
    const { items } = await makeVendorWithItems(['Disabled dish']);
    const r = await runAiClassifierBatch(prisma, fake({}, false), { limit: 10, vendorId: items[0]!.vendorId });
    expect(r).toEqual({ scanned: 0, suggested: 0, dropped: 0, budgetLeft: 0 });
    expect(await prisma.discoveryCategorySuggestion.count({ where: { itemId: items[0]!.id } })).toBe(0);
  });
});
