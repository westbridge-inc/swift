/**
 * [P35 · board 4b "Verified seller" · GUARDRAILS §4/§8 · REVIEW-G #2112 S4-1 · REVIEW-F #2112 S2-1] What a customer
 * may be told as "Verified seller": a person approved every checklist document of a REAL store and they are still
 * current. All of:
 *  - `isVerified`: the activation projection (a person approved the documents);
 *  - `activationValidUntil` (the soonest document expiry) null or still in the future: the column can lag an expiry
 *    until the expiry flow re-projects it;
 *  - not synthetic: a store-review or demo store is fiction nobody checked. Review-pack stores are
 *    `Vendor.isSynthetic` (review/content-pack.ts); the dev demo seed's stores belong to owners marked
 *    `syntheticRunId: 'seed-demo'` (prisma/seed.ts). Either marker, on the store or its owner, withholds the claim.
 */
export interface SellerVerifiedFacts {
  isVerified: boolean;
  activationValidUntil: Date | null;
  isSynthetic: boolean;
  owner: { user: { isSynthetic: boolean; syntheticRunId: string | null } | null } | null;
}

/** The select both store reads add to compute it (never sent to a client). */
export const SELLER_VERIFIED_SELECT = {
  activationValidUntil: true,
  isSynthetic: true,
  owner: { select: { user: { select: { isSynthetic: true, syntheticRunId: true } } } },
} as const;

export function sellerVerifiedNow(store: SellerVerifiedFacts, now: Date = new Date()): boolean {
  const ownerUser = store.owner?.user;
  const synthetic = store.isSynthetic === true || ownerUser?.isSynthetic === true || (ownerUser?.syntheticRunId ?? null) !== null;
  // A row read without its bound (undefined, or not a Date) is never "verified" and never throws: fail closed, and a
  // store page must not 500 on a missing field.
  const bound: unknown = store.activationValidUntil;
  return store.isVerified === true
    && !synthetic
    && (bound === null || (bound instanceof Date && bound.getTime() > now.getTime()));
}
