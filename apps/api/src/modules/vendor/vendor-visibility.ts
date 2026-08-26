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
