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
//
// Owner decision 46 (13 Oct 2026) supersedes that for STORE orders: Swift
// never shows or implies a fee it cannot collect. A store order cancels free
// while it waits for the store to accept; once the store accepts, the customer
// cannot cancel it in the app — they contact the store — unless no mover was
// found or it is too late to deliver. `cancellationVerdict` is that rule; the
// marker remains only for the kinds owner #46 did not rule on (rides, parcels,
// bookings).
// ---------------------------------------------------------------------------

import { journalAuthorityWhere, poolForOrder } from '../dispatch/dispatch-generation-keys';
import { isTooOldToDeliver, type TooOldSubject } from '../dispatch/rescue';

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
  /** DELIVERY / PICKUP / APPOINTMENT. Required: it is half of what makes an
   *  order a STORE order (owner #46), and a caller that forgets it must fail
   *  to compile rather than silently fall into another kind's rule. */
  fulfillment: string;
  placedAt: Date;
  holdExpiresAt: Date | null;
  riderId: string | null;
  driverId: string | null;
  /** Set at checkout when the customer picks a future slot. Null = "now". */
  scheduledFor: Date | null;
  /** A booking's slot, chosen at checkout and reserved by the provider at
   *  acceptance. Optional because a delivery row never carries one; both the
   *  charge path and the preview hold full order rows, so it flows unchanged. */
  appointmentSlot?: Date | null;
  /** [Item 64] The mover search for this order's current delivery generation
   *  came back with nobody. A dispatch-journal fact, not an order column: both
   *  callers read it with `readNoMoverFound` (the charge path under the order
   *  lock) and pass it in. Absent means "not known to be true". */
  noMoverFound?: boolean;
  /** [owner #46] The order is past the food-age cutoff with nobody to carry
   *  it — the rescue sweep's own rule (`isTooOldToDeliver`, dispatch/rescue).
   *  Read by the caller with `readTooLateToDeliver` and passed in, like
   *  `noMoverFound`. Absent means "not known to be true". */
  tooLateToDeliver?: boolean;
};

/** [Item 64] What the preview tells the customer when no mover was found. */
export const NO_MOVER_FREE_CANCEL_MESSAGE = 'No mover was found. You can cancel without a fee.';

/** [owner #46] The refusal code and the words the clients show as-is. */
export const STORE_ACCEPTED_CANCEL_CODE = 'STORE_ACCEPTED';
export const STORE_ACCEPTED_CANCEL_MESSAGE = 'The store has accepted your order, so it can no longer be cancelled in the app. Contact the store to change or cancel it.';
/** [owner #46] Why a store order is free right now, in plain words. */
export const AWAITING_STORE_FREE_CANCEL_MESSAGE = 'You can cancel for free until the store accepts your order.';
export const TOO_LATE_FREE_CANCEL_MESSAGE = 'Your order is running very late. You can cancel it for free.';

/**
 * [owner #46] A STORE order: a marketplace order a business accepts and
 * prepares — food or groceries, delivered or collected. Not a ride, not a
 * parcel, and not a booking (a service business's appointment rides the same
 * FOOD_DELIVERY spine with `fulfillment: 'APPOINTMENT'`); those keep their
 * own rule until the owner rules on them.
 */
export function isStoreOrder(order: Pick<CancellationSnapshot, 'orderType' | 'fulfillment'>): boolean {
  return (order.orderType === 'FOOD_DELIVERY' || order.orderType === 'GROCERY_DELIVERY')
    && order.fulfillment !== 'APPOINTMENT';
}

/**
 * [owner #46] Is this store order too late to deliver? The rescue sweep's
 * food-age cutoff, read for one order (the same scope the sweep cancels by).
 * Only a store order can be; any other kind is never read, so a ride or a
 * parcel never touches the cutoff's configuration. `config` reads the
 * tenant's cutoff; the order fields come from the caller's row (the charge
 * path's is the locked one).
 */
export async function readTooLateToDeliver(
  config: Parameters<typeof isTooOldToDeliver>[0],
  order: TooOldSubject & Pick<CancellationSnapshot, 'orderType' | 'fulfillment'>,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isStoreOrder(order)) return false;
  return isTooOldToDeliver(config, order, now);
}

