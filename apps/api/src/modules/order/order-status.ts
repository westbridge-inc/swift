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
