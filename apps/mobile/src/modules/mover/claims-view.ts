/**
 * [DOC-1 §31.4 · P31-1] The rider's guarantee claims, in the rider's words. Pure: the
 * server's claim view in, labels out — so the screen has nothing to decide.
 */
export type ClaimView = {
  id: string; orderId: string; amount: string; status: string; reason: string; flags: string[];
  filedAt: string; paidAt: string | null; paymentRef: string | null;
  evidence: { complete: boolean; missing: string[]; items: Array<{ key: string; present: boolean; required: boolean }> } | null;
  settleBy: string | null; underReview: boolean;
};

export function claimStatus(status: string): { label: string; tone: 'brand' | 'success' | 'neutral' | 'error' } {
  switch (status) {
    case 'AUTO_APPROVED': case 'APPROVED': return { label: 'Approved — Swift pays you', tone: 'success' };
    case 'PAID': return { label: 'Paid', tone: 'success' };
    case 'PENDING_REVIEW': return { label: 'Under review', tone: 'brand' };
    case 'REJECTED': return { label: 'Not covered', tone: 'error' };
    default: return { label: status.toLowerCase().replace(/_/g, ' '), tone: 'neutral' };
  }
}

const EVIDENCE_LABEL: Record<string, string> = {
  handover_not_completed: 'Handover was not completed',
  rider_at_door: 'You were at the door',
  customer_contacted: 'You contacted the customer in the app',
  door_photo: 'Photo at the door',
  pickup_proof: 'Pickup recorded',
  cart_snapshot: 'Order contents on file',
};
export function evidenceLine(item: { key: string; present: boolean; required: boolean }): { label: string; state: 'ok' | 'missing' | 'optional' } {
  const label = EVIDENCE_LABEL[item.key] ?? item.key.replace(/_/g, ' ');
  if (item.present) return { label, state: 'ok' };
  return { label, state: item.required ? 'missing' : 'optional' };
}

/** What a flag means for the rider — never the internal name, never a blame. */
export function flagHint(flag: string): string | null {
  switch (flag) {
    case 'over_monthly_cap': return 'You have reached the guarantee limit for the last 30 days, so a person reviews this one.';
    case 'over_review_threshold': return 'Claims of this size are always reviewed by a person.';
    case 'over_cap': return 'Several claims this month — a person reviews this one.';
    case 'protection_suspended': return 'Your loss protection is suspended; a person reviews this claim. Get help to ask for a review.';
    case 'evidence_incomplete': return 'Some evidence is missing (see the checklist). A person can still approve it.';
    case 'gps_far': return 'Your location was recorded far from the delivery address, so a person reviews this one.';
    case 'sla_breached': return 'This payment to you is late. Swift has been told.';
    case 'collusion_customer': case 'collusion_customer_cluster': case 'collusion_pair': case 'collusion_pair_cluster': case 'collusion_address': case 'outlier':
      return 'Reviewed by a person.';
    default: return null;
  }
}

export function reasonLabel(reason: string): string {
  return reason === 'no_show' ? 'Customer did not show' : reason === 'refused' ? 'Customer refused to pay' : reason.replace(/_/g, ' ');
}
