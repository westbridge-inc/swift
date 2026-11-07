import { AppError } from '../../utils/errors';

/**
 * [O1 · owner ruling 7 Nov 2026 ~04:10Z, replacing "no cap" of 5 Nov] Guyana's rider cash limit is GY$100,000 at
 * every trust level: the most store cash a rider may have out at once (CountryConfig.floatL1/L2/L3, seeded by
 * ops/platform-config). Riders still see the amount of every cash job and choose.
 */
export const GUYANA_RIDER_CASH_LIMIT = 100_000;

/**
 * [O1 · riders choose] The most store cash a rider may take on WITHOUT the app having shown the amount: an older app
 * sends no amount back, and an offer whose cash split the server cannot state (cashMathForOffer returns null, e.g. a
 * discount) shows none. It is the L1 limit those apps were built under, so an older app keeps exactly the work it had;
 * above it the job is refused with the amount in words. An app that showed the amount and sends it back is limited
 * only by the rider's cash limit.
 */
export const UNSHOWN_CASH_MAX = 8000;

const gyd = (n: number) => `GY$${Math.round(n).toLocaleString('en-US')}`;
const cents = (n: number) => Math.round(n * 100);

/**
 * [O1 · reviewers A S2-1/S2-2] A rider never takes on store cash they were not shown. `shown` is the pay-the-store
 * amount the app displayed and sent back (undefined when it displayed none); `locked` is the amount read from the
 * LOCKED order inside the claim. Refused when:
 *   - the cash went UP since it was shown (a dearer substitute approved while the card or the board row was open):
 *     CASH_AMOUNT_CHANGED, with the new amount, so the rider can look again;
 *   - no amount was shown and the job needs more than UNSHOWN_CASH_MAX: CASH_AMOUNT_NOT_SHOWN.
 * A lower amount than shown is never refused (the rider fronts less than they agreed to).
 */
export function assertCashShown(locked: number, shown: number | undefined, storeName: string | null | undefined): void {
  if (!(locked > 0)) return;
  const store = storeName || 'the store';
  if (shown !== undefined && cents(locked) > cents(shown)) {
    throw new AppError(409, 'CASH_AMOUNT_CHANGED',
      `This order changed: you now pay ${store} ${gyd(locked)} in cash at pickup, not ${gyd(shown)}. Look at it again before you accept.`,
      { payToVendor: locked });
  }
  if (shown === undefined && locked > UNSHOWN_CASH_MAX) {
    throw new AppError(409, 'CASH_AMOUNT_NOT_SHOWN',
      `This cash job needs you to pay ${store} ${gyd(locked)} at pickup, and that amount was not shown to you with it, so it cannot be accepted here.`,
      { payToVendor: locked });
  }
}
