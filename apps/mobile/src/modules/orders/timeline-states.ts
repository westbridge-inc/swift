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
