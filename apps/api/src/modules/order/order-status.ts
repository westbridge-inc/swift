import type { OrderStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// THE terminality of an order status — ONE definition.
//
// "Which statuses are terminal" was declared SEVEN times across apps/api/src:
// the exported constant here's predecessor in order.service, a local copy in
// mover-authority (custody + session revocation), locals in dispatch.service,
// delivery-watchdog (the rescue path) and fulfillment/order-sla, an inline
// literal in admin.routes, and TWICE as raw SQL strings in
// mover-authority-cutover-preparation.
//
// All seven agreed. That agreement was the hazard, not the reassurance:
// `OrderStatus[]` is not exhaustive-checked, so adding a state — or
// reclassifying one — produced NO compile error in any of them. Every copy
// would have silently kept the old set, and the two SQL strings could never be
// type-checked at all. The subsystems that would then disagree are the ones
// that can least afford it: custody decides who holds authority over an order,
// and the watchdog decides which stranded orders get rescued.
//
// This is the same drift class the codebase has already paid for twice —
// cancel-policy.ts exists because the fee shown and the fee charged were two
// literals, and vendor-visibility.ts exists because the visibility predicate
// reached six copies. This is the seventh family.
//
// THE FIX IS THE Record, not the array. `Record<OrderStatus, …>` makes adding
// an OrderStatus a COMPILE ERROR until it is deliberately classified, which
// turns a convention ("remember to update seven places") into a guarantee.
// The exported arrays are derived; they are never hand-maintained.
//
// This module is a LEAF on purpose: it imports nothing but the Prisma type, so
// any module can depend on it without a cycle. order.service re-exports
// TERMINAL_ORDER_STATUSES so existing importers are untouched.
// ---------------------------------------------------------------------------

/** Terminal = the order is finished and will not transition again. Everything
 *  else is LIVE: still moving, still cancellable, still someone's problem. */
export type Terminality = 'TERMINAL' | 'LIVE';

// ---------------------------------------------------------------------------
// CUSTODY — the EIGHTH member of this family, and the one that decides whether
// an order can be TAKEN AWAY from the person carrying it.
//
// "Has the mover taken custody yet?" was declared NINE times across
// apps/api/src, under five different names, in two mirrored halves:
//
//   taxi  (DRIVER_ASSIGNED / EN_ROUTE / ARRIVED)
//     mover-authority `DRIVER_PRE_HANDOFF`, driver.routes `cancellable`,
//     dispatch.service `NOT_ABOARD`, liveness.service `NOT_ABOARD`
//   delivery  (RIDER_ASSIGNED / EN_ROUTE_PICKUP / ARRIVED_PICKUP)
//     mover-authority `RIDER_PRE_HANDOFF`, rider.routes `PRE_CUSTODY`,
//     delivery-watchdog `PRE_CUSTODY`, agent.service (inline)
//   and the complement `IN_CUSTODY`, declared twice more.
//
// All nine agreed, and — exactly as with terminality — that agreement was the
// hazard. These are the lists that authorise a RELEASE: dropping the mover,
// re-opening the order, freeing the committed CASH float, re-dispatching. Get
// one wrong in one copy and the platform releases an order whose goods are in
// a rider's bag, or re-dispatches a taxi with the passenger already aboard.
//
// `OrderStatus[]` is not exhaustive-checked, so adding a state — a
// `DRIVER_WAITING`, a second pickup leg — compiles cleanly against all nine
// and is silently treated as "not yet in custody" by every one of them,
// because absence from a list reads as false.
//
// So custody is classified ONCE, here, in the same shape the terminality fix
// used: a `Record<OrderStatus, …>` that FAILS TO COMPILE until a new state is
// deliberately classified.
//
// TERMINALITY IS NOW DERIVED FROM IT. A status is terminal exactly when nobody
// holds the order any more, so keeping two independent records would have
// recreated the very drift this file exists to prevent — one record, three
// questions.
//
// NOT folded in: vendor.routes' `COURIER_ACTIVE`. It happens to list the same
// three statuses, but it asks a different question — "does the rider own the
// status lane, so kitchen progress must ride the timestamps instead?" — and
// unifying two questions because today's answers coincide is how the next
// drift starts.
// ---------------------------------------------------------------------------

/** Who physically holds the order right now. */
export type Custody =
  /** No mover is committed: unassigned, or still being prepared in the store. */
  | 'UNASSIGNED'
  /** A mover is committed but has NOT taken the goods/passenger yet. This is
   *  the only class an automatic release may act on. */
  | 'ASSIGNED_NOT_HOLDING'
  /** The goods are in the mover's bag, or the passenger is in the car. Never
   *  auto-release: the mover has also fronted the vendor's cash. */
  | 'MOVER_HOLDING'
  /** The order is over; custody is nobody's question any more. */
  | 'FINISHED';

/** Which mover role the state belongs to. The two legs are mirrored, and the
 *  release paths are per-leg, so the distinction has to survive the census. */
export type Mover = 'RIDER' | 'DRIVER' | 'NONE';

/**
 * Every OrderStatus, classified. **Adding a value to the OrderStatus enum
 * makes this object fail to type-check until the new state is classified** —
 * that is the entire point of this file. Do not widen the type to make an
 * error go away; classify the state.
 */
const STATUS_LAW: Record<OrderStatus, { custody: Custody; mover: Mover }> = {
  // ── Nobody is carrying it ────────────────────────────────────────────────
  PENDING: { custody: 'UNASSIGNED', mover: 'NONE' },
  ACCEPTED: { custody: 'UNASSIGNED', mover: 'NONE' },
  PREPARING: { custody: 'UNASSIGNED', mover: 'NONE' },
  READY_FOR_PICKUP: { custody: 'UNASSIGNED', mover: 'NONE' },

  // ── Delivery leg: rider committed, goods still at the store ──────────────
  RIDER_ASSIGNED: { custody: 'ASSIGNED_NOT_HOLDING', mover: 'RIDER' },
  RIDER_EN_ROUTE_PICKUP: { custody: 'ASSIGNED_NOT_HOLDING', mover: 'RIDER' },
  RIDER_ARRIVED_PICKUP: { custody: 'ASSIGNED_NOT_HOLDING', mover: 'RIDER' },

  // ── Delivery leg: goods in the rider's bag ───────────────────────────────
  PICKED_UP: { custody: 'MOVER_HOLDING', mover: 'RIDER' },
  EN_ROUTE_DELIVERY: { custody: 'MOVER_HOLDING', mover: 'RIDER' },
  ARRIVED: { custody: 'MOVER_HOLDING', mover: 'RIDER' },

  // ── Taxi leg: driver committed, passenger not aboard ─────────────────────
  DRIVER_ASSIGNED: { custody: 'ASSIGNED_NOT_HOLDING', mover: 'DRIVER' },
  DRIVER_EN_ROUTE: { custody: 'ASSIGNED_NOT_HOLDING', mover: 'DRIVER' },
  DRIVER_ARRIVED: { custody: 'ASSIGNED_NOT_HOLDING', mover: 'DRIVER' },

  // ── Taxi leg: passenger aboard ───────────────────────────────────────────
  RIDE_IN_PROGRESS: { custody: 'MOVER_HOLDING', mover: 'DRIVER' },

  // ── Over ─────────────────────────────────────────────────────────────────
  DELIVERED: { custody: 'FINISHED', mover: 'NONE' },
  COMPLETED: { custody: 'FINISHED', mover: 'NONE' },
  CANCELLED: { custody: 'FINISHED', mover: 'NONE' },
  REFUNDED: { custody: 'FINISHED', mover: 'NONE' },
  FAILED: { custody: 'FINISHED', mover: 'NONE' },
};

const ALL_STATUSES = Object.keys(STATUS_LAW) as OrderStatus[];

const byCustody = (...classes: Custody[]) =>
  ALL_STATUSES.filter((s) => classes.includes(STATUS_LAW[s].custody));

/** The custody class of a status. */
export function custodyOf(status: OrderStatus): Custody {
  return STATUS_LAW[status].custody;
}

/** THE terminal set. Derived from the custody law — never hand-written.
 *  A status is terminal exactly when the order is over. */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = byCustody('FINISHED');

/** The complement. Useful for `status: { in: … }` reads that want live work. */
export const LIVE_ORDER_STATUSES: OrderStatus[] = byCustody(
  'UNASSIGNED',
  'ASSIGNED_NOT_HOLDING',
  'MOVER_HOLDING',
);

/** Predicate form — prefer this to `TERMINAL_ORDER_STATUSES.includes(s)` at
 *  call sites that test a single status; it reads as the question being asked. */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return STATUS_LAW[status].custody === 'FINISHED';
}

