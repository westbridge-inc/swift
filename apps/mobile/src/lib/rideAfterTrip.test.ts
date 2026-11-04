import { describe, expect, it } from 'vitest';
import { rideCanBeRated, rideIsOver, rideOverTitle, ridePaidAmount } from './rideAfterTrip';

describe('[G06] a finished ride, read back', () => {
  it('the amount is what was paid, waiting included', () => {
    expect(ridePaidAmount({ taxiFareTotal: 800, totalAmount: 1100 })).toBe(1100);
    expect(ridePaidAmount({ taxiFareTotal: '800' })).toBe(800);
    expect(ridePaidAmount({})).toBeNull();
    expect(ridePaidAmount({ totalAmount: 'x' })).toBeNull();
  });
  it('says how it ended', () => {
    expect(rideOverTitle('DELIVERED')).toBe('Trip complete');
    expect(rideOverTitle('CANCELLED')).toBe('Ride cancelled');
    expect(rideOverTitle('FAILED')).toBe('Ride closed');
  });
  it('only a finished ride with a driver, not yet rated, asks for a rating', () => {
    expect(rideCanBeRated({ status: 'DELIVERED', driver: {}, hasBeenRated: false })).toBe(true);
    expect(rideCanBeRated({ status: 'DELIVERED', driver: {}, hasBeenRated: true })).toBe(false);
    expect(rideCanBeRated({ status: 'CANCELLED', driver: {} })).toBe(false);
    expect(rideCanBeRated({ status: 'DELIVERED', driver: null })).toBe(false);
  });
  it('knows a ride that is over', () => {
    expect(rideIsOver('delivered')).toBe(true);
    expect(rideIsOver('FAILED')).toBe(true);
    expect(rideIsOver('RIDE_IN_PROGRESS')).toBe(false);
    expect(rideIsOver(undefined)).toBe(false);
  });
});
