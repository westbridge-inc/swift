import type { FastifyInstance } from 'fastify';

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

export function dispatchTrigger(): DispatchTrigger {
  return process.env['DISPATCH_TRIGGER'] === 'ON_READY' ? 'ON_READY' : 'ON_ACCEPT';
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