/** The terminality of a status, named. */
export function terminalityOf(status: OrderStatus): Terminality {
  return isTerminalOrderStatus(status) ? 'TERMINAL' : 'LIVE';
}

/** A rider is assigned but the goods have NOT left the store. THE set an
 *  automatic release, handback or rescue may act on for a delivery leg. */
export const RIDER_PRE_CUSTODY_STATUSES: OrderStatus[] = ALL_STATUSES.filter(
  (s) => STATUS_LAW[s].custody === 'ASSIGNED_NOT_HOLDING' && STATUS_LAW[s].mover === 'RIDER',
);

/** A driver is assigned but the passenger is NOT aboard. THE set an automatic
 *  release or driver-cancel may act on for a taxi leg. */
export const DRIVER_PRE_CUSTODY_STATUSES: OrderStatus[] = ALL_STATUSES.filter(
  (s) => STATUS_LAW[s].custody === 'ASSIGNED_NOT_HOLDING' && STATUS_LAW[s].mover === 'DRIVER',
);

/** The goods are in the rider's bag. Never auto-release. */
export const RIDER_IN_CUSTODY_STATUSES: OrderStatus[] = ALL_STATUSES.filter(
  (s) => STATUS_LAW[s].custody === 'MOVER_HOLDING' && STATUS_LAW[s].mover === 'RIDER',
);

