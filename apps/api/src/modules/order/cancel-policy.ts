// ---------------------------------------------------------------------------
// The cancellation policy — ONE implementation [SWIFT-UG-CRAFT-01].
//
// The service CANCELS by this verdict and the customer routes PREVIEW by it.
// They were once two independent literals (order.service hardcoded the window
// while customer.routes declared its own constants with a "must match"
// comment) — the exact drift class where a customer is shown one outcome and
// handed another. Import from here or don't touch the policy.
//
// There is no cancellation fee anywhere. The old flat late-cancel "marker"
// (announced, never collected — 2026-07-20) is gone: owner decisions 46 and 50
// (13–14 Oct 2026) — Swift never shows or implies a fee it cannot collect. A
// customer cancel is either FREE or REFUSED (the customer contacts the store,
// the driver, the rider or the provider instead):
//  - store orders (#46): free while the order waits for the store to accept;
//  - rides, parcels and bookings (#50): free inside the five-minute window;
//  - every kind: free while nobody has accepted it yet, free when no mover was
//    found, and free when it is very late (#52) — nobody is ever stuck with an
//    order or a ride that never comes.
// `cancellationVerdict` is that rule.
// ---------------------------------------------------------------------------

// Kept light on purpose: boot-config imports FREE_CANCEL_WINDOW_MIN from here
// and the value-free deploy preflight loads boot-config with no services, so
// nothing heavy (Prisma, queues, notification) may be imported by this file.
// The food-age fact is read by `readTooLateToDeliver` in dispatch/rescue.ts.
import { journalAuthorityWhere, poolForOrder } from '../dispatch/dispatch-generation-keys';

/** [owner #50] Minutes after placing during which a ride, a parcel or a
 *  booking cancels free whatever has happened since. Under LIFECYCLE_V2 a held
 *  order's window lasts at least as long as its hold. */
export const FREE_CANCEL_WINDOW_MIN = 5;

/** [owner #52 · #50] How long past its promised moment an order (or the mover
 *  or provider serving it) must be before the customer may cancel it free for
 *  lateness. One number for every kind. */
export const VERY_LATE_AFTER_MIN = 30;

/** The fields the cancellation decision reads. Structural on purpose: the
 *  cancel path (order.service, and the courier route through the canonical
 *  transition) and the customer preview (customer.routes) hold full order
 *  rows — no Prisma import needed here. */
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
   *  acceptance — the booking's promised moment. */
  appointmentSlot?: Date | null;
  /** [owner #52] The delivery promise made at checkout (ALG-12; revised only
   *  out loud). */
  promisedAt?: Date | null;
  /** [owner #52] The store's prep minutes — a pickup order's promised moment
   *  is "ready in about this long" (what the order screen shows). */
  estimatedPrepTime?: number | null;
  /** [owner #50] A parcel's quoted job time in minutes. */
  estimatedDeliveryTime?: number | null;
  /** [owner #50] When the driver took the ride (the claim writes it). */
  acceptedAt?: Date | null;
  /** [Item 64] The mover search for this order's current delivery generation
   *  came back with nobody. A dispatch-journal fact, not an order column: both
   *  callers read it with `readNoMoverFound` (the cancel path under the order
   *  lock) and pass it in. Absent means "not known to be true". */
  noMoverFound?: boolean;
  /** [owner #46] The order is past the food-age cutoff with nobody to carry
   *  it — the rescue sweep's own rule (`isTooOldToDeliver`, dispatch/rescue).
   *  Read by the caller with `readTooLateToDeliver` (dispatch/rescue) and
   *  passed in, like `noMoverFound`. Absent means "not known to be true". */
  tooLateToDeliver?: boolean;
};

/** [Item 64] What the preview tells the customer when no mover was found. */
export const NO_MOVER_FREE_CANCEL_MESSAGE = 'No mover was found. You can cancel for free.';

