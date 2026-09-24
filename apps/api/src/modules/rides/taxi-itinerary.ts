import { z } from 'zod';
import { AppError } from '../../utils/errors';
import { haversineDistance } from '../../utils/distance';

// ---------------------------------------------------------------------------
// [TAXI multi-stop] The itinerary of one ride: the pickup, then up to three
// intermediate stops in the order the passenger chose, then the final
// destination. The pickup and the destination stay where they are today (the
// order's pickup* and delivery* columns); this module decides only what the
// stops in between may be, and numbers them.
//
// Pure on purpose: no database, no routing, no money, no clock. The request
// path calls it before anything is priced or written, so a ride that cannot be
// driven as asked is refused before anyone quotes it.
//
// Inert today: nothing calls it yet, and it never reads TAXI_MAX_STOPS — the
// caller passes the configured maximum in.
// ---------------------------------------------------------------------------

/** The most intermediate stops a ride can carry: the database cap
 *  (taxi_trip_stops_sequence_check allows sequence 1..3). The configured
 *  maximum can lower it, never raise it. */
export const MAX_TAXI_INTERMEDIATE_STOPS = 3;

/** Two consecutive points of a route closer than this are one place, not two
 *  stops: a driver cannot arrive somewhere he is already standing. */
export const MIN_TAXI_STOP_GAP_METERS = 50;

/** A point, bounded exactly as the ride request bounds its pickup and dropoff. */
const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/** One stop as the passenger asks for it: the request schema's point and the
 *  request schema's address bounds (rides.routes requestRideSchema). Unknown
 *  keys are dropped, so a client cannot choose its own sequence. */
export const taxiStopInputSchema = pointSchema.extend({
  address: z.string().trim().min(3).max(200),
});

const itinerarySchema = z.object({
  pickup: pointSchema,
  dropoff: pointSchema,
  stops: z.array(taxiStopInputSchema),
});

export type TaxiPoint = z.infer<typeof pointSchema>;
export type TaxiStopInput = z.input<typeof taxiStopInputSchema>;

/** A validated stop, numbered by the server: 1..n in the passenger's order. */
export interface TaxiStopPlan {
  readonly sequence: number;
  readonly lat: number;
  readonly lng: number;
  readonly address: string;
}

/** The configured maximum, held to 0..cap. A value that is not a number fails
 *  closed (no stops), never open. */
function stopLimit(maxStops: number): number {
  if (!Number.isFinite(maxStops)) return 0;
  return Math.max(0, Math.min(MAX_TAXI_INTERMEDIATE_STOPS, Math.floor(maxStops)));
}

function tooManyStops(maxStops: number, stopCount: number): AppError {
  return new AppError(400, 'TOO_MANY_STOPS',
    maxStops === 0
      ? 'Stops are not available on this ride.'
      : `You can add up to ${maxStops} ${maxStops === 1 ? 'stop' : 'stops'}.`,
    { maxStops, stopCount });
}

/** The name a passenger knows each point by: 0 is the pickup, 1..n the stops,
 *  n + 1 the final destination. */
function placeCode(index: number, stopCount: number): string {
  if (index === 0) return 'PICKUP';
  if (index === stopCount + 1) return 'DESTINATION';
  return `STOP_${index}`;
}

function placeName(index: number, stopCount: number): string {
  if (index === 0) return 'your pickup';
  if (index === stopCount + 1) return 'your destination';
  return `stop ${index}`;
}

function stopTooClose(from: number, to: number, stopCount: number, meters: number): AppError {
  // Name the stop to fix: the later point of the leg, unless that is the
  // destination, in which case the last stop.
  const stopSequence = to === stopCount + 1 ? from : to;
  const other = stopSequence === to ? from : to;
  return new AppError(400, 'STOP_TOO_CLOSE',
    `Stop ${stopSequence} is too close to ${placeName(other, stopCount)}. Stops need to be at least ${MIN_TAXI_STOP_GAP_METERS} m apart.`,
    {
      stopSequence,
      from: placeCode(from, stopCount),
      to: placeCode(to, stopCount),
      distanceMeters: Math.round(meters),
      minMeters: MIN_TAXI_STOP_GAP_METERS,
    });
}

/**
 * Validate a ride's intermediate stops and number them. Returns [] for a ride
 * without stops, judging nothing new: that ride is exactly today's.
 *
 * Refuses, in this order:
 *  - more stops than the maximum → 400 TOO_MANY_STOPS (counted first, so an
 *    oversized list is never walked);
 *  - a stop, pickup or destination the request schema would refuse → the
 *    ZodError the route's own validation throws (400 VALIDATION_ERROR);
 *  - two consecutive points of the route under 50 m apart, from the pickup to
 *    stop 1 through to the last stop and the destination → 400 STOP_TOO_CLOSE.
 *
 * The status matches the ride request's other refusals of what was asked
 * (INVALID_RIDE_CLASS, TOO_MANY_PASSENGERS): the passenger can fix the request.
 */
export function normalizeTaxiStops(input: {
  pickup: TaxiPoint;
  dropoff: TaxiPoint;
  stops?: readonly TaxiStopInput[] | null;
  /** The configured maximum (TAXI_MAX_STOPS, 0..3; 0 = off). Required, with no
   *  default: a caller that forgot the flag must not be handed the cap. */
  maxStops: number;
}): readonly TaxiStopPlan[] {
  if (input.stops == null) return [];
  if (Array.isArray(input.stops)) {
    if (input.stops.length === 0) return [];
    const limit = stopLimit(input.maxStops);
    if (input.stops.length > limit) throw tooManyStops(limit, input.stops.length);
  }
  const { pickup, dropoff, stops } = itinerarySchema.parse({ pickup: input.pickup, dropoff: input.dropoff, stops: input.stops });

  const plan = stops.map((s, i): TaxiStopPlan => Object.freeze({ sequence: i + 1, lat: s.lat, lng: s.lng, address: s.address }));
  const route: TaxiPoint[] = [pickup, ...plan, dropoff];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!;
    const b = route[i]!;
    const meters = haversineDistance(a.lat, a.lng, b.lat, b.lng) * 1000;
    if (meters < MIN_TAXI_STOP_GAP_METERS) throw stopTooClose(i - 1, i, plan.length, meters);
  }
  return Object.freeze(plan);
}