/** Either leg, mover holding: goods in a bag or a passenger in a car. This is
 *  the set no cancellation may reach — see ORDER_TRANSITIONS.CANCELLED. */
export const MOVER_HOLDING_STATUSES: OrderStatus[] = byCustody('MOVER_HOLDING');

/** True when a mover is committed but has not taken the goods/passenger. */
export function isPreCustody(status: OrderStatus): boolean {
  return STATUS_LAW[status].custody === 'ASSIGNED_NOT_HOLDING';
}

/** True when the mover physically holds the order. */
export function isMoverHolding(status: OrderStatus): boolean {
  return STATUS_LAW[status].custody === 'MOVER_HOLDING';
}

// ---------------------------------------------------------------------------
// THE MACHINE, AND THE TRUTH ABOUT RECOVERY.
//
// `ORDER_TRANSITIONS` lives here rather than in order.service because the
// modules that need it — the rescue watchdog, the rider handback, session
// revocation — are deliberately light, and order.service is not. This file
// imports nothing but the Prisma type, so any of them can depend on it.
// order.service re-exports it, so existing importers are untouched.
//
// It described the FORWARD lifecycle only, while claiming to describe all of
// it: "Anything not listed here is impossible." Twelve transitions production
// performs were therefore declared impossible, and one comment was simply
// false — PENDING said "entry state — never transitioned into" while FOUR live
// paths transition orders into it.
//
// Those twelve are not defects. They are RECOVERY: a mover was assigned and
// then had to be released — they went dark, their session was revoked, they
// handed the job back, or a passenger said "this isn't my driver" — so the
// order returns to the honest stage it was at before anyone was assigned. The
// forward table has no way to say that, because a recovery edge runs BACKWARDS
// and every forward guard would (correctly) refuse it.
//
// So recovery is declared, separately and explicitly. Two tables, because they
// are two different authorities: a forward edge is something anyone on the
// happy path may do, a recovery edge is something only a release may do.
// ---------------------------------------------------------------------------

/**
 * The locked FORWARD state machine. Key = target state, value = the states it
 * may be entered from on the normal path. Compare-and-set on these makes a
 * concurrent transition race safely.
 *
 * Canonical chain: placed(PENDING) → accepted → preparing → ready → picked_up →
 * delivered | cancelled; mover/driver legs are intermediates.
 *
 * A backwards move is NOT here and never should be — see RECOVERY_TRANSITIONS.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // No FORWARD predecessor: an order is born here. A taxi release returns an
  // order to PENDING, which is a RECOVERY edge, not a forward one.
  PENDING: [],
  ACCEPTED: ['PENDING'],
  PREPARING: ['ACCEPTED'],
  READY_FOR_PICKUP: ['PREPARING'],
  RIDER_ASSIGNED: ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'],
  RIDER_EN_ROUTE_PICKUP: ['RIDER_ASSIGNED'],
  RIDER_ARRIVED_PICKUP: ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP'],
  PICKED_UP: ['READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'],
  EN_ROUTE_DELIVERY: ['PICKED_UP'],
  ARRIVED: ['PICKED_UP', 'EN_ROUTE_DELIVERY'],
  DRIVER_ASSIGNED: ['PENDING'],
  DRIVER_EN_ROUTE: ['DRIVER_ASSIGNED'],
  DRIVER_ARRIVED: ['DRIVER_EN_ROUTE'],
  RIDE_IN_PROGRESS: ['DRIVER_ARRIVED'],
  // READY_FOR_PICKUP is here for VENDOR_DELIVERY only [F-0026]: a self-delivering
  // vendor never has a rider, so the order never passes through PICKED_UP and had
  // no exit at all — it stranded in READY_FOR_PICKUP forever. The mode check lives
  // on the one route that can fire this (vendor /orders/:id/delivered); rider
  // routes cannot reach it because they all require order.riderId.
  DELIVERED: ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS', 'READY_FOR_PICKUP'],
  // DELIVERED for delivery; READY_FOR_PICKUP for takeaway (vendor hands it
  // over); ACCEPTED for appointments, which skip prep/dispatch entirely —
  // without it the services vertical could never be closed out (found live:
  // complete-appointment always 409'd).
  COMPLETED: ['DELIVERED', 'READY_FOR_PICKUP', 'ACCEPTED'],
  CANCELLED: [
    'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED',
    'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
    'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED',
  ],
  REFUNDED: ['CANCELLED', 'DELIVERED', 'COMPLETED'],
  FAILED: ['ARRIVED', 'RIDE_IN_PROGRESS', 'PICKED_UP', 'EN_ROUTE_DELIVERY'],
};

/**
 * THE RELEASE EDGES. Key = the stage an order is returned to, value = the
 * pre-custody states a release may return it from.
 *
 * Every one of these runs backwards, and every one is only reachable by DROPPING
 * a mover. The sources are exactly the pre-custody sets: a release may never
 * touch an order whose goods are in a bag or whose passenger is in the car —
 * that is asserted against the custody law in the test suite, not restated here.
 */
