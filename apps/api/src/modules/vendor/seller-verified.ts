/**
 * [P35 · board 4b "Verified seller" · GUARDRAILS §4/§8 · REVIEW-G #2112 S4-1] What a customer may be told as
 * "Verified seller": the store's activation projection (`isVerified`, a person approved every checklist document)
 * AND its wall-clock bound (`activationValidUntil`, the soonest expiry among those documents) still in the future.
 * The column alone can lag a document's expiry until the expiry flow re-projects it; this never does.
 */
export function sellerVerifiedNow(store: { isVerified: boolean; activationValidUntil: Date | null }, now: Date = new Date()): boolean {
  return store.isVerified === true && (store.activationValidUntil === null || store.activationValidUntil.getTime() > now.getTime());
}
