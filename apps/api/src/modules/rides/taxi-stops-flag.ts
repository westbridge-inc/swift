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
  if (maxStops === 0) {
    throw new AppError(409, 'MULTI_STOP_UNAVAILABLE', 'Stops are not available yet. Remove the stops to book this ride.',
      { maxStops: 0, stopCount: input.stops.length });
  }
  const plan = normalizeTaxiStops({ pickup: input.pickup, dropoff: input.dropoff, stops: input.stops as readonly TaxiStopInput[], maxStops });
  assertTaxiRouteInMarket({ pickup: input.pickup, stops: plan, dropoff: input.dropoff });
  return plan;
}
