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

  const table = kind === 'TAXI' ? TAXI : kind === 'COURIER' ? COURIER : FROM_A_STORE;
  // A taxi that somehow reports a rider status (or vice versa) should not be
  // described with the other vertical's words — fall through to the honest
  // fallback instead of borrowing a label that would be actively misleading.
  return table[s] ?? 'In progress';
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
