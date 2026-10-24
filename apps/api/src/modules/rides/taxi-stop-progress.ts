import type { Prisma, PrismaClient, TaxiStopStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { haversineDistance } from '../../utils/distance';
import { gpsEvidence } from '../cash/cash-rules.service';
import { arrivalGate } from '../dispatch/arrival-evidence';
import { isTaxiStopOpen, isTaxiStopTransition, TAXI_STOP_PARENT_STATUS } from '../order/order-status';
import { lockTaxiOrderForCustodyDecision } from './passenger-custody';
import { nextStopSequence, TAXI_STOP_PUBLIC_SELECT, type TaxiStopRow } from './taxi-stops-read';
import { stopWaitOf, type TaxiStopWait } from './taxi-stop-rules';

// ---------------------------------------------------------------------------
// [TAXI multi-stop 4/8] How a ride moves through its stops: THE one place a
// stop's status and its clocks are written (CONTRACT.md §6.3, §6.4; the
// grace and the capability are taxi-stop-rules.ts). The driver arrives at the next open stop, then leaves it, or
// skips it with a reason the passenger is told. Every action:
//
//  - locks the ride's order row first (the lock the start, the fare outcome
//    and the completion take), then reads the stops under it, so two taps, or
//    a tap and "Fare collected", can never interleave;
//  - needs the ride in progress, its assigned driver, and the NEXT open stop
//    in the passenger's order (else 409 STOP_OUT_OF_ORDER): stops are never
//    reached out of order, and the itinerary is frozen at request;
//  - takes its time from the server's clock, never the phone's: the waiting
//    charge (taxi-waiting.ts) sums each stop's arrival → departure (or skip)
//    from exactly these timestamps;
//  - is safe to repeat: a tap whose stop is already where it would put it
//    answers the stop as it is and writes nothing.
//
// The arrival is NOTED with where the driver's own location stream put the
// car (the stop row's evidence note, for a person reviewing it), and never
// refused for it: a stop is often a shop behind a wall.
//
// Reads are never switched off (TAXI_MAX_STOPS): a ride booked with stops can
// always be finished after the switch goes back to 0.
// ---------------------------------------------------------------------------

export type TaxiStopAction = 'arrived' | 'depart' | 'skip';

const TARGET: Record<TaxiStopAction, TaxiStopStatus> = { arrived: 'ARRIVED', depart: 'DEPARTED', skip: 'SKIPPED' };

/** A tap whose stop is already where it would put it: answered, never written. */
function alreadyDone(stop: Pick<TaxiStopRow, 'status' | 'arrivedAt'>, action: TaxiStopAction): boolean {
  if (action === 'arrived') return stop.status === 'ARRIVED' || stop.status === 'DEPARTED' || (stop.status === 'SKIPPED' && stop.arrivedAt != null);
  return stop.status === TARGET[action];
}

/** The note an arrival keeps: where the driver's own location stream put the
 *  car, and how old that fix was. Never a reason to refuse. */
export function stopArrivalNote(
  sequence: number,
  fix: { lat: number | null; lng: number | null; at: Date | null },
  stop: { lat: number; lng: number },
  now: Date,
): string {
  const base = `Driver reported arriving at stop ${sequence}`;
  if (fix.lat == null || fix.lng == null || fix.at == null) return `${base} — no location fix on record at the time`;
  const metres = Math.round(haversineDistance(fix.lat, fix.lng, stop.lat, stop.lng) * 1000);
  const ageSeconds = Math.max(0, Math.round((now.getTime() - fix.at.getTime()) / 1000));
  return `${base} — ${gpsEvidence(fix.lat, fix.lng)} ${metres}m away, fix ${ageSeconds}s old`;
}

export interface TaxiStopMoveInput {
  orderId: string;
  driverId: string;
  sequence: number;
  action: TaxiStopAction;
  /** A skip's reason (required for a skip; the passenger is told it). */
  reason?: string;
  actorUserId: string;
  /** The driver's last fix from their location stream (an arrival's note). */
  fix: { lat: number | null; lng: number | null; at: Date | null };
  now?: Date;
}

export interface TaxiStopMoveResult {
  /** False for a repeated tap: nothing was written, nothing is announced. */
  changed: boolean;
  orderId: string;
  customerId: string;
  stop: TaxiStopRow;
  nextStopSequence: number | null;
  stopWait: TaxiStopWait | null;
}

/**
 * Moves one stop of one ride, on the locked order row, in one commit. The
 * checks, in order: the ride is this driver's (404), the stop exists (404
 * STOP_NOT_FOUND), a repeated tap answers as it is, a finished stop is not
 * reopened (409 STOP_ALREADY_RESOLVED), the passenger is aboard (409
 * INVALID_STATUS), the stop is the next open one (409 STOP_OUT_OF_ORDER), and
 * the stop law allows the move (409 STOP_NOT_ARRIVED: a stop is left only
 * after it was reached).
 */
export async function moveTaxiStop(
  prisma: Pick<PrismaClient, '$transaction'>,
  input: TaxiStopMoveInput,
): Promise<TaxiStopMoveResult> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockTaxiOrderForCustodyDecision(tx, input.orderId);
    const order = await tx.order.findFirst({
      where: { id: input.orderId, driverId: input.driverId, orderType: 'TAXI' },
      select: { id: true, status: true, customerId: true },
    });
    if (!order) throw new NotFoundError('Ride', input.orderId);
    const rows = await tx.taxiTripStop.findMany({
      where: { orderId: input.orderId },
      select: { ...TAXI_STOP_PUBLIC_SELECT, id: true },
      orderBy: { sequence: 'asc' },
    });
    const found = rows.find((s) => s.sequence === input.sequence);
    if (!found) throw new AppError(404, 'STOP_NOT_FOUND', `This ride has no stop ${input.sequence}.`, { sequence: input.sequence });
    const { id: stopId, ...stop } = found;
    const answer = (changed: boolean, current: TaxiStopRow, all: readonly TaxiStopRow[]): TaxiStopMoveResult => ({
      changed, orderId: order.id, customerId: order.customerId, stop: current,
      nextStopSequence: nextStopSequence(all), stopWait: stopWaitOf(all),
    });
    const publicRows = rows.map(({ id: _id, ...r }) => r);
    if (alreadyDone(stop, input.action)) return answer(false, stop, publicRows);
    if (!isTaxiStopOpen(stop.status)) {
      throw new AppError(409, 'STOP_ALREADY_RESOLVED', `Stop ${stop.sequence} is already finished.`, { sequence: stop.sequence, status: stop.status });
    }
    if (order.status !== TAXI_STOP_PARENT_STATUS) {
      throw new AppError(409, 'INVALID_STATUS', `Stops are marked only during the trip (ride is ${order.status}).`);
    }
    const next = nextStopSequence(publicRows);
    if (next !== stop.sequence) {
      throw new AppError(409, 'STOP_OUT_OF_ORDER', `Stop ${next} comes first.`, { sequence: stop.sequence, nextStopSequence: next });
    }
    const target = TARGET[input.action];
    if (!isTaxiStopTransition(stop.status, target)) {
      throw new AppError(409, 'STOP_NOT_ARRIVED', `Mark that you have arrived at stop ${stop.sequence} first, or skip it.`, { sequence: stop.sequence });
    }
    // [COORD ruling 19 Oct, option A] The arrival is never refused, but only one
    // the E19 arrival gate accepts (a fresh fix within 300 m of the stop) starts
    // a billable wait: the passenger is never charged for a wait the GPS can't place.
    const verified = input.action === 'arrived' ? arrivalGate(input.fix, { lat: stop.lat, lng: stop.lng }, now).allowed : false;
    const data: Prisma.TaxiTripStopUpdateManyMutationInput = input.action === 'arrived'
      ? {
        status: target, arrivedAt: now, arrivalVerified: verified, actedBy: input.actorUserId,
        evidenceNote: `${stopArrivalNote(stop.sequence, input.fix, stop, now)}${verified ? '' : ' — not verified, so this wait is not charged'}`,
      }
      : input.action === 'depart'
        ? { status: target, departedAt: now, actedBy: input.actorUserId }
        : { status: target, skippedAt: now, skipReason: input.reason ?? null, actedBy: input.actorUserId };
    // Compare-and-set on the status read under the lock: the lock already
    // serialises every writer, and this keeps a stray writer from moving it twice.
    const written = await tx.taxiTripStop.updateMany({ where: { id: stopId, status: stop.status }, data });
    if (written.count !== 1) throw new AppError(409, 'STOP_CHANGED', 'This stop changed meanwhile. Refresh and try again.', { sequence: stop.sequence });
    const moved = await tx.taxiTripStop.findUniqueOrThrow({ where: { id: stopId }, select: TAXI_STOP_PUBLIC_SELECT });
    return answer(true, moved, publicRows.map((r) => (r.sequence === moved.sequence ? moved : r)));
  });
}
