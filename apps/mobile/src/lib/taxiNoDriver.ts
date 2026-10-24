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
 *   - `searchReleaseAt`: when the server will release the ride if still nobody
 *     (absent for a ride the server holds for a person instead).
 * The phone never invents either from its own clock.
 */
import { GUYANA_TZ } from '@swift/types';

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

/** Market time, whatever zone the phone is set to (REVIEW-F S4-1): the same
 *  rule as every human-facing instant (appointmentTime.ts). */
function guyanaClock(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: GUYANA_TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

/** The release time as words. A phone that cannot format the market zone
 *  says which zone it fell back to, never a bare unlabelled clock. */
export function releaseClockText(d: Date, format: (d: Date) => string = guyanaClock): string {
  try {
    return format(d);
  } catch {
    return `${d.toISOString().slice(11, 16)} UTC`;
  }
}

export interface NoDriverContext {
  /** A driver took this ride and dropped it; the app is finding another. */
  rematching?: boolean;
}

export function noDriverView(
  ride: NoDriverFacts | null | undefined,
  socketExhausted: boolean,
  nowMs: number,
  ctx: NoDriverContext = {},
): NoDriverView | null {
  if (!ride || ride.driver) return null;
  if (ride.status && ride.status !== 'PENDING') return null;
  // REVIEW-F S3-1: a live "exhausted" event from BEFORE a driver took the ride
  // says nothing about the search for a new driver. The server's fact counts
  // only empty searches since the latest driver took it, so it still decides.
  const liveEvent = socketExhausted && !ctx.rematching;
  if (!liveEvent && ride.noDriverFound !== true) return null;

  const releaseAt = typeof ride.searchReleaseAt === 'string' ? new Date(ride.searchReleaseAt) : null;
  const releaseKnown = releaseAt != null && !Number.isNaN(releaseAt.getTime()) && releaseAt.getTime() > nowMs;
  return {
    // True both before any driver took it and after one dropped it.
    title: 'No driver is free right now',
    body: releaseKnown
      ? `We ask every driver who comes online, every minute. If none takes it by ${releaseClockText(releaseAt)}, the request ends on its own. You can keep waiting or cancel.`
      : 'We ask every driver who comes online, every minute. You can keep waiting or cancel.',
  };
}