/**
 * [Item 64 · owner ruling 5 Oct: "no rider → no fee + plain message"] The
 * cancel is free because the platform could not find anyone to do the job: the
 * mover search came back empty and still nobody holds it. Read by the one
 * predicate below and by the callers' wording — never re-derived.
 */
export function freeBecauseNoMoverFound(order: Pick<CancellationSnapshot, 'riderId' | 'driverId' | 'noMoverFound'>): boolean {
  return order.noMoverFound === true && order.riderId == null && order.driverId == null;
}

/** The fields the dispatch-journal read needs; both callers hold full rows. */
export type NoMoverSubject = {
  id: string;
  orderType: string;
  fulfillment: string | null;
  fulfillmentMode: string | null;
  fulfillmentModeVersion: number;
  riderId: string | null;
  driverId: string | null;
};

/** Structural on purpose, like the snapshot: the app client and a transaction
 *  client both fit, and this file still imports nothing from Prisma. */
export interface DispatchJournalReader {
  dispatchSearch: { findFirst(args: unknown): Promise<unknown> };
}

/**
 * [Item 64] Did the mover search for this order's CURRENT delivery generation
 * come back with nobody? True when nobody holds the job and the dispatch
 * journal has an EXHAUSTED search for the platform pool that serves it:
 *  - a taxi: the driver pool's searches (they carry no delivery generation);
 *  - everything else: only platform-rider delivery (never a pickup or a
 *    store's own delivery, which have no rider search by design), and only a
 *    search of the order's current generation — an exhaustion from before the
 *    store switched who delivers says nothing about the search now. A search
 *    with no generation recorded predates generations and is generation 0
 *    (the dispatch journal's own rule).
 * An exhaustion followed by a retry still counts: the search already came back
 * empty once for this generation, and the customer has been waiting since.
 */
export async function readNoMoverFound(db: DispatchJournalReader, order: NoMoverSubject): Promise<boolean> {
  if (order.riderId != null || order.driverId != null) return false;
  // The pool and the generation rule are dispatch's own (dispatch-generation-keys.ts):
  // the fact is read by the rule the search was written by.
  const pool = poolForOrder(order);
  if (pool === 'RIDER' && (order.fulfillment !== 'DELIVERY' || order.fulfillmentMode === 'VENDOR_DELIVERY')) return false;
  const exhausted = await db.dispatchSearch.findFirst({
    where: { subjectId: order.id, subjectType: 'ORDER', status: 'EXHAUSTED', ...journalAuthorityWhere(pool, order.fulfillmentModeVersion) },
    select: { id: true },
  });
  return exhausted != null;
}

/** The real moment the work is scheduled to happen, or null for "now".
 * Both appointmentSlot and scheduledFor are true instants. */
function scheduledMoment(appointmentSlot: Date | null | undefined, scheduledFor: Date | null): Date | null {
  if (appointmentSlot != null) return appointmentSlot;
  return scheduledFor ?? null;
}

/** What a customer cancel may do right now. */
export type CancellationVerdict =
  | { allowed: true; free: true; reason: 'NO_MOVER' | 'TOO_LATE' | 'AWAITING_STORE' | 'NOTHING_COMMITTED' }
  | { allowed: true; free: false; reason: 'LATE' }
  | { allowed: false; free: false; code: typeof STORE_ACCEPTED_CANCEL_CODE; message: string };

/**
 * THE one cancellation predicate — the charge path and the customer preview
 * must both route here, or the customer is shown one outcome and handed
 * another (the drift this file exists to kill).
 *
 * [Item 64] No mover found (and still nobody holds the job): free, for every
 * kind of order — the platform could not deliver what it took.
 *
 * [owner #46] A STORE order (`isStoreOrder`) has no fee at all:
 *  - free while it waits for the store to accept (PENDING, no clock — a
 *    scheduled order included: nobody has committed to it yet);
 *  - free when it is too late to deliver (`tooLateToDeliver`);
 *  - otherwise REFUSED — the store accepted (or a mover holds the job), so the
 *    customer contacts the store. Never a fee Swift cannot collect.
 *
 * Every other kind (rides, parcels, bookings) keeps the clock below and the
 * announced-but-uncollected marker; owner #46 did not rule on them.
 */
