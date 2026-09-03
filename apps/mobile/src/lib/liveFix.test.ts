import { describe, it, expect, beforeEach } from 'vitest';
import { coordinateOf, decideLiveFix, liveFixDrops, recordFixDrop, resetFixDrops } from './liveFix';

// ---------------------------------------------------------------------------
// [MOB-024] A LIVE COURIER FIX BELONGS TO ONE ORDER.
//
// The delivery screen accepted `rider:location` and moved the courier marker
// and the ETA without checking which order the event was for. The handler for
// `driver:location` two lines below it DID check — one law, written twice, and
// the copy that mattered was the one that forgot.
//
// An event from another room — a retained subscription, a reconnect that
// rejoined an old room, a customer with two deliveries open — moved the
// courier on the wrong customer's screen: someone else's rider position,
// someone else's ETA, on a map that says it is yours.
// ---------------------------------------------------------------------------

const ORDER = 'ord_this_one';
const ok = {
  orderId: ORDER,
  latitude: 6.8013,
  longitude: -58.1551,
  timestamp: '2026-09-03T12:00:00.000Z',
  etaMinutes: 7,
};
const ctx = { orderId: ORDER, lastFixAt: null, allowed: true };

beforeEach(resetFixDrops);

describe('[MOB-024] the fix must name THIS order', () => {
  it('a fix for another order is dropped — this is the defect, in one line', () => {
    const decision = decideLiveFix({ ...ok, orderId: 'ord_someone_else' }, ctx);
    expect(decision.accepted).toBe(false);
    expect(decision).toMatchObject({ reason: 'foreign_order' });
  });

  it('a fix that names NO order is dropped too — an unidentified event is exactly the shape of the defect', () => {
    for (const orderId of [undefined, null, '', 42, {}]) {
      expect(decideLiveFix({ ...ok, orderId }, ctx)).toMatchObject({ accepted: false, reason: 'foreign_order' });
    }
  });

  it('a fix for this order, with a good coordinate and time, is accepted', () => {
    const decision = decideLiveFix(ok, ctx);
    expect(decision).toMatchObject({
      accepted: true,
      coordinate: { latitude: 6.8013, longitude: -58.1551 },
      etaMinutes: 7,
    });
  });

  it('the identity is checked BEFORE anything else — a foreign event is never even parsed for a position', () => {
    // a foreign event with a broken coordinate reports the identity failure,
    // not the coordinate one: the order it belongs to is the first question
    const decision = decideLiveFix({ ...ok, orderId: 'ord_other', latitude: 'x', longitude: null }, ctx);
    expect(decision).toMatchObject({ reason: 'foreign_order' });
  });
});

describe('[MOB-024] and it must be usable, and current', () => {
  it('a coordinate off the globe, or missing, is dropped', () => {
    for (const bad of [{ latitude: 91 }, { longitude: 181 }, { latitude: null }, { longitude: undefined }, { latitude: 'north' }]) {
      expect(decideLiveFix({ ...ok, ...bad }, ctx)).toMatchObject({ accepted: false, reason: 'bad_coordinate' });
    }
  });

  it('a fix with no parsable server time is dropped — freshness cannot be judged without one', () => {
    for (const ts of [undefined, null, 'yesterday', 1234567890]) {
      expect(decideLiveFix({ ...ok, timestamp: ts }, ctx)).toMatchObject({ accepted: false, reason: 'bad_timestamp' });
    }
  });

  it('an OLDER fix never moves the marker backwards — out-of-order delivery is normal on a socket', () => {
    const lastFixAt = Date.parse('2026-09-03T12:00:05.000Z');
    expect(decideLiveFix({ ...ok, timestamp: '2026-09-03T12:00:00.000Z' }, { ...ctx, lastFixAt }))
      .toMatchObject({ accepted: false, reason: 'stale' });
    // the same instant is not stale: a re-send of the current fix is harmless
    expect(decideLiveFix({ ...ok, timestamp: '2026-09-03T12:00:05.000Z' }, { ...ctx, lastFixAt }))
      .toMatchObject({ accepted: true });
  });

  it('a screen that may not show a live position shows none', () => {
    expect(decideLiveFix(ok, { ...ctx, allowed: false })).toMatchObject({ accepted: false, reason: 'not_permitted' });
  });

  it('an absent or nonsense ETA is null, not a number the screen would print', () => {
    expect(decideLiveFix({ ...ok, etaMinutes: undefined }, ctx)).toMatchObject({ accepted: true, etaMinutes: null });
    expect(decideLiveFix({ ...ok, etaMinutes: -3 }, ctx)).toMatchObject({ accepted: true, etaMinutes: null });
    expect(decideLiveFix({ ...ok, etaMinutes: 'soon' }, ctx)).toMatchObject({ accepted: true, etaMinutes: null });
    expect(decideLiveFix({ ...ok, etaMinutes: '12' }, ctx)).toMatchObject({ accepted: true, etaMinutes: 12 });
  });
});

describe('[MOB-024] both transports answer to the same law', () => {
  it('the rider payload and the driver payload decide identically once their field names are mapped', () => {
    // rider:location sends lat/lng/ts; driver:location sends latitude/longitude/timestamp
    const rider = { orderId: ORDER, lat: 6.8, lng: -58.1, ts: '2026-09-03T12:00:00.000Z', etaMinutes: 5 };
    const driver = { orderId: ORDER, latitude: 6.8, longitude: -58.1, timestamp: '2026-09-03T12:00:00.000Z', etaMinutes: 5 };
    const fromRider = decideLiveFix(
      { orderId: rider.orderId, latitude: rider.lat, longitude: rider.lng, timestamp: rider.ts, etaMinutes: rider.etaMinutes },
      ctx,
    );
    const fromDriver = decideLiveFix(
      { orderId: driver.orderId, latitude: driver.latitude, longitude: driver.longitude, timestamp: driver.timestamp, etaMinutes: driver.etaMinutes },
      ctx,
    );
    expect(fromRider).toEqual(fromDriver);
  });
});

describe('[MOB-024] a dropped fix is counted, by reason', () => {
  it('foreign_order is the count that is supposed to stay at zero — anything else means rooms are leaking', () => {
    expect(liveFixDrops.foreign_order).toBe(0);
    for (const event of [{ ...ok, orderId: 'ord_a' }, { ...ok, orderId: undefined }]) {
      const decision = decideLiveFix(event, ctx);
      if (!decision.accepted) recordFixDrop(decision.reason);
    }
    expect(liveFixDrops.foreign_order).toBe(2);
    expect(liveFixDrops.stale).toBe(0);
  });

  it('every reason has its own counter, so a real cause is never hidden behind a common one', () => {
    expect(Object.keys(liveFixDrops).sort()).toEqual(
      ['bad_coordinate', 'bad_timestamp', 'foreign_order', 'not_permitted', 'stale'],
    );
  });
});

describe('[MOB-024] the coordinate rule the map and the socket share', () => {
  it('is one function, so the screen and the socket cannot disagree about what is showable', () => {
    expect(coordinateOf(6.8, -58.1)).toEqual({ latitude: 6.8, longitude: -58.1 });
    expect(coordinateOf(91, 0)).toBeNull();
    expect(coordinateOf(0, 181)).toBeNull();
    expect(coordinateOf(null, 1)).toBeNull();
    expect(coordinateOf('6.8', '-58.1')).toEqual({ latitude: 6.8, longitude: -58.1 });
  });
});
