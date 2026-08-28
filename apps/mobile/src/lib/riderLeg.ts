/**
 * WHERE A RIDER IS IN THE JOB, AND WHAT THEY DO NEXT.
 *
 * One authority for the rider's leg of a delivery: it maps the order status to
 * the single action available at that moment, and it answers the one question
 * several surfaces need to ask about that sequence — has the rider taken
 * custody of the goods yet?
 *
 * It lives here rather than in the cockpit screen for the same reason
 * `orderStatus.ts` does: it is a pure function of status, it decides what a
 * person is told, and more than one surface needs it. A copy in a screen is how
 * the customer-facing status map went wrong twice.
 */

export type RiderAction = 'en-route-pickup' | 'arrived-pickup' | 'picked-up' | 'en-route-delivery' | 'arrived';

export type RiderStep = { label: string; action: RiderAction };

/** The one thing the rider can do next, or null when the handover controls take
 *  over (ARRIVED) or the job is not on the rider's lane at all. */
export function riderStep(job: { status?: string | null } | null | undefined): RiderStep | null {
  const s = String(job?.status ?? '').toUpperCase();
  if (s === 'RIDER_ASSIGNED') return { label: "I'm on the way to pick up", action: 'en-route-pickup' };
  if (s === 'RIDER_EN_ROUTE_PICKUP') return { label: "I've arrived at pickup", action: 'arrived-pickup' };
  if (s === 'RIDER_ARRIVED_PICKUP' || s === 'READY_FOR_PICKUP') return { label: 'Picked up the order', action: 'picked-up' };
  if (s === 'PICKED_UP') return { label: "I'm on the way to the customer", action: 'en-route-delivery' };
  if (s === 'EN_ROUTE_DELIVERY') return { label: "I've arrived at the customer", action: 'arrived' };
  return null; // ARRIVED → the handover/delivered controls take over
}

/**
 * The pickup leg: the goods are still with the vendor, not the rider.
 *
 * Read off the action union above, not restated as a status list — rename an
 * action and this stops compiling. A new POST-custody action is excluded by
 * default, which is the safe direction: the worst case is a counter signal
 * going quiet early rather than one that keeps claiming a bag is waiting.
 */
const PRE_CUSTODY_ACTIONS: ReadonlySet<RiderAction> = new Set(['en-route-pickup', 'arrived-pickup', 'picked-up']);

export function awaitingPickup(job: { status?: string | null } | null | undefined): boolean {
  const step = riderStep(job);
  return step != null && PRE_CUSTODY_ACTIONS.has(step.action);
}

/**
 * IS THE KITCHEN'S "IT'S READY" SIGNAL STILL TRUE?
 *
 * `readyAt` is a HISTORICAL FACT — the minute prep finished — and nothing
 * clears it. Every other reader in the app treats it that way and is right to:
 * the customer's timeline marks "preparation finished" permanently, the vendor
 * stops being offered "Mark ready", the prep-duration line needs the stamp.
 * A completed step stays completed.
 *
 * The rider cockpit was the one place reading it as a CURRENT state, and so
 * kept a green tick reading "Order is packed and ready for pickup" on screen
 * through PICKED_UP, EN_ROUTE_DELIVERY and ARRIVED — telling a rider who had
 * already collected the bag, driven across town and parked outside the customer
 * that it was still sitting on the counter. Verified on the database: `readyAt`
 * precedes custody and is still set at DELIVERED.
 */
export function showBagIsWaiting(job: { status?: string | null; readyAt?: unknown } | null | undefined): boolean {
  if (!job) return false;
  if (!awaitingPickup(job)) return false;
  return Boolean(job.readyAt) || String(job.status ?? '').toUpperCase() === 'READY_FOR_PICKUP';
}
