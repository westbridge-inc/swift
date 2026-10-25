import { AppError } from '../../utils/errors';
import {
  MAX_TAXI_INTERMEDIATE_STOPS,
  assertTaxiRouteInMarket,
  normalizeTaxiStops,
  type TaxiPoint,
  type TaxiStopInput,
  type TaxiStopPlan,
} from './taxi-itinerary';

// ---------------------------------------------------------------------------
// [TAXI multi-stop] The switch: TAXI_MAX_STOPS, 0..3, default 0 (off). This is
// the one place the setting is read; the itinerary rules take the number it
// answers. At 0 a ride carrying stops is refused (409 MULTI_STOP_UNAVAILABLE)
// and a ride without them is exactly the ride of today.
// ---------------------------------------------------------------------------

/** The configured maximum number of intermediate stops. Unset, blank or
 *  anything but a whole number is off (0), never on; a number above the
 *  database cap is held to the cap. */
export function taxiMaxStops(env: Record<string, string | undefined> = process.env): number {
  const raw = env['TAXI_MAX_STOPS']?.trim() ?? '';
  if (!/^\d+$/.test(raw)) return 0;
  return Math.min(MAX_TAXI_INTERMEDIATE_STOPS, Number(raw));
}

/** The refusal of any stop while the switch is off: one answer everywhere. */
function multiStopUnavailable(stopCount: number): AppError {
  return new AppError(409, 'MULTI_STOP_UNAVAILABLE', 'Stops are not available yet. Remove the stops to book this ride.',
    { maxStops: 0, stopCount });
}

/** The stops a request asked for, validated and numbered by the server, or []
 *  for a ride without stops (absent, null or an empty list), which judges
 *  nothing new. Stops while the switch is off are refused before they are
 *  looked at; otherwise the itinerary rules judge them (400 TOO_MANY_STOPS,
 *  400 STOP_TOO_CLOSE, or the request schema bounds), and then every point of
 *  the route must lie where Swift works (400 STOP_OUT_OF_MARKET). */
export function planTaxiStops(
  input: { pickup: TaxiPoint; dropoff: TaxiPoint; stops?: readonly unknown[] | null },
  env: Record<string, string | undefined> = process.env,
): readonly TaxiStopPlan[] {
  if (input.stops == null || input.stops.length === 0) return [];
  const maxStops = taxiMaxStops(env);
  if (maxStops === 0) throw multiStopUnavailable(input.stops.length);
  const plan = normalizeTaxiStops({ pickup: input.pickup, dropoff: input.dropoff, stops: input.stops as readonly TaxiStopInput[], maxStops });
  assertTaxiRouteInMarket({ pickup: input.pickup, stops: plan, dropoff: input.dropoff });
  return plan;
}

/** [TAXI multi-stop 3/8] The ride queue never holds a trip with stops in v1
 *  (the plan's ruling): its entry has no place for them, so a queued trip
 *  with stops would be auto-requested later as the pickup → destination leg,
 *  at that leg's price. Refused before anything is written: while the switch
 *  is off with the same answer the request gives, and while it is on with 409
 *  MULTI_STOP_QUEUE_UNSUPPORTED. A trip without stops joins as it always has. */
export function refuseQueuedStops(
  stops: readonly unknown[] | null | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  if (stops == null || stops.length === 0) return;
  if (taxiMaxStops(env) === 0) throw multiStopUnavailable(stops.length);
  throw new AppError(409, 'MULTI_STOP_QUEUE_UNSUPPORTED',
    'The ride queue cannot hold a trip with stops yet. Remove the stops to join the queue, or request the ride with its stops when a driver is free.',
    { stopCount: stops.length });
}

/** [TAXI multi-stop 3/8] A ride with stops is booked at the route fare the
 *  passenger was shown for exactly that itinerary and tier: the request must
 *  say which (expectedFare), so a fare the passenger never saw is never
 *  charged. Judged with the itinerary, before anything is read, priced or
 *  claimed; the server's own fare is compared with it later (409
 *  FARE_CHANGED). A ride without stops is not asked: it books as today. */
export function assertQuotedFare(stopCount: number, expectedFare: number | undefined): void {
  if (stopCount > 0 && expectedFare === undefined) {
    throw new AppError(400, 'EXPECTED_FARE_REQUIRED',
      'Check the fare for this trip and its stops, then book again.',
      { stopCount });
  }
}
