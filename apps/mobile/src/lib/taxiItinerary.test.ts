import { describe, expect, it } from 'vitest';
import {
  TAXI_STOPS_CAPABILITY,
  addStop,
  boardStops,
  canAddStop,
  driverStopStep,
  hasOpenStop,
  legLine,
  maxStopsFrom,
  moveStop,
  nextStopSequence,
  placeName,
  removeStop,
  replaceStop,
  rideStops,
  sameWireStops,
  stopActionsSupported,
  stopAddress,
  stopNavigationUrls,
  stopPhase,
  stopRefusalCopy,
  wireStops,
} from './taxiItinerary';
import {
  BOARD_STOPS,
  CAMP_STREET,
  ESTIMATE_WITH_ONE_STOP,
  REQUEST_BODY_WITH_ONE_STOP,
  RIDE_STOPS_PENDING,
  SHERIFF_STREET,
  driverRideWithStops,
  riderRideWithStops,
  riderRideWithoutStops,
} from './taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · parts 6–7] The phone's half of a ride's itinerary, held to
// the API contract (CONTRACT.md Rev 2 §1–§6): the flag the app reads, the stop
// list the passenger edits, the wire shape it sends, and the reads it renders.
// ---------------------------------------------------------------------------

const camp = { lat: CAMP_STREET.lat, lng: CAMP_STREET.lng, label: CAMP_STREET.address };
const sheriff = { lat: SHERIFF_STREET.lat, lng: SHERIFF_STREET.lng, label: SHERIFF_STREET.address };
const third = { lat: 6.83, lng: -58.17, label: 'Regent Street' };

describe('the flag the app reads: GET /rides/capabilities → maxStops (§1)', () => {
  it('a whole number 1..3 is the number of stops allowed', () => {
    expect(maxStopsFrom({ maxStops: 1 })).toBe(1);
    expect(maxStopsFrom({ maxStops: 3 })).toBe(3);
  });

  it('missing, 0, negative, fractional, text or junk is OFF — today’s screen', () => {
    for (const data of [undefined, null, {}, { maxStops: 0 }, { maxStops: -1 }, { maxStops: 2.5 }, { maxStops: '2' }, { maxStops: NaN }, { maxStops: Infinity }, 'x', 7]) {
      expect(maxStopsFrom(data), JSON.stringify(data)).toBe(0);
    }
  });

  it('above the database cap is held to 3, never more', () => {
    expect(maxStopsFrom({ maxStops: 9 })).toBe(3);
  });
});

describe('the passenger edits the stops: add, remove, reorder, never past the max', () => {
  it('adds up to the max and refuses the next one', () => {
    let stops: readonly typeof camp[] = [];
    stops = addStop(stops, camp, 2);
    stops = addStop(stops, sheriff, 2);
    expect(stops.map((s) => s.label)).toEqual(['Camp Street', 'Sheriff Street']);
    expect(canAddStop(stops, 2)).toBe(false);
    const refused = addStop(stops, third, 2);
    expect(refused, 'beyond the max is refused: the same list comes back').toBe(stops);
  });

  it('nothing can be added while the flag is off', () => {
    expect(canAddStop([], 0)).toBe(false);
    expect(addStop([], camp, 0)).toEqual([]);
  });

  it('removes one stop and keeps the others in order', () => {
    expect(removeStop([camp, sheriff, third], 1).map((s) => s.label)).toEqual(['Camp Street', 'Regent Street']);
  });

  it('moves a stop up or down; the ends stay put', () => {
    const list = [camp, sheriff, third];
    expect(moveStop(list, 1, -1).map((s) => s.label)).toEqual(['Sheriff Street', 'Camp Street', 'Regent Street']);
    expect(moveStop(list, 1, 1).map((s) => s.label)).toEqual(['Camp Street', 'Regent Street', 'Sheriff Street']);
    expect(moveStop(list, 0, -1)).toBe(list);
    expect(moveStop(list, 2, 1)).toBe(list);
  });

  it('replaces one stop in place (the passenger picked a different place)', () => {
    expect(replaceStop([camp, sheriff], 0, third).map((s) => s.label)).toEqual(['Regent Street', 'Sheriff Street']);
  });
});

