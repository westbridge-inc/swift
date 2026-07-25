import type { OrderStatus } from '@prisma/client';

/**
 * FUL-007: vendor kitchen-capacity guard (Part 5D — protect the kitchen).
 *
 * A small kitchen slammed with more simultaneous orders than it can cook falls
 * behind on every one of them. Rather than make the owner babysit the manual
 * "pause orders" toggle, a vendor can set a concurrent-order cap; the server
 * refuses new orders once the kitchen is already holding that many in flight.
 *
 * "In flight / still in the kitchen" = accepted-or-earlier plus food that's
 * cooked-but-not-yet-collected. Once a rider picks up (PICKED_UP onward) the
 * order is off the kitchen's hands and no longer counts against the cap.
 */
export const KITCHEN_ACTIVE_STATUSES: OrderStatus[] = [
  'PENDING',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
];

/**
 * Is the kitchen at (or over) its concurrent-order cap? A null cap means the
 * vendor never set one — unlimited intake, the default for every vendor.
 */
export function isKitchenAtCapacity(activeCount: number, cap: number | null | undefined): boolean {
  if (cap === null || cap === undefined) return false;
  return activeCount >= cap;
}
