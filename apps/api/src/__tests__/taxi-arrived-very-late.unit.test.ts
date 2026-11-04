// [BUG-HUNT-2 G04] The one cancel predicate at the pickup.
import { describe, expect, it } from 'vitest';
import { cancellationVerdict, customerCancelView, TAXI_ARRIVED_VERY_LATE_MIN, type CancellationSnapshot } from '../modules/order/cancel-policy';

const MIN = 60_000;
const NOW = new Date('2026-11-04T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN);
function ride(over: Partial<CancellationSnapshot> = {}): CancellationSnapshot {
  return { status: 'DRIVER_ARRIVED', orderType: 'TAXI', fulfillment: 'DELIVERY', placedAt: ago(30), holdExpiresAt: null, riderId: null, driverId: 'd1', scheduledFor: null, acceptedAt: ago(25), assignedAt: ago(25), driverArrivedAt: ago(TAXI_ARRIVED_VERY_LATE_MIN), ...over };
}

describe('[G04] a ride at the pickup', () => {
  it('is 15 minutes, the number in the ruling', () => expect(TAXI_ARRIVED_VERY_LATE_MIN).toBe(15));
  it('free from exactly 15 minutes after the arrival, refused a second before', () => {
    expect(cancellationVerdict(ride(), NOW)).toEqual({ allowed: true, free: true, reason: 'TOO_LATE' });
    expect(cancellationVerdict(ride({ driverArrivedAt: new Date(ago(15).getTime() + 1_000) }), NOW)).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
  });
  it('a caller that did not read the arrival gets the old refusal', () => {
    expect(cancellationVerdict(ride({ driverArrivedAt: undefined }), NOW)).toMatchObject({ allowed: false });
    expect(cancellationVerdict(ride({ driverArrivedAt: null }), NOW)).toMatchObject({ allowed: false });
  });
  it('the 30 minutes on the way to the pickup stand', () => {
    expect(cancellationVerdict(ride({ status: 'DRIVER_EN_ROUTE', driverArrivedAt: null, acceptedAt: ago(29), assignedAt: ago(29) }), NOW)).toMatchObject({ allowed: false });
    expect(cancellationVerdict(ride({ status: 'DRIVER_EN_ROUTE', driverArrivedAt: null, acceptedAt: ago(30), assignedAt: ago(30) }), NOW)).toMatchObject({ allowed: true, reason: 'TOO_LATE' });
  });
  it('the words say what is true, and never that the driver is on the way', () => {
    expect(customerCancelView(ride(), NOW).cancellationMessage).toBe('This ride is very late starting: your driver arrived over 15 minutes ago and you are not aboard. You can cancel it for free.');
    expect(customerCancelView(ride({ status: 'DRIVER_EN_ROUTE', driverArrivedAt: null, acceptedAt: ago(40), assignedAt: ago(40) }), NOW).cancellationMessage).toBe('Your driver is running very late. You can cancel the ride for free.');
  });
});
