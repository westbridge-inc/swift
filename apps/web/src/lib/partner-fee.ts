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
import { feeDate, subscriptionWords } from './weekly-fee';

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

/** The status word: trial and grace are flags layered on the status, read first (phone pill). */
export function subscriptionStatusWord(sub: Sub): string {
  if (!sub) return 'Not active yet';
  if (sub['isTrialActive'] === true) return 'Free trial';
  if (sub['isInGracePeriod'] === true) return 'Grace period';
  return subscriptionWords(String(sub['status'] ?? ''));
}

/** Trial and active operate; everything else needs the partner's attention. */
export function subscriptionInGoodStanding(sub: Sub): boolean {
  if (!sub) return false;
  if (sub['isTrialActive'] === true) return true;
  if (sub['isInGracePeriod'] === true) return false;
  const status = String(sub['status'] ?? '');
  return status === 'ACTIVE' || status === 'TRIAL';
}

const date = (value: unknown) => feeDate(typeof value === 'string' ? value : null);

/** The phone's one line under the status: trial end, grace deadline, or rate + next bill. */
export function subscriptionLine(sub: Sub): string {
  if (!sub) return 'Not active yet';
  const fee = `${formatMoney(chargedWeeklyFee(sub))}/week`;
  if (sub['isTrialActive'] === true && date(sub['trialEndDate'])) return `Trial ends ${date(sub['trialEndDate'])} · then ${fee}`;
  if (sub['isInGracePeriod'] === true && date(sub['gracePeriodEnd'])) return `Weekly fee due by ${date(sub['gracePeriodEnd'])}`;
  const next = date(sub['nextBillingDate']);
  return `${fee}${next ? ` · next bill ${next}` : ''}`;
}
