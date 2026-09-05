import { getTenantId } from '../../plugins/tenant-context';
// ---------------------------------------------------------------------------
// THE customer-facing vendor-visibility predicate — ONE implementation
// [B2/#790]. A store is visible to customers only when all three hold:
//
//   status ACTIVE        — not suspended/rejected,
//   isVerified           — a human approved its papers,
//   tenant.isActive      — its OPERATOR is still on the platform. Load-bearing
//                          for guests [F-028-07]: a guest request is UNSCOPED
//                          (no tenant context in the Prisma extension), so this
//                          relational predicate is the only wall between a
//                          shut-off operator and public surfaces.
//
// History, which is why this file exists: the Home popular rail shipped with
// status alone (a deactivated operator's DISH sat above the fold while their
// STORE was hidden — fixed in #790), and the search module then turned out to
// carry five more hand-rolled copies, each missing a different clause —
// suggestions had NO vendor predicate at all, so a banned store's dish names
// kept autocompleting. Same drift class the cancel policy had. Import from
// here or don't touch visibility.
//
// Per-surface EXTRAS (isCurrentlyOpen, items:{some:{isAvailable:true}}) stay
// at the call site — openness is a surface choice; visibility is not.
// ---------------------------------------------------------------------------

/** Spread into a `vendor.findMany` where. */
export const VISIBLE_VENDOR = {
  status: 'ACTIVE',
  isVerified: true,
  tenant: { isActive: true },
} as const;

/** Spread into an ITEM query's `vendor:` relation filter. */
export const VISIBLE_VENDOR_REL = VISIBLE_VENDOR;

/**
 * [STA-1 RLS-N3 / DL-7] The visible-vendor relation filter, pinned to the
 * CALLER's tenant. Child tables without a tenantId column (items, categories)
 * are walled only through their vendor, so a relation filter that omits the
 * tenant reaches every tenant's vendors — a reviewer would see real menus and
 * a real customer the fiction's. Anonymous callers get the production tenant.
 */
export function visibleVendorRelForCaller(): typeof VISIBLE_VENDOR & { tenantId: string } {
  return { ...VISIBLE_VENDOR, tenantId: getTenantId() ?? 'swift-default' };
}

/**
 * The SAME predicate, decided in memory on an already-fetched row.
 *
 * A sixth hand-rolled copy turned up in the search module's INCREMENTAL sync,
 * which is the path that actually runs in normal operation: `syncVendor` and
 * `syncVendorItems` tested `status === 'ACTIVE'` alone, so a vendor whose
 * papers were never approved, or whose OPERATOR had been switched off, was
 * written into the Meilisearch index and then served — because the search
 * methods filter on surface attributes and trust the index for visibility. A
 * full re-index removed them again; the next incremental sync put them back.
 *
 * The values are read off `VISIBLE_VENDOR` rather than repeated, so the two
 * forms cannot disagree about WHAT visible means. `vendor-visibility.test.ts`
 * asserts they constrain the same set of fields, which is the only way they
 * could still drift.
 *
 * Pass a row selected with at least `status`, `isVerified`, and
 * `tenant: { select: { isActive: true } }`. A missing tenant relation is
 * treated as NOT visible — failing closed, because the tenant clause is the
 * only wall between a shut-off operator and an unscoped guest request.
 */
export function isVendorVisible(vendor: {
  status: string;
  isVerified: boolean;
  tenant?: { isActive: boolean } | null;
}): boolean {
  return (
    vendor.status === VISIBLE_VENDOR.status &&
    vendor.isVerified === VISIBLE_VENDOR.isVerified &&
    vendor.tenant?.isActive === VISIBLE_VENDOR.tenant.isActive
  );
}

/** The exact select a caller needs for `isVendorVisible` to be able to decide.
 *  Spread it into a `select` so a caller cannot forget a clause and get a
 *  silently permissive answer. */
export const VISIBLE_VENDOR_SELECT = {
  status: true,
  isVerified: true,
  tenant: { select: { isActive: true } },
} as const;

/** [R048-003] The visibility predicate INSIDE one tenant — for relation
 *  filters (`item.vendor`), which the tenant-scoping extension does not reach.
 *  A public catalogue or search query names its tenant here, or it is not one
 *  tenant's query. */
export function visibleVendorInTenant(tenantId: string) {
  if (!tenantId) throw new Error('[R048-003] visibleVendorInTenant needs a tenant');
  return { ...VISIBLE_VENDOR, tenantId } as const;
}
