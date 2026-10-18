import { describe, it, expect } from 'vitest';
import {
  cancellationVerdict,
  customerCancelView,
  veryLateAfterMin,
  STORE_VERY_LATE_AFTER_MIN,
  STORE_FALLBACK_PROMISE_MIN,
  VERY_LATE_AFTER_MIN,
  type CancellationSnapshot,
} from '../modules/order/cancel-policy';

// ---------------------------------------------------------------------------
// [owner 17 Oct 2026] A STORE order (food or a shop, delivered or collected)
// becomes "very late" — the customer may cancel it free in the app — an HOUR
// past its promised moment, not thirty minutes. Rides, parcels and bookings
// stay at thirty. One predicate (isVeryLate via cancellationVerdict) decides
// for the cancel path and the customer preview alike.
//
// And the edge the owner asked about: an accepted store order promised
// NOTHING (no checkout promise, no prep minutes — a store may declare 0 — and
// no slot) could never become very late, so the customer was stuck waiting on
// the store forever. It is now taken as promised at the store's acceptance +
// 45 minutes (or + its prep minutes, when longer).
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-17T18:00:00.000Z');
const MIN = 60_000;
const ago = (m: number) => new Date(NOW.getTime() - m * MIN);
const ahead = (m: number) => new Date(NOW.getTime() + m * MIN);

const store: CancellationSnapshot = {
  status: 'PREPARING', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
  placedAt: ago(300), acceptedAt: ago(295), holdExpiresAt: null, riderId: null, driverId: null, scheduledFor: null,
};
const verdict = (order: CancellationSnapshot) => cancellationVerdict(order, NOW);
const FREE_LATE = { allowed: true, free: true, reason: 'TOO_LATE' };
const STORE_REFUSED = { allowed: false, free: false, code: 'STORE_ACCEPTED' };

