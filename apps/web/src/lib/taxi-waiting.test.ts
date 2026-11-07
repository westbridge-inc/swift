import { describe, expect, it } from 'vitest';
import { clockLabel, fareBreakdownOf, liveWaiting, waitingView } from './taxi-waiting';

// [WEB-TAXI · TAXI waiting charge · research E4] The website reads the wait and
// the receipt exactly as the phone does (apps/mobile lib/taxiWaiting.test.ts,
// the same contract fixtures): the server's figures, never a made-up value.

const WAITING_LIVE = {
  chargePerBlock: 300, blockMinutes: 10, currencyCode: 'GYD',
  pickupWaitMinutes: 7, waitingMinutes: 13, waitingCharge: 300, running: true,
  nextChargeAt: '2026-10-01T21:10:00.000Z',
} as const;
const FARE_BREAKDOWN = { routeFare: 2800, waitingMinutes: 13, waitingCharge: 300, total: 3100, currencyCode: 'GYD' } as const;
const nextAt = Date.parse(WAITING_LIVE.nextChargeAt);

describe('the live wait (§8.3)', () => {
  it('is absent before the driver arrives, and for a broken object', () => {
    expect(liveWaiting({ id: 'r' })).toBeNull();
    expect(liveWaiting({ waiting: { running: true } })).toBeNull();
  });
  it('ticks the timer locally from nextChargeAt; the money stays the server’s', () => {
    const live = liveWaiting({ waiting: WAITING_LIVE })!;
    expect(waitingView(live, nextAt - 390_000)).toMatchObject({ minutes: 13, charge: 300, running: true, nextChargeInSeconds: 390 });
    expect(waitingView(live, nextAt - 120_000)).toMatchObject({ minutes: 18, charge: 300, nextChargeInSeconds: 120 });
  });
  it('past nextChargeAt no charge is predicted before the server says so', () => {
    const view = waitingView(liveWaiting({ waiting: WAITING_LIVE })!, nextAt + 90_000);
    expect(view).toMatchObject({ minutes: 21, charge: 300, nextChargeInSeconds: null });
  });
  it('a clock that runs behind never shows less than the server', () => {
    expect(waitingView(liveWaiting({ waiting: WAITING_LIVE })!, nextAt - 3_600_000)).toMatchObject({ minutes: 13, nextChargeInSeconds: 600 });
  });
  it('prints a countdown as m:ss', () => {
    expect(clockLabel(390)).toBe('6:30');
    expect(clockLabel(65)).toBe('1:05');
  });
});

describe('the receipt’s breakdown (§8.4)', () => {
  it('reads it from the finished ride; anything malformed is today’s receipt', () => {
    expect(fareBreakdownOf({ fareBreakdown: FARE_BREAKDOWN })).toEqual(FARE_BREAKDOWN);
    expect(fareBreakdownOf({ fareBreakdown: { routeFare: 2800, total: 'x' } })).toBeNull();
    expect(fareBreakdownOf(null)).toBeNull();
  });
});
