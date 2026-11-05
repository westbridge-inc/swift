/**
 * [DOC-1 §31.4 · P31-1] The rider's unpaid cash orders, in the rider's words. Pure: the server's view in, labels out,
 * so the screen has nothing to decide. [Coordinator ruling, 5 Nov 2026] Case by case: a person decides each one, Swift
 * may help, and no line here promises money, a date or a right.
 */
export type ClaimView = {
  id: string; orderId: string; amount: string; status: string; reason: string; flags: string[];
  filedAt: string; paidAt: string | null; paymentRef: string | null;
  evidence: { complete: boolean; missing: string[]; items: Array<{ key: string; present: boolean; required: boolean }> } | null;
  underReview: boolean;
};

export function claimStatus(status: string, evidenceComplete = true): { label: string; tone: 'brand' | 'success' | 'neutral' | 'error' } {
  switch (status) {
    // Evidence is missing: it needs one more decision, so nothing reads as done.
    case 'APPROVED': return evidenceComplete ? { label: 'Approved by a person', tone: 'success' } : { label: 'Reviewed', tone: 'brand' };
    case 'PAID': return { label: 'Paid', tone: 'success' };
    // A row the old rule approved automatically waits for a person like a new one.
    case 'AUTO_APPROVED': case 'PENDING_REVIEW': return { label: 'A person will review this', tone: 'brand' };
    case 'REJECTED': return { label: 'Not approved', tone: 'error' };
    // [UI-SWEEP U73] A status this file has not been taught: words, never the code.
    default: return { label: 'Being processed', tone: 'neutral' };
  }
}

const EVIDENCE_LABEL: Record<string, string> = {
  handover_not_completed: 'Handover was not completed',
  rider_at_door: 'You were at the door',
  elapsed_wait: 'Wait at the door',
  customer_contacted: 'You contacted the customer in the app',
  door_photo: 'Photo at the door',
  pickup_proof: 'Pickup recorded',
  cart_snapshot: 'Order contents on file',
};
export function evidenceLine(item: { key: string; present: boolean; required: boolean }): { label: string; state: 'ok' | 'missing' | 'optional' } {
  const label = EVIDENCE_LABEL[item.key] ?? 'Other evidence';
  if (item.present) return { label, state: 'ok' };
  return { label, state: item.required ? 'missing' : 'optional' };
}

/** What a flag means for the rider — never the internal name, never a blame. */
export function flagHint(flag: string): string | null {
  switch (flag) {
    case 'over_monthly_cap': return 'You have a lot of unpaid orders in the last 30 days. The reviewer can see this.';
    case 'over_review_threshold': case 'over_gate': return 'Orders of this size get a closer look.';
    case 'over_cap': return 'Several this month. The reviewer can see this.';
    case 'protection_suspended': return 'Swift\'s help was suspended for you when this was recorded. Get help to ask for a review.';
    case 'evidence_incomplete': return 'Some evidence is missing (see the checklist). The reviewer can see this.';
    case 'gps_far': return 'Your location was recorded far from the delivery address. The reviewer can see this.';
    case 'sla_breached': return 'This is taking longer than it should. Swift has been told.';
    case 'collusion_customer': case 'collusion_customer_cluster': case 'collusion_pair': case 'collusion_pair_cluster': case 'collusion_address': case 'outlier':
      return 'Reviewed by a person.';
    default: return null;
  }
}

/** The hints for one case. A closed case is never told it is late: that reads as money still on its way. */
export function claimHints(flags: string[], status: string): string[] {
  const open = status !== 'PAID' && status !== 'REJECTED';
  return flags.filter((f) => open || f !== 'sla_breached').map(flagHint).filter((h): h is string => Boolean(h));
}

export function reasonLabel(reason: string): string {
  return reason === 'no_show' ? 'Customer did not show' : reason === 'refused' ? 'Customer refused to pay' : 'Other reason';
}
