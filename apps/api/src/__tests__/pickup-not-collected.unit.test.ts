// [BUG-HUNT-2 G20] The one cancel predicate: a ready pickup nobody collected, from 24 hours, cash only.
import { describe, expect, it } from 'vitest';
import { cancellationVerdict, customerCancelView, isPickupNotCollected, PICKUP_NOT_COLLECTED_AFTER_HOURS, type CancellationSnapshot } from '../modules/order/cancel-policy';

const HOUR = 3_600_000;
const NOW = new Date('2026-11-04T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

function snapshot(over: Partial<CancellationSnapshot> = {}): CancellationSnapshot {
  return {
    status: 'READY_FOR_PICKUP', orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', placedAt: ago(30), holdExpiresAt: null, riderId: null, driverId: null,
    scheduledFor: null, promisedAt: null, estimatedPrepTime: 20, acceptedAt: ago(29), readyAt: ago(PICKUP_NOT_COLLECTED_AFTER_HOURS), paymentMethod: 'CASH', paymentStatus: 'PENDING', ...over,
  };
}

describe('[G20] isPickupNotCollected', () => {
  it('is 24 hours, the number in the ruling', () => expect(PICKUP_NOT_COLLECTED_AFTER_HOURS).toBe(24));
  it('counts from the moment the store marked it ready, to the millisecond', () => {
    expect(isPickupNotCollected(snapshot(), NOW)).toBe(true);
    expect(isPickupNotCollected(snapshot({ readyAt: new Date(ago(24).getTime() + 1) }), NOW)).toBe(false);
  });
  it('counts from the slot when the slot is later', () => {
    expect(isPickupNotCollected(snapshot({ scheduledFor: ago(1) }), NOW)).toBe(false);
    expect(isPickupNotCollected(snapshot({ scheduledFor: ago(24) }), NOW)).toBe(true);
  });
  it('asks only of a store pickup that is ready', () => {
    expect(isPickupNotCollected(snapshot({ fulfillment: 'DELIVERY' }), NOW)).toBe(false);
    expect(isPickupNotCollected(snapshot({ status: 'PREPARING' }), NOW)).toBe(false);
    expect(isPickupNotCollected(snapshot({ orderType: 'COURIER' }), NOW)).toBe(false);
    expect(isPickupNotCollected(snapshot({ fulfillment: 'APPOINTMENT' }), NOW)).toBe(false);
  });
  it('a caller that did not read the ready moment gets no', () => {
    expect(isPickupNotCollected(snapshot({ readyAt: undefined }), NOW)).toBe(false);
    expect(isPickupNotCollected(snapshot({ readyAt: null }), NOW)).toBe(false);
  });
});

describe('[G20] the verdict', () => {
  it('free for a cash pickup from 24 hours, refused before', () => {
    expect(cancellationVerdict(snapshot(), NOW)).toEqual({ allowed: true, free: true, reason: 'NOT_COLLECTED' });
    expect(cancellationVerdict(snapshot({ readyAt: ago(23) }), NOW)).toMatchObject({ allowed: false, code: 'STORE_ACCEPTED' });
  });
  it('never for anything but cash', () => {
    expect(cancellationVerdict(snapshot({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' }), NOW)).toMatchObject({ allowed: false });
    expect(cancellationVerdict(snapshot({ paymentMethod: 'CARD', paymentStatus: 'CAPTURED' }), NOW)).toMatchObject({ allowed: false });
  });
  it('the screen says why, with no countdown', () => {
    expect(customerCancelView(snapshot(), NOW)).toEqual({
      canCancel: true, freeCancellationExpiresAt: null, cancelUnavailable: null,
      cancellationMessage: 'Your pickup has been waiting over a day, so it is very late. You can cancel it for free.',
    });
  });
});
