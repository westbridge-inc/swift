/** [BUG-HUNT-2 G02] Unpaid at the door: the parcel is the sender's and still in the rider's hands. Says what to do next. */
export function parcelUnpaidWords(claimStatus?: string): string {
  // [Coordinator ruling, 5 Nov 2026] Case by case, and never a promise. An older server can still answer AUTO_APPROVED.
  const next = claimStatus === 'AUTO_APPROVED' || claimStatus === 'PENDING_REVIEW' ? ' A person will review this, and Swift may help.' : '';
  return `Recorded. Bring the parcel back to the sender.${next}`;
}
