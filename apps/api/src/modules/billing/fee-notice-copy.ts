/**
 * How a partner can ACTUALLY pay the weekly fee today — the words every fee
 * notice uses, in one place.
 *
 * The owner, 29 Sep: partners pay the weekly fee on ONE checkout page, "Pay
 * GY$X with MMG" on the Weekly fee page in the app (#1378). Never at an MMG
 * agent, never in cash, never with the Swift Number: the dormant agent rail is
 * not offered to partners. The page's MMG action goes live with the checkout
 * rail. Until then no notice may offer it as if it were: "pay in the app" sent
 * a partner looking for a button that does not exist (the truthful-copy rule,
 * #1359), so the notice says payment with MMG opens in the app soon.
 *
 * The one other real door: approving the MMG request on the phone, only where
 * the rail really sends one: MOBILE_MONEY with a payer number, while the
 * account is still being retried. A CHURNED account is not retried, so it is
 * never offered there.
 *
 * And no promise of an instant restore: "as soon as your payment reaches us"
 * is true on every channel.
 */

/** The checkout door, open to every subscription; its MMG action is not live yet. */
export const CHECKOUT_PAY_WAY = 'Payment with MMG opens in the app soon';

/** What happens after paying, on every channel. */
export const FEE_RESTORE_LINE = 'Access comes back as soon as your payment reaches us.';

/** The ways to pay for an account the billing cycle still retries (PAST_DUE
 *  and SUSPENDED are retried daily), without the final full stop.
 *  An account no longer retried (CHURNED) gets CHECKOUT_PAY_WAY alone. */
export function feePayWays(sub: { billingMethod?: string | null; mmgPayerMsisdn?: string | null }): string {
  return sub.billingMethod === 'MOBILE_MONEY' && Boolean(sub.mmgPayerMsisdn)
    ? `Approve the MMG request on your phone when one arrives. ${CHECKOUT_PAY_WAY}`
    : CHECKOUT_PAY_WAY;
}