export function cancellationVerdict(order: CancellationSnapshot, now: Date = new Date()): CancellationVerdict {
  if (freeBecauseNoMoverFound(order)) return { allowed: true, free: true, reason: 'NO_MOVER' };
  if (isStoreOrder(order)) {
    const unassigned = order.riderId == null && order.driverId == null;
    if (unassigned && order.tooLateToDeliver === true) return { allowed: true, free: true, reason: 'TOO_LATE' };
    if (unassigned && order.status === 'PENDING') return { allowed: true, free: true, reason: 'AWAITING_STORE' };
    return { allowed: false, free: false, code: STORE_ACCEPTED_CANCEL_CODE, message: STORE_ACCEPTED_CANCEL_MESSAGE };
  }
  return nothingCommittedYet(order, now)
    ? { allowed: true, free: true, reason: 'NOTHING_COMMITTED' }
    : { allowed: true, free: false, reason: 'LATE' };
}

/** Free right now — allowed AND without the marker. A refused cancel is not
 *  free; a caller deciding whether to cancel at all reads the verdict. */
export function isFreeCancellation(order: CancellationSnapshot, now: Date = new Date()): boolean {
  const verdict = cancellationVerdict(order, now);
  return verdict.allowed && verdict.free;
}

/**
 * The clock for the kinds that still have one (rides, parcels, bookings).
 * Store orders never reach it (owner #46); no-mover is decided above it.
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
 *
 * A BOOKING is the same fact read from its own column. A service business's
 * appointment carries `appointmentSlot`, not `scheduledFor`, and the provider
 * reserves that slot at acceptance — so a PENDING haircut booked this morning
 * for Thursday was handed the kitchen's five-minute clock and previewed the
 * late-cancellation marker before any provider had seen it. The slot IS the
 * scheduled moment; the rule above applies to it unchanged, and an accepted
 * booking is committed exactly as before.
 *
 * Both slot columns are instants, so the same cutoff arithmetic applies to
 * appointments and scheduled deliveries without any zone conversion here.
 */
function nothingCommittedYet(order: CancellationSnapshot, now: Date): boolean {
  const unassigned = order.riderId == null && order.driverId == null;
  if (!unassigned) return false;
  if (order.holdExpiresAt != null && order.holdExpiresAt > now) return true;
  const uncommittedStatus = order.status === 'PENDING'
    || (order.orderType === 'COURIER' && order.status === 'READY_FOR_PICKUP');
  if (!uncommittedStatus) return false;
  const minutesSincePlaced = (now.getTime() - order.placedAt.getTime()) / 60000;
  if (minutesSincePlaced <= FREE_CANCEL_WINDOW_MIN) return true;
  // Still nothing committed, and the slot has not come around yet. A booking's
  // slot is its scheduled moment (the column bookings carry).
  const slotAt = scheduledMoment(order.appointmentSlot, order.scheduledFor);
  if (slotAt == null) return false;
  const minutesUntilSlot = (slotAt.getTime() - now.getTime()) / 60000;
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
 * promise. [Item 64] Also null when it is free because no mover was found:
 * that lasts until a mover takes the job, so there is no moment to count to.
 * [owner #46] And null for every free STORE cancel: it is free until the
 * store accepts (or because the order is too late) — no clock to count down.
 */
export function freeCancellationExpiresAt(order: CancellationSnapshot, now: Date = new Date()): Date | null {
  const verdict = cancellationVerdict(order, now);
  if (!verdict.allowed || !verdict.free || verdict.reason !== 'NOTHING_COMMITTED') return null;
  // Held and unassigned: the hold IS the window.
  if (order.holdExpiresAt != null && order.holdExpiresAt > now) return order.holdExpiresAt;
  const candidates = [new Date(order.placedAt.getTime() + FREE_CANCEL_WINDOW_MIN * 60_000)];
  // The same moment the predicate read: a booking's slot, else the schedule.
  const slotAt = scheduledMoment(order.appointmentSlot, order.scheduledFor);
  if (slotAt != null) {
    candidates.push(new Date(slotAt.getTime() - FREE_CANCEL_WINDOW_MIN * 60_000));
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
