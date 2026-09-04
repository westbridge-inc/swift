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

// ---------------------------------------------------------------------------
// [AF-MOB-001] The no-show, as a policy rather than a button.
//
// The handover accepts `no_show` and, in one transaction, writes FAILED, a
// `Strike` against the customer and a company-guarantee `ReimbursementClaim` —
// today with nothing standing between the mover's tap and those three facts.
// A mover can mark ARRIVED and mark NO-SHOW in the same second, from anywhere,
// and a customer who was home the whole time carries a strike and a money
// claim on one person's unverified word.
//
// Two things were missing, and only two. Arrival evidence is NOT one of them:
// `rider.routes.ts` already measures the distance from the rider's own
// location stream (not a request body — the point being that a spoofed arrival
// must also be spoofed to the customer's map) and names every degraded case.
// What that evidence has never done is DECIDE anything. It is written into a
// status-log sentence, and the strike fires regardless of what it says.
//
// So: a grace window, and evidence that gates the CUSTOMER's punishment.
//
// The asymmetry is deliberate, and it is the whole design. Band F's rule —
// *"flag into human review, never refuse a money outcome outright"* — protects
// the MOVER: a rider genuinely at the door under a tin roof with a stale fix
// must still be able to end the job and still be paid. So the claim always
// stages. It is the customer's STRIKE that waits for evidence, because a
// strike is a punishment and a punishment on a weak fix is a wrong one.
//
// The grace window is the one refusal, and it refuses only EARLINESS, never
// the outcome: `NO_SHOW_TOO_EARLY` tells the mover when they may try again.
// Waiting two more minutes is not a stranding; being unable to close the job
// at all would be.
// ---------------------------------------------------------------------------

/** Minutes a mover must wait at the door, after arriving, before a no-show is
 *  a fact rather than an impatience. Uber's rides equivalent is ~5 minutes of
 *  verified waiting after grace; deliveries get the same. */
export const NO_SHOW_GRACE_MIN = 5;

/** How far from the destination a fix may be and still support a punishment.
 *  Generous on purpose: Georgetown addresses are imprecise, and this number
 *  decides whether a CUSTOMER is struck, not whether a mover is paid. */
export const NO_SHOW_EVIDENCE_MAX_M = 250;

/** How old the fix may be. Beyond this the rider's position is a memory. */
export const NO_SHOW_EVIDENCE_MAX_AGE_MS = 5 * 60_000;

/** What the platform actually knows about where the mover was. */
export type ArrivalFix = {
  /** Metres from the delivery point, or null when it could not be computed. */
  metres: number | null;
  /** Age of the position fix in ms, or null when there is no fix at all. */
  ageMs: number | null;
};

export type EvidenceStrength = 'STRONG' | 'WEAK' | 'ABSENT';

/**
 * How much weight the arrival evidence can carry. `ABSENT` and `WEAK` differ
 * for the humans reading a review queue — "we never had a fix" is a different
 * story from "the fix put them 900 m away" — and both withhold the strike.
 */
export function evidenceStrength(fix: ArrivalFix): EvidenceStrength {
  if (fix.metres == null || fix.ageMs == null) return 'ABSENT';
  if (fix.ageMs > NO_SHOW_EVIDENCE_MAX_AGE_MS) return 'WEAK';
  return fix.metres <= NO_SHOW_EVIDENCE_MAX_M ? 'STRONG' : 'WEAK';
}

/** Everything the no-show decision reads. Structural, like its neighbours. */
export type NoShowSnapshot = {
  /** When the mover reported arriving. Null = they never did. */
  arrivedAt: Date | null;
  fix: ArrivalFix;
};

export type NoShowDecision =
  | { allowed: false; reason: 'NOT_ARRIVED' }
  | { allowed: false; reason: 'TOO_EARLY'; retryAt: Date; waitedMs: number }
  | { allowed: true; strikeCustomer: boolean; evidence: EvidenceStrength };

/**
 * May this no-show close the job, and may it punish the customer for it?
 *
 * Note the two answers are separate. `allowed` governs the MOVER's exit;
 * `strikeCustomer` governs the CUSTOMER's record. A no-show can — and on weak
 * evidence should — end the job, pay the mover, and leave the customer
 * untouched pending review.
 */
export function noShowDecision(snapshot: NoShowSnapshot, now: Date = new Date()): NoShowDecision {
  if (!snapshot.arrivedAt) return { allowed: false, reason: 'NOT_ARRIVED' };
  const waitedMs = now.getTime() - snapshot.arrivedAt.getTime();
  const graceMs = NO_SHOW_GRACE_MIN * 60_000;
  if (waitedMs < graceMs) {
    return {
      allowed: false,
      reason: 'TOO_EARLY',
      retryAt: new Date(snapshot.arrivedAt.getTime() + graceMs),
      waitedMs,
    };
  }
  const evidence = evidenceStrength(snapshot.fix);
  return { allowed: true, strikeCustomer: evidence === 'STRONG', evidence };
}

/** True when the mover may end the job as a no-show. The predicate
 *  SWIFT_KERB_AND_COCKPIT names by this exact word. */
export function isNoShowEligible(snapshot: NoShowSnapshot, now: Date = new Date()): boolean {
  return noShowDecision(snapshot, now).allowed;
}
