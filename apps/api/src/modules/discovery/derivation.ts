import type { PrismaClient } from '@prisma/client';
import { requireDiscoveryTenantId } from './tenant-boundary';

// ---------------------------------------------------------------------------
// Stage C — store derivation (spec Part 4). Pure arithmetic over item tags:
// a vendor belongs to category C (beyond its chosen picks) when at least
// CAT_DERIVE_MIN_ITEMS live items or CAT_DERIVE_SHARE of its live items carry
// C. This is how a Creole restaurant with twelve vegan dishes appears under
// Vegan without burning a store pick. The reconcile writes ONLY
// source=DERIVED rows — chosen rows are untouchable by construction (every
// write carries WHERE source='DERIVED').
// ---------------------------------------------------------------------------

export const CAT_DERIVE_MIN_ITEMS = 5;
export const CAT_DERIVE_SHARE = 0.25;

/** Pure membership rule — exported for the CAT-F threshold table. */
export function qualifiesDerived(taggedLiveItems: number, totalLiveItems: number): boolean {
  if (totalLiveItems === 0) return false;
  return taggedLiveItems >= CAT_DERIVE_MIN_ITEMS || taggedLiveItems / totalLiveItems >= CAT_DERIVE_SHARE;
}

/**
 * Reconcile one vendor's DERIVED memberships. Idempotent; safe to run twice;
 * chosen (VENDOR/ADMIN) rows are never read as derivation output and never
 * written here.
 */
export async function reconcileVendorDerived(
  prisma: PrismaClient,
  vendorId: string,
  tenantId: string,
): Promise<{ added: number; removed: number }> {
  const scopedTenantId = requireDiscoveryTenantId(tenantId);
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, tenantId: scopedTenantId },
    select: { tenantId: true },
  });
  if (!vendor) return { added: 0, removed: 0 };

  const liveItems = await prisma.item.findMany({
    where: { vendorId, isAvailable: true, vendor: { tenantId: scopedTenantId } },
    select: { id: true },
  });
  const liveIds = liveItems.map((i) => i.id);
  const totalLive = liveIds.length;

  // Live-item tag counts per category.
  const tagCounts = liveIds.length
      ? await prisma.itemDiscoveryCategory.groupBy({
        by: ['categoryId'],
        where: { tenantId: vendor.tenantId, itemId: { in: liveIds } },
        _count: { _all: true },
      })
    : [];
  const qualified = new Set(
    tagCounts.filter((t) => qualifiesDerived(t._count._all, totalLive)).map((t) => t.categoryId),
  );

  // A chosen row already covers the category — a DERIVED duplicate would just
  // fight the unique; skip those.
  const chosen = await prisma.vendorDiscoveryCategory.findMany({
    where: { tenantId: vendor.tenantId, vendorId, source: { in: ['VENDOR', 'ADMIN'] } },
    select: { categoryId: true },
  });
  for (const c of chosen) qualified.delete(c.categoryId);

  const existingDerived = await prisma.vendorDiscoveryCategory.findMany({
    where: { tenantId: vendor.tenantId, vendorId, source: 'DERIVED' },
    select: { id: true, categoryId: true },
  });
  const existingIds = new Set(existingDerived.map((d) => d.categoryId));

  let added = 0;
  for (const categoryId of qualified) {
    if (existingIds.has(categoryId)) continue;
    await prisma.vendorDiscoveryCategory.create({
      data: { tenantId: vendor.tenantId, vendorId, categoryId, role: 'SECONDARY', source: 'DERIVED' },
    }).then(() => { added += 1; }).catch(() => undefined); // unique race with a fresh pick — the pick wins
  }
  const stale = existingDerived.filter((d) => !qualified.has(d.categoryId));
  const removed = stale.length
    ? (await prisma.vendorDiscoveryCategory.deleteMany({
        where: { id: { in: stale.map((s) => s.id) }, tenantId: scopedTenantId, source: 'DERIVED' },
      })).count
    : 0;
  return { added, removed };
}

/** Nightly sweep for exactly one tenant. The scheduler enumerates active
 * tenants explicitly; this function never falls back to a platform-wide scan.
 * Existing DERIVED rows are included even after their final tag disappears so
 * stale membership can be removed. */
export async function reconcileAllDerived(
  prisma: PrismaClient,
  tenantId: string,
): Promise<{ vendors: number; added: number; removed: number }> {
  const scopedTenantId = requireDiscoveryTenantId(tenantId);
  const tagged = await prisma.itemDiscoveryCategory.findMany({
    where: { tenantId: scopedTenantId },
    distinct: ['itemId'],
    select: { itemId: true },
  });
  const taggedVendors = await prisma.item.findMany({
    where: {
      id: { in: tagged.map((v) => v.itemId) },
      vendor: { tenantId: scopedTenantId },
    },
    select: { vendorId: true },
    distinct: ['vendorId'],
  });
  const existingDerived = await prisma.vendorDiscoveryCategory.findMany({
    where: { source: 'DERIVED', tenantId: scopedTenantId },
    select: { vendorId: true },
    distinct: ['vendorId'],
  });
  const vendorIds = [...new Set([...taggedVendors, ...existingDerived].map((row) => row.vendorId))];
  let added = 0;
  let removed = 0;
  for (const vendorId of vendorIds) {
    const r = await reconcileVendorDerived(prisma, vendorId, scopedTenantId);
    added += r.added;
    removed += r.removed;
  }
  return { vendors: vendorIds.length, added, removed };
}
