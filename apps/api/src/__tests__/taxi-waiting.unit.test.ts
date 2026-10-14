import { describe, it, expect } from 'vitest';
import {
  TAXI_WAITING_DEFAULTS,
  fareBreakdownOf,
  liveWaitingPayload,
  tallyTaxiWaiting,
  taxiWaitingEnabled,
  waitingDisclosure,
  waitingTermsFromRates,
  waitingTermsText,
  type TaxiWaitClock,
  type TaxiWaitStopClock,
  type TaxiWaitingTerms,
} from '../modules/rides/taxi-waiting';
import { validatePricingConfig, pricingPayloadHash } from '../modules/country/pricing-config';
import { LEGACY_GY_TAXI_CARD } from './helpers/legacy-taxi-card';
import { renderReceiptHtml } from '../modules/order/receipt';

// ---------------------------------------------------------------------------
// [TAXI waiting charge · owner ruling 1 Oct 2026] The rule, on the pure clock
// (CONTRACT.md Rev 2 §8.1): 500 per FULL 10 minutes of waiting; the pickup
// wait (arrival → start) and every stop's wait (arrival → departure, or →
// skip) summed on the server's timestamps, then floored to whole blocks. Not
// at the final destination; a negative wait (clock skew) is 0; no cap.
// ---------------------------------------------------------------------------

