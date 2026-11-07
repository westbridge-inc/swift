/** [Coordinator ruling, 5 Nov 2026] Case by case, and never a promise. An older server can still answer AUTO_APPROVED.
 *  A suspended mover reads the suspension, never "may help". */
export function reviewWords(claimStatus?: string, flags?: string[]): string | null {
  if (claimStatus !== 'AUTO_APPROVED' && claimStatus !== 'PENDING_REVIEW') return null;
  return flags?.includes('protection_suspended')
    ? 'Swift\u2019s help is suspended for you. A person will still look at this.'
    : 'A person will review this, and Swift may help.';
}

/** [BUG-HUNT-2 G02] Unpaid at the door: the parcel is the sender's and still in the rider's hands. Says what to do next. */
export function parcelUnpaidWords(claimStatus?: string, flags?: string[]): string {
  const next = reviewWords(claimStatus, flags);
  return `Recorded. Bring the parcel back to the sender.${next ? ` ${next}` : ''}`;
}
