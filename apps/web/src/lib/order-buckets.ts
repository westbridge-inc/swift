// ---------------------------------------------------------------------------
// [W-11] THE VENDOR ORDER BOARD MAY NOT LOSE AN ORDER.
//
// The board grouped orders by scanning a list of matchers and pushing only on a
// hit:
//
//     const b = BUCKETS.find((x) => x.match(status));
//     if (b) map.get(b.key)!.push(o);          // <- no else
//
// An order whose status matched nothing was SILENTLY DROPPED. Not shown in
// another lane, not counted, not mentioned: gone. And the matchers were not
// exhaustive. Measured against the OrderStatus enum the API actually sends:
//
//   NOT MATCHED BY ANY LANE — invisible on the vendor's board today:
//     EN_ROUTE_DELIVERY, ARRIVED   (real delivery states; order.service.ts
//                                   transitions PICKED_UP → EN_ROUTE_DELIVERY
//                                   → ARRIVED)
//     REFUNDED, FAILED             (money outcomes the vendor most needs)
//     DRIVER_ASSIGNED, DRIVER_EN_ROUTE, DRIVER_ARRIVED, RIDE_IN_PROGRESS
//
//   MATCHERS FOR STATUSES THAT DO NOT EXIST — dead code that made the lanes
//   look comprehensive:
//     PLACED, CONFIRMED, READY, RIDER_EN_ROUTE_DROPOFF
//
// So the fix is not another matcher. It is an EXHAUSTIVE map plus a visible
// lane for anything unmapped, and a census test that fails the day a status is
// added to the enum. A status the board does not understand becomes loud, not
// invisible.
// ---------------------------------------------------------------------------

export type BucketKey = 'new' | 'kitchen' | 'handoff' | 'moving' | 'done' | 'attention' | 'unknown';

export const BUCKETS: ReadonlyArray<{ key: BucketKey; label: string }> = [
  { key: 'new', label: 'New' },
  { key: 'kitchen', label: 'In progress' },
  { key: 'handoff', label: 'Ready / handoff' },
  { key: 'moving', label: 'Out for delivery' },
  { key: 'done', label: 'Done' },
  // REFUNDED and FAILED used to match nothing and vanish. They are money
  // outcomes; the vendor is the person who most needs to see them.
  { key: 'attention', label: 'Needs attention' },
  // Anything the server sends that this build does not know about. An empty
  // lane costs nothing; a hidden order costs an order.
  { key: 'unknown', label: 'Unrecognised' },
];

/**
 * Every OrderStatus the API can send, classified. This is asserted 1:1 against
 * `packages/types/src/order.ts` by the census test, so adding a status to the
 * enum turns this file red rather than quietly hiding those orders.
 */
export const STATUS_BUCKET: Readonly<Record<string, BucketKey>> = {
  PENDING: 'new',

  ACCEPTED: 'kitchen',
  PREPARING: 'kitchen',

  READY_FOR_PICKUP: 'handoff',
  RIDER_ASSIGNED: 'handoff',
  RIDER_EN_ROUTE_PICKUP: 'handoff',
  RIDER_ARRIVED_PICKUP: 'handoff',

  PICKED_UP: 'moving',
  EN_ROUTE_DELIVERY: 'moving',
  ARRIVED: 'moving',
  // A mover on the ride rail can carry a delivery; these are still "with the
  // mover, on the way" from the vendor's side, and must not disappear.
  DRIVER_ASSIGNED: 'moving',
  DRIVER_EN_ROUTE: 'moving',
  DRIVER_ARRIVED: 'moving',
  RIDE_IN_PROGRESS: 'moving',

  DELIVERED: 'done',
  COMPLETED: 'done',
  CANCELLED: 'done',

  REFUNDED: 'attention',
  FAILED: 'attention',
};

/** The lane for a status. Anything unmapped is `unknown` — never dropped. */
export function bucketFor(status: string | null | undefined): BucketKey {
  const key = (status ?? '').toUpperCase();
  return STATUS_BUCKET[key] ?? 'unknown';
}

/**
 * Group orders into every lane, including the empty ones. The total across all
 * lanes always equals the number of orders in — that is the property the old
 * `if (b)` broke, and the one the test pins.
 */
export function groupOrders<T extends { status?: string | null }>(orders: readonly T[]): Map<BucketKey, T[]> {
  const map = new Map<BucketKey, T[]>();
  for (const b of BUCKETS) map.set(b.key, []);
  for (const o of orders) map.get(bucketFor(o.status))!.push(o);
  return map;
}

export interface Completeness {
  /** What the server says exists, when it says so. */
  total: number | null;
  shown: number;
  /** How many exist that this page is not showing. */
  missing: number;
  /** True only when the server told us a total AND we are showing all of it. */
  complete: boolean;
}

/**
 * What the board is allowed to claim about its own completeness.
 *
 * The board asked for 100 and ignored `meta` entirely, so a vendor with 143
 * orders saw 100 and was told nothing. `complete` is false when the total is
 * unknown as well as when it is larger — an unknown total is not a complete one.
 */
export function completeness(shown: number, meta: unknown): Completeness {
  const total =
    meta && typeof meta === 'object' && typeof (meta as { total?: unknown }).total === 'number'
      ? (meta as { total: number }).total
      : null;
  if (total === null) return { total: null, shown, missing: 0, complete: false };
  return { total, shown, missing: Math.max(0, total - shown), complete: total <= shown };
}
