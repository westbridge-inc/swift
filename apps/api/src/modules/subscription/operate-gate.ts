import type { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import type { FeePausePredicate } from '../billing/mmg-pause';

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
  | { operable: false; why: 'MISSING' | 'STATUS' | 'GRACE_LAPSED' | 'BILLING_STOPPED'; status?: SubscriptionStatus };

export type OperabilitySubscription = Pick<Subscription, 'id' | 'status' | 'gracePeriodEnd' | 'autoRenew' | 'currentPeriodEnd' | 'billingConfirmationPausedAt' | 'billingEnforcementDueAt' | 'autoSuspendEnabled'>;

export function subscriptionOperability(
  sub: OperabilitySubscription | null | undefined,
  opts: { missingRow: 'BLOCK' | 'GRANDFATHER' },
  feePause: FeePausePredicate,
  now = new Date(),
): SubscriptionOperability {
  if (!sub) {
    return opts.missingRow === 'GRANDFATHER' ? { operable: true } : { operable: false, why: 'MISSING' };
  }
  if (!OPERABLE_STATUSES.includes(sub.status)) {
    return { operable: false, why: 'STATUS', status: sub.status };
  }
  const graceEnd = sub.billingEnforcementDueAt;
  // [PROD-PATH] While no partner has a live way to pay (MMG off, no live card
  // rail: billing/fee-pause.ts) nobody's grace lapses, whatever their billing
  // method: their dunning clock is paused for the span (billing/mmg-pause.ts),
  // including an open span or persisted repair after the switches return.
  if (sub.status === 'PAST_DUE' && sub.autoSuspendEnabled && !sub.billingConfirmationPausedAt && graceEnd && graceEnd <= now && !feePause.holds(sub.id)) {
    return { operable: false, why: 'GRACE_LAPSED', status: sub.status };
  }
  // [E12] A partner who stopped weekly billing works exactly until the period
  // they already paid for (or their trial) ends — at the gate, not an hour
  // later when the billing job's lapse sweep turns the row PAUSED.
  if (!sub.autoRenew && sub.currentPeriodEnd <= now) {
    return { operable: false, why: 'BILLING_STOPPED', status: sub.status };
  }
  return { operable: true };
}

/** DB form of the same refusal rule. A nullable relation may use `isNot` with
 * this filter to preserve the vendor gate's legacy missing-row policy. */
export function inoperableSubscriptionWhere(feePause: FeePausePredicate, now = new Date()): Prisma.SubscriptionWhereInput {
  return {
    OR: [
      { status: { notIn: [...OPERABLE_STATUSES] } },
      // [PROD-PATH] The same held grace as subscriptionOperability: while no
      // partner has a live way to pay, a lapsed grace refuses nobody.
      { status: 'PAST_DUE', autoSuspendEnabled: true, billingConfirmationPausedAt: null, billingEnforcementDueAt: { lte: now }, ...feePause.excludingHeld },
      // [E12] Billing stopped and the paid period (or trial) over — the same
      // refusal subscriptionOperability makes, so a catalogue read never shows
      // a store the gate would refuse.
      { autoRenew: false, currentPeriodEnd: { lte: now } },
    ],
  };
}
