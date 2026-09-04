import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { seedRetailCatalogue } from '../modules/market/retail-catalogue.seed';
import { seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';
import { marketGate, MARKET_MIN_ITEMS, MARKET_MIN_VENDORS } from '../modules/market/launch-depth';

// ---------------------------------------------------------------------------
// [MKT G3/G7] The retail catalogue, and the two silent failures it hit.
//
// The Market tab draws from STORE vendors. The platform had exactly one —
// City Hardware, five items — so G7's launch gate (150 items / 2 vendors)
// correctly HID the tab, and a demo could not show its own marketplace. This
// seed is the other half.
//
// Building it surfaced two failures that both reported success:
//
//  1. The cross-vendor taxonomy is seeded at API BOOT (server.ts), not by the
//     seed script. Seeding a fresh database before the API had ever started
//     produced 151 items and ZERO tags — a Market tab whose category filters
//     match nothing — and the seed printed "Seed complete!".
//
//  2. Items and STORES are filed into that taxonomy through two DIFFERENT
//     tables. `/market/items?category=` filters on item tags; the CHIPS are
//     counted from `vendor_discovery_categories`. Tagging only items gives a
//     tab whose filters work and whose rail is empty, every chip dropped by
//     "law D: no dead taps".
//
//     Worse, Postgres carries a partial unique index the Prisma schema does
//     not express — `one_primary_discovery_category_per_vendor UNIQUE
//     (vendorId) WHERE role = 'PRIMARY'` — so a store filed into a second
//     category as PRIMARY is REJECTED. With `skipDuplicates: true` that
//     rejection is silent: 15 memberships were attempted, 7 were written, and
//     the seed reported success. Six of seven stores were missing from every
//     category rail but their first.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const tenantId = 'swift-default';
/** Marks this file's throwaway rows as synthetic. Without it the owner below
 *  counts as an UNCLASSIFIED user, and `purge-plan.test.ts` asserts that its
 *  unclassified count does not move underneath it — two files running in
 *  parallel, one silently failing the other. */
const RUN_ID = `test:retail-catalogue:${nanoid(8)}`;
let ownerId = '';
let userId = '';
/** True when THIS file created the catalogue. CI runs the demo seed before the
 *  suite, so the usual case is that the stores already exist — and then they
 *  are not ours to delete. */
let weCreatedIt = false;
const slugs = [
  'stabroek-threads', 'regent-home-store', 'camp-street-electronics', 'bourda-pharmacy',
  'demerara-stationers', 'kitty-sports-and-auto', 'bourda-variety',
];

beforeAll(async () => {
  await seedDiscoveryTaxonomy(prisma, tenantId);
  const existing = await prisma.vendor.findFirst({ where: { slug: { in: slugs } }, select: { ownerId: true } });
  if (existing) {
    // The demo seed got here first — grade what it produced, and touch nothing.
    ownerId = existing.ownerId;
    return;
  }
  weCreatedIt = true;
  const user = await prisma.user.create({
    data: {
      phone: `+592819${String(Math.floor(Math.random() * 900000) + 100000)}`,
      firstName: 'Seed', lastName: `Owner${nanoid(4)}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
      syntheticRunId: RUN_ID,
      vendorOwner: { create: {} },
    },
  });
  userId = user.id;
  ownerId = (await prisma.vendorOwner.findUniqueOrThrow({ where: { userId } })).id;
});

afterAll(async () => {
  // Only ever tear down a catalogue this file created. Deleting the demo
  // seed's stores would leave the shared database missing the marketplace
  // other suites may reasonably expect to find.
  if (weCreatedIt) {
    const vendors = await prisma.vendor.findMany({ where: { slug: { in: slugs } }, select: { id: true } });
    const ids = vendors.map((v) => v.id);
    const items = await prisma.item.findMany({ where: { vendorId: { in: ids } }, select: { id: true } });
    await prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: items.map((i) => i.id) } } });
    await prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: ids } } });
    await prisma.item.deleteMany({ where: { vendorId: { in: ids } } });
    await prisma.category.deleteMany({ where: { vendorId: { in: ids } } });
    await prisma.vendor.deleteMany({ where: { id: { in: ids } } });
    await prisma.vendorOwner.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

describe('[MKT G3/G7] the retail catalogue seed', () => {
  // Every assertion grades the DATABASE, never one call's return value. The
  // seed is idempotent, so on CI — where the demo seed has already run — those
  // counters are legitimately zero. An earlier draft asserted the deltas and
  // went red for exactly that reason: it was measuring "did this call do work",
  // when the thing that matters is "is the catalogue correct".
  it('files every item into the taxonomy AND every store into the rail', async () => {
    await seedRetailCatalogue(prisma, ownerId, tenantId);

    const vendors = await prisma.vendor.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } });
    expect(vendors.length).toBe(slugs.length);

    const items = await prisma.item.findMany({
      where: { vendorId: { in: vendors.map((v) => v.id) } },
      select: { id: true, name: true },
    });
    expect(items.length).toBeGreaterThan(100);

    // A catalogue with no tags is a Market tab whose filters match nothing —
    // which is exactly what a database seeded before the API ever booted got,
    // while the seed printed "Seed complete!".
    const tagged = await prisma.itemDiscoveryCategory.count({ where: { itemId: { in: items.map((i) => i.id) } } });
    expect(tagged, 'items exist but were never filed into the taxonomy').toBe(items.length);

    // ...and the SEPARATE table the chips are counted from.
    const memberships = await prisma.vendorDiscoveryCategory.count({ where: { vendorId: { in: vendors.map((v) => v.id) } } });
    expect(memberships, 'no store membership means an empty category rail').toBeGreaterThanOrEqual(vendors.length);
  });

  it('a store claims exactly ONE primary category, however many it sells in', async () => {
    // The rule Postgres enforces and the schema does not state:
    //   one_primary_discovery_category_per_vendor UNIQUE (vendorId)
    //     WHERE role = 'PRIMARY'
    // Getting it wrong is silent under `skipDuplicates` — the row is dropped,
    // the count looks plausible, and the store vanishes from every rail but one.
    const vendors = await prisma.vendor.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } });
    expect(vendors.length).toBe(slugs.length);

    const spans: number[] = [];
    for (const v of vendors) {
      const rows = await prisma.vendorDiscoveryCategory.findMany({ where: { vendorId: v.id }, select: { role: true } });
      expect(rows.length, `${v.slug} was filed into no category`).toBeGreaterThan(0);
      const primaries = rows.filter((r) => r.role === 'PRIMARY').length;
      expect(primaries, `${v.slug} must have exactly one PRIMARY, found ${primaries}`).toBe(1);
      expect(rows.filter((r) => r.role === 'SECONDARY').length).toBe(rows.length - 1);
      spans.push(rows.length);
    }

    // At least one store genuinely spans more than one category, or the check
    // above proves nothing about the rule it exists to guard.
    expect(Math.max(...spans), 'no multi-category store — the PRIMARY rule is untested').toBeGreaterThan(1);
  });

  it('carries the catalogue over the launch gate that hides the tab', async () => {
    const where = { isAvailable: true, vendor: { status: 'ACTIVE' as const, vendorType: 'STORE' as const } };
    const [items, sellers] = await Promise.all([
      prisma.item.count({ where }),
      prisma.item.findMany({ where, select: { vendorId: true }, distinct: ['vendorId'] }),
    ]);
    const gate = marketGate({ items, vendors: sellers.length });
    expect(gate.visible, `still below the gate: ${items}/${MARKET_MIN_ITEMS} items, ${sellers.length}/${MARKET_MIN_VENDORS} vendors`).toBe(true);
  });

  it('ships no photograph nobody has opened', async () => {
    // [M-D5] The honest name-tile, never stock imagery. The existing seed
    // already NULLED three of City Hardware's five photos after someone looked
    // at them and found a blue-paint photo on a white-paint listing. 150
    // unverified stock images would undo that judgement at thirty times scale.
    const vendors = await prisma.vendor.findMany({ where: { slug: { in: slugs } }, select: { id: true } });
    const withPhotos = await prisma.item.count({
      where: { vendorId: { in: vendors.map((v) => v.id) }, imageUrl: { not: null } },
    });
    expect(withPhotos, 'an unopened photograph entered the retail catalogue').toBe(0);
  });

  it('is idempotent — a re-run adds nothing and stomps nothing', async () => {
    const again = await seedRetailCatalogue(prisma, ownerId, tenantId);
    expect(again.items).toBe(0);
    expect(again.tags).toBe(0);
    expect(again.memberships).toBe(0);
  });
});
