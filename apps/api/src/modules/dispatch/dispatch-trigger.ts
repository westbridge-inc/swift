import type { FastifyInstance } from 'fastify';
import type { OrderStatus, Prisma } from '@prisma/client';
import { ORDER_TRANSITIONS } from '../order/order-status';
import { log } from '../../utils/logger';

/**
 * FUL-005 (fulfillment prompt Part 5.1): WHEN a delivery order is dispatched to
 * riders is the single biggest lever on delivery time and food temperature.
 *
 * - `ON_ACCEPT` — **the default, and Swift's current behavior**: dispatch when
 *   the vendor ACCEPTS, so the rider travels to the store DURING prep and rider
 *   + food tend to converge. This is closer to the "PREDICTIVE" ideal than a
 *   literal `ON_READY` (which makes hot food wait the full rider-ETA after it's
 *   cooked), which is why it stays the default — see reports/fulfillment/
 *   RECONCILIATION.md Q1. Changing it should be decided on Swift's own numbers.
 * - `ON_READY` — the founder's literal spec: dispatch when the vendor marks the
 *   order READY. Simpler, but slower/colder. Built and switchable per deployment.
 * - `PREDICTIVE` — dispatch at expected_ready − rider_eta; needs prep-time data.
 *   Documented as the upgrade path, not built yet.
 *
 * Selected per-deployment via env `DISPATCH_TRIGGER`. Default `ON_ACCEPT`, so
 * existing behavior is unchanged until it's flipped deliberately.
 */
export type DispatchTrigger = 'ON_ACCEPT' | 'ON_READY';
export type RequestedDispatchTrigger = DispatchTrigger | 'PREDICTIVE';

/** What the deployment ASKED for — including PREDICTIVE, which is not live yet. */
export function requestedDispatchTrigger(): RequestedDispatchTrigger {
  const v = process.env['DISPATCH_TRIGGER'];
  return v === 'ON_READY' || v === 'PREDICTIVE' ? v : 'ON_ACCEPT';
}

let predictiveWarned = false;
/** Test seam only. */
export function _resetPredictiveWarning(): void { predictiveWarned = false; }

/**
 * What dispatch actually runs. [ALG-03 / R-2.4.2] PREDICTIVE needs a promoted
 * prep-time learner (the nightly shadow gate: median error ≤ 4 min, p80
 * coverage ≥ 80%). Until then it degrades to ON_ACCEPT — never earlier than
 * ON_ACCEPT would dispatch, per the algorithm document's clamp — and says so
 * once in the log rather than silently.
 */
export function dispatchTrigger(): DispatchTrigger {
  const requested = requestedDispatchTrigger();
  if (requested === 'PREDICTIVE') {
    if (!predictiveWarned) {
      predictiveWarned = true;
      log().warn({ requested }, 'dispatch-trigger: PREDICTIVE requested but the prep-time learner is unpromoted (ALG-03 shadow) — dispatching ON_ACCEPT');
    }
    return 'ON_ACCEPT';
  }
  return requested;
}

/** The status, not a milestone timestamp or client flag, grants readiness.
 * Courier/taxi have no vendor preparation phase. Unknown types fail closed. */
export function riderDispatchableStatusesFor(
  orderType: string | null | undefined,
  trigger: DispatchTrigger = dispatchTrigger(),
): OrderStatus[] {
  return trigger === 'ON_READY' && !['COURIER', 'TAXI'].includes(orderType ?? '')
    ? ['READY_FOR_PICKUP'] : [...ORDER_TRANSITIONS.RIDER_ASSIGNED];
}

export function withheldAwaitingReadiness(
  order: { status: string; orderType: string | null | undefined },
  trigger: DispatchTrigger = dispatchTrigger(),
): boolean {
  return ORDER_TRANSITIONS.RIDER_ASSIGNED.includes(order.status as OrderStatus)
    && !riderDispatchableStatusesFor(order.orderType, trigger).includes(order.status as OrderStatus);
}

/** Compose in AND so the caller's ownership/hold OR cannot be overwritten. */
export function riderDispatchReadinessFilter(trigger: DispatchTrigger = dispatchTrigger()): Prisma.OrderWhereInput {
  return trigger === 'ON_READY'
    ? { OR: [{ orderType: { in: ['COURIER', 'TAXI'] } }, { status: 'READY_FOR_PICKUP' }] } : {};
}

/** A null hold is released; equality is the first legal dispatch instant. */
export function dispatchHoldExpired(order: { holdExpiresAt: Date | null }, now = new Date()): boolean {
  return order.holdExpiresAt == null || order.holdExpiresAt <= now;
}

export function dispatchHoldExpiredFilter(now = new Date()): Prisma.OrderWhereInput {
  return { OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: now } }] };
}

/**
 * Enqueue the delivery-dispatch job. The ONE place the job is shaped, so the
 * accept-time and ready-time triggers cannot drift apart. Express jumps the
 * queue (lower priority number = higher BullMQ priority). No-op if the queue
 * isn't wired (e.g. the API running with workers off).
 */
export async function enqueueDeliveryDispatch(
  app: FastifyInstance,
  order: { id: string; isExpress: boolean },
): Promise<void> {
  if (!app.dispatchQueue) return;
  await app.dispatchQueue.add(
    'dispatch-order',
    { orderId: order.id },
    { priority: order.isExpress ? 1 : 10, removeOnComplete: 100, removeOnFail: 50 },
  );
}
