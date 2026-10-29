import type { MmgDirectPaymentAction, OrderCheckoutResult } from '@swift/types';
import { MMG_PAY_TO_STORE_NUMBER } from './cartPayment';

// ---------------------------------------------------------------------------
// [perf · BOOK-WEB #2206] After an order is placed: which MMG pay action the app may open, and the confirmation
// copy. Moved as is from ./cartPayment (no rule or word changed) so the website's checkout first load carries only
// what it shows before an order is placed; the phone's cart screen imports both from here.
// ---------------------------------------------------------------------------

/** Accept an action only when it belongs to this MMG checkout and preserves
 * the no-custody contract. URL safety is checked again by openMmgPaymentAction. */
export function paymentActionForCheckout(
  result: Partial<OrderCheckoutResult>,
  submittedMethod: 'CASH' | 'MOBILE_MONEY',
): MmgDirectPaymentAction | null {
  const action = result.paymentAction as Partial<MmgDirectPaymentAction> | null | undefined;
  if (
    submittedMethod !== 'MOBILE_MONEY'
    || action?.kind !== 'OPEN_EXTERNAL_URL'
    || action.method !== 'MOBILE_MONEY'
    || action.provider !== 'MMG'
    || action.fundsFlow !== 'DIRECT_TO_VENDOR'
    || typeof action.orderId !== 'string'
    || action.orderId.trim().length === 0
    || typeof action.recipientName !== 'string'
    || action.recipientName.trim().length === 0
    || typeof action.amount !== 'number'
    || !Number.isFinite(action.amount)
    || action.amount < 0
    || typeof action.url !== 'string'
    || action.url.trim().length === 0
  ) {
    return null;
  }
  return action as MmgDirectPaymentAction;
}

export function placedOrderConfirmationCopy(input: {
  appointment: boolean;
  /** [BOOK-S6a] The checkout answer came back ACCEPTED: the business's listing confirmed it at once. */
  appointmentConfirmed?: boolean;
  pickup: boolean;
  held: boolean;
  submittedMethod: 'CASH' | 'MOBILE_MONEY';
  paymentAction: MmgDirectPaymentAction | null;
  /** [PAYMENT-SIMPLIFY] The order pays the store's MMG number (shown on the order once it accepts). */
  mmgPayTo?: typeof MMG_PAY_TO_STORE_NUMBER;
}): string {
  if (input.submittedMethod === 'MOBILE_MONEY' && input.mmgPayTo === MMG_PAY_TO_STORE_NUMBER) {
    // [BOOK-FU3 · REVIEW-F S4 #2202] A booking is a booking, never an "order".
    if (input.appointment) {
      return 'When the business accepts, your booking shows its MMG number and the exact amount to send. Pay within 30 minutes of it accepting, or the booking cancels automatically. You pay the business directly in MMG; it marks the booking paid when the money arrives. Swift never holds the money.';
    }
    return 'When the business accepts, your order screen shows its MMG number and the exact amount to send. Pay within 30 minutes of it accepting, or the order cancels automatically. You pay the business directly in MMG; it marks the order paid when the money arrives. Swift never holds the money.';
  }
  if (input.submittedMethod === 'MOBILE_MONEY') {
    if (input.paymentAction) {
      return `Complete payment directly to ${input.paymentAction.recipientName} in MMG. Swift does not hold the money; the business confirms it after receipt.`;
    }
    return input.appointment
      ? 'Your MMG booking was placed, but its payment link is unavailable. Do not send money to another link; open the booking for the latest payment action.'
      : 'Your MMG order was placed, but its payment link is unavailable. Do not send money to another link; open the order for the latest payment action.';
  }
  if (input.appointment && input.appointmentConfirmed === true) {
    return 'Your time is confirmed — pay cash directly to the business when the service is done.';
  }
  if (input.appointment) {
    return 'Your time is confirmed when the business accepts — pay cash directly to them when the service is done.';
  }
  if (input.pickup) {
    return 'We’ll tell you when it’s ready — show the pickup code and pay cash directly at the counter.';
  }
  if (input.held) {
    // [REPORT-013 F-013-03 S2] This popup can outlive the hold (one-time
    // device-clock snapshot, no timer) — state the RULE, never "is free"
    // as a standing promise the order screen may already contradict.
    // [Terms 2026-10-15 §7 · review S3-1 on #1732] free until the store ACCEPTS, not only while it has not been told
    return 'Changed your mind? Until the store accepts it, you can cancel free from the order screen. Pay cash at handover.';
  }
  return 'The store has been notified — pay cash at handover. Swift never holds the order money.';
}
