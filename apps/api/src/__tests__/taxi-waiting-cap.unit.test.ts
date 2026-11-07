import { describe, it, expect } from 'vitest';
import {
  TAXI_WAITING_CAP_MINUTES,
  liveWaitingPayload,
  tallyTaxiWaiting,
  waitingChargeCap,
  waitingTermsText,
  type TaxiWaitClock,
  type TaxiWaitingTerms,
} from '../modules/rides/taxi-waiting';

// ---------------------------------------------------------------------------
// [Owner 4 Nov 2026] The waiting charge, on the pure clock: capped at GY$1,800
// for a ride (one hour counted), started only when GPS puts the car at the
// pickup, stopped at the ride code.
// ---------------------------------------------------------------------------

const GYD: TaxiWaitingTerms = { chargePerBlock: 300, blockMinutes: 10, currencyCode: 'GYD' };
const T0 = new Date('2026-11-04T10:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const MIN = 60;

const clock = (extra: Partial<TaxiWaitClock>): TaxiWaitClock => ({
  status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickupArrivalVerified: true, ridePinVerifiedAt: null, pickedUpAt: null, stops: [], ...extra,
});
const closed = (seconds: number) => clock({ pickedUpAt: at(seconds) });
const atPickup = (extra: Partial<TaxiWaitClock> = {}) => clock({ status: 'DRIVER_ARRIVED', ...extra });
const verifiedStop = (sequence: number, from: number, to: number) => ({
  sequence, status: 'DEPARTED' as const, arrivedAt: at(from), arrivalVerified: true, departedAt: at(to), skippedAt: null,
});

describe('the cap: GY$1,800 for a ride, one hour counted', () => {
  it.each([
    ['59:59', 60 * MIN - 1, 1500, 59],
    ['exactly one hour', 60 * MIN, 1800, 60],
    ['one second over', 60 * MIN + 1, 1800, 60],
    ['three hours', 180 * MIN, 1800, 60],
  ])('a pickup wait of %s', (_label, seconds, charge, minutes) => {
    const tally = tallyTaxiWaiting(closed(seconds), GYD, at(4 * 3600), 'final');
    expect({ charge: tally.waitingCharge, minutes: tally.waitingMinutes }).toEqual({ charge, minutes });
    expect(tally.totalSeconds).toBe(Math.min(seconds, 3600));
  });

  it('is for the whole ride, not for each wait: 40 minutes at the pickup and 40 at a stop', () => {
    const tally = tallyTaxiWaiting(
      clock({ pickedUpAt: at(40 * MIN), stops: [verifiedStop(1, 50 * MIN, 90 * MIN)] }), GYD, at(4 * 3600), 'final',
    );
    expect(tally.waitingCharge).toBe(1800);
    expect(tally.totalSeconds).toBe(3600);
  });

  it('live: the last block still lands, and past it nothing more is promised', () => {
    const before = tallyTaxiWaiting(atPickup(), GYD, at(59 * MIN), 'live');
    expect(before.waitingCharge).toBe(1500);
    expect(before.nextChargeAt).toEqual(at(60 * MIN));
    for (const seconds of [60 * MIN, 61 * MIN, 200 * MIN]) {
      const after = tallyTaxiWaiting(atPickup(), GYD, at(seconds), 'live');
      expect(after.waitingCharge, String(seconds)).toBe(1800);
      expect(after.nextChargeAt, String(seconds)).toBeNull();
      expect(after.running, 'the car is still there').toBe(1);
    }
  });

  it('a block that does not divide the hour: only whole blocks inside the hour are charged', () => {
    const terms = { chargePerBlock: 250, blockMinutes: 7, currencyCode: 'GYD' };
    expect(waitingChargeCap(terms)).toBe(2000);
    const tally = tallyTaxiWaiting(atPickup(), terms, at(57 * MIN), 'live');
    expect(tally.waitingCharge).toBe(2000);
    expect(tally.nextChargeAt, 'a ninth block would pass the hour').toBeNull();
  });

  it('the minutes on the screens never pass the hour', () => {
    const tally = tallyTaxiWaiting(atPickup(), GYD, at(75 * MIN), 'live');
    const live = liveWaitingPayload(GYD, tally);
    expect(live).toMatchObject({ pickupWaitMinutes: 60, waitingMinutes: 60, waitingCharge: 1800, running: true, nextChargeAt: null });
  });

  it('the owner\'s figures: one hour, GY$1,800 on the default terms', () => {
    expect(TAXI_WAITING_CAP_MINUTES).toBe(60);
    expect(waitingChargeCap(GYD)).toBe(1800);
  });
});

describe('the pickup wait starts only when GPS puts the car at the pickup', () => {
  it.each([[null], [false]])('an arrival with GPS %s counts nothing, live or final, however long', (verified) => {
    const closedRide = tallyTaxiWaiting(clock({ pickupArrivalVerified: verified, pickedUpAt: at(45 * MIN) }), GYD, at(50 * MIN), 'final');
    expect(closedRide).toMatchObject({ pickup: null, totalSeconds: 0, waitingCharge: 0, running: 0, nextChargeAt: null });
    const live = tallyTaxiWaiting(atPickup({ pickupArrivalVerified: verified }), GYD, at(45 * MIN), 'live');
    expect(live).toMatchObject({ pickup: null, totalSeconds: 0, waitingCharge: 0, running: 0, nextChargeAt: null });
  });

  it('a stop the GPS placed still counts on a ride whose pickup it did not', () => {
    const tally = tallyTaxiWaiting(
      clock({ pickupArrivalVerified: false, pickedUpAt: at(30 * MIN), stops: [verifiedStop(1, 40 * MIN, 52 * MIN)] }), GYD, at(60 * MIN), 'final',
    );
    expect(tally.waitingCharge).toBe(300);
    expect(tally.totalSeconds).toBe(12 * MIN);
  });
});

describe('the pickup wait stops at the ride code', () => {
  it('the time between the code and the trip start is not counted', () => {
    const tally = tallyTaxiWaiting(clock({ ridePinVerifiedAt: at(12 * MIN), pickedUpAt: at(30 * MIN) }), GYD, at(40 * MIN), 'final');
    expect(tally.pickup).toEqual({ ms: 12 * MIN * 1000, running: false });
    expect(tally.waitingCharge).toBe(300);
  });

  it('live: with the code verified the wait stands still, the car not yet moving', () => {
    const verified = atPickup({ ridePinVerifiedAt: at(12 * MIN) });
    for (const seconds of [12 * MIN, 20 * MIN, 45 * MIN]) {
      const tally = tallyTaxiWaiting(verified, GYD, at(seconds), 'live');
      expect(tally, String(seconds)).toMatchObject({ pickup: { ms: 12 * MIN * 1000, running: false }, waitingCharge: 300, running: 0, nextChargeAt: null });
    }
  });

  it('a ride with no code on its row ends the wait at the trip start', () => {
    const tally = tallyTaxiWaiting(clock({ pickedUpAt: at(21 * MIN) }), GYD, at(40 * MIN), 'final');
    expect(tally.pickup?.ms).toBe(21 * MIN * 1000);
    expect(tally.waitingCharge).toBe(600);
  });

  it('live and final agree once the trip has started', () => {
    const ride = clock({ ridePinVerifiedAt: at(33 * MIN), pickedUpAt: at(35 * MIN) });
    expect(tallyTaxiWaiting(ride, GYD, at(50 * MIN), 'live').waitingCharge)
      .toBe(tallyTaxiWaiting(ride, GYD, at(50 * MIN), 'final').waitingCharge);
  });
});

describe('the line shown before booking names the cap', () => {
  it('on the default terms', () => {
    expect(waitingTermsText(GYD)).toBe('Waiting: 300 per 10 minutes after your driver arrives, up to 1,800 a ride');
  });

  it('built from the terms, so the words and the charge are one number', () => {
    expect(waitingTermsText({ chargePerBlock: 1000, blockMinutes: 1, currencyCode: 'GYD' }))
      .toBe('Waiting: 1,000 per minute after your driver arrives, up to 60,000 a ride');
  });
});
