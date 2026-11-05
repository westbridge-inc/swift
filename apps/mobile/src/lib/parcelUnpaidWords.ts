/** [BUG-HUNT-2 G02] Unpaid at the door: the parcel is the sender's and still in the rider's hands. Says what to do next. */
export function parcelUnpaidWords(claimStatus?: string): string {
  const cover = claimStatus === 'AUTO_APPROVED' ? ' Swift will pay you.'
    : claimStatus === 'PENDING_REVIEW' ? ' This is being reviewed.' : '';
  return `Recorded. Bring the parcel back to the sender.${cover}`;
}
