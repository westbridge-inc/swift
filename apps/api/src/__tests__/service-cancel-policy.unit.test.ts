import { describe, expect, it } from 'vitest';
import {
  FREE_CANCEL_WINDOW_MIN,
  LATE_CANCEL_FEE,
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
    placedAt: new Date(NOW.getTime() - 10 * MINUTE),
    holdExpiresAt: null,
    riderId: null,
    driverId: null,
    scheduledFor: null,
    appointmentSlot: new Date('2026-09-24T10:00:00.000Z'),
    ...over,
  };
}

describe('an appointment slot is the moment the work happens', () => {
  it('RED reproduction — a PENDING booking ten minutes after placing, slot tomorrow: still free, nobody has started', () => {
    expect(isFreeCancellation(booking(), NOW)).toBe(true);
  });

  it('RED reproduction — the promised window ends FREE_CANCEL_WINDOW_MIN before the slot, not five minutes after placing', () => {
    const expires = freeCancellationExpiresAt(booking(), NOW);
    // The slot's face is 10:00Z, which is 10:00 LOCAL (America/Guyana, UTC-4,
    // the SCH-F convention): it happens at 14:00Z, so the window ends at
    // 13:55Z — not at 09:55Z, four hours early [R2 F01].
    expect(expires?.getTime()).toBe(new Date('2026-09-24T14:00:00.000Z').getTime() - FREE_CANCEL_WINDOW_MIN * MINUTE);
  });

  it('the slot inside the window is no longer free (the provider is about to start)', () => {
    // NOW (14:00Z) is 10:00 local; a slot three minutes away carries 10:03 on
    // its UTC face, i.e. it happens at 14:03Z [R2 F01].
    const soon = booking({ appointmentSlot: new Date('2026-09-23T10:03:00.000Z') });
    expect(isFreeCancellation(soon, NOW)).toBe(false);
    expect(freeCancellationExpiresAt(soon, NOW)).toBeNull();
  });

  it('an accepted booking is committed — the provider reserved the slot — so it is not free', () => {
    expect(isFreeCancellation(booking({ status: 'ACCEPTED' }), NOW)).toBe(false);
    expect(freeCancellationExpiresAt(booking({ status: 'ACCEPTED' }), NOW)).toBeNull();
  });

  it('the checkout hold still wins while it runs, and the window it promises is the hold', () => {
    const held = booking({ placedAt: new Date(NOW.getTime() - MINUTE), holdExpiresAt: new Date(NOW.getTime() + 2 * MINUTE) });
    expect(isFreeCancellation(held, NOW)).toBe(true);
    expect(freeCancellationExpiresAt(held, NOW)?.getTime()).toBe(held.holdExpiresAt!.getTime());
  });

  it('a booking whose slot takes precedence over a scheduledFor that would already have closed', () => {
    const both = booking({ scheduledFor: new Date(NOW.getTime() + 3 * MINUTE) });
    expect(isFreeCancellation(both, NOW)).toBe(true);
  });
});

describe('everything else keeps its clock (controls)', () => {
  it('a marketplace food order ten minutes after placing is not free, and the marker is unchanged', () => {
    expect(isFreeCancellation(booking({ appointmentSlot: null }), NOW)).toBe(false);
    expect(LATE_CANCEL_FEE).toBe(500);
  });

  it('inside the first five minutes a food order is still free', () => {
    expect(isFreeCancellation(booking({ appointmentSlot: null, placedAt: new Date(NOW.getTime() - 2 * MINUTE) }), NOW)).toBe(true);
  });

  it('a scheduled delivery keeps the existing scheduled rule', () => {
    const scheduled = booking({ appointmentSlot: null, scheduledFor: new Date('2026-09-24T18:00:00.000Z') });
    expect(isFreeCancellation(scheduled, NOW)).toBe(true);
    expect(freeCancellationExpiresAt(scheduled, NOW)?.getTime()).toBe(new Date('2026-09-24T18:00:00.000Z').getTime() - FREE_CANCEL_WINDOW_MIN * MINUTE);
  });

  it('a mover assignment ends every free window, slot or not', () => {
    expect(isFreeCancellation(booking({ riderId: 'rider-1' }), NOW)).toBe(false);
    expect(isFreeCancellation(booking({ holdExpiresAt: new Date(NOW.getTime() + 2 * MINUTE), driverId: 'driver-1' }), NOW)).toBe(false);
  });

  it('a courier parcel born READY_FOR_PICKUP keeps its carve-out', () => {
    expect(isFreeCancellation(booking({ orderType: 'COURIER', status: 'READY_FOR_PICKUP', appointmentSlot: null, placedAt: new Date(NOW.getTime() - 2 * MINUTE) }), NOW)).toBe(true);
  });
});
