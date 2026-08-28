import { describe, it, expect } from 'vitest';
import { riderStep, awaitingPickup, showBagIsWaiting } from '../lib/riderLeg';

/**
 * THE COUNTER SIGNAL MUST STOP BEING TRUE WHEN IT STOPS BEING TRUE.
 *
 * The rider cockpit showed a green tick reading "Order is packed and ready for
 * pickup" whenever `readyAt` was set. `readyAt` is the minute the kitchen
 * finished and nothing ever clears it — verified on the database, where it
 * precedes custody and is still set on DELIVERED orders. So the tick survived
 * PICKED_UP, EN_ROUTE_DELIVERY and ARRIVED: a rider with the bag in their hands,
 * parked outside the customer's house, was being told it was on the counter.
 *
 * It is the same mistake as a stale status label, one layer down — a HISTORICAL
 * FACT rendered as a CURRENT state. Every other reader of `readyAt` in the app
 * is correct precisely because it reads it as history: the customer's timeline
 * marks preparation finished permanently, the vendor stops being offered "Mark
 * ready", the prep-duration line needs the stamp. A completed step stays
 * completed. Only the cockpit was claiming something about right now.
 */

const withStatus = (status: string, readyAt: unknown = '2026-08-28T10:00:00Z') => ({ status, readyAt });

/** The rider's lane, in order, with custody taken at PICKED_UP. */
const PICKUP_LEG = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'READY_FOR_PICKUP'];
const AFTER_CUSTODY = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED'];

describe('the bag-is-waiting signal', () => {
  it.each(PICKUP_LEG)('shows on %s — the goods really are still with the vendor', (status) => {
    expect(showBagIsWaiting(withStatus(status))).toBe(true);
  });

  it.each(AFTER_CUSTODY)('is gone on %s — the rider is carrying it', (status) => {
    // The exact defect: every one of these returned true before the fix,
    // because readyAt is set and never cleared.
    expect(
      showBagIsWaiting(withStatus(status)),
      `"packed and ready for pickup" on ${status} tells the rider to collect what they already have`,
    ).toBe(false);
  });

  it('needs the kitchen to have actually said so', () => {
    // On the pickup leg but nothing ready yet: no signal. The tick means the
    // bag is packed, not that the rider is heading for it.
    expect(showBagIsWaiting({ status: 'RIDER_ASSIGNED', readyAt: null })).toBe(false);
    expect(showBagIsWaiting({ status: 'RIDER_EN_ROUTE_PICKUP', readyAt: undefined })).toBe(false);
  });

  it('trusts the status when the timestamp is missing', () => {
    // READY_FOR_PICKUP says it outright, so a payload without the stamp still
    // gets the signal — that is why the status arm exists.
    expect(showBagIsWaiting({ status: 'READY_FOR_PICKUP', readyAt: null })).toBe(true);
  });

  it('says nothing about a job it has not been given', () => {
    expect(showBagIsWaiting(null)).toBe(false);
    expect(showBagIsWaiting(undefined)).toBe(false);
    expect(showBagIsWaiting({})).toBe(false);
    expect(showBagIsWaiting({ status: 'NOT_A_STATUS', readyAt: 'x' })).toBe(false);
  });
});

describe('custody is read off the action sequence, not a status list', () => {
  it.each(PICKUP_LEG)('%s is before custody', (status) => {
    expect(awaitingPickup({ status })).toBe(true);
  });

  it.each(AFTER_CUSTODY)('%s is after custody', (status) => {
    expect(awaitingPickup({ status })).toBe(false);
  });

  it('every pre-custody status offers an action, and the last of them is the pickup', () => {
    // Guards the link between the two: `awaitingPickup` is only meaningful
    // because `riderStep` returns an action for each of these.
    for (const status of PICKUP_LEG) {
      expect(riderStep({ status }), `${status} must have a next action`).not.toBeNull();
    }
    expect(riderStep({ status: 'RIDER_ARRIVED_PICKUP' })?.action).toBe('picked-up');
    expect(riderStep({ status: 'PICKED_UP' })?.action).toBe('en-route-delivery');
  });

  it('ARRIVED hands over to the delivery controls rather than offering a step', () => {
    expect(riderStep({ status: 'ARRIVED' })).toBeNull();
  });
});