export const RECOVERY_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // A taxi release un-assigns the driver and puts the ride back on the market.
  // Four paths do this: driver cancel, the stranded-taxi watchdog, session
  // revocation, and a passenger reporting "this isn't my driver".
  PENDING: ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'],
  // A delivery release returns the order to its HONEST kitchen stage — never
  // rewinding the vendor's progress, never claiming an unfinished order is
  // ready. Which of the three depends on the order's own timestamps.
  ACCEPTED: ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'],
  PREPARING: ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'],
  READY_FOR_PICKUP: ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'],

  // Nothing else is recoverable. Forward-only states, in-custody states and
  // terminal states are all listed so that adding an OrderStatus fails the
  // build here too, and the answer has to be given deliberately.
  RIDER_ASSIGNED: [],
  RIDER_EN_ROUTE_PICKUP: [],
  RIDER_ARRIVED_PICKUP: [],
  PICKED_UP: [],
  EN_ROUTE_DELIVERY: [],
  ARRIVED: [],
  DRIVER_ASSIGNED: [],
  DRIVER_EN_ROUTE: [],
  DRIVER_ARRIVED: [],
  RIDE_IN_PROGRESS: [],
  DELIVERED: [],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: [],
  FAILED: [],
};

/** True when a RELEASE may move an order from `from` to `to`. */
export function isRecoveryTransition(from: OrderStatus, to: OrderStatus): boolean {
  return RECOVERY_TRANSITIONS[to].includes(from);
}

/**
 * THE stage a released delivery leg returns to — the order's own furthest
 * honest milestone, so replacing a rider never rewinds the kitchen and never
 * claims an unfinished order is ready.
 *
 * This was computed TWICE, and the two disagreed. The release kernel read only
 * the timestamps; session revocation also special-cased COURIER. A courier
 * parcel has no kitchen — it is ready the moment it is created — so with no
 * `readyAt` the kernel returned ACCEPTED, and the customer of a parcel whose
 * rider had just been taken away was shown "Rider found". The courier-aware
 * answer is the correct one, and now it is the only one.
 */
export function releaseStageFor(order: {
  orderType: string | null;
  readyAt: Date | null;
  preparingAt: Date | null;
}): OrderStatus {
  if (order.orderType === 'COURIER' || order.readyAt) return 'READY_FOR_PICKUP';
  if (order.preparingAt) return 'PREPARING';
  return 'ACCEPTED';
}

/** Thrown when a release is asked for an edge nobody declared. */
export class UndeclaredRecoveryError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(
      `Refusing to release order from ${from} to ${to}: that is not a declared recovery edge. `
      + 'Add it to RECOVERY_TRANSITIONS with a reason, or fix the caller.',
    );
    this.name = 'UndeclaredRecoveryError';
  }
}

/**
 * The guard a release kernel runs before it writes. It exists because the
 * kernel used to take the order WITHOUT its status and trust every caller to
 * have checked custody first — so a third caller that forgot would have
 * released an order whose goods were already in a rider's bag.
 */
export function assertRecoveryTransition(from: OrderStatus, to: OrderStatus): void {
  if (!isRecoveryTransition(from, to)) throw new UndeclaredRecoveryError(from, to);
}
