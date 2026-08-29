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

/**
 * Every OrderStatus, classified. **Adding a value to the OrderStatus enum
 * makes this object fail to type-check until the new state is classified** —
 * that is the entire point of this file. Do not widen the type to make an
 * error go away; classify the state.
 */
const TERMINALITY: Record<OrderStatus, Terminality> = {
  // ── Terminal ─────────────────────────────────────────────────────────────
  DELIVERED: 'TERMINAL',
  COMPLETED: 'TERMINAL',
  CANCELLED: 'TERMINAL',
  REFUNDED: 'TERMINAL',
  FAILED: 'TERMINAL',

  // ── Live: marketplace / delivery ─────────────────────────────────────────
  PENDING: 'LIVE',
  ACCEPTED: 'LIVE',
  PREPARING: 'LIVE',
  READY_FOR_PICKUP: 'LIVE',
  RIDER_ASSIGNED: 'LIVE',
  RIDER_EN_ROUTE_PICKUP: 'LIVE',
  RIDER_ARRIVED_PICKUP: 'LIVE',
  PICKED_UP: 'LIVE',
  EN_ROUTE_DELIVERY: 'LIVE',
  ARRIVED: 'LIVE',

  // ── Live: taxi ───────────────────────────────────────────────────────────
  DRIVER_ASSIGNED: 'LIVE',
  DRIVER_EN_ROUTE: 'LIVE',
  DRIVER_ARRIVED: 'LIVE',
  RIDE_IN_PROGRESS: 'LIVE',
};

const ALL_STATUSES = Object.keys(TERMINALITY) as OrderStatus[];

/** THE terminal set. Derived from TERMINALITY — never hand-written. */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ALL_STATUSES.filter(
  (s) => TERMINALITY[s] === 'TERMINAL',
);

/** The complement. Useful for `status: { in: … }` reads that want live work. */
export const LIVE_ORDER_STATUSES: OrderStatus[] = ALL_STATUSES.filter(
  (s) => TERMINALITY[s] === 'LIVE',
);

/** Predicate form — prefer this to `TERMINAL_ORDER_STATUSES.includes(s)` at
 *  call sites that test a single status; it reads as the question being asked. */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINALITY[status] === 'TERMINAL';
}
