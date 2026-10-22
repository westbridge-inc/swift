/**
 * [TAXI-FLOW 22 Oct 2026] The honest "no driver yet" state of a waiting ride.
 *
 * The cascade asked every driver it could and nobody took the ride. The server
 * keeps re-asking every minute as drivers come online, and releases the ride on
 * its own after its wait limit ("We couldn't find you a driver … nothing to
 * pay"). Before this, the phone learned it only from a live socket event while
 * the ride screen happened to be open — reopen the app and it was "Finding you
 * a driver" with a spinner, minute after minute, for half an hour.
 *
 * Two server facts decide (both additive on GET /rides/active; an older API
 * sends neither and the live socket event still works exactly as before):
 *   - `noDriverFound`: a search for this ride has already come back empty;
 *   - `searchReleaseAt`: when the server will release the ride if still nobody.
 * The phone never invents either from its own clock.
 */
export interface NoDriverFacts {
  status?: string | null;
  driver?: unknown;
  noDriverFound?: boolean | null;
  searchReleaseAt?: string | null;
}

export interface NoDriverView {
  title: string;
  body: string;
}

function clock(d: Date): string {
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

export function noDriverView(ride: NoDriverFacts | null | undefined, socketExhausted: boolean, nowMs: number): NoDriverView | null {
  if (!ride || ride.driver) return null;
  if (ride.status && ride.status !== 'PENDING') return null;
  if (!socketExhausted && ride.noDriverFound !== true) return null;

  const releaseAt = typeof ride.searchReleaseAt === 'string' ? new Date(ride.searchReleaseAt) : null;
  const releaseKnown = releaseAt != null && !Number.isNaN(releaseAt.getTime()) && releaseAt.getTime() > nowMs;
  return {
    title: 'No driver has taken your ride yet',
    body: releaseKnown
      ? `We ask every driver who comes online, every minute. If none takes it by ${clock(releaseAt)}, the request ends on its own. You can keep waiting or cancel.`
      : 'We ask every driver who comes online, every minute. You can keep waiting or cancel.',
  };
}
