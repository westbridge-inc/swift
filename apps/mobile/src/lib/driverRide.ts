/**
 * Whether the driver may offer the ride-handback control.
 *
 * The server remains authoritative and re-checks this under the order lock.
 * This client predicate only keeps an impossible action off the screen. Both
 * persisted verification fields count independently so a partially-written
 * legacy row fails safe: once the passenger may be aboard, handback disappears.
 */

const DRIVER_PRE_CUSTODY_STATUSES = new Set([
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
]);

export function canDriverHandbackRide(ride: {
  status?: string | null;
  ridePinVerified?: boolean | null;
  ridePinVerifiedAt?: unknown;
} | null | undefined): boolean {
  if (!ride) return false;
  if (!DRIVER_PRE_CUSTODY_STATUSES.has(String(ride.status ?? '').toUpperCase())) return false;
  return ride.ridePinVerified !== true && ride.ridePinVerifiedAt == null;
}

/** [BUG-HUNT-2 G05] Why a driver step did not go through: the server's words, or, with no answer at all, what to try. */
export function driverStepFailedWords(error: unknown): string {
  const message = (error as { response?: { data?: { error?: { message?: unknown } } } } | null | undefined)?.response?.data?.error?.message;
  return typeof message === 'string' && message.trim() !== '' ? message : 'That didn’t go through. Check your connection and try again.';
}
