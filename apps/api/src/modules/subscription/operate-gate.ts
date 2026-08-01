import type { SubscriptionStatus } from '@prisma/client';

// THE canOperate predicate (lifecycle/billing spec §14, G-BILL-03) — the ONE
// place that answers "may this subscription state operate right now?". Before
// this module the rule lived in three inline copies (driver go-online, rider
// go-online, vendor work-orders) and they had already diverged: the vendor
// copy was missing the grace-lapse check, so a PAST_DUE vendor whose grace
// had run out could keep working orders until the billing sweep flipped them
// SUSPENDED. One implementation per business rule (standing order #17); the
// source-scan test in operate-gate-unification.test.ts is the CI gate that
// keeps future routes from forking it again.
//
// The rule: TRIAL and ACTIVE operate. PAST_DUE operates ONLY through its
// grace window — once grace lapses we block at the gate rather than waiting
// minutes for the billing sweep, because a mover or vendor earning unpaid is
// the business model leaking. Everything else (PAUSED, SUSPENDED, CANCELLED,
// CHURNED) does not operate. A missing subscription row is caller policy:
// movers require one; legacy riders pre-dating birth-on-verification are
// grandfathered (their historical behavior, preserved exactly).

export const OPERABLE_STATUSES: readonly SubscriptionStatus[] = ['TRIAL', 'ACTIVE', 'PAST_DUE'];

export type SubscriptionOperability =
  | { operable: true }
  | { operable: false; why: 'MISSING' | 'STATUS' | 'GRACE_LAPSED'; status?: SubscriptionStatus };

export function subscriptionOperability(
  sub: { status: SubscriptionStatus; gracePeriodEnd: Date | null } | null | undefined,
  opts: { missingRow: 'BLOCK' | 'GRANDFATHER' },
  now = new Date(),
): SubscriptionOperability {
  if (!sub) {
    return opts.missingRow === 'GRANDFATHER' ? { operable: true } : { operable: false, why: 'MISSING' };
  }
  if (!OPERABLE_STATUSES.includes(sub.status)) {
    return { operable: false, why: 'STATUS', status: sub.status };
  }
  if (sub.status === 'PAST_DUE' && sub.gracePeriodEnd && sub.gracePeriodEnd < now) {
    return { operable: false, why: 'GRACE_LAPSED', status: sub.status };
  }
  return { operable: true };
}
