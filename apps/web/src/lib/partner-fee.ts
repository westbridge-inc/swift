// ---------------------------------------------------------------------------
// [UI-SWEEP U18 / U46] The subscription summary a partner reads on the store
// Settings page and the earner office home — the phone's words and the phone's
// arithmetic (apps/mobile/src/lib/billing.ts weeklyFeeGyd, VendorAccountScreen
// SubscriptionCard).
//
// U18: the card printed `weeklyRate`, the LIST rate. A partner on a custom rate
// was shown a fee they are not charged. The rate in force is payInfo's
// `weeklyFeeGyd`, then the row's `customRate`, then the list rate.
// U46: it printed the status code raw ("PAST_DUE"), read a `trialEndsAt` the
// server never sends (the column is `trialEndDate`), and dated the next bill
// from `currentPeriodEnd` (the phone reads `nextBillingDate`).
// ---------------------------------------------------------------------------

import { formatMoney, parseAmount } from './money';
import { feeStatusOf, feeStatusPill, type FeeSubscription } from './weekly-fee';

type Sub = Record<string, unknown> | null | undefined;

/** The weekly fee actually charged, or null when the server sent no figure. */
export function chargedWeeklyFee(sub: Sub): number | null {
  if (!sub) return null;
  for (const value of [sub['weeklyFeeGyd'], sub['customRate'], sub['weeklyRate']]) {
    const amount = parseAmount(value);
    if (amount !== null) return amount;
  }
  return null;
}

// [FEE-STATUS · owner 25 Oct 2026] The status word and the line say where the fee stands (the API's
// feeStatus, lib/weekly-fee feeStatusOf): the phone read "Active" + "next bill 13 Oct" on 25 October.
// Never the code, never "Active" or a next bill on a date that has passed.
const statusOf = (sub: Record<string, unknown>) => feeStatusOf(sub as unknown as FeeSubscription);

/** The status word, the phone's pill. */
export function subscriptionStatusWord(sub: Sub): string {
  if (!sub) return 'Not active yet';
  return feeStatusPill(statusOf(sub).state).label;
}

/** A trial or a paid week is in good standing; everything else needs the partner's attention. */
export function subscriptionInGoodStanding(sub: Sub): boolean {
  if (!sub) return false;
  const state = statusOf(sub).state;
  return state === 'TRIAL' || state === 'PAID' || state === 'COVERED';
}

/** The phone's one line under the status: the rate and where the fee stands. */
export function subscriptionLine(sub: Sub): string {
  if (!sub) return 'Not active yet';
  const fee = `${formatMoney(chargedWeeklyFee(sub))}/week`;
  const status = statusOf(sub);
  return status.state === 'TRIAL' ? `${status.headline} · then ${fee}` : `${fee} · ${status.headline}`;
}
