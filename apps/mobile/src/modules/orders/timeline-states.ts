/**
 * The customer's order timeline: each step's state, decided from the server's facts. Pure (no React Native),
 * so the rules are testable as they are.
 *
 * [PICKUP · owner 30 Oct 2026, testing a takeaway on staging] "Preparing still shows on the customer side, which it
 * should, but it's not green when the restaurant accepts it, and same with Ready." For a STORE order (delivery or
 * pickup) a step is done — green, with its tick — the moment the server says it is reached; the next step stays
 * upcoming. A step reached and still happening is `live`: it keeps its present-tense words ("is working on your
 * order") and does not light the leg to the next step.
 *
 * Never green before the server says so: Preparing turns green on a preparation fact (PREPARING, its timestamp or
 * log row, or a later kitchen fact), not on ACCEPTED alone (an MMG order waits for "Paid by MMG"); a rider status
 * never ticks Preparing without such a fact; a held order (or one whose release is being checked) is not yet sent.
 * Parcels and bookings keep the timeline they had (the step the order is at stays in progress).
 */

export type OrderStepFacts = {
  /** timelineIndex(): the step the order is at, or null when its status has no step. */
  currentIndex: number | null;
  /** A store order (not a courier parcel, not a booking). */
  storeOrder: boolean;
  holdActive: boolean;
  releasePending: boolean;
  status: string;
  preparationStarted: boolean;
  preparationFinished: boolean;
  acceptedRecorded: boolean;
};

export type OrderStepState = { state: 'done' | 'current' | 'upcoming'; live: boolean };

const LAST_STEP = 4;

export function orderStepState(key: string, index: number, facts: OrderStepFacts): OrderStepState {
  const { currentIndex, status } = facts;
  // No position known: only the first step is claimed (the order exists).
  if (currentIndex == null) return { state: index === 0 ? 'done' : 'upcoming', live: false };
  if (!facts.storeOrder) {
    return { state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming', live: false };
  }
  if (key === 'preparing' && currentIndex >= 2) {
    // The kitchen's own facts. At step 2 a READY_FOR_PICKUP delivery ("Ready for pickup") has been prepared.
    const prepared = facts.preparationStarted || facts.preparationFinished || status === 'PREPARING'
      || (currentIndex === 2 && status === 'READY_FOR_PICKUP');
    if (prepared) {
      // Live while the order is at this step, or while the kitchen still works beside a rider already moving.
      return { state: 'done', live: currentIndex === 2 || !facts.preparationFinished };
    }
    return { state: currentIndex === 2 || facts.acceptedRecorded ? 'current' : 'upcoming', live: false };
  }
  if (index < currentIndex) return { state: 'done', live: false };
  if (index > currentIndex) return { state: 'upcoming', live: false };
  // The step the order is at: reached — except Sent while the hold runs or its release is being checked.
  if (key === 'sent' && (facts.holdActive || facts.releasePending)) return { state: 'current', live: false };
  return { state: 'done', live: index < LAST_STEP };
}

/** The fields of an order the timeline reads (the customer order detail the server sends). */
export type TimelineOrder = {
  status?: unknown;
  fulfillment?: unknown;
  orderType?: unknown;
  acceptedAt?: unknown;
  preparingAt?: unknown;
  readyAt?: unknown;
  timeline?: unknown;
};

/**
 * [#2252 REVIEW-F S4-1] The step the order is at (0 Placed · 1 Sent · 2 Preparing · 3 the travel step · 4 the end),
 * or null when its status has no step. Moved here unchanged from DeliveryScreen so the website's status rail reads
 * the same position as the phone.
 */
export function orderTimelineIndex(order: TimelineOrder, holdActive: boolean, releasePending: boolean): number | null {
  if (holdActive) return 1;
  if (releasePending) return 1;
  const status = String(order.status ?? '').toUpperCase();
  const pickup = order.fulfillment === 'PICKUP';
  const courier = order.orderType === 'COURIER';
  // [E17 · DS231 F3] On its way back: the travel step, relabelled below. A
  // RETURNED parcel has no step — the forward timeline would promise a
  // delivery — so it falls to the plain status line.
  if (courier && status === 'RETURNING') return 3;
  if (['DELIVERED', 'COMPLETED'].includes(status) || (pickup && status === 'PICKED_UP')) return 4;
  if (pickup && status === 'READY_FOR_PICKUP') return 3;
  if (['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS'].includes(status)) return 3;
  if (courier && status === 'RIDER_ASSIGNED') return 2;
  if (courier && ['RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(status)) return 3;
  if (status === 'DRIVER_ASSIGNED') return 2;
  if (['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(status)) return 3;
  if (['ACCEPTED', 'PREPARING'].includes(status) || (!courier && status === 'READY_FOR_PICKUP')) return 2;
  if (['PENDING', 'READY_FOR_PICKUP'].includes(status)) return 1;
  return null;
}

/** The kitchen's facts the Preparing step is judged on: the order's own stamps, its status log (a row with a time),
 *  or the food having left the store. Shared with the website for the same reason as orderTimelineIndex. */
export function orderPrepFacts(order: TimelineOrder): Pick<OrderStepFacts, 'acceptedRecorded' | 'preparationStarted' | 'preparationFinished'> {
  const status = String(order.status ?? '').toUpperCase();
  const entries = (Array.isArray(order.timeline) ? order.timeline : []) as Array<{ status?: string; timestamp?: string | null }>;
  const eventTime = (statuses: string[]) => entries.find((entry) => entry.status && statuses.includes(entry.status))?.timestamp;
  return {
    acceptedRecorded: !!(order.acceptedAt || eventTime(['ACCEPTED'])),
    preparationStarted: !!(order.preparingAt || eventTime(['PREPARING'])),
    preparationFinished: !!(order.readyAt || eventTime(['READY_FOR_PICKUP']))
      || ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED'].includes(status),
  };
}