describe('the wire shape: stops in the passenger’s order, no sequence (§2, §3)', () => {
  it('matches the contract’s request body stop list exactly', () => {
    expect(wireStops([camp])).toEqual(REQUEST_BODY_WITH_ONE_STOP.stops);
  });

  it('keeps the order the passenger chose', () => {
    expect(wireStops([sheriff, camp]).map((s) => s.address)).toEqual(['Sheriff Street', 'Camp Street']);
  });

  it('never sends a sequence or any other key', () => {
    for (const stop of wireStops([camp, sheriff])) expect(Object.keys(stop).sort()).toEqual(['address', 'lat', 'lng']);
  });

  it('holds the address inside 3..200 after trimming', () => {
    expect(stopAddress('  Camp   Street ', 1)).toBe('Camp Street');
    expect(stopAddress('', 2)).toBe('Stop 2');
    expect(stopAddress('A1', 3)).toBe('Stop 3');
    expect(stopAddress('x'.repeat(250), 1)).toHaveLength(200);
  });

  it('compares two stop lists by place and order', () => {
    expect(sameWireStops(wireStops([camp, sheriff]), wireStops([camp, sheriff]))).toBe(true);
    expect(sameWireStops(wireStops([camp, sheriff]), wireStops([sheriff, camp]))).toBe(false);
    expect(sameWireStops(undefined, [])).toBe(true);
    expect(sameWireStops(undefined, wireStops([camp]))).toBe(false);
  });
});

describe('the reads: a ride’s stops (§5, §6)', () => {
  it('a ride without stops has none — absent means no stops', () => {
    expect(rideStops(riderRideWithoutStops())).toEqual([]);
    expect(nextStopSequence(riderRideWithoutStops())).toBeNull();
    expect(hasOpenStop(riderRideWithoutStops())).toBe(false);
  });

  it('stops come back sorted by sequence whatever order they arrive in', () => {
    const ride = riderRideWithStops({ stops: [...riderRideWithStops().stops].reverse() });
    expect(rideStops(ride).map((s) => s.sequence)).toEqual([1, 2]);
  });

  it('each stop’s phase follows the contract’s status', () => {
    const ride = riderRideWithStops();
    const [first, second] = rideStops(ride);
    expect(stopPhase(first!, ride)).toBe('done');
    expect(stopPhase(second!, ride)).toBe('arrived');
    const skipped = { ...first!, status: 'SKIPPED', skipReason: 'Road blocked' };
    expect(stopPhase(skipped, ride)).toBe('skipped');
  });

  it('the next stop is the server’s nextStopSequence, and only once the trip is under way', () => {
    const started = driverRideWithStops();
    const [first, second] = rideStops(started);
    expect(stopPhase(first!, started)).toBe('next');
    expect(stopPhase(second!, started)).toBe('upcoming');
    const beforePickup = driverRideWithStops({ status: 'DRIVER_EN_ROUTE' });
    expect(stopPhase(rideStops(beforePickup)[0]!, beforePickup)).toBe('upcoming');
  });

  it('a stop is open until nextStopSequence is null', () => {
    expect(hasOpenStop(driverRideWithStops())).toBe(true);
    expect(hasOpenStop(driverRideWithStops({ nextStopSequence: null }))).toBe(false);
  });

  it('the board and offer carry the same stop list (§6.1, §6.2)', () => {
    expect(boardStops({ id: 'r1', ...BOARD_STOPS }).map((s) => s.address)).toEqual(['Camp Street', 'Sheriff Street']);
    expect(boardStops({ id: 'r2' })).toEqual([]);
    expect(boardStops(null)).toEqual([]);
  });
});

describe('the driver’s stop step (part 4) and the capability it needs', () => {
  it('stop actions exist only when the server sends the part-4 stopWait key', () => {
    expect(stopActionsSupported(driverRideWithStops())).toBe(false);
    expect(stopActionsSupported(driverRideWithStops({ stopWait: null }))).toBe(true);
    expect(stopActionsSupported(null)).toBe(false);
  });

  it('PENDING next stop → "Arrived at stop N"; ARRIVED → "Done at stop N"', () => {
    expect(driverStopStep(driverRideWithStops())).toEqual({ action: 'arrived', sequence: 1, label: 'Arrived at stop 1' });
    const at1 = driverRideWithStops({ stops: [{ ...RIDE_STOPS_PENDING[0], status: 'ARRIVED' }, { ...RIDE_STOPS_PENDING[1] }] });
    expect(driverStopStep(at1)).toEqual({ action: 'depart', sequence: 1, label: 'Done at stop 1' });
  });

  it('no stop step before the trip starts, or once every stop is done', () => {
    expect(driverStopStep(driverRideWithStops({ status: 'DRIVER_ARRIVED' }))).toBeNull();
    expect(driverStopStep(driverRideWithStops({ nextStopSequence: null }))).toBeNull();
    expect(driverStopStep(riderRideWithoutStops())).toBeNull();
  });

  it('declares the contract’s capability name at go-online', () => {
    expect(TAXI_STOPS_CAPABILITY).toBe('TAXI_STOPS_V1');
  });
});

