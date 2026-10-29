// ---------------------------------------------------------------------------
// [UI-SWEEP U18 / U46] The subscription summary a partner reads on the store
// Settings page and the earner office home — the phone's words and the phone's
// arithmetic (apps/mobile/src/lib/billing.ts weeklyFeeGyd, VendorAccountScreen
// SubscriptionCard).
//
// U18: the card printed `weeklyRate`, the LIST rate. A partner on a custom rate
// was shown a fee they are not charged. The rate in force is payInfo's
// `weeklyFeeGyd`, then the row's `customRate`, then the list rate.
// [CHAINS · REVIEW-M #2211] Without payInfo's figure, the biller's rule: a
// custom rate is charged only when it is not above the list rate (the lower).
// U46: it printed the status code raw ("PAST_DUE"), read a `trialEndsAt` the
// server never sends (the column is `trialEndDate`), and dated the next bill
// from `currentPeriodEnd` (the phone reads `nextBillingDate`).
// ---------------------------------------------------------------------------

import { formatMoney, parseAmount } from './money';
import { feeStatusOf, type FeeSubscription } from './weekly-fee';
import { feeStatusPillWords } from './subscription-words';

type Sub = Record<string, unknown> | null | undefined;

/** The weekly fee actually charged, or null when the server sent no figure. */
export function chargedWeeklyFee(sub: Sub): number | null {
  if (!sub) return null;
  const charged = parseAmount(sub['weeklyFeeGyd']);
  if (charged !== null) return charged;
  const custom = parseAmount(sub['customRate']);
  const list = parseAmount(sub['weeklyRate']);
  if (custom !== null && list !== null) return Math.min(custom, list);
  return custom ?? list;
}

// [FEE-STATUS · owner 25 Oct 2026] The status word and the line say where the fee stands (the API's
// feeStatus, lib/weekly-fee feeStatusOf): the phone read "Active" + "next bill 13 Oct" on 25 October.
// Never the code, never "Active" or a next bill on a date that has passed.
const statusOf = (sub: Record<string, unknown>) => feeStatusOf(sub as unknown as FeeSubscription);

/** The status word, the phone's pill. */
export function subscriptionStatusWord(sub: Sub): string {
  if (!sub) return 'Not active yet';
  return feeStatusPillWords(statusOf(sub).state).label;
}

/** A trial or a paid week is in good standing; everything else needs the partner's attention. */
export function subscriptionInGoodStanding(sub: Sub): boolean {
  if (!sub) return false;
  const state = statusOf(sub).state;
  return state === 'TRIAL' || state === 'PAID' || state === 'UPCOMING' || state === 'COVERED';
}

/** The phone's one line under the status: the rate and where the fee stands. */
export function subscriptionLine(sub: Sub): string {
  if (!sub) return 'Not active yet';
  const fee = `${formatMoney(chargedWeeklyFee(sub))}/week`;
  const status = statusOf(sub);
  return status.state === 'TRIAL' ? `${status.headline} · then ${fee}` : `${fee} · ${status.headline}`;
}
