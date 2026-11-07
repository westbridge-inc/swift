import { AppError } from '../../utils/errors';

/**
 * [Ruling 1 Nov 2026 · REVIEW-M N1 · GUARDRAILS §1 + §8] Swift-paid promo codes are OFF.
 *
 * A code whose funder is not the store (funder PLATFORM: an admin code, or any row that took the
 * column's PLATFORM default) means SWIFT pays the discount. Swift never holds or moves order money,
 * so a Swift-paid discount on a store's order would leave Swift owing money it has no path to pay
 * (on a store-MMG order it also booked the store as owing the rider a fee it only partly collected).
 * Until Swift has a payout path for them (revisit after launch):
 *   - no Swift-paid code is created, and an existing one cannot be changed, except switched off;
 *   - an existing Swift-paid row, whatever its isActive says, never discounts a quote, is never
 *     accepted by /promo/validate, and is never redeemed at checkout;
 *   - a store's own code (funder VENDOR) is untouched.
 *
 * Fail closed: anything that is not exactly VENDOR counts as Swift-paid. The dormant ON path (the
 * platform-code pricing kept for after launch) answers only to SWIFT_PAID_PROMOS=1, read per request;
 * unset or any other value is OFF. Turning it on needs an owner ruling and a payout path first.
 */
export function swiftPaidPromosOn(): boolean {
  return process.env['SWIFT_PAID_PROMOS'] === '1';
}

export const SWIFT_PAID_PROMOS_OFF_MESSAGE =
  'Swift-paid promo codes are switched off. Swift never holds or moves order money, so it cannot pay a discount on a store’s order. A store can still make its own promo code in the Swift app.';

/** What a customer is told about a Swift-paid code: it is simply not usable. */
export const SWIFT_PAID_PROMO_CUSTOMER_MESSAGE = 'This promo code is no longer active';

export function isSwiftPaidPromo(promo: { funder: string | null | undefined }): boolean {
  return promo.funder !== 'VENDOR';
}

/** True when this code may discount a quote or an order: a store's own code, or (switch on) any code. */
export function promoUsable(promo: { funder: string | null | undefined }): boolean {
  return !isSwiftPaidPromo(promo) || swiftPaidPromosOn();
}

/** Refuse creating, changing or restoring a Swift-paid code while they are off. */
export function assertSwiftPaidPromoWritable(promo: { funder: string | null | undefined }): void {
  if (!promoUsable(promo)) throw new AppError(403, 'SWIFT_PAID_PROMOS_OFF', SWIFT_PAID_PROMOS_OFF_MESSAGE);
}

/** Refuse a Swift-paid code at the customer's door (validate, checkout). */
export function assertPromoNotSwiftPaid(promo: { funder: string | null | undefined }): void {
  if (!promoUsable(promo)) throw new AppError(400, 'INVALID_PROMO', SWIFT_PAID_PROMO_CUSTOMER_MESSAGE);
}
