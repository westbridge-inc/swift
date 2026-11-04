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

/** [BUG-HUNT-2 G03] What the driver's screen says after the sheet. "Passenger did not arrive" closes the ride, so the server
 *  answers CANCELLED; any other reason hands it back. The answer decides, never the reason tapped. */
export function driverHandbackDoneWords(answer: unknown): { title: string; body: string } {
  return (answer as { status?: unknown } | null | undefined)?.status === 'CANCELLED'
    ? { title: 'Ride closed', body: 'Recorded: the passenger did not come. This does not count against you.' }
    : { title: 'Ride handed back', body: 'The passenger is being matched with another driver.' };
}