describe('Navigate opens the phone’s own maps at that stop', () => {
  it('Apple Maps on iOS', () => {
    expect(stopNavigationUrls(CAMP_STREET, 'ios')).toEqual({
      app: 'maps://?daddr=6.8143,-58.1443',
      web: 'https://maps.apple.com/?daddr=6.8143,-58.1443',
    });
  });

  it('Google Maps on Android', () => {
    expect(stopNavigationUrls(CAMP_STREET, 'android')).toEqual({
      app: 'google.navigation:q=6.8143,-58.1443',
      web: 'https://www.google.com/maps/dir/?api=1&destination=6.8143,-58.1443',
    });
  });
});

describe('plain words for places, legs and refusals', () => {
  it('names the contract’s place codes', () => {
    expect(placeName('PICKUP')).toBe('your pickup');
    expect(placeName('STOP_2')).toBe('stop 2');
    expect(placeName('DESTINATION')).toBe('your destination');
  });

  it('prints each estimate leg in route order', () => {
    const [a, b] = ESTIMATE_WITH_ONE_STOP.data.legs;
    expect(legLine(a)).toBe('Pickup to stop 1 · 2.5 km');
    expect(legLine(b)).toBe('Stop 1 to destination · 2.4 km');
    expect(legLine({ from: 'STOP_1', to: 'STOP_2', meters: 900, seconds: 150 })).toBe('Stop 1 to stop 2 · 0.9 km · about 3 min');
    expect(legLine({ from: 'PICKUP' })).toBeNull();
  });

  it('turns each stop refusal into short plain English', () => {
    expect(stopRefusalCopy('MULTI_STOP_UNAVAILABLE', { maxStops: 0, stopCount: 1 })).toBe('Stops aren’t available right now. Remove your stops to book this ride.');
    expect(stopRefusalCopy('TOO_MANY_STOPS', { maxStops: 2, stopCount: 3 })).toBe('You can add up to 2 stops. Remove a stop to continue.');
    expect(stopRefusalCopy('TOO_MANY_STOPS', { maxStops: 1, stopCount: 2 })).toBe('You can add 1 stop. Remove a stop to continue.');
    expect(stopRefusalCopy('STOP_TOO_CLOSE', { stopSequence: 1, from: 'PICKUP', to: 'STOP_1', distanceMeters: 20, minMeters: 50 }))
      .toBe('Your pickup and stop 1 are too close together. Move or remove that stop.');
    expect(stopRefusalCopy('STOP_OUT_OF_MARKET', { place: 'STOP_2' })).toBe('Stop 2 is outside the area Swift serves.');
    expect(stopRefusalCopy('MULTI_STOP_ZONE_PRICED', {})).toBe('This route has a fixed price, so it can’t take stops. Remove your stops to book it.');
    expect(stopRefusalCopy('ROUTE_UNAVAILABLE', { stopCount: 2 })).toBe('We can’t plan a route with these stops right now. Try again in a minute, or remove your stops.');
    expect(stopRefusalCopy('FARE_CHANGED', { expectedFare: 2800, fare: 3000, rideClass: 'ECONOMY', currencyCode: 'GYD' }))
      .toMatch(/^The fare for this trip is now \$3.?000\. Check it, then tap Request again\.$/);
    expect(stopRefusalCopy('MULTI_STOP_QUEUE_UNSUPPORTED', {})).toBe('The queue can’t hold stops. Remove your stops to join it.');
    expect(stopRefusalCopy('NO_DRIVERS_NEARBY', {})).toBeNull();
    expect(stopRefusalCopy(undefined, undefined)).toBeNull();
  });
});
