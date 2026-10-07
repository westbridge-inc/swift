/**
 * [NO-DEAD-ENDS] The "store suspended for an expired document" banner on the
 * order board, per role.
 *
 * Only the owner can see and upload the store's documents (Account >
 * Documents is owner-only, and the documents are the owner's). The banner
 * told every role "Tap to fix it under Account", so a manager or floor staff
 * member tapped into an Account screen with no Documents. It also named the
 * failing documents from the viewer's OWN verification status, which for
 * staff is empty, so it listed the whole checklist as "needs renewal". The
 * owner keeps the named list and the door; anyone else is told who can fix
 * it. Pure, so it is unit-testable.
 */
export function renewalBannerCopy(isStoreOwner: boolean, failingDocLabels: readonly string[]): string {
  if (!isStoreOwner) {
    return 'Store suspended — a required document needs renewing, so new orders are off. Only the owner can renew documents: ask them to open Account, then Documents.';
  }
  return failingDocLabels.length > 0
    ? `Store suspended — ${failingDocLabels.join(', ')} ${failingDocLabels.length === 1 ? 'needs' : 'need'} renewal, so new orders are off. Tap to fix it under Account.`
    : 'Store suspended — a required document is missing or expired, so new orders are off. Tap to renew it under Account.';
}
