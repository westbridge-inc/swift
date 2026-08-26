// ---------------------------------------------------------------------------
// The cancellation policy — ONE implementation [SWIFT-UG-CRAFT-01].
//
// The service CHARGES by these numbers and the customer routes PREVIEW by
// them. They were previously two independent literals (order.service
// hardcoded 5/500 while customer.routes declared its own constants with a
// "must match" comment) — the exact drift class where a customer is shown one
// fee and "charged" another. Import from here or don't touch the policy.
//
// ADR: the fee is flat and announced-but-uncollected (cash-only platform —
// Swift can't collect it); its role is deterrence + the risk-score signal.
// Founder decision 2026-07-20: record it as a marker, keep displaying it.
// ---------------------------------------------------------------------------

/** Minutes after placing during which a PENDING order cancels free. Under
 *  LIFECYCLE_V2 the hold window itself is always free regardless. */
export const FREE_CANCEL_WINDOW_MIN = 5;

/** Flat late-cancellation fee (GYD, integer). */
export const LATE_CANCEL_FEE = 500;

/** The fields the free-cancellation decision reads. Structural on purpose:
 *  both the charge path (order.service) and the customer preview
 *  (customer.routes) hold full order rows — no Prisma import needed here. */
export type CancellationSnapshot = {
  status: string;
  orderType: string;
  placedAt: Date;
  holdExpiresAt: Date | null;
  riderId: string | null;
  driverId: string | null;
};

/**
 * THE one free-cancellation predicate — the charge path and the customer
 * preview must both route here, or the customer is shown one fee and
 * "charged" another (the drift this file exists to kill).
 *
 * Free means NOTHING WAS COMMITTED yet:
 *  - no mover holds the job (`riderId`/`driverId`) — every assignment writer
 *    CASes status forward atomically today, but the money boundary does not
 *    trust that invariant; an assignment ends the free window in every branch;
 *  - within the LIFECYCLE_V2 hold nobody has even seen the order, so an
 *    unassigned held order is always free;
 *  - after the hold, the legacy clock applies to the order's UNCOMMITTED
 *    status: PENDING for marketplace/taxi — and READY_FOR_PICKUP for COURIER,
 *    which is born there (a parcel has no vendor prep step, so it never has a
 *    PENDING phase; keying on PENDING alone silently charged every unclaimed
 *    parcel the moment its hold lapsed).
 *
 * Marketplace READY_FOR_PICKUP stays chargeable: a vendor cooked/prepared —
 * that IS commitment. The carve-out is COURIER-scoped for exactly that reason.
 */
export function isFreeCancellation(order: CancellationSnapshot, now: Date = new Date()): boolean {
  const unassigned = order.riderId == null && order.driverId == null;
  if (!unassigned) return false;
  if (order.holdExpiresAt != null && order.holdExpiresAt > now) return true;
  const uncommittedStatus = order.status === 'PENDING'
    || (order.orderType === 'COURIER' && order.status === 'READY_FOR_PICKUP');
  const minutesSincePlaced = (now.getTime() - order.placedAt.getTime()) / 60000;
  return uncommittedStatus && minutesSincePlaced <= FREE_CANCEL_WINDOW_MIN;
}
