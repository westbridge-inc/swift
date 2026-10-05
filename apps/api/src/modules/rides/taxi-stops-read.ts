import type { Prisma, PrismaClient, TaxiStopStatus } from '@prisma/client';
import { isTaxiStopOpen } from '../order/order-status';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 3/8] How the stops of a ride are READ and shown: one
// select, two shapes and one "next stop" rule. Every surface that shows stops
// reads them through here (the request answer, the passenger's ride, the
// driver's board, the live offer card and the card rebuilt after an app
// restart, and the driver's active ride), so no two of them can disagree.
//
// A ride without stops (Order.taxiStopCount NULL, every ride today) gains
// nothing: the caller adds no key, so its payload stays exactly what it was.
// Reads are never switched off: a ride booked with stops keeps showing them
// after TAXI_MAX_STOPS goes back to 0, so a ride in flight always finishes.
//
// Never shown: the row id, the tenant, who moved the stop last and the
// driver's evidence note. The passenger is told a skip's reason; the rest is
// the platform's.
// ---------------------------------------------------------------------------

/** The columns a stop is read with, and nothing else. */
export const TAXI_STOP_PUBLIC_SELECT = {
  orderId: true,
  sequence: true,
  address: true,
  lat: true,
  lng: true,
  status: true,
  legMeters: true,
  legSeconds: true,
  arrivedAt: true,
  departedAt: true,
  skippedAt: true,
  skipReason: true,
} as const satisfies Prisma.TaxiTripStopSelect;

export type TaxiStopRow = Prisma.TaxiTripStopGetPayload<{ select: typeof TAXI_STOP_PUBLIC_SELECT }>;

/** Where the ride goes, in order: what a driver judges an offer by. */
export interface TaxiStopPreview {
  sequence: number;
  address: string;
  lat: number;
  lng: number;
}

/** A stop on a live ride: where it is and how far the ride has got with it. */
export interface TaxiStopProgress extends TaxiStopPreview {
  status: TaxiStopStatus;
  /** The priced leg that ENDS at this stop (from the pickup or the previous
   *  stop), in whole metres and seconds; null when it was not routed. */
  legMeters: number | null;
  legSeconds: number | null;
  arrivedAt: Date | null;
  departedAt: Date | null;
  skippedAt: Date | null;
  skipReason: string | null;
}

const bySequence = <T extends { sequence: number }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.sequence - b.sequence);

/** The itinerary as an offer shows it: sequence, address and position only. */
export function stopPreview(rows: readonly Pick<TaxiStopRow, 'sequence' | 'address' | 'lat' | 'lng'>[]): TaxiStopPreview[] {
  return bySequence(rows).map((s) => ({ sequence: s.sequence, address: s.address, lat: s.lat, lng: s.lng }));
}

/** The itinerary as a live ride shows it, with each stop's progress. */
export function stopProgress(rows: readonly TaxiStopRow[]): TaxiStopProgress[] {
  return bySequence(rows).map((s) => ({
    sequence: s.sequence,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
    status: s.status,
    legMeters: s.legMeters,
    legSeconds: s.legSeconds,
    arrivedAt: s.arrivedAt,
    departedAt: s.departedAt,
    skippedAt: s.skippedAt,
    skipReason: s.skipReason,
  }));
}

/** The stop the ride is heading for (or waiting at): the first one, in the
 *  passenger's order, the driver still owes an arrival, a departure or a skip
 *  (the stop law's OPEN states). Null once every stop is done: the final
 *  destination is next. */
export function nextStopSequence(rows: readonly Pick<TaxiStopRow, 'sequence' | 'status'>[]): number | null {
  return bySequence(rows).find((s) => isTaxiStopOpen(s.status))?.sequence ?? null;
}

/**
 * The stops of the given rides, by order id, each list in sequence order. One
 * query for any number of rides, none for an empty list. The read is tenant
 * scoped like every read of a tenant table (the caller's tenant, under RLS),
 * so a ride of another operator yields nothing.
 */
export async function loadTaxiStops(
  prisma: Pick<PrismaClient, 'taxiTripStop'>,
  orderIds: readonly string[],
): Promise<Map<string, TaxiStopRow[]>> {
  const byOrder = new Map<string, TaxiStopRow[]>();
  if (orderIds.length === 0) return byOrder;
  const rows = await prisma.taxiTripStop.findMany({
    where: { orderId: { in: [...new Set(orderIds)] } },
    select: TAXI_STOP_PUBLIC_SELECT,
    orderBy: [{ orderId: 'asc' }, { sequence: 'asc' }],
  });
  for (const row of rows) {
    const list = byOrder.get(row.orderId) ?? [];
    list.push(row);
    byOrder.set(row.orderId, list);
  }
  return byOrder;
}

/** What a ride WITH stops adds to an offer, a board item or a recovered card:
 *  how many stops, and where. A ride without them adds nothing (null). */
export function offerItinerary(
  order: { id: string; taxiStopCount: number | null },
  stops: ReadonlyMap<string, readonly TaxiStopRow[]>,
): { stopCount: number; stops: TaxiStopPreview[] } | null {
  if (order.taxiStopCount == null) return null;
  const rows = stops.get(order.id) ?? [];
  return { stopCount: rows.length, stops: stopPreview(rows) };
}

/** What a ride WITH stops adds to the passenger's or the driver's live ride:
 *  every stop with its progress, and the one the ride is heading for. A ride
 *  without them adds nothing (null). */
export function rideItinerary(
  order: { id: string; taxiStopCount: number | null },
  stops: ReadonlyMap<string, readonly TaxiStopRow[]>,
): { stops: TaxiStopProgress[]; nextStopSequence: number | null } | null {
  if (order.taxiStopCount == null) return null;
  const rows = stops.get(order.id) ?? [];
  return { stops: stopProgress(rows), nextStopSequence: nextStopSequence(rows) };
}

/** One ride's live-ride fields, read and shaped; null (and no query) for a
 *  ride without stops. */
export async function readRideItinerary(
  prisma: Pick<PrismaClient, 'taxiTripStop'>,
  order: { id: string; taxiStopCount: number | null },
): Promise<{ stops: TaxiStopProgress[]; nextStopSequence: number | null } | null> {
  if (order.taxiStopCount == null) return null;
  return rideItinerary(order, await loadTaxiStops(prisma, [order.id]));
}

/** One ride's offer fields, read and shaped; null (and no query) for a ride
 *  without stops. */
export async function readOfferItinerary(
  prisma: Pick<PrismaClient, 'taxiTripStop'>,
  order: { id: string; taxiStopCount: number | null },
): Promise<{ stopCount: number; stops: TaxiStopPreview[] } | null> {
  if (order.taxiStopCount == null) return null;
  return offerItinerary(order, await loadTaxiStops(prisma, [order.id]));
}
