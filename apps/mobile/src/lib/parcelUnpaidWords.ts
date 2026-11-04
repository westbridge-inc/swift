/** [BUG-HUNT-2 G02] Unpaid at the door: the parcel is the sender's and still in the rider's hands. Says what to do next. */
export function parcelUnpaidWords(claimStatus?: string): string {
  const cover = claimStatus === 'AUTO_APPROVED' ? ' The Swift guarantee covers it.'
    : claimStatus === 'PENDING_REVIEW' ? ' Your claim is under review.' : '';
  return `Recorded. Bring the parcel back to the sender.${cover}`;
}
