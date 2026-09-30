/**
 * How a partner can ACTUALLY pay the weekly fee today — the words every fee
 * notice uses, in one place.
 *
 * The app has no pay button. Its "How to pay" screen (VendorSwiftNumberScreen,
 * and SwiftNumberView in BillingSurfaces for movers) shows the Swift Number and
 * the agent steps this API serves (agent-cash.service.ts payCashSteps: visit
 * any MMG agent, give your Swift Number, pay cash). A notice that said "tap Pay
 * in the app" or "open the app to pay" sent a partner who was about to lose
 * their income looking for a button that does not exist, and "update your
 * card" named a card door the app deliberately does not have.
 *
 * Two doors, and only two:
 *   - cash at any MMG agent with the Swift Number, for every subscription;
 *   - approving the MMG request on the phone, only where the rail really sends
 *     one: MOBILE_MONEY with a payer number, while the account is still being
 *     retried. A CHURNED account is not retried, so it is never offered there.
 *
 * And no promise of an instant restore. The server reinstates the moment a
 * payment is RECORDED, but an agent payment is recorded at its channel pace
 * (within 1 business day in MANUAL mode, per the activationCopy the app shows).
 * "As soon as your payment reaches us" is true on every channel.
 */

/** The agent door, open to every subscription. */
export const AGENT_PAY_WAY = 'Pay cash at any MMG agent with your Swift Number (shown in the app)';

/** What happens after paying, on every channel. */
export const FEE_RESTORE_LINE = 'Access comes back as soon as your payment reaches us.';

/** The ways to pay for an account the billing cycle still retries (PAST_DUE
 *  and SUSPENDED are retried daily), as one sentence without its full stop.
 *  An account no longer retried (CHURNED) gets AGENT_PAY_WAY alone. */
export function feePayWays(sub: { billingMethod?: string | null; mmgPayerMsisdn?: string | null }): string {
  return sub.billingMethod === 'MOBILE_MONEY' && Boolean(sub.mmgPayerMsisdn)
    ? 'Approve the MMG request on your phone when one arrives, or pay cash at any MMG agent with your Swift Number (shown in the app)'
    : AGENT_PAY_WAY;
}
