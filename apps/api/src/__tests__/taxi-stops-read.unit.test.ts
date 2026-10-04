import { describe, it, expect, vi } from 'vitest';
import type { TaxiStopStatus } from '@prisma/client';
import {
  TAXI_STOP_PUBLIC_SELECT,
  loadTaxiStops,
  nextStopSequence,
  offerItinerary,
  readOfferItinerary,
  readRideItinerary,
  rideItinerary,
  stopPreview,
  stopProgress,
  type TaxiStopRow,
} from '../modules/rides/taxi-stops-read';
import { TAXI_STOP_LAW } from '../modules/order/order-status';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 3/8] The one place a ride's stops are read and shaped:
// every surface (the request answer, the passenger's ride, the driver's board,
// the live and the recovered offer card, the driver's active ride) goes
// through it. Pure, no database: the loader is given a stub.
// ---------------------------------------------------------------------------

const at = new Date('2026-10-01T20:00:00.000Z');
function row(sequence: number, status: TaxiStopStatus = 'PENDING', orderId = 'ride-1', extra: Partial<TaxiStopRow> = {}): TaxiStopRow {
  return {
    orderId, sequence, address: `Stop ${sequence}`, lat: Number((6.4 + sequence / 100).toFixed(2)), lng: Number((-58.6 - sequence / 100).toFixed(2)), status,
    legMeters: 1000 * sequence, legSeconds: null, arrivedAt: null, departedAt: null, skippedAt: null, skipReason: null,
    ...extra,
  };
}

describe('the shapes', () => {
  it('an offer shows where the ride goes, in order: sequence, address and position, nothing else', () => {
    expect(stopPreview([row(3), row(1), row(2)])).toEqual([
      { sequence: 1, address: 'Stop 1', lat: 6.41, lng: -58.61 },
      { sequence: 2, address: 'Stop 2', lat: 6.42, lng: -58.62 },
      { sequence: 3, address: 'Stop 3', lat: 6.43, lng: -58.63 },
    ]);
  });

  it('a live ride shows each stop with its progress, in order; never the row id, the tenant, the actor or the evidence note', () => {
    const shaped = stopProgress([row(2, 'ARRIVED', 'ride-1', { arrivedAt: at }), row(1, 'SKIPPED', 'ride-1', { skippedAt: at, skipReason: 'Road closed' })]);
    expect(shaped.map((s) => Object.keys(s))).toEqual([
      ['sequence', 'address', 'lat', 'lng', 'status', 'legMeters', 'legSeconds', 'arrivedAt', 'departedAt', 'skippedAt', 'skipReason'],
      ['sequence', 'address', 'lat', 'lng', 'status', 'legMeters', 'legSeconds', 'arrivedAt', 'departedAt', 'skippedAt', 'skipReason'],
    ]);
    expect(shaped.map((s) => [s.sequence, s.status, s.skipReason])).toEqual([[1, 'SKIPPED', 'Road closed'], [2, 'ARRIVED', null]]);
    // The select itself never reads what must not be shown.
    for (const hidden of ['id', 'tenantId', 'actedBy', 'evidenceNote', 'createdAt', 'updatedAt']) {
      expect(TAXI_STOP_PUBLIC_SELECT).not.toHaveProperty(hidden);
    }
  });
});

describe('the next stop', () => {
  it('is the first stop the driver still owes something, by sequence: PENDING or ARRIVED, never DEPARTED or SKIPPED', () => {
    expect(nextStopSequence([row(1), row(2), row(3)])).toBe(1);
    expect(nextStopSequence([row(2), row(1, 'ARRIVED'), row(3)])).toBe(1);
    expect(nextStopSequence([row(1, 'DEPARTED'), row(2, 'ARRIVED'), row(3)])).toBe(2);
    expect(nextStopSequence([row(3), row(1, 'SKIPPED'), row(2, 'DEPARTED')])).toBe(3);
    expect(nextStopSequence([row(1, 'DEPARTED'), row(2, 'SKIPPED')])).toBeNull();
    expect(nextStopSequence([])).toBeNull();
  });

  it('reads the stop law, not a list of its own: every OPEN state is next, every RESOLVED one is passed', () => {
    for (const [status, law] of Object.entries(TAXI_STOP_LAW) as [TaxiStopStatus, string][]) {
      expect(nextStopSequence([row(1, status), row(2)]), status).toBe(law === 'OPEN' ? 1 : 2);
    }
  });
});

describe('a ride without stops gains nothing', () => {
  const rows = new Map([['ride-1', [row(1)]]]);
  it('no key, and no query', async () => {
    expect(offerItinerary({ id: 'ride-1', taxiStopCount: null }, rows)).toBeNull();
    expect(rideItinerary({ id: 'ride-1', taxiStopCount: null }, rows)).toBeNull();
    const findMany = vi.fn(async () => []);
    const prisma = { taxiTripStop: { findMany } } as never;
    expect(await readRideItinerary(prisma, { id: 'ride-1', taxiStopCount: null })).toBeNull();
    expect(await readOfferItinerary(prisma, { id: 'ride-1', taxiStopCount: null })).toBeNull();
    expect((await loadTaxiStops(prisma, [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a ride WITH stops: the count, the stops in order and the next one', async () => {
    expect(offerItinerary({ id: 'ride-1', taxiStopCount: 1 }, rows)).toEqual({ stopCount: 1, stops: [{ sequence: 1, address: 'Stop 1', lat: 6.41, lng: -58.61 }] });
    expect(rideItinerary({ id: 'ride-1', taxiStopCount: 1 }, rows)).toMatchObject({ nextStopSequence: 1, stops: [{ sequence: 1, status: 'PENDING' }] });
  });
});

describe('the loader', () => {
  it('one query for many rides, its rows grouped by ride and in sequence order, the duplicates asked once', async () => {
    const findMany = vi.fn(async () => [row(1, 'PENDING', 'a'), row(2, 'PENDING', 'a'), row(1, 'PENDING', 'b')]);
    const byOrder = await loadTaxiStops({ taxiTripStop: { findMany } } as never, ['a', 'b', 'a']);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { orderId: { in: ['a', 'b'] } },
      select: TAXI_STOP_PUBLIC_SELECT,
      orderBy: [{ orderId: 'asc' }, { sequence: 'asc' }],
    });
    expect([...byOrder.entries()].map(([id, list]) => [id, list.map((s) => s.sequence)])).toEqual([['a', [1, 2]], ['b', [1]]]);
  });
});
