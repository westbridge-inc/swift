import { describe, expect, it, vi } from 'vitest';

// [REVIEW-G #2022 S4-1] The release time follows the CONFIGURED wait limit,
// not a remembered 30: this file runs with a non-default limit, set before
// dispatch.service reads it at import.
vi.hoisted(() => { process.env['TAXI_WAIT_LIMIT_MIN'] = '45'; });

import { rideSearchFacts, type WaitingRide } from '../modules/rides/search-facts';
import { TAXI_WAIT_LIMIT_MIN } from '../modules/dispatch/dispatch.service';

const PLACED = new Date('2026-10-22T16:12:00.000Z');
const ride = (over: Partial<WaitingRide> = {}): WaitingRide => ({
  id: 'r1', status: 'PENDING', driverId: null, placedAt: PLACED, paymentMethod: 'CASH', paymentStatus: 'PENDING', ...over,
});

describe('rideSearchFacts', () => {
  it('releases at placement + the configured limit (45 here, not 30)', () => {
    expect(TAXI_WAIT_LIMIT_MIN).toBe(45);
    expect(rideSearchFacts(ride(), false)).toEqual({ noDriverFound: false, searchReleaseAt: '2026-10-22T16:57:00.000Z' });
  });

  it('a ride recorded as paid by MMG is held for a person: no release time is promised', () => {
    for (const paymentStatus of ['CAPTURED', 'CLAIMED']) {
      expect(rideSearchFacts(ride({ paymentMethod: 'MOBILE_MONEY', paymentStatus }), true)).toEqual({ noDriverFound: true });
    }
    // An MMG ride not yet paid is released like any other.
    expect(rideSearchFacts(ride({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' }), true).searchReleaseAt).toBe('2026-10-22T16:57:00.000Z');
  });

  it('says nothing once a driver has the ride, or it is no longer waiting', () => {
    expect(rideSearchFacts(ride({ driverId: 'd1' }), true)).toEqual({});
    expect(rideSearchFacts(ride({ status: 'DRIVER_ASSIGNED' }), true)).toEqual({});
  });
});
