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
  /** Set at checkout when the customer picks a future slot. Null = "now". */
  scheduledFor: Date | null;
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
 *
 * SCHEDULED ORDERS get the same treatment for the same reason. "Five minutes
 * since placing" is not a rule about five minutes; it is a PROXY for "nobody
 * has started yet", and on a scheduled order that proxy is simply wrong. A
 * customer who books tomorrow's dinner at 9am this morning is handed the
 * identical five-minute clock, so from 9:05am cancelling costs the late-cancel
 * marker — for an order no vendor will touch for thirty-four hours and no
 * mover has been offered. The clock expired long before the work could
 * possibly begin.
 *
 * So a scheduled order is free while its SLOT is still more than the window
 * away. That deliberately reuses FREE_CANCEL_WINDOW_MIN rather than inventing
 * a second number: the window is the last stretch before the thing happens,
 * whether "the thing" is the kitchen picking up an order placed now or a slot
 * booked for Thursday. The two branches are OR'd, so this is never STRICTER
 * than today — an order scheduled for two minutes from now still gets its
 * ordinary post-placement window.
 *
 * The shape of a longer-horizon cancellation CURVE (does a week's notice
 * differ from an hour's?) is a founder decision and is not invented here.
 * This only stops charging for a commitment that provably has not happened.
 */
export function isFreeCancellation(order: CancellationSnapshot, now: Date = new Date()): boolean {
  const unassigned = order.riderId == null && order.driverId == null;
  if (!unassigned) return false;
  if (order.holdExpiresAt != null && order.holdExpiresAt > now) return true;
  const uncommittedStatus = order.status === 'PENDING'
    || (order.orderType === 'COURIER' && order.status === 'READY_FOR_PICKUP');
  if (!uncommittedStatus) return false;
  const minutesSincePlaced = (now.getTime() - order.placedAt.getTime()) / 60000;
  if (minutesSincePlaced <= FREE_CANCEL_WINDOW_MIN) return true;
  // Still nothing committed, and the slot has not come around yet.
  if (order.scheduledFor == null) return false;
  const minutesUntilSlot = (order.scheduledFor.getTime() - now.getTime()) / 60000;
  return minutesUntilSlot > FREE_CANCEL_WINDOW_MIN;
}

/**
 * WHEN the free window closes — the timestamp the app counts down to.
 *
 * Split out for the same reason the predicate was: the preview used to build
 * this inline as `placedAt + FREE_CANCEL_WINDOW_MIN`, which is correct only
 * for an order happening now. Add the scheduled branch to `isFreeCancellation`
 * and that inline expression starts handing the client a moment in the PAST
 * while the server still answers "free" — a countdown that has already run out
 * on an order that is genuinely still free to cancel. The UI never lies, so
 * the two answers come from one place.
 *
 * Returns null when the cancel is not free right now; there is no window to
 * promise.
 */
export function freeCancellationExpiresAt(order: CancellationSnapshot, now: Date = new Date()): Date | null {
  if (!isFreeCancellation(order, now)) return null;
  // Held and unassigned: the hold IS the window.
  if (order.holdExpiresAt != null && order.holdExpiresAt > now) return order.holdExpiresAt;
  const candidates = [new Date(order.placedAt.getTime() + FREE_CANCEL_WINDOW_MIN * 60_000)];
  if (order.scheduledFor != null) {
    candidates.push(new Date(order.scheduledFor.getTime() - FREE_CANCEL_WINDOW_MIN * 60_000));
  }
  // The two branches of the predicate are OR'd, so the window ends at the
  // LATER of them — anything else expires the countdown early.
  return candidates.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
}
