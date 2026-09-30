import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import {
  MAX_TAXI_INTERMEDIATE_STOPS,
  MIN_TAXI_STOP_GAP_METERS,
  normalizeTaxiStops,
  type TaxiStopInput,
} from '../modules/rides/taxi-itinerary';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 1/8] The itinerary rules, service-free: at most three
// intermediate stops, each a real place the request schema would accept,
// numbered by the SERVER in the passenger's order, and no two consecutive
// points of the route (pickup → stops → destination) closer than 50 m.
// A ride with no stops is exactly today's ride: nothing new is judged.
// ---------------------------------------------------------------------------

/** Metres per degree of latitude on the haversine sphere (R = 6371 km). */
const M_PER_DEG_LAT = (2 * Math.PI * 6_371_000) / 360;
const north = (p: { lat: number; lng: number }, meters: number) => ({ lat: p.lat + meters / M_PER_DEG_LAT, lng: p.lng });

const pickup = { lat: 6.8013, lng: -58.1553 };
const dropoff = { lat: 6.84, lng: -58.13 };
const stopA: TaxiStopInput = { lat: 6.81, lng: -58.16, address: 'Stabroek Market' };
const stopB: TaxiStopInput = { lat: 6.82, lng: -58.15, address: 'Bourda Market' };
const stopC: TaxiStopInput = { lat: 6.83, lng: -58.14, address: 'Sheriff Street' };
/** The maximum a caller passes with the feature fully on (TAXI_MAX_STOPS=3). */
const ON = MAX_TAXI_INTERMEDIATE_STOPS;

function refusal(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected a refusal, got none');
}

function zodPath(fn: () => unknown): (string | number)[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ZodError) return err.issues[0]!.path;
    throw err;
  }
  throw new Error('expected a validation error, got none');
}

describe('taxi itinerary: a ride with no stops is today’s ride', () => {
  it('no stops, null stops and an empty list all plan nothing', () => {
    expect(normalizeTaxiStops({ pickup, dropoff, maxStops: ON })).toEqual([]);
    expect(normalizeTaxiStops({ pickup, dropoff, stops: null, maxStops: ON })).toEqual([]);
    expect(normalizeTaxiStops({ pickup, dropoff, stops: [], maxStops: ON })).toEqual([]);
  });

  it('judges nothing new without stops — a pickup beside its destination is not refused here', () => {
    expect(normalizeTaxiStops({ pickup, dropoff: north(pickup, 10), stops: [], maxStops: ON })).toEqual([]);
  });

  it('a switched-off feature (maximum 0) still accepts a ride without stops', () => {
    expect(normalizeTaxiStops({ pickup, dropoff, stops: [], maxStops: 0 })).toEqual([]);
  });
});

describe('taxi itinerary: the server numbers the stops, in the passenger’s order', () => {
  it('numbers up to the three-stop limit 1..n in the order given — never re-sorted by distance', () => {
    const plan = normalizeTaxiStops({ pickup, dropoff, stops: [stopC, stopA, stopB], maxStops: ON });
    expect(plan.map((s) => [s.sequence, s.address])).toEqual([
      [1, 'Sheriff Street'], [2, 'Stabroek Market'], [3, 'Bourda Market'],
    ]);
    expect(MAX_TAXI_INTERMEDIATE_STOPS).toBe(3);
  });

  it('ignores a sequence the client sent — the numbering is authoritative, not echoed', () => {
    const forged = [{ ...stopA, sequence: 3 }, { ...stopB, sequence: 1 }] as unknown as TaxiStopInput[];
    expect(normalizeTaxiStops({ pickup, dropoff, stops: forged, maxStops: ON }).map((s) => s.sequence)).toEqual([1, 2]);
  });

  it('keeps coordinates exact, trims the address, and carries nothing else from the input', () => {
    const [only] = normalizeTaxiStops({
      pickup, dropoff,
      stops: [{ lat: 6.812345678, lng: -58.161234567, address: '  Stabroek Market  ', note: 'x' } as TaxiStopInput],
      maxStops: ON,
    });
    expect(only).toEqual({ sequence: 1, lat: 6.812345678, lng: -58.161234567, address: 'Stabroek Market' });
  });

  it('returns a frozen copy — changing the input afterwards changes nothing', () => {
    const mutable = { ...stopA };
    const input = [mutable];
    const plan = normalizeTaxiStops({ pickup, dropoff, stops: input, maxStops: ON });
    mutable.address = 'Changed after request';
    input.reverse();
    expect(plan[0]!.address).toBe('Stabroek Market');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.every((s) => Object.isFrozen(s))).toBe(true);
  });

  it('a round trip is allowed: the final destination may be the pickup, and a stop may repeat when not consecutive', () => {
    const plan = normalizeTaxiStops({ pickup, dropoff: pickup, stops: [stopA, stopB, stopA], maxStops: ON });
    expect(plan.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });
});