const GYD: TaxiWaitingTerms = { chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD' };
const T0 = new Date('2026-10-01T21:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const MIN = 60;

/** A single-leg ride whose pickup wait lasted `seconds` (closed: the trip started). */
const pickupOnly = (seconds: number): TaxiWaitClock => ({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: at(seconds), stops: [] });
const stop = (sequence: number, extra: Partial<TaxiWaitStopClock>): TaxiWaitStopClock =>
  ({ sequence, status: 'PENDING', arrivedAt: null, departedAt: null, skippedAt: null, ...extra });
const final = (clock: TaxiWaitClock, now = at(3 * 3600)) => tallyTaxiWaiting(clock, GYD, now, 'final');

describe('the edge-case table (the brief, item 5)', () => {
  const cases: Array<[string, TaxiWaitClock, number, number]> = [
    ['exactly 10:00 → one block', pickupOnly(10 * MIN), 500, 10],
    ['9:59 → nothing', pickupOnly(10 * MIN - 1), 0, 9],
    ['19:59 → one block', pickupOnly(20 * MIN - 1), 500, 19],
    ['20:00 → two blocks', pickupOnly(20 * MIN), 1000, 20],
    ['0 → nothing', pickupOnly(0), 0, 0],
    ['pickup 7 min + stop 4 min = 11 → one block', {
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: at(7 * MIN),
      stops: [stop(1, { status: 'DEPARTED', arrivedAt: at(20 * MIN), departedAt: at(24 * MIN) })],
    }, 500, 11],
    ['pickup 6 min + stop 2 min + stop 1:59 = 9:59 → nothing', {
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: at(6 * MIN),
      stops: [
        stop(1, { status: 'DEPARTED', arrivedAt: at(20 * MIN), departedAt: at(22 * MIN) }),
        stop(2, { status: 'DEPARTED', arrivedAt: at(30 * MIN), departedAt: at(32 * MIN - 1) }),
      ],
    }, 0, 9],
    ['clock skew: the start reads before the arrival → that leg is 0, never negative', pickupOnly(-5 * MIN), 0, 0],
    ['clock skew on one stop only: the other waits still count', {
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: at(10 * MIN),
      stops: [stop(1, { status: 'DEPARTED', arrivedAt: at(30 * MIN), departedAt: at(25 * MIN) })],
    }, 500, 10],
    ['a stop skipped AFTER arriving counts arrival → skip (the car waited)', {
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: at(0),
      stops: [stop(1, { status: 'SKIPPED', arrivedAt: at(20 * MIN), skippedAt: at(32 * MIN) })],
    }, 500, 12],
    ['a stop skipped without arriving counts nothing', {
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: at(0),
      stops: [stop(1, { status: 'SKIPPED', skippedAt: at(32 * MIN) })],
    }, 0, 0],
    ['no cap (none in the contract): 10 hours at the pickup → 60 blocks', pickupOnly(10 * 3600), 30_000, 600],
  ];
  it.each(cases)('%s', (_label, clock, charge, minutes) => {
    const tally = final(clock);
    expect({ charge: tally.waitingCharge, minutes: tally.waitingMinutes }).toEqual({ charge, minutes });
    expect(tally.totalSeconds).toBeGreaterThanOrEqual(0);
  });

  it('the waits are summed on exact timestamps BEFORE flooring: 300.5 s + 299.5 s is one full block', () => {
    const tally = final({
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: new Date(T0.getTime() + 300_500),
      stops: [stop(1, { status: 'DEPARTED', arrivedAt: at(20 * MIN), departedAt: new Date(at(20 * MIN).getTime() + 299_500) })],
    });
    expect({ seconds: tally.totalSeconds, charge: tally.waitingCharge }).toEqual({ seconds: 600, charge: 500 });
  });

  it('a full block under other terms: 250 per 5 minutes; 14:59 is two blocks, 15:00 three', () => {
    const terms = { chargePerBlock: 250, blockMinutes: 5, currencyCode: 'GYD' };
    expect(tallyTaxiWaiting(pickupOnly(15 * MIN - 1), terms, at(0), 'final').waitingCharge).toBe(500);
    expect(tallyTaxiWaiting(pickupOnly(15 * MIN), terms, at(0), 'final').waitingCharge).toBe(750);
  });
});

describe('not counted at the final destination; the frozen figure is the one the driver was shown', () => {
  const trip: TaxiWaitClock = {
    status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: at(7 * MIN),
    stops: [stop(1, { status: 'DEPARTED', arrivedAt: at(20 * MIN), departedAt: at(24 * MIN) })],
  };
  it('every wait closed: the charge does not grow while the car drives on or stands at the destination', () => {
    for (const later of [25 * MIN, 60 * MIN, 5 * 3600]) {
      const live = tallyTaxiWaiting(trip, GYD, at(later), 'live');
      expect({ charge: live.waitingCharge, minutes: live.waitingMinutes, running: live.running, next: live.nextChargeAt }).toEqual({ charge: 500, minutes: 11, running: 0, next: null });
      expect(final(trip, at(later)).waitingCharge).toBe(500);
    }
  });
  it('a single-leg ride after the start: nothing runs, nothing grows', () => {
    const live = tallyTaxiWaiting(pickupOnly(9 * MIN), GYD, at(90 * MIN), 'live');
    expect({ charge: live.waitingCharge, running: live.running }).toEqual({ charge: 0, running: 0 });
  });
});

describe('the live clock (CONTRACT §8.3)', () => {
  it('at the pickup: the wait runs to now; the next block lands when the summed wait reaches it', () => {
    const waiting: TaxiWaitClock = { status: 'DRIVER_ARRIVED', driverArrivedAt: T0, pickedUpAt: null, stops: [] };
    const seven = liveWaitingPayload(GYD, tallyTaxiWaiting(waiting, GYD, at(7 * MIN), 'live'));
    expect(seven).toEqual({
      chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD',
      pickupWaitMinutes: 7, waitingMinutes: 7, waitingCharge: 0, running: true, nextChargeAt: '2026-10-01T21:10:00.000Z',
    });
    const thirteen = liveWaitingPayload(GYD, tallyTaxiWaiting(waiting, GYD, at(13 * MIN + 30), 'live'));
    expect(thirteen).toMatchObject({ pickupWaitMinutes: 13, waitingMinutes: 13, waitingCharge: 500, running: true, nextChargeAt: '2026-10-01T21:20:00.000Z' });
  });
  it('at an arrived stop: the closed pickup wait counts toward the next block', () => {
    const atStop: TaxiWaitClock = {
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: T0, pickedUpAt: at(7 * MIN),
      stops: [stop(1, { status: 'ARRIVED', arrivedAt: at(20 * MIN) }), stop(2, {})],
    };
    const tally = tallyTaxiWaiting(atStop, GYD, at(24 * MIN), 'live');
    expect({ minutes: tally.waitingMinutes, charge: tally.waitingCharge, running: tally.running }).toEqual({ minutes: 11, charge: 500, running: 1 });
    // 7 min at the pickup + 13 min at the stop = the second block, at 20:00 + 13:00.
    expect(tally.nextChargeAt?.toISOString()).toBe(at(33 * MIN).toISOString());
    expect(tally.stops.get(1)).toEqual({ ms: 4 * MIN * 1000, running: true });
    expect(tally.stops.get(2)).toBeNull();
    // The freeze never counts a wait that is still open (the stop guard closes it first).
    expect(final(atStop, at(24 * MIN)).waitingCharge).toBe(0);
  });
  it('before the arrival, and after a release before pickup (status back to PENDING with the old arrival on the row): no pickup wait', () => {
    for (const status of ['DRIVER_EN_ROUTE', 'PENDING', 'DRIVER_ASSIGNED'] as const) {
      const tally = tallyTaxiWaiting({ status, driverArrivedAt: T0, pickedUpAt: null, stops: [] }, GYD, at(30 * MIN), 'live');
      expect({ pickup: tally.pickup, charge: tally.waitingCharge, running: tally.running }).toEqual({ pickup: null, charge: 0, running: 0 });
    }
  });
  it('the next block is always in the future while a wait runs, at every second of a block', () => {
    const waiting: TaxiWaitClock = { status: 'DRIVER_ARRIVED', driverArrivedAt: T0, pickedUpAt: null, stops: [] };
    for (let s = 0; s <= 25 * MIN; s += 37) {
      const tally = tallyTaxiWaiting(waiting, GYD, at(s), 'live');
      expect(tally.nextChargeAt!.getTime()).toBeGreaterThan(at(s).getTime());
      expect(tally.nextChargeAt!.getTime()).toBe(at((Math.floor(s / 600) + 1) * 600).getTime());
    }
  });
});

describe('the terms, the sentence and the switch', () => {
  it('a market that names no waiting terms waits on the declared defaults (500 per 10 minutes)', () => {
    expect(TAXI_WAITING_DEFAULTS).toEqual({ chargePerBlock: 500, blockMinutes: 10 });
    expect(waitingTermsFromRates(LEGACY_GY_TAXI_CARD, 'GYD')).toEqual(GYD);
    expect(waitingTermsFromRates({ waitingChargePerBlock: 750, waitingBlockMinutes: 15 }, 'TTD')).toEqual({ chargePerBlock: 750, blockMinutes: 15, currencyCode: 'TTD' });
  });
  it('the disclosure is the contract\'s block and sentence', () => {
    expect(waitingDisclosure(GYD)).toEqual({ chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD', text: 'Waiting: 500 per 10 minutes after your driver arrives' });
    expect(waitingTermsText({ chargePerBlock: 1000, blockMinutes: 1, currencyCode: 'GYD' })).toBe('Waiting: 1,000 per minute after your driver arrives');
  });
  it('TAXI_WAITING_CHARGE is on only when it is exactly "1"', () => {
    expect(taxiWaitingEnabled({ TAXI_WAITING_CHARGE: '1' })).toBe(true);
    expect(taxiWaitingEnabled({ TAXI_WAITING_CHARGE: ' 1 ' })).toBe(true);
    for (const off of [undefined, '', '0', 'true', 'yes', 'on', '2', '1x']) expect(taxiWaitingEnabled({ TAXI_WAITING_CHARGE: off }), String(off)).toBe(false);
  });
  it('the breakdown adds up: route fare + waiting = total, only once frozen', () => {
    const order = { taxiFareTotal: 2800, totalAmount: 3300, currencyCode: 'GYD' };
    expect(fareBreakdownOf(order, { waitingMinutes: 13, waitingCharge: 500 as never, frozenAt: T0 }))
      .toEqual({ routeFare: 2800, waitingMinutes: 13, waitingCharge: 500, total: 3300, currencyCode: 'GYD' });
    expect(fareBreakdownOf(order, { waitingMinutes: null, waitingCharge: null, frozenAt: null })).toBeNull();
    expect(fareBreakdownOf(order, null)).toBeNull();
  });
});

describe('the rates are config (TAXI_RATES), validated; a stored card without them is unchanged', () => {
  it('waitingChargePerBlock is whole money and waitingBlockMinutes whole minutes 1..1440; anything else is refused, naming the field', () => {
    expect(validatePricingConfig('TAXI_RATES', { waitingChargePerBlock: 750, waitingBlockMinutes: 15 })).toMatchObject({ status: 'VALID', payload: { waitingChargePerBlock: 750, waitingBlockMinutes: 15 } });
    expect(validatePricingConfig('TAXI_RATES', { waitingChargePerBlock: 0 }).status).toBe('VALID');
    for (const bad of [-1, 1.5, NaN, Infinity, '500', null, 100_000_001]) {
      const v = validatePricingConfig('TAXI_RATES', { waitingChargePerBlock: bad });
      expect(v.status, String(bad)).toBe('INVALID');
      expect(v.problems.join(' ')).toContain('waitingChargePerBlock');
    }
    for (const bad of [0, -10, 1.5, 1441, '10', null]) {
      const v = validatePricingConfig('TAXI_RATES', { waitingBlockMinutes: bad });
      expect(v.status, String(bad)).toBe('INVALID');
      expect(v.problems.join(' ')).toContain('waitingBlockMinutes');
    }
    expect(validatePricingConfig('TAXI_RATES', { waitingCharge: 500 }).status).toBe('INVALID'); // a typo'd key does not silently do nothing
  });
  it('a card written before the waiting terms validates to exactly itself: same payload, same hash, so no new version is minted', () => {
    const verdict = validatePricingConfig('TAXI_RATES', LEGACY_GY_TAXI_CARD);
    expect(verdict.status).toBe('VALID');
    expect(JSON.stringify(verdict.payload)).toBe(JSON.stringify(LEGACY_GY_TAXI_CARD));
    expect(Object.keys(verdict.payload!).some((k) => /waiting/i.test(k))).toBe(false);
    expect(pricingPayloadHash(verdict.payload!)).toBe(pricingPayloadHash({ ...LEGACY_GY_TAXI_CARD }));
    // A market with no card at all: the defaults name no waiting terms either.
    expect(Object.keys(validatePricingConfig('TAXI_RATES', null).payload!).some((k) => /waiting/i.test(k))).toBe(false);
  });
});

describe('the printed receipt itemises a frozen waiting charge (CONTRACT §8.4)', () => {
  const ride = {
    orderNumber: 'TX-1', placedAt: T0, status: 'DELIVERED', orderType: 'TAXI', fulfillment: 'DELIVERY', paymentMethod: 'CASH', paymentStatus: 'CAPTURED',
    subtotalCustomer: 2800, deliveryFee: 0, tipAmount: 0, discount: 0, totalAmount: 3300, deliveryAddress: 'Lamaha Street',
    vendor: null, customer: { firstName: 'Ann', lastName: 'Lee' }, items: [], currencyCode: 'GYD',
  };
  const row = (html: string, label: string) => html.match(new RegExp(`<td>${label.replace(/[()]/g, '\\$&')}</td><td class="num">([^<]+)</td>`))?.[1] ?? null;
  it('a waiting line between the trip and the total, which it adds up to', () => {
    const html = renderReceiptHtml({ ...ride, fareBreakdown: { routeFare: 2800, waitingMinutes: 13, waitingCharge: 500, total: 3300 } });
    expect(row(html, 'Waiting (13 min)')).toMatch(/500/);
    expect(row(html, 'Total')).toMatch(/3,300/);
  });
  it('no line without a frozen charge, and none for a charge of 0', () => {
    expect(renderReceiptHtml({ ...ride, totalAmount: 2800 })).not.toMatch(/Waiting/);
    expect(renderReceiptHtml({ ...ride, totalAmount: 2800, fareBreakdown: { routeFare: 2800, waitingMinutes: 9, waitingCharge: 0, total: 2800 } })).not.toMatch(/Waiting/);
  });
});