describe('how late is very late — one number per kind, chosen in one place', () => {
  it('a store order: 60 minutes; a ride, a parcel or a booking: 30', () => {
    expect(STORE_VERY_LATE_AFTER_MIN).toBe(60);
    expect(VERY_LATE_AFTER_MIN).toBe(30);
    expect(veryLateAfterMin({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY' })).toBe(60);
    expect(veryLateAfterMin({ orderType: 'GROCERY_DELIVERY', fulfillment: 'PICKUP' })).toBe(60);
    expect(veryLateAfterMin({ orderType: 'TAXI', fulfillment: 'DELIVERY' })).toBe(30);
    expect(veryLateAfterMin({ orderType: 'COURIER', fulfillment: 'DELIVERY' })).toBe(30);
    expect(veryLateAfterMin({ orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT' })).toBe(30);
  });
});

describe('[owner 17 Oct] a store order is very late 60 minutes past its promise', () => {
  it.each([
    ['food, delivered', { orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY' }],
    ['groceries, delivered', { orderType: 'GROCERY_DELIVERY', fulfillment: 'DELIVERY' }],
  ] as const)('%s: refused at 59 minutes past the checkout promise, free at 60', (_kind, over) => {
    expect(verdict({ ...store, ...over, promisedAt: ago(59) })).toMatchObject(STORE_REFUSED);
    expect(verdict({ ...store, ...over, promisedAt: ago(31) })).toMatchObject(STORE_REFUSED); // the old 30 frees nothing
    expect(verdict({ ...store, ...over, promisedAt: ago(60) })).toEqual(FREE_LATE);
  });

  it('a pickup: 60 minutes past "ready in about N minutes" (placing + prep)', () => {
    const pickup = { ...store, fulfillment: 'PICKUP', estimatedPrepTime: 20 };
    expect(verdict({ ...pickup, placedAt: ago(20 + 59) })).toMatchObject(STORE_REFUSED);
    expect(verdict({ ...pickup, placedAt: ago(20 + 60) })).toEqual(FREE_LATE);
  });

  it('a scheduled order: 60 minutes past its slot', () => {
    expect(verdict({ ...store, promisedAt: ago(200), scheduledFor: ago(59) })).toMatchObject(STORE_REFUSED);
    expect(verdict({ ...store, promisedAt: ago(200), scheduledFor: ago(60) })).toEqual(FREE_LATE);
  });

  it('the customer preview says the same, in the same words', () => {
    expect(customerCancelView({ ...store, promisedAt: ago(59) }, NOW)).toMatchObject({ canCancel: false });
    expect(customerCancelView({ ...store, promisedAt: ago(60) }, NOW)).toMatchObject({
      canCancel: true, freeCancellationExpiresAt: null, cancellationMessage: 'Your order is running very late. You can cancel it for free.',
    });
  });
});

describe('rides, parcels and bookings stay at 30 minutes (unchanged)', () => {
  it('a ride: 30 minutes after the driver accepted and still not there', () => {
    const ride = { ...store, orderType: 'TAXI', status: 'DRIVER_EN_ROUTE', driverId: 'd1', placedAt: ago(40) };
    expect(verdict({ ...ride, acceptedAt: ago(29) })).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    expect(verdict({ ...ride, acceptedAt: ago(30) })).toEqual(FREE_LATE);
  });

  it('a parcel: 30 minutes past placing + its quoted job minutes, rider not at the pickup yet', () => {
    const parcel = { ...store, orderType: 'COURIER', status: 'RIDER_ASSIGNED', riderId: 'r1', estimatedDeliveryTime: 25, assignedAt: ago(40) };
    expect(verdict({ ...parcel, placedAt: ago(25 + 29) })).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    expect(verdict({ ...parcel, placedAt: ago(25 + 30) })).toEqual(FREE_LATE);
  });

  it('a booking: 30 minutes past its slot', () => {
    const booking = { ...store, fulfillment: 'APPOINTMENT', status: 'ACCEPTED', acceptedAt: ago(200) };
    expect(verdict({ ...booking, appointmentSlot: ago(29) })).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    expect(verdict({ ...booking, appointmentSlot: ago(30) })).toEqual(FREE_LATE);
  });
});

describe('[owner 17 Oct] an accepted store order promised nothing is never stuck', () => {
  const unpromised = { ...store, promisedAt: null, estimatedPrepTime: null, scheduledFor: null };

  it('the fallback is 45 minutes', () => {
    expect(STORE_FALLBACK_PROMISE_MIN).toBe(45);
  });

  it.each([
    ['a delivery with no checkout promise', { fulfillment: 'DELIVERY' }],
    ['a pickup from a store that declared 0 prep minutes', { fulfillment: 'PICKUP', estimatedPrepTime: 0 }],
    ['a pickup with no prep minutes at all', { fulfillment: 'PICKUP', estimatedPrepTime: null }],
  ] as const)('%s: promised at acceptance + 45; very late 60 minutes after that', (_kind, over) => {
    expect(verdict({ ...unpromised, ...over, acceptedAt: ago(45 + 59) })).toMatchObject(STORE_REFUSED);
    expect(verdict({ ...unpromised, ...over, acceptedAt: ago(45 + 60) })).toEqual(FREE_LATE);
  });

  it('counts from the store accepting it, not from placing', () => {
    expect(verdict({ ...unpromised, placedAt: ago(600), acceptedAt: ago(45 + 59) })).toMatchObject(STORE_REFUSED);
  });

  it('with no acceptance time on record, counts from placing', () => {
    expect(verdict({ ...unpromised, acceptedAt: null, placedAt: ago(45 + 59) })).toMatchObject(STORE_REFUSED);
    expect(verdict({ ...unpromised, acceptedAt: null, placedAt: ago(45 + 60) })).toEqual(FREE_LATE);
  });

  it("a store whose own prep minutes are longer than 45 is given them", () => {
    const slow = { ...unpromised, estimatedPrepTime: 90 }; // a delivery: prep alone never made a promise before
    expect(verdict({ ...slow, acceptedAt: ago(90 + 59) })).toMatchObject(STORE_REFUSED);
    expect(verdict({ ...slow, acceptedAt: ago(90 + 60) })).toEqual(FREE_LATE);
  });

  it('a scheduled order keeps its slot as the promise: never late before it, however long ago it was accepted', () => {
    expect(verdict({ ...unpromised, acceptedAt: ago(600), scheduledFor: ahead(10) })).toMatchObject(STORE_REFUSED);
    expect(verdict({ ...unpromised, acceptedAt: ago(600), scheduledFor: ago(59) })).toMatchObject(STORE_REFUSED);
    expect(verdict({ ...unpromised, acceptedAt: ago(600), scheduledFor: ago(60) })).toEqual(FREE_LATE);
    // The slot IS its promise, so no fallback replaces it: accepted only after
    // the slot had passed, the order is still 60 minutes past its slot.
    expect(verdict({ ...unpromised, acceptedAt: ago(70), scheduledFor: ago(100) })).toEqual(FREE_LATE);
  });

  it('a pickup the store has marked ready is waiting for the customer: never late on the store side', () => {
    expect(verdict({ ...unpromised, fulfillment: 'PICKUP', status: 'READY_FOR_PICKUP', acceptedAt: ago(600) })).toMatchObject(STORE_REFUSED);
  });

  it('still waiting for the store: free at any age, as before (the fallback never applies)', () => {
    expect(verdict({ ...unpromised, status: 'PENDING', acceptedAt: null, placedAt: ago(1) })).toEqual({ allowed: true, free: true, reason: 'AWAITING_STORE' });
  });
});
