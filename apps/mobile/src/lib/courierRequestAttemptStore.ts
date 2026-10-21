import { zustandStorage } from './storage';
import { createRideRequestAttempt } from './rideRequestAttempt';

// [UI-SWEEP U01] One parcel intent = one Idempotency-Key, kept across retries
// of that same parcel (a timeout, a lost answer, an app restart, a second tap)
// and retired only by that parcel's own definitive answer. It is the taxi
// booking's attempt store (lib/rideRequestAttempt) on a slot of its own: the
// courier route already replays the parcel it made for a key it has seen
// (apps/api courier.routes.ts, CheckoutReceipt), so a retried send can never
// book a second parcel.

export const COURIER_REQUEST_ATTEMPT_STORAGE_KEY = 'swift.courier.requestAttempt.v1';

/** `parcel_<base36 ms>_<10 base36 chars>` — inside the server's key rule ([A-Za-z0-9._~-]{1,200}). */
export function mintCourierRequestKey(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = random().toString(36).slice(2, 12).padEnd(10, '0');
  return `parcel_${now.toString(36)}_${tail}`;
}

export const courierRequestAttempt = createRideRequestAttempt({
  get: () => {
    const v = zustandStorage.getItem(COURIER_REQUEST_ATTEMPT_STORAGE_KEY);
    return typeof v === 'string' ? v : null;
  },
  set: (value) => {
    void zustandStorage.setItem(COURIER_REQUEST_ATTEMPT_STORAGE_KEY, value);
  },
  clear: () => {
    void zustandStorage.removeItem(COURIER_REQUEST_ATTEMPT_STORAGE_KEY);
  },
}, () => mintCourierRequestKey());
