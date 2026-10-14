import { describe, expect, it } from 'vitest';
import { clockLabel, fareBreakdownOf, liveWaiting, stopWaitMinutes, waitingDisclosure, waitingView } from './taxiWaiting';
import { ESTIMATE_WITH_ONE_STOP, FARE_BREAKDOWN, RIDE_STOPS_PENDING, WAITING_LIVE, WAITING_TERMS, riderRideWithStops } from './taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI waiting charge · owner ruling 1 Oct] CONTRACT.md Rev 2 §8. The phone
// shows what the server sends — the disclosure before booking, the live wait
// and its charge, the receipt's "Waiting" line — and never makes up a value:
// with no `waiting` object there is nothing to show.
// ---------------------------------------------------------------------------

const nextAt = Date.parse(WAITING_LIVE.nextChargeAt);

describe('the disclosure before booking (§8.2)', () => {
  it('shows the server’s own sentence', () => {
    expect(waitingDisclosure({ ...ESTIMATE_WITH_ONE_STOP.data, waiting: WAITING_TERMS })).toBe('Waiting: 500 per 10 minutes after your driver arrives');
  });

  it('nothing when the server sends no terms — today’s screen', () => {
    expect(waitingDisclosure(ESTIMATE_WITH_ONE_STOP.data)).toBeNull();
    expect(waitingDisclosure(undefined)).toBeNull();
    expect(waitingDisclosure({ waiting: null })).toBeNull();
  });

  it('builds the same sentence from the server’s numbers when the text is missing', () => {
    expect(waitingDisclosure({ waiting: { chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD' } }))
      .toMatch(/^Waiting: \$500 per 10 minutes after your driver arrives$/);
  });

  it('never invents terms from broken numbers', () => {
    for (const waiting of [{ chargePerBlock: 'x', blockMinutes: 10 }, { chargePerBlock: 500, blockMinutes: 0 }, { chargePerBlock: -5, blockMinutes: 10 }, { blockMinutes: 10 }]) {
      expect(waitingDisclosure({ waiting }), JSON.stringify(waiting)).toBeNull();
    }
  });
});

describe('the live wait (§8.3)', () => {
  it('is absent before the driver arrives', () => {
    expect(liveWaiting(riderRideWithStops())).toBeNull();
    expect(liveWaiting({ waiting: { running: true } })).toBeNull();
  });

  it('reads the contract’s object', () => {
    expect(liveWaiting(riderRideWithStops({ waiting: WAITING_LIVE }))).toMatchObject({ waitingMinutes: 13, waitingCharge: 500, running: true });
  });

  it('ticks the timer locally from nextChargeAt; the money stays the server’s', () => {
    const live = liveWaiting({ waiting: WAITING_LIVE })!;
    const view = waitingView(live, nextAt - 390_000);
    expect(view).toMatchObject({ minutes: 13, charge: 500, running: true, nextChargeInSeconds: 390 });
    expect(waitingView(live, nextAt - 120_000)).toMatchObject({ minutes: 18, charge: 500, nextChargeInSeconds: 120 });
  });

  it('past nextChargeAt the clock keeps going but no charge is predicted before the server says so', () => {
    const view = waitingView(liveWaiting({ waiting: WAITING_LIVE })!, nextAt + 90_000);
    expect(view.minutes).toBe(21);
    expect(view.charge).toBe(500);
    expect(view.nextChargeInSeconds).toBeNull();
  });

  it('a phone clock that runs behind never shows less than the server', () => {
    const view = waitingView(liveWaiting({ waiting: WAITING_LIVE })!, nextAt - 3_600_000);
    expect(view.minutes).toBe(13);
    expect(view.nextChargeInSeconds).toBe(600);
  });

  it('a stopped wait shows the server’s figures as they are', () => {
    const view = waitingView(liveWaiting({ waiting: { ...WAITING_LIVE, running: false, nextChargeAt: null } })!, nextAt);
    expect(view).toMatchObject({ minutes: 13, charge: 500, running: false, nextChargeInSeconds: null });
  });

  it('each stop’s own wait, when the server sends it', () => {
    expect(stopWaitMinutes({ ...RIDE_STOPS_PENDING[0], waitMinutes: 6 })).toBe(6);
    expect(stopWaitMinutes(RIDE_STOPS_PENDING[0])).toBeNull();
    expect(stopWaitMinutes({ waitMinutes: null })).toBeNull();
  });

  it('prints a countdown as m:ss', () => {
    expect(clockLabel(390)).toBe('6:30');
    expect(clockLabel(65)).toBe('1:05');
    expect(clockLabel(600)).toBe('10:00');
  });
});

describe('the receipt’s breakdown (§8.4)', () => {
  it('reads it from the finished ride', () => {
    expect(fareBreakdownOf({ fareBreakdown: FARE_BREAKDOWN })).toEqual(FARE_BREAKDOWN);
  });

  it('reads it from the DELIVERED socket fare object', () => {
    expect(fareBreakdownOf({ orderId: 'x', status: 'DELIVERED', fare: { total: 2800, fareBreakdown: FARE_BREAKDOWN } })).toEqual(FARE_BREAKDOWN);
  });

  it('no breakdown means today’s receipt', () => {
    expect(fareBreakdownOf({ fare: { base: 800, total: 2800 } })).toBeNull();
    expect(fareBreakdownOf({ fareBreakdown: { routeFare: 2800, total: 'x' } })).toBeNull();
    expect(fareBreakdownOf(null)).toBeNull();
  });
});
