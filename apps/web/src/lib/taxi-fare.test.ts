import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FARE_UNAVAILABLE, ROAD_ROUTING_UNAVAILABLE, TAXI_TIER_META, readTaxiEstimate, taxiEstimateRefusal } from './taxi-fare';

// [Row 117] The web shows the server's fare and nothing it made up.

const tier = (over: Record<string, unknown> = {}) => ({ rideClass: 'ECONOMY', fare: 800, multiplier: 1, capacity: 4, source: 'formula', ...over });

describe('readTaxiEstimate: only what the server priced', () => {
  it('keeps every named tier with a real fare, in the server’s order', () => {
    expect(readTaxiEstimate({ tiers: [tier(), tier({ rideClass: 'GROUP', fare: 1600, capacity: 14 })], durationMin: 9 })).toEqual({
      tiers: [{ rideClass: 'ECONOMY', fare: 800, capacity: 4 }, { rideClass: 'GROUP', fare: 1600, capacity: 14 }],
      durationMin: 9,
      waitingText: null,
    });
  });

  it.each([
    ['no fare', tier({ fare: null })],
    ['a zero fare', tier({ fare: 0 })],
    ['a negative fare', tier({ fare: -800 })],
    ['a text fare', tier({ fare: '800' })],
    ['an endless fare', tier({ fare: Number.POSITIVE_INFINITY })],
    ['a tier the web cannot name', tier({ rideClass: 'BOAT' })],
    ['an inherited name', tier({ rideClass: 'toString' })],
    ['no seats', tier({ capacity: 0 })],
    ['part of a seat', tier({ capacity: 2.5 })],
  ])('drops a tier with %s — and an answer left with none is no estimate', (_name, bad) => {
    expect(readTaxiEstimate({ tiers: [bad], durationMin: 9 })).toBeNull();
    expect(readTaxiEstimate({ tiers: [bad, tier()], durationMin: 9 })?.tiers).toEqual([{ rideClass: 'ECONOMY', fare: 800, capacity: 4 }]);
  });

  it.each([null, undefined, {}, { tiers: null }, { tiers: 'ECONOMY' }, 'estimate'])('%j is no estimate', (raw) => {
    expect(readTaxiEstimate(raw)).toBeNull();
  });

  it('a trip time is shown only when the server gave a real one', () => {
    for (const durationMin of [0, -3, null, undefined, Number.NaN, '12']) {
      expect(readTaxiEstimate({ tiers: [tier()], durationMin })?.durationMin).toBeNull();
    }
    expect(readTaxiEstimate({ tiers: [tier()], durationMin: 13.6 })?.durationMin).toBe(14);
  });

  it('the waiting sentence is the server’s, or none', () => {
    expect(readTaxiEstimate({ tiers: [tier()], waiting: { text: '  Waiting: $200 per 5 minutes.  ' } })?.waitingText).toBe('Waiting: $200 per 5 minutes.');
    for (const waiting of [null, {}, { text: '' }, { text: '   ' }, { text: 200 }]) {
      expect(readTaxiEstimate({ tiers: [tier()], waiting })?.waitingText).toBeNull();
    }
  });
});

describe('taxiEstimateRefusal: plain words, never a price', () => {
  it('road routing down is the phone’s sentence, with a retry', () => {
    expect(taxiEstimateRefusal({ code: 'ROUTE_UNAVAILABLE', message: 'anything' })).toEqual({ message: ROAD_ROUTING_UNAVAILABLE, retry: true });
  });

  it('outside the market is the server’s own sentence; without one, the general line', () => {
    expect(taxiEstimateRefusal({ code: 'ROUTE_OUT_OF_MARKET', message: 'Your pickup is outside Guyana, where Swift works today. Choose a place in Guyana.' }))
      .toEqual({ message: 'Your pickup is outside Guyana, where Swift works today. Choose a place in Guyana.', retry: false });
    expect(taxiEstimateRefusal({ code: 'ROUTE_OUT_OF_MARKET', message: ' ' })).toEqual({ message: FARE_UNAVAILABLE, retry: false });
  });

  it.each([new Error('socket hang up'), { code: 'VALIDATION_ERROR', message: 'Expected number' }, null, undefined, 'boom'])(
    'anything else (%j) is the general line, never the raw error', (error) => {
      expect(taxiEstimateRefusal(error)).toEqual({ message: FARE_UNAVAILABLE, retry: false });
    },
  );

  it('the routing sentence is the phone’s, word for word', () => {
    const phone = readFileSync(join(process.cwd(), '../mobile/src/lib/roadRouting.ts'), 'utf8');
    expect(phone).toContain(`'${ROAD_ROUTING_UNAVAILABLE}'`);
  });
});

describe('the web names each ride type as the phone does', () => {
  it('every label and line matches apps/mobile TaxiScreen TIER_META', () => {
    const phone = readFileSync(join(process.cwd(), '../mobile/src/modules/movement/screens/TaxiScreen.tsx'), 'utf8');
    for (const [rideClass, meta] of Object.entries(TAXI_TIER_META)) {
      expect(phone).toContain(`${rideClass}: { label: '${meta.label}', icon: '${meta.pictogram}', blurb: '${meta.blurb}' }`);
    }
  });
});