describe('taxi itinerary: TOO_MANY_STOPS', () => {
  it('a fourth stop is refused at the database cap, with the numbers the app needs', () => {
    const err = refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA, stopB, stopC, stopA], maxStops: ON }));
    expect([err.statusCode, err.code]).toEqual([400, 'TOO_MANY_STOPS']);
    expect(err.details).toEqual({ maxStops: 3, stopCount: 4 });
  });

  it('a caller’s lower maximum binds (the configured TAXI_MAX_STOPS is passed in, never read here)', () => {
    expect(normalizeTaxiStops({ pickup, dropoff, stops: [stopA], maxStops: 1 })).toHaveLength(1);
    const err = refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA, stopB], maxStops: 1 }));
    expect([err.code, err.details]).toEqual(['TOO_MANY_STOPS', { maxStops: 1, stopCount: 2 }]);
  });

  it('has no default maximum: forgetting the configured one fails closed, and does not compile', () => {
    // @ts-expect-error maxStops is required, so a caller cannot silently inherit the cap.
    const err = refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA] }));
    expect([err.code, err.details]).toEqual(['TOO_MANY_STOPS', { maxStops: 0, stopCount: 1 }]);
  });

  it('a maximum of 0 refuses any stop', () => {
    expect(refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA], maxStops: 0 })).code).toBe('TOO_MANY_STOPS');
  });

  it('a maximum above the database cap is held to the cap', () => {
    const err = refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA, stopB, stopC, stopA], maxStops: 10 }));
    expect(err.details).toEqual({ maxStops: 3, stopCount: 4 });
  });

  it('a broken maximum fails closed, not open', () => {
    expect(refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA], maxStops: Number.NaN })).details)
      .toEqual({ maxStops: 0, stopCount: 1 });
  });

  it('counts before it validates: an oversized list is refused as too many, whatever is inside it', () => {
    const junk = Array.from({ length: 50 }, () => ({ lat: 999, lng: 999, address: '' }));
    expect(refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: junk, maxStops: ON })).code).toBe('TOO_MANY_STOPS');
  });
});

describe('taxi itinerary: every stop is a place the request schema would accept', () => {
  it.each([
    { lat: 90.001 }, { lat: -90.001 }, { lat: Number.NaN }, { lat: Number.POSITIVE_INFINITY },
    { lng: 180.001 }, { lng: -180.001 }, { lng: Number.NaN },
  ])('refuses an impossible coordinate %j, naming the stop', (bad) => {
    expect(zodPath(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA, { ...stopB, ...bad }], maxStops: ON })))
      .toEqual(['stops', 1, Object.keys(bad)[0]!]);
  });

  it('accepts the coordinate bounds themselves', () => {
    const far = normalizeTaxiStops({
      pickup, dropoff, maxStops: ON,
      stops: [{ lat: 90, lng: 180, address: 'North' }, { lat: -90, lng: -180, address: 'South' }],
    });
    expect(far).toHaveLength(2);
  });

  it('refuses an address under 3 or over 200 characters once trimmed — the request schema bounds', () => {
    expect(zodPath(() => normalizeTaxiStops({ pickup, dropoff, stops: [{ ...stopA, address: '  ab  ' }], maxStops: ON }))).toEqual(['stops', 0, 'address']);
    expect(zodPath(() => normalizeTaxiStops({ pickup, dropoff, stops: [{ ...stopA, address: 'x'.repeat(201) }], maxStops: ON }))).toEqual(['stops', 0, 'address']);
    expect(normalizeTaxiStops({ pickup, dropoff, stops: [{ ...stopA, address: 'abc' }], maxStops: ON })[0]!.address).toBe('abc');
    expect(normalizeTaxiStops({ pickup, dropoff, stops: [{ ...stopA, address: `  ${'x'.repeat(200)}  ` }], maxStops: ON })[0]!.address).toHaveLength(200);
  });

  it('refuses a stop list that is not a list', () => {
    expect(() => normalizeTaxiStops({ pickup, dropoff, stops: 'Stabroek' as unknown as TaxiStopInput[], maxStops: ON })).toThrow(ZodError);
  });

  it('refuses a broken pickup or destination once stops make them matter', () => {
    expect(zodPath(() => normalizeTaxiStops({ pickup: { lat: 91, lng: 0 }, dropoff, stops: [stopA], maxStops: ON }))).toEqual(['pickup', 'lat']);
    expect(zodPath(() => normalizeTaxiStops({ pickup, dropoff: { lat: 0, lng: Number.NaN }, stops: [stopA], maxStops: ON }))).toEqual(['dropoff', 'lng']);
  });
});

describe('taxi itinerary: STOP_TOO_CLOSE — consecutive points at least 50 m apart', () => {
  it('holds the line at 50 m on the first leg: pickup to stop 1', () => {
    expect(MIN_TAXI_STOP_GAP_METERS).toBe(50);
    const near = { ...north(pickup, 49), address: 'Next door' };
    const err = refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [near], maxStops: ON }));
    expect([err.statusCode, err.code]).toEqual([400, 'STOP_TOO_CLOSE']);
    expect(err.details).toMatchObject({ stopSequence: 1, from: 'PICKUP', to: 'STOP_1', minMeters: 50 });
    expect(err.message).toMatch(/Stop 1 is too close to your pickup/);
    expect(normalizeTaxiStops({ pickup, dropoff, stops: [{ ...north(pickup, 51), address: 'Down the road' }], maxStops: ON })).toHaveLength(1);
  });

  it('checks every leg between stops', () => {
    const tooNear = { ...north(stopA, 30), address: 'Same block' };
    const err = refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA, tooNear, stopC], maxStops: ON }));
    expect(err.details).toMatchObject({ stopSequence: 2, from: 'STOP_1', to: 'STOP_2' });
    expect(err.message).toMatch(/Stop 2 is too close to stop 1/);
  });

  it('checks the last leg: the final stop to the destination', () => {
    const atTheDoor = { ...north(dropoff, 20), address: 'Almost there' };
    const err = refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [stopA, atTheDoor], maxStops: ON }));
    expect(err.details).toMatchObject({ stopSequence: 2, from: 'STOP_2', to: 'DESTINATION' });
    expect(err.message).toMatch(/Stop 2 is too close to your destination/);
  });

  it('reports the measured gap, rounded to the metre', () => {
    const err = refusal(() => normalizeTaxiStops({ pickup, dropoff, stops: [{ ...north(pickup, 12.4), address: 'Right here' }], maxStops: ON }));
    expect(err.details?.['distanceMeters']).toBe(12);
  });
});
