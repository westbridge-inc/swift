import type { Order } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { arrivalEvidence } from '../dispatch/arrival-evidence';
import { NO_SHOW_GRACE_MIN, noShowDecision } from '../order/cancel-policy';
import { haversineDistance } from '../../utils/distance';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G03 · COORD 4 Nov 2026] THE PASSENGER NEVER COMES TO THE CAR.
//
// The driver's only door was the hand-back: the driver was marked down, the passenger was told "your driver had to cancel",
// and the same ride went to the next driver, and the next. Now the reason the driver already taps ("Passenger did not
// arrive", the words every installed build sends) records what happened: past the no-show grace (cancel-policy, the one
// grace) the ride ends through the canonical cancel. A true record, no fare, no waiting charge (a ride that ends without
// the trip carries none, Terms s4), no strike, the driver is not marked down, the passenger is told, nobody else is sent.
// A passenger aboard is never absent: the canonical seam refuses a ride with its code verified.
// ---------------------------------------------------------------------------

/** The reason the driver's screen sends. The words are the wire: installed builds carry them. */
export const PASSENGER_NO_SHOW_TAP = 'Passenger did not arrive';

/** The order's cancellation reason: a sentence, so every build shows it as written. */
export const PASSENGER_NO_SHOW_REASON = 'Passenger did not come: the driver waited at the pickup (recorded by the driver).';

type ArrivedFacts = Pick<Order, 'driverArrivedAt'>;
type Where = Pick<Order, 'pickupLat' | 'pickupLng'>;
type Fix = { lat: number | null; lng: number | null; at: Date | null };

function fixOf(fix: Fix, pickup: Where, now: Date) {
  const placed = fix.lat != null && fix.lng != null && pickup.pickupLat != null && pickup.pickupLng != null;
  return {
    metres: placed ? Math.round(haversineDistance(fix.lat as number, fix.lng as number, pickup.pickupLat as number, pickup.pickupLng as number) * 1000) : null,
    ageMs: fix.at ? now.getTime() - fix.at.getTime() : null,
  };
}

/** Why the driver may not record this now, or null when they may. The one no-show rule: arrived, and the grace is over. */
export function passengerNoShowRefusal(order: ArrivedFacts & Where, fix: Fix, now: Date): AppError | null {
  const decision = noShowDecision({ arrivedAt: order.driverArrivedAt, fix: fixOf(fix, order, now) }, now);
  if (decision.allowed) return null;
  if (decision.reason === 'NOT_ARRIVED') {
    return new AppError(409, 'NO_SHOW_NOT_ARRIVED', 'Tap I\'ve arrived first. You can record that the passenger did not come once you have waited at the pickup.');
  }
  const minutes = Math.max(1, Math.ceil((decision.retryAt.getTime() - now.getTime()) / 60_000));
  return new AppError(409, 'NO_SHOW_TOO_EARLY', `Please wait ${minutes} more minute${minutes === 1 ? '' : 's'}. You can record this after waiting ${NO_SHOW_GRACE_MIN} minutes at the pickup.`, { retryAt: decision.retryAt.toISOString() });
}

/** The status log's line: the record, and where the driver's location put them. For a person reading it later. */
export function passengerNoShowNote(order: Where, fix: Fix, now: Date): string {
  const { note } = arrivalEvidence(fix, { lat: order.pickupLat, lng: order.pickupLng }, now);
  return `${PASSENGER_NO_SHOW_REASON} ${note.replace('Driver reported arriving at the pickup point', 'Location at the time')}.`;
}

/** The passenger's notice. True, and it costs them nothing. */
export function passengerNoShowNotice(orderNumber: string) {
  return {
    title: 'Ride closed',
    body: `Your driver waited at the pickup and you did not come, so ride ${orderNumber} was closed. There is no fee. If that isn't right, open Get Help.`,
  };
}
