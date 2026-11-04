// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G06] A finished ride, read back. Pure: the amount and the title the screen and the history row use, so the two
// can never disagree. taxiFareTotal is the fare quoted; totalAmount is what was paid, waiting included.
// ---------------------------------------------------------------------------

const FINISHED = new Set(['DELIVERED', 'COMPLETED']);
const OVER = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'FAILED', 'REFUNDED', 'RETURNED']);

/** A ride that will not move again. */
export function rideIsOver(status: unknown): boolean {
  return OVER.has(String(status ?? '').toUpperCase());
}

/** What the passenger paid: the server's total, never the route fare alone. */
export function ridePaidAmount(ride: { totalAmount?: unknown; taxiFareTotal?: unknown } | null | undefined): number | null {
  const raw = ride?.totalAmount ?? ride?.taxiFareTotal;
  const n = Number(raw);
  return raw === null || raw === undefined || !Number.isFinite(n) ? null : n;
}

/** The heading of a ride that is over. */
export function rideOverTitle(status: unknown): string {
  const s = String(status ?? '').toUpperCase();
  if (FINISHED.has(s)) return 'Trip complete';
  if (s === 'CANCELLED') return 'Ride cancelled';
  if (s === 'REFUNDED') return 'Ride refunded';
  return 'Ride closed';
}

/** Only a finished ride with a driver and no rating asks for one. */
export function rideCanBeRated(ride: { status?: unknown; driver?: unknown; hasBeenRated?: unknown } | null | undefined): boolean {
  return !!ride && FINISHED.has(String(ride.status ?? '').toUpperCase()) && !!ride.driver && ride.hasBeenRated !== true;
}
