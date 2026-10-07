import { zustandStorage } from './storage';
import { createRideRequestAttempt, RIDE_REQUEST_ATTEMPT_STORAGE_KEY } from './rideRequestAttempt';

/** [TAXI multi-stop · part 6] The taxi booking intent, persisted in the
 *  encrypted MMKV behind every persisted store, so an app killed mid-request
 *  retries with the same Idempotency-Key when it comes back. A storage fault
 *  degrades to memory: it must never stop someone booking a ride. */
export const rideRequestAttempt = createRideRequestAttempt({
  get: () => {
    const v = zustandStorage.getItem(RIDE_REQUEST_ATTEMPT_STORAGE_KEY);
    return typeof v === 'string' ? v : null;
  },
  set: (value) => {
    void zustandStorage.setItem(RIDE_REQUEST_ATTEMPT_STORAGE_KEY, value);
  },
  clear: () => {
    void zustandStorage.removeItem(RIDE_REQUEST_ATTEMPT_STORAGE_KEY);
  },
});
