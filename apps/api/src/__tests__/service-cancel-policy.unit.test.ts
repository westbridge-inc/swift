import { describe, expect, it } from 'vitest';
import * as policy from '../modules/order/cancel-policy';
import {
  FREE_CANCEL_WINDOW_MIN,
  freeCancellationExpiresAt,
  isFreeCancellation,
  type CancellationSnapshot,
} from '../modules/order/cancel-policy';

// ---------------------------------------------------------------------------
// A BOOKING IS CANCELLED BY ITS SLOT, NOT BY A KITCHEN CLOCK.
//
// cancel-policy.ts already says why "five minutes since placing" is a PROXY for
// "nobody has started yet", and already stops applying that proxy to a
// scheduled order whose slot is still more than the window away. An
// appointment is the same fact with a different column: its slot is
// `appointmentSlot`, chosen at checkout and reserved by the provider at
// acceptance. The predicate read only `scheduledFor`, so a haircut booked this
// morning for Thursday became a GYD 500 late-cancellation five minutes after
// the customer tapped Book — before any provider had seen it.
//
// These cases reuse FREE_CANCEL_WINDOW_MIN. No number is invented; the cancel
// curve for long-horizon bookings remains the recorded founder decision.
//
// [owner #50, 14 Oct] That decision is now made: a booking nobody has accepted
// is free at any time (no clock — nobody to contact); once the provider
// accepts it, it is free only inside the five-minute window, then refused
// (contact the provider). Never a fee.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const NOW = new Date('2026-09-23T14:00:00.000Z');

type Snapshot = CancellationSnapshot & { appointmentSlot?: Date | null };

/** A PENDING booking placed ten minutes ago for tomorrow at 10:00, on the
 *  legacy FOOD_DELIVERY spine exactly as the database holds it. */
function booking(over: Partial<Snapshot> = {}): Snapshot {
  return {
    status: 'PENDING',
    orderType: 'FOOD_DELIVERY',
    fulfillment: 'APPOINTMENT',
    placedAt: new Date(NOW.getTime() - 10 * MINUTE),
    holdExpiresAt: null,
    riderId: null,
    driverId: null,
    scheduledFor: null,
    appointmentSlot: new Date('2026-09-24T14:00:00.000Z'),
    ...over,
  };
}

describe('an appointment slot is the moment the work happens', () => {
  it('RED reproduction — a PENDING booking ten minutes after placing, slot tomorrow: still free, nobody has started', () => {
    expect(isFreeCancellation(booking(), NOW)).toBe(true);
  });

  // [owner #50, 14 Oct] Free until the provider accepts: no countdown at all —
  // never one that ends five minutes after placing while the server says free.
  it('RED reproduction — no countdown that ends five minutes after placing: free until the provider accepts', () => {
    expect(freeCancellationExpiresAt(booking(), NOW)).toBeNull();
  });

  // [owner #50, 14 Oct] The slot no longer closes an UNACCEPTED booking (the
  // provider has not committed — there is no one to contact); an accepted one
  // past the five-minute window is refused.
  it('a slot about to start: free while the provider has not accepted, refused once it has', () => {
    // NOW (14:00Z) is 10:00 local; a slot three minutes away is 14:03Z.
    const soon = booking({ appointmentSlot: new Date('2026-09-23T14:03:00.000Z') });
    expect(isFreeCancellation(soon, NOW)).toBe(true);
    expect(freeCancellationExpiresAt(soon, NOW)).toBeNull();
    expect(isFreeCancellation({ ...soon, status: 'ACCEPTED' }, NOW)).toBe(false);
  });

  it('an accepted booking is committed — the provider reserved the slot — so it is not free', () => {
    expect(isFreeCancellation(booking({ status: 'ACCEPTED' }), NOW)).toBe(false);
    expect(freeCancellationExpiresAt(booking({ status: 'ACCEPTED' }), NOW)).toBeNull();
  });

  // [owner #50, 14 Oct] The window is the LATER of the hold and five minutes
  // after placing (production holds are never shorter than the window).
  it('the checkout hold still wins while it runs, and the window it promises is the hold', () => {
    const held = booking({ placedAt: new Date(NOW.getTime() - MINUTE), holdExpiresAt: new Date(NOW.getTime() + 7 * MINUTE) });
    expect(isFreeCancellation(held, NOW)).toBe(true);
    expect(freeCancellationExpiresAt(held, NOW)?.getTime()).toBe(held.holdExpiresAt!.getTime());
    const shortHold = booking({ placedAt: new Date(NOW.getTime() - MINUTE), holdExpiresAt: new Date(NOW.getTime() + 2 * MINUTE) });
    expect(freeCancellationExpiresAt(shortHold, NOW)?.getTime()).toBe(shortHold.placedAt.getTime() + FREE_CANCEL_WINDOW_MIN * MINUTE);
  });

  it('a booking whose slot takes precedence over a scheduledFor that would already have closed', () => {
    const both = booking({ scheduledFor: new Date(NOW.getTime() + 3 * MINUTE) });
    expect(isFreeCancellation(both, NOW)).toBe(true);
  });
});

describe('everything else keeps its own rule (controls)', () => {
  // [owner #46, 13 Oct] A marketplace STORE order no longer runs the clock: it
  // is free while it waits for the store (no countdown), and refused once the
  // store accepts (store-order-cancel-after-accept.test.ts). [owner #50,
  // 14 Oct] No kind keeps the marker: the fee constant is gone.
  const food = { appointmentSlot: null, fulfillment: 'DELIVERY' } as const;

  it('a marketplace food order ten minutes after placing, still waiting for the store, is free; there is no fee at all', () => {
    expect(isFreeCancellation(booking(food), NOW)).toBe(true);
    expect(freeCancellationExpiresAt(booking(food), NOW)).toBeNull();
    expect('LATE_CANCEL_FEE' in policy).toBe(false);
  });

  it('inside the first five minutes a food order is still free', () => {
    expect(isFreeCancellation(booking({ ...food, placedAt: new Date(NOW.getTime() - 2 * MINUTE) }), NOW)).toBe(true);
  });

  it('a scheduled delivery waiting for the store is free with no countdown (owner #46)', () => {
    const scheduled = booking({ ...food, scheduledFor: new Date('2026-09-24T18:00:00.000Z') });
    expect(isFreeCancellation(scheduled, NOW)).toBe(true);
    expect(freeCancellationExpiresAt(scheduled, NOW)).toBeNull();
  });

  it('a mover assignment ends every free window, slot or not', () => {
    expect(isFreeCancellation(booking({ riderId: 'rider-1' }), NOW)).toBe(false);
    expect(isFreeCancellation(booking({ holdExpiresAt: new Date(NOW.getTime() + 2 * MINUTE), driverId: 'driver-1' }), NOW)).toBe(false);
  });

  it('a courier parcel born READY_FOR_PICKUP keeps its carve-out', () => {
    expect(isFreeCancellation(booking({ orderType: 'COURIER', fulfillment: 'DELIVERY', status: 'READY_FOR_PICKUP', appointmentSlot: null, placedAt: new Date(NOW.getTime() - 2 * MINUTE) }), NOW)).toBe(true);
  });
});