/** [owner #46] The refusal for an accepted store order, in words the clients show as-is. */
export const STORE_ACCEPTED_CANCEL_CODE = 'STORE_ACCEPTED';
export const STORE_ACCEPTED_CANCEL_MESSAGE = 'The store has accepted your order, so it can no longer be cancelled in the app. Contact the store to change or cancel it.';
/** [owner #50] The refusal for a ride, a parcel or a booking past its window. */
export const CANCEL_WINDOW_CLOSED_CODE = 'CANCEL_WINDOW_CLOSED';
/** [owner #46] Why a store order is free right now, in plain words. */
export const AWAITING_STORE_FREE_CANCEL_MESSAGE = 'You can cancel for free until the store accepts your order.';
export const TOO_LATE_FREE_CANCEL_MESSAGE = 'Your order is running very late. You can cancel it for free.';

/** Why a cancel is free right now. */
export type FreeCancelReason =
  | 'NO_MOVER' // [Item 64] the mover search came back empty
  | 'AWAITING_STORE' // [owner #46] a store order nobody has accepted yet
  | 'NOT_ACCEPTED' // [owner #50] a ride, parcel or booking nobody has accepted yet
  | 'IN_WINDOW' // [owner #50] inside the five-minute window (or the hold)
  | 'TOO_LATE'; // [owner #46/#50/#52] very late

/** What a customer cancel may do right now: free, or refused. Never a fee. */
export type CancellationVerdict =
  | { allowed: true; free: true; reason: FreeCancelReason }
  | {
      allowed: false;
      free: false;
      code: typeof STORE_ACCEPTED_CANCEL_CODE | typeof CANCEL_WINDOW_CLOSED_CODE;
      message: string;
    };

/**
 * [owner #46] A STORE order: a marketplace order a business accepts and
 * prepares — food or groceries, delivered or collected. Not a ride, not a
 * parcel, and not a booking (a service business's appointment rides the same
 * FOOD_DELIVERY spine with `fulfillment: 'APPOINTMENT'`).
 */
