import { describe, expect, it } from 'vitest';
import {
  TAXI_STOPS_CAPABILITY,
  TAXI_STOP_NO_SHOW_GRACE_MINUTES,
  assertTripMayEndUnpaid,
  declaresTaxiStops,
  stopWaitOf,
} from '../modules/rides/taxi-stop-rules';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 4/8] The pure rules of a ride's stops (CONTRACT §6.3,
// §6.4): the capability a driver app declares, the 10-minute grace at an
// arrived stop on the server clock, and when a trip with a stop still open may
// end without its fare. The route suite (taxi-multistop-driver) drives the
// same rules through the real endpoints; this pins the edges exactly.
// ---------------------------------------------------------------------------

const T0 = new Date('2026-10-18T20:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

type Row = { sequence: number; status: 'PENDING' | 'ARRIVED' | 'DEPARTED' | 'SKIPPED'; arrivedAt: Date | null };
const pending = (sequence: number): Row => ({ sequence, status: 'PENDING', arrivedAt: null });
const arrived = (sequence: number, when = T0): Row => ({ sequence, status: 'ARRIVED', arrivedAt: when });
const departed = (sequence: number): Row => ({ sequence, status: 'DEPARTED', arrivedAt: at(-30 * MIN) });
const skipped = (sequence: number, wasArrived = false): Row => ({ sequence, status: 'SKIPPED', arrivedAt: wasArrived ? at(-20 * MIN) : null });

const refusal = (fn: () => void) => {
  try { fn(); } catch (error) { return error as { statusCode: number; code: string; details?: unknown }; }
  return null;
};

describe('the capability a driver app declares at go-online', () => {
  it('only the exact TAXI_STOPS_V1 entry counts; absent, empty, malformed or other entries are nothing declared', () => {
    expect(TAXI_STOPS_CAPABILITY).toBe('TAXI_STOPS_V1');
    expect(declaresTaxiStops(['TAXI_STOPS_V1'])).toBe(true);
    expect(declaresTaxiStops(['SOMETHING_ELSE', 'TAXI_STOPS_V1'])).toBe(true);
    for (const nothing of [undefined, null, [], ['taxi_stops_v1'], ['TAXI_STOPS_V2'], ['TAXI_STOPS']]) {
      expect(declaresTaxiStops(nothing as never), JSON.stringify(nothing)).toBe(false);
    }
  });
});

describe('the grace at an arrived stop (stopWait)', () => {
  it('is 10 minutes, counted from the stop\'s arrival on the server clock', () => {
    expect(TAXI_STOP_NO_SHOW_GRACE_MINUTES).toBe(10);
    expect(stopWaitOf([departed(1), arrived(2), pending(3)])).toEqual({ sequence: 2, arrivedAt: T0, noShowAvailableAt: at(10 * MIN) });
  });

  it('is null while the ride is heading for a stop, and once every stop is done (the destination is next)', () => {
    expect(stopWaitOf([pending(1), pending(2)])).toBeNull();
    expect(stopWaitOf([departed(1), pending(2)])).toBeNull();
    expect(stopWaitOf([departed(1), skipped(2, true)])).toBeNull();
    expect(stopWaitOf([])).toBeNull();
  });

  it('reads the stops in the passenger\'s order, whatever order the rows come in', () => {
    expect(stopWaitOf([pending(3), arrived(2), departed(1)])?.sequence).toBe(2);
  });
});

describe('ending the trip unpaid while a stop is open', () => {
  it('a ride whose stops are all done ends as today, for either outcome', () => {
    for (const rows of [[departed(1), skipped(2)], [skipped(1, true)], []]) {
      expect(refusal(() => assertTripMayEndUnpaid(rows, 'no_show', T0))).toBeNull();
      expect(refusal(() => assertTripMayEndUnpaid(rows, 'refused', T0))).toBeNull();
    }
  });

  it('a no-show at an arrived stop: refused until the grace is over (STOP_WAIT_NOT_ELAPSED with retryAt), allowed from that instant on', () => {
    const rows = [departed(1), arrived(2), pending(3)];
    const early = refusal(() => assertTripMayEndUnpaid(rows, 'no_show', at(10 * MIN - 1)));
    expect(early).toMatchObject({ statusCode: 409, code: 'STOP_WAIT_NOT_ELAPSED', details: { sequence: 2, retryAt: at(10 * MIN).toISOString() } });
    expect(refusal(() => assertTripMayEndUnpaid(rows, 'no_show', at(10 * MIN)))).toBeNull();
    expect(refusal(() => assertTripMayEndUnpaid(rows, 'no_show', at(45 * MIN)))).toBeNull();
  });

  it('a no-show while the car is still heading for a stop: finish that stop first (STOPS_REMAINING naming it)', () => {
    const e = refusal(() => assertTripMayEndUnpaid([departed(1), pending(2)], 'no_show', at(60 * MIN)));
    expect(e).toMatchObject({ statusCode: 409, code: 'STOPS_REMAINING', details: { nextStopSequence: 2 } });
  });

  it('a refusal to pay with a stop open, even after the grace: said at the destination (STOPS_REMAINING)', () => {
    for (const rows of [[pending(1)], [arrived(1)]]) {
      const e = refusal(() => assertTripMayEndUnpaid(rows, 'refused', at(60 * MIN)));
      expect(e).toMatchObject({ statusCode: 409, code: 'STOPS_REMAINING', details: { nextStopSequence: 1 } });
    }
  });
});
