import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { nextStopSequence, type TaxiStopRow } from './taxi-stops-read';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 4/8] The rules of a ride's stops that more than one seam
// asks (CONTRACT.md §6.1, §6.3, §6.4): which driver apps may take a ride with
// stops, the grace at a stop, and when a trip with a stop still open may end
// without its fare. Pure rules plus one read, with no service imports, so
// dispatch, the fare outcome (cash-rules) and the driver's active ride
// (stopWait) can all ask here: the clock the app shows is the clock the
// server holds the driver to.
// ---------------------------------------------------------------------------

/** The capability a driver app declares at go-online when it can run a ride's
 *  stops (CONTRACT §6.4). Without it the app is never offered, shown or given
 *  a ride with stops. */
export const TAXI_STOPS_CAPABILITY = 'TAXI_STOPS_V1';

/** Whether a go-online body's declared capabilities include the stops. */
export function declaresTaxiStops(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(TAXI_STOPS_CAPABILITY);
}

/** The refusal of a ride with stops to a driver app that cannot run them. */
export function taxiStopsAppUpdateRequired(): AppError {
  return new AppError(409, 'APP_UPDATE_REQUIRED',
    'This ride has stops. Update the Swift app, then go online again to take rides with stops.');
}

/** How long the car waits at an arrived stop before the driver may end the
 *  trip because the passenger did not come back (the no-show rail). On the
 *  server clock, from the stop's arrival. */
export const TAXI_STOP_NO_SHOW_GRACE_MINUTES = 10;
const GRACE_MS = TAXI_STOP_NO_SHOW_GRACE_MINUTES * 60_000;

/** The wait at the stop the ride is at: the driver's grace clock. */
export interface TaxiStopWait {
  sequence: number;
  arrivedAt: Date;
  noShowAvailableAt: Date;
}

/**
 * §6.3 `stopWait`: the car is at the next open stop (ARRIVED) and the grace
 * runs from its arrival; null while the ride is heading for a stop, or once
 * every stop is done.
 */
export function stopWaitOf(rows: readonly Pick<TaxiStopRow, 'sequence' | 'status' | 'arrivedAt'>[]): TaxiStopWait | null {
  const next = nextStopSequence(rows);
  const stop = next == null ? null : rows.find((s) => s.sequence === next);
  if (!stop || stop.status !== 'ARRIVED' || !stop.arrivedAt) return null;
  return { sequence: stop.sequence, arrivedAt: stop.arrivedAt, noShowAvailableAt: new Date(stop.arrivedAt.getTime() + GRACE_MS) };
}

/**
 * Whether the trip may end without the fare (the passenger did not come back,
 * or refused to pay) while it still has a stop to finish. A ride with no open
 * stop is always answered yes: the car is heading for the final destination,
 * exactly today's rule. With an open stop:
 *
 *  - a refusal is a passenger aboard who will not pay: that is said at the
 *    destination, after the stops (409 STOPS_REMAINING, like "Fare collected");
 *  - a no-show needs the car waiting AT the next stop (ARRIVED) for the whole
 *    grace (else 409 STOP_WAIT_NOT_ELAPSED with when to try again); while that
 *    stop is not reached yet, it is finished first (409 STOPS_REMAINING).
 */
export function assertTripMayEndUnpaid(
  rows: readonly Pick<TaxiStopRow, 'sequence' | 'status' | 'arrivedAt'>[],
  outcome: 'no_show' | 'refused',
  now: Date,
): void {
  const next = nextStopSequence(rows);
  if (next == null) return;
  const wait = stopWaitOf(rows);
  if (outcome === 'no_show' && wait) {
    if (now.getTime() >= wait.noShowAvailableAt.getTime()) return;
    throw new AppError(409, 'STOP_WAIT_NOT_ELAPSED',
      `The passenger still has time to come back to the car. If they don’t, you can end the trip from ${wait.noShowAvailableAt.toISOString()}.`,
      { sequence: wait.sequence, retryAt: wait.noShowAvailableAt.toISOString() });
  }
  throw new AppError(409, 'STOPS_REMAINING',
    'This ride still has a stop to finish. Arrive at it and continue, or skip it, before you end the trip.',
    { nextStopSequence: next });
}

/** The same rule, read from the ride's stop rows inside the caller's
 *  transaction (which holds the order row, so no stop moves meanwhile). A ride
 *  without stops reads nothing more than one empty list. */
export async function assertTripMayEndUnpaidOn(
  tx: Pick<Prisma.TransactionClient, 'taxiTripStop'>,
  orderId: string,
  outcome: 'no_show' | 'refused',
  now: Date = new Date(),
): Promise<void> {
  const rows = await tx.taxiTripStop.findMany({
    where: { orderId },
    select: { sequence: true, status: true, arrivedAt: true },
    orderBy: { sequence: 'asc' },
  });
  if (rows.length === 0) return;
  assertTripMayEndUnpaid(rows, outcome, now);
}
