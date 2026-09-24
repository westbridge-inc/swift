/**
 * [E10] The reasons a store gives when it rejects an order. The API requires
 * one on every rejection and tells the customer, so the words must fit the
 * order: a salon declining a booking cannot say its kitchen is busy (DS200 D3).
 * The phone app carries the same lists (apps/mobile/src/modules/vendor/rejectReasons.ts).
 */
export const ORDER_REJECT_REASONS = ['Out of stock', 'Kitchen is too busy', 'Closing soon'] as const;
export const BOOKING_REJECT_REASONS = ['Fully booked at that time', 'Not available that day', 'Closing early that day'] as const;

export function rejectReasonsFor(fulfillment: string | null | undefined): readonly string[] {
  return fulfillment === 'APPOINTMENT' ? BOOKING_REJECT_REASONS : ORDER_REJECT_REASONS;
}
