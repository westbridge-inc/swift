import { randomInt } from 'node:crypto';

// The ONE definition of a taxi ride PIN and its reset — a zero-dependency
// module so both dispatch.service and driver.routes can share it without an
// import cycle through rides.service.

/** A CSPRNG 6-digit ride PIN. */
export function newRidePin(): string {
  return String(randomInt(100000, 1000000));
}

/** [REPORT-014 F-014-12] The atomic PIN reset applied whenever a taxi ride is
 *  released back to PENDING pre-custody (driver cancel or the GPS-dark
 *  watchdog): a FRESH PIN + zeroed attempt budget together. The next driver
 *  gets an untouched 5-attempt window, and because the PIN is NEW a prior
 *  driver who burned all attempts cannot brute-force it. Resetting only the
 *  counter (keeping the PIN) would enable distributed brute force. */
export function freshRidePinReset(): {
  ridePin: string;
  ridePinAttempts: number;
  ridePinVerified: boolean;
  ridePinVerifiedAt: null;
} {
  return { ridePin: newRidePin(), ridePinAttempts: 0, ridePinVerified: false, ridePinVerifiedAt: null };
}
