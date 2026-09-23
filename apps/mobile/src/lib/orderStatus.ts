/**
 * What an order's status is called, in words, for the person waiting on it.
 *
 * Two bugs lived in the old six-entry map on HomeScreen:
 *
 * 1. `READY` was never a status. The enum value is `READY_FOR_PICKUP`, so the
 *    key never matched and the label was dead code from the day it was typed.
 *    Of the fifteen non-terminal statuses the active-order query can return,
 *    only five had a label; the other ten fell through to "Order in progress",
 *    which tells someone standing on a kerb precisely nothing.
 *
 * 2. The map had no idea what KIND of order it was describing. A taxi ride is
 *    born `PENDING` with no vendor attached, so a passenger sitting in the back
 *    of a moving car was told "Waiting for the store". There is no store.
 *
 * So the label depends on the order type, and the fallback is honest rather
 * than confident: a status this file has not been taught reads as "In
 * progress", never as a guess about what is happening.
 */
export type OrderKind = 'FOOD_DELIVERY' | 'GROCERY_DELIVERY' | 'COURIER' | 'TAXI';

/**
 * What the SERVER declares an order's vertical to be. The persisted enum has
 * no SERVICE member — a barbershop booking is stored on the FOOD_DELIVERY
 * spine — so the API derives SERVICE from the business type and the
 * appointment fulfillment (`orderVertical`, apps/api) and sends it beside
 * `orderType` as `vertical`. Everything else is the persisted type. This file
 * renders that declaration; it never re-derives it from a vendor or a line.
 */
export type OrderVertical = OrderKind | 'SERVICE';

/** Terminal states — an order here is finished and is not "active". */
const TERMINAL: Record<string, string> = {
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
  FAILED: 'Failed',
};

/** A ride. No store, no picking, no packing — a driver and a car. */
const TAXI: Record<string, string> = {
  PENDING: 'Finding you a driver',
  ACCEPTED: 'Driver found',
  DRIVER_ASSIGNED: 'Driver assigned',
  DRIVER_EN_ROUTE: 'Driver on the way',
  DRIVER_ARRIVED: 'Your driver is outside',
  RIDE_IN_PROGRESS: 'On your way',
};

/** A parcel. Someone collects it from you and takes it to someone else. */
const COURIER: Record<string, string> = {
  PENDING: 'Finding a rider',
  ACCEPTED: 'Rider found',
  RIDER_ASSIGNED: 'Rider on the way to collect',
  RIDER_EN_ROUTE_PICKUP: 'Rider on the way to collect',
  RIDER_ARRIVED_PICKUP: 'Rider is at the pickup',
  PICKED_UP: 'On its way',
  EN_ROUTE_DELIVERY: 'On its way',
  ARRIVED: 'Rider has arrived',
};

/** A booking with a service business: a provider confirms it and does the
 *  work. No store, no kitchen, no rider — a status a booking never reaches
 *  falls through to the honest fallback rather than borrowing store words. */
const SERVICE: Record<string, string> = {
  PENDING: 'Waiting for the provider',
  ACCEPTED: 'Booking confirmed',
};

/** Food and groceries: a merchant prepares it, then a rider carries it. */
const FROM_A_STORE: Record<string, string> = {
  PENDING: 'Waiting for the store',
  ACCEPTED: 'Order accepted',
  PREPARING: 'Being prepared',
  READY_FOR_PICKUP: 'Ready for pickup',
  RIDER_ASSIGNED: 'Rider on the way to the store',
  RIDER_EN_ROUTE_PICKUP: 'Rider on the way to the store',
  RIDER_ARRIVED_PICKUP: 'Rider is at the store',
  PICKED_UP: 'On its way to you',
  EN_ROUTE_DELIVERY: 'On its way to you',
  ARRIVED: 'Your rider has arrived',
};

export function orderStatusLabel(status: string | null | undefined, kind?: string | null): string {
  const s = String(status ?? '').toUpperCase();
  if (!s) return 'In progress';

  if (TERMINAL[s]) return TERMINAL[s]!;

  const table = kind === 'TAXI' ? TAXI : kind === 'COURIER' ? COURIER : kind === 'SERVICE' ? SERVICE : FROM_A_STORE;
  // A taxi that somehow reports a rider status (or vice versa) should not be
  // described with the other vertical's words — fall through to the honest
  // fallback instead of borrowing a label that would be actively misleading.
  return table[s] ?? 'In progress';
}

/**
 * The vertical a screen should speak: the server's declaration when it sent
 * one, else the persisted type — so an older API that sends no `vertical`
 * still gets its own words, and a newer one gets SERVICE for a booking.
 */
export function presentedVertical(order: { vertical?: string | null; orderType?: string | null }): string | null {
  return order.vertical ?? order.orderType ?? null;
}

/** Who has not been told yet while an order is held: a booking has not been
 *  sent to a "store". */
export function orderRecipientNoun(vertical: string | null | undefined): 'the provider' | 'the store' {
  return vertical === 'SERVICE' ? 'the provider' : 'the store';
}

/**
 * The line under the status: who it is with, and which order it is.
 *
 * It used to be `{vendor?.name} · #{orderNumber}` interpolated directly, so a
 * taxi or a parcel — which have no vendor — rendered a leading orphan: the
 * separator with nothing in front of it. Segments are joined, never prefixed.
 */
export function orderSubtitle(vendorName?: string | null, orderNumber?: string | null): string {
  return [vendorName, orderNumber ? `#${orderNumber}` : null].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// [W-25] Why a store cannot mark an MMG payment received.
//
// These are PAYMENT states, not order states, but they are prose about an
// order and prose has one owner — a second copy in a screen drifts the day
// either is edited. Both vendor surfaces read them from here.
// ---------------------------------------------------------------------------

/** The payment states where a store's word that money arrived is admissible. */
export const ATTESTABLE_PAYMENT_STATUSES = ['PENDING', 'AUTHORIZED'] as const;

const PAYMENT_BLOCKED: Record<string, string> = {
  REFUNDED: 'This payment was refunded — a new payment is a new transaction.',
  PARTIALLY_REFUNDED: 'This payment was partly refunded — support settles the balance.',
  FAILED: 'MMG reports this payment as failed. Contact support with the reference if money did reach you.',
  EXPIRED: 'The payment window closed — ask the customer to pay again.',
  UNKNOWN: 'Unresolved with MMG. Support settles it; it cannot be marked received here.',
  CANCELLED: 'This payment was superseded.',
};

/** True when a store may attest against this payment state. */
export function canAttestPayment(paymentStatus: string | null | undefined): boolean {
  return (ATTESTABLE_PAYMENT_STATUSES as readonly string[]).includes(String(paymentStatus ?? ''));
}

/** The sentence to show instead of the button, or null when there is nothing to say. */
export function paymentAttestBlockedReason(paymentStatus: string | null | undefined): string | null {
  return PAYMENT_BLOCKED[String(paymentStatus ?? '')] ?? null;
}
