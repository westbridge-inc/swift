import { formatMoney } from '../../utils/currency-amount';

/**
 * The words every weekly-fee notice uses about paying, in one place.
 *
 * The owner's rule (2026-09-29): partners pay the weekly fee on the MMG
 * checkout in the Swift app. No notice offers an MMG agent, cash, a Swift
 * Number or an account number. So the paying sentence of a notice is one of
 * two, and nothing else:
 *   - "Pay GY$X with MMG in the Swift app." ONLY while the MMG checkout is
 *     live for the partner on every platform (fee-pay-actions.ts), for exactly
 *     what the checkout would charge;
 *   - otherwise the amount and when it is due, promising no way to pay.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** Guyana keeps UTC−4 all year (no daylight saving). */
const GUYANA_OFFSET_MS = -4 * 3_600_000;

/** A day as a partner in Guyana reads it: "Tue 29 Sep". */
export function guyanaDay(at: Date): string {
  const local = new Date(at.getTime() + GUYANA_OFFSET_MS);
  return `${WEEKDAYS[local.getUTCDay()]} ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}`;
}

/** The checkout sentence: only when fee-pay-actions says MMG is live everywhere. [BILL-PRO PR4 · owner A4] A pro's
 *  notice names the website too (Partner portal, Weekly fee): some phones cannot take the update with the pro fee
 *  screen, and both open MMG's checkout page. */
export function mmgPayLine(amountGyd: number, opts: { alsoWebsite?: boolean } = {}): string {
  return `Pay ${formatMoney(amountGyd, 'GYD', { whole: true })} with MMG in the Swift app${opts.alsoWebsite ? ' or on the Swift website' : ''}.`;
}

/** The amount and when it is due, promising no way to pay. */
export function feeDueLine(amount: number, currencyCode: string, due: Date | null, opts: { first?: boolean } = {}): string {
  return `${opts.first ? 'Your first weekly fee' : 'The weekly fee'} of ${formatMoney(amount, currencyCode)} is due ${due ? `on ${guyanaDay(due)}` : 'now'}.`;
}

/** The fee is already paid (money received before it was due): nothing to pay, so no way to pay is named.
 *  [OWNER RULING 8 Oct, NO "WALLET"] never "balance", "wallet" or "top up"; [owner #62] never "paid ahead". */
export function feeCoveredLine(amount: number, currencyCode: string, opts: { first?: boolean } = {}): string {
  return `${opts.first ? 'Your first weekly fee' : 'The weekly fee'} of ${formatMoney(amount, currencyCode)} is already paid.`;
}

/** What happens after paying: true on every rail, promising no way to pay. */
export const FEE_RESTORE_LINE = 'Your access comes back as soon as your payment is received.';
