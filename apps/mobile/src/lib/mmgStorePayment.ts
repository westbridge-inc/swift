import type { MmgStoreNumberPayment } from '@swift/types';

/**
 * [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The customer's "Pay $X by MMG to <store>'s MMG number <number>".
 *
 * The server sends it ONLY to this order's customer, ONLY once the store has accepted, and only until the
 * store marks the order "Paid by MMG". The money goes straight from the customer's MMG to the store's: Swift
 * never holds, moves or confirms it, and the app never opens a payment page for it.
 *
 * Accepted only in its exact shape — a Guyana mobile number, a real amount, the server's own sentence — so a
 * malformed or partial answer shows nothing rather than a number that might be wrong. Pure (types only), so
 * the web order page reads the same rule.
 */
const GY_MOBILE = /^\+592[67]\d{6}$/;

export function parseMmgStorePayment(value: unknown): MmgStoreNumberPayment | null {
  const v = value as Partial<MmgStoreNumberPayment> | null | undefined;
  if (
    !v
    || v.payTo !== 'STORE_NUMBER'
    || v.provider !== 'MMG'
    || v.fundsFlow !== 'DIRECT_TO_VENDOR'
    || typeof v.number !== 'string' || !GY_MOBILE.test(v.number)
    || typeof v.numberDisplay !== 'string' || v.numberDisplay.replace(/\s/g, '') !== v.number
    || typeof v.recipientName !== 'string' || v.recipientName.trim().length === 0
    || typeof v.amount !== 'number' || !Number.isFinite(v.amount) || v.amount <= 0
    || typeof v.currencyCode !== 'string'
    || typeof v.instruction !== 'string' || !v.instruction.includes(v.numberDisplay)
  ) {
    return null;
  }
  return v as MmgStoreNumberPayment;
}

/** The line under the instruction: what happens next, and who confirms it. */
export function mmgStorePaymentNote(payment: MmgStoreNumberPayment): string {
  return `Send it in your MMG app. ${payment.recipientName} marks your order paid when the money arrives. Swift never holds this money.`;
}

/** [owner 18 Oct 2026] The server's pay-by sentence: an accepted MMG order not marked "Paid by MMG" within 30 minutes
 *  is cancelled automatically. Shown only as the server wrote it, and only with its time (an older server sends none). */
export function mmgStorePaymentDeadline(payment: MmgStoreNumberPayment): string | null {
  const { deadline, payBy } = payment;
  if (typeof deadline !== 'string' || deadline.trim().length === 0) return null;
  if (typeof payBy !== 'string' || !Number.isFinite(Date.parse(payBy))) return null;
  return deadline;
}
