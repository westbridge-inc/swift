/**
 * [TAXI-FLOW 22 Oct 2026 · #2022 review follow-up] A waiting ride's search,
 * in the server's words, for GET /rides/active (additive keys; builds 9/11/12
 * ignore them):
 *   - `noDriverFound`: a search for THIS ride has come back empty SINCE the
 *     latest driver took it. An exhaustion from before a driver took the ride
 *     and dropped it says nothing about the new search that is running now
 *     (REVIEW-F S3-1). The boundary is the claim's own append-only
 *     DRIVER_ASSIGNED status record, written in the claim commit
 *     (dispatch.claimOrder): never a best-effort journal update. A ride no
 *     driver ever took counts any empty search, so the card stays steady
 *     through the slow lane's re-sweeps.
 *   - `searchReleaseAt`: when the slow lane releases the ride if still
 *     nobody (placement + TAXI_WAIT_LIMIT_MIN, dispatch's own clock). Left
 *     out for a ride recorded as paid by MMG: the slow lane holds that one
 *     for a person instead of releasing it, so no release time is promised
 *     (REVIEW-F S4-3).
 *
 * The cancel verdict's `readNoMoverFound` (a fee rule: free cancel) is NOT
 * this fact and is unchanged.
 */
import { journalAuthorityWhere } from '../dispatch/dispatch-generation-keys';
import { TAXI_WAIT_LIMIT_MIN } from '../dispatch/dispatch.service';
import { isCapturedMmg } from '../dispatch/rescue';

export interface SearchFactsReader {
  orderStatusLog: { findFirst(args: unknown): Promise<unknown> };
  dispatchSearch: { findFirst(args: unknown): Promise<unknown> };
}

export interface WaitingRide {
  id: string;
  status: string;
  driverId: string | null;
  placedAt: Date;
  paymentMethod: string;
  paymentStatus: string;
}

function waiting(ride: WaitingRide): boolean {
  return ride.status === 'PENDING' && !ride.driverId;
}

/** A search came back empty since the latest driver took this ride. */
export async function readNoDriverFoundSinceAssignment(db: SearchFactsReader, ride: WaitingRide): Promise<boolean> {
  if (!waiting(ride)) return false;
  const lastTaken = await db.orderStatusLog.findFirst({
    where: { orderId: ride.id, status: 'DRIVER_ASSIGNED' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  }) as { createdAt: Date } | null;
  const empty = await db.dispatchSearch.findFirst({
    where: {
      subjectId: ride.id,
      subjectType: 'ORDER',
      status: 'EXHAUSTED',
      ...journalAuthorityWhere('DRIVER', 0),
      ...(lastTaken ? { startedAt: { gt: lastTaken.createdAt } } : {}),
    },
    select: { id: true },
  });
  return empty != null;
}

/** The additive keys; nothing for a ride that is not waiting for a driver. */
export function rideSearchFacts(
  ride: WaitingRide,
  noDriverFound: boolean,
): { noDriverFound?: boolean; searchReleaseAt?: string } {
  if (!waiting(ride)) return {};
  if (isCapturedMmg(ride)) return { noDriverFound };
  return {
    noDriverFound,
    searchReleaseAt: new Date(ride.placedAt.getTime() + TAXI_WAIT_LIMIT_MIN * 60_000).toISOString(),
  };
}