export function isStoreOrder(order: Pick<CancellationSnapshot, 'orderType' | 'fulfillment'>): boolean {
  return (order.orderType === 'FOOD_DELIVERY' || order.orderType === 'GROCERY_DELIVERY')
    && order.fulfillment !== 'APPOINTMENT';
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

const MINUTE_MS = 60_000;
const plusMinutes = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MINUTE_MS);
const latest = (dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((a, b) => (b != null && (a == null || b.getTime() > a.getTime()) ? b : a), null);

/** Nobody holds the job. */
function unassigned(order: CancellationSnapshot): boolean {
  return order.riderId == null && order.driverId == null;
}

/**
 * Nobody has accepted the job yet: no mover holds it and it is still in the
 * status it was born in — PENDING, or READY_FOR_PICKUP for a parcel (a parcel
 * has no store prep step, so it is born ready and waits there for a rider).
 * Cancelling it costs nobody anything, at any age: there is no one to contact,
 * and a customer must never be stuck waiting for a ride or an order nobody took.
 */
function notAcceptedYet(order: CancellationSnapshot): boolean {
  if (!unassigned(order)) return false;
  return order.status === 'PENDING'
    || (order.orderType === 'COURIER' && order.status === 'READY_FOR_PICKUP');
}

/**
 * [owner #50] When the free window of a ride, a parcel or a booking closes:
 * five minutes after placing — or, under LIFECYCLE_V2, the end of the order's
 * hold when that is later (a held order is hidden and undispatched, so its
 * whole hold is free). The hold extends the window only while nobody holds
 * the job: the hold exemption is for orders nobody committed to (no writer
 * assigns a held order today; the policy does not trust that invariant).
 * There is no fee to protect inside the window, only the moment after which
 * the customer contacts the driver, rider or provider instead.
 */
function freeWindowEnd(order: CancellationSnapshot): Date {
  return latest([plusMinutes(order.placedAt, FREE_CANCEL_WINDOW_MIN), unassigned(order) ? order.holdExpiresAt : null]) as Date;
}

/**
 * [owner #52 · #50] The moment this order was promised for, while it can
 * still be late — or null when nothing was promised or lateness no longer
 * applies at this stage. Very late = `VERY_LATE_AFTER_MIN` past it.
 *  - store order: the checkout delivery promise (ALG-12); for a pickup with no
 *    promise, placing + the store's prep minutes (the "ready in about" the
 *    order screen shows). A scheduled order is never "late" before its slot.
 *    A pickup the store has already marked READY is waiting for the CUSTOMER,
 *    so it is never late on the store's side;
 *  - booking: the slot, while the provider has accepted but not completed it;
 *  - ride: the driver's acceptance, while the driver has not arrived. No
 *    pickup ETA is stored on a ride, so the quoted ETA is taken as zero: very
 *    late = thirty minutes after the driver accepted and still not there;
 *  - parcel: placing (or the end of its hold, or its slot) + the quoted job
 *    minutes, while the rider has not reached the pickup.
 */
function promisedMoment(order: CancellationSnapshot): Date | null {
  if (order.fulfillment === 'APPOINTMENT') {
    return order.status === 'ACCEPTED' ? (order.appointmentSlot ?? order.scheduledFor ?? null) : null;
  }
  if (isStoreOrder(order)) {
    if (order.fulfillment === 'PICKUP' && order.status === 'READY_FOR_PICKUP') return null;
    const prep = order.estimatedPrepTime != null && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : null;
    const promise = order.promisedAt
      ?? (order.fulfillment === 'PICKUP' && prep != null ? plusMinutes(order.placedAt, prep) : null);
    return latest([promise, order.scheduledFor]);
  }
  if (order.orderType === 'TAXI') {
    if (order.driverId == null || (order.status !== 'DRIVER_ASSIGNED' && order.status !== 'DRIVER_EN_ROUTE')) return null;
    return latest([order.acceptedAt ?? order.placedAt, order.scheduledFor]);
  }
  if (order.orderType === 'COURIER') {
    if (order.riderId == null || (order.status !== 'RIDER_ASSIGNED' && order.status !== 'RIDER_EN_ROUTE_PICKUP')) return null;
    const start = latest([order.placedAt, order.holdExpiresAt, order.scheduledFor]) as Date;
    return plusMinutes(start, Math.max(0, order.estimatedDeliveryTime ?? 0));
  }
  return null;
}

/** [owner #52 · #50] Is the order very late — `VERY_LATE_AFTER_MIN` past its
 *  promised moment (`promisedMoment`)? */
export function isVeryLate(order: CancellationSnapshot, now: Date = new Date()): boolean {
  const promised = promisedMoment(order);
  return promised != null && now.getTime() >= plusMinutes(promised, VERY_LATE_AFTER_MIN).getTime();
}

/** [owner #46/#50/#52] Whose lateness frees the cancel, in the customer's words. */
function tooLateMessage(order: CancellationSnapshot): string {
  if (order.fulfillment === 'APPOINTMENT') return 'The provider is running very late. You can cancel the booking for free.';
  if (order.orderType === 'TAXI') return 'Your driver is running very late. You can cancel the ride for free.';
  if (order.orderType === 'COURIER') return 'Your rider is running very late. You can cancel for free.';
  return TOO_LATE_FREE_CANCEL_MESSAGE;
}

/** [owner #50] Who the customer contacts instead, in the refusal's words. */
function windowClosedMessage(order: CancellationSnapshot): string {
  const closed = `the ${FREE_CANCEL_WINDOW_MIN}-minute cancellation window has passed`;
  if (order.fulfillment === 'APPOINTMENT') return `This booking can no longer be cancelled in the app: ${closed}. Contact the provider to change or cancel it.`;
  if (order.orderType === 'TAXI') return `This ride can no longer be cancelled in the app: ${closed}. Contact your driver.`;
  return `This delivery can no longer be cancelled in the app: ${closed}. Contact your rider.`;
}

/**
 * THE one cancellation predicate — the cancel path and the customer preview
 * must both route here, or the customer is shown one outcome and handed
 * another (the drift this file exists to kill). Never a fee: free or refused.
 *
 * Every kind of order:
 *  - [Item 64] no mover found (and still nobody holds the job): free;
 *  - nobody has accepted it yet (`notAcceptedYet`): free, at any age.
 *
 * [owner #46] A STORE order (`isStoreOrder`) once the store has accepted it:
 *  - free when it is very late — past the food-age cutoff with nobody to
 *    carry it (`tooLateToDeliver`), or [owner #52] thirty minutes past its
 *    promised time;
 *  - otherwise REFUSED: the customer contacts the store.
 *
 * [owner #50] A RIDE, a PARCEL or a BOOKING once someone has accepted it:
 *  - free inside the five-minute window (`freeWindowEnd`);
 *  - free when the driver, rider or provider is very late (`isVeryLate`);
 *  - otherwise REFUSED: the customer contacts the driver, rider or provider.
 *
 * Custody is the caller's gate, before this: an order a mover physically
 * holds (food in the bag, a passenger aboard) is never cancelled here.
 */
export function cancellationVerdict(order: CancellationSnapshot, now: Date = new Date()): CancellationVerdict {
  if (freeBecauseNoMoverFound(order)) return { allowed: true, free: true, reason: 'NO_MOVER' };
  if (isStoreOrder(order)) {
    if (notAcceptedYet(order)) return { allowed: true, free: true, reason: 'AWAITING_STORE' };
    if ((unassigned(order) && order.tooLateToDeliver === true) || isVeryLate(order, now)) {
      return { allowed: true, free: true, reason: 'TOO_LATE' };
    }
    return { allowed: false, free: false, code: STORE_ACCEPTED_CANCEL_CODE, message: STORE_ACCEPTED_CANCEL_MESSAGE };
  }
  if (now.getTime() <= freeWindowEnd(order).getTime()) return { allowed: true, free: true, reason: 'IN_WINDOW' };
  if (notAcceptedYet(order)) return { allowed: true, free: true, reason: 'NOT_ACCEPTED' };
  if (isVeryLate(order, now)) return { allowed: true, free: true, reason: 'TOO_LATE' };
  return { allowed: false, free: false, code: CANCEL_WINDOW_CLOSED_CODE, message: windowClosedMessage(order) };
}

/** May the customer cancel right now? Every allowed cancel is free. */
export function isFreeCancellation(order: CancellationSnapshot, now: Date = new Date()): boolean {
  return cancellationVerdict(order, now).allowed;
}

/**
 * WHEN the free window closes — the timestamp the app counts down to.
 *
 * Split out for the same reason the predicate was: built inline by a caller it
 * drifts from the predicate and hands the client a moment that has already
 * passed while the server still answers "free". The UI never lies, so the two
 * answers come from one place.
 *
 * Only a ride, a parcel or a booking inside its five-minute window (or hold)
 * has a moment to count down to. Null otherwise: a refused cancel has no
 * window; a free cancel for any other reason lasts — until someone accepts it
 * (nobody has yet; a store order, until the store accepts), or for as long as
 * nobody was found or the order stays late.
 */
export function freeCancellationExpiresAt(order: CancellationSnapshot, now: Date = new Date()): Date | null {
  const verdict = cancellationVerdict(order, now);
  if (!verdict.allowed || verdict.reason !== 'IN_WINDOW') return null;
  return freeWindowEnd(order);
}

/** What a customer screen is told about cancelling, straight from the verdict:
 *  the order preview and the ride read hand this to the apps, so no client
 *  re-derives the rule. The refusal's contact number is the caller's to add
 *  (only the order preview knows the business). */
export type CustomerCancelView = {
  canCancel: boolean;
  freeCancellationExpiresAt: string | null;
  cancellationMessage: string | null;
  cancelUnavailable: { code: string; message: string } | null;
};

/** [owner #46/#50/#52] The verdict in the words the apps show. */
export function customerCancelView(order: CancellationSnapshot, now: Date = new Date()): CustomerCancelView {
  const verdict = cancellationVerdict(order, now);
  if (!verdict.allowed) {
    return { canCancel: false, freeCancellationExpiresAt: null, cancellationMessage: null, cancelUnavailable: { code: verdict.code, message: verdict.message } };
  }
  const cancellationMessage = verdict.reason === 'NO_MOVER'
    ? NO_MOVER_FREE_CANCEL_MESSAGE
    : verdict.reason === 'AWAITING_STORE'
      ? AWAITING_STORE_FREE_CANCEL_MESSAGE
      : verdict.reason === 'TOO_LATE' ? tooLateMessage(order) : null;
  return {
    canCancel: true,
    freeCancellationExpiresAt: freeCancellationExpiresAt(order, now)?.toISOString() ?? null,
    cancellationMessage,
    cancelUnavailable: null,
  };
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
