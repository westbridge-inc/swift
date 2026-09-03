// ---------------------------------------------------------------------------
// [W-47] WHAT A PUBLIC TRACKING PAGE MAY CLAIM, AND WHAT IT MAY DISCLOSE.
//
// Two public pages — a parcel's `track/[token]` and a ride's `trip/[token]` —
// hand a link to someone outside the app and then poll a position on a timer.
// Both had the same four faults, and all four are the same mistake made in
// different places: the page spoke with more confidence than it had.
//
//  1. THE AGE FROZE. `fetchedAt` was set only on a SUCCESSFUL poll, and the
//     age was derived from it during render. React re-renders on state change,
//     so when polling started failing nothing changed and "Updated 4s ago"
//     stayed on screen for as long as the outage lasted. The one moment the
//     reader needed to distrust the dot is the moment it froze looking fresh.
//
//  2. IT MEASURED THE WRONG THING. Even when polling worked, the age was the
//     age of the CLIENT'S FETCH, not of the courier's position. A server
//     returning a ten-minute-old point rendered "just now".
//
//  3. RESPONSES COULD ARRIVE OUT OF ORDER. A `setInterval` with no sequence
//     guard: a slow response landing after a newer one silently moved the
//     courier backwards.
//
//  4. PRECISE COORDINATES LEFT TO A THIRD PARTY. The exact latitude and
//     longitude went into an OpenStreetMap embed URL and an outbound link, so
//     every map load disclosed a live person's precise position — and the
//     referer disclosed which tracking token was watching.
//
// This module is the shared answer. It is deliberately small and pure so both
// pages use the same rules and a test can drive them with a fake clock.
// ---------------------------------------------------------------------------

/** Past this, a page must stop implying the position is current. */
export const STALE_AFTER_MS = 45_000;
/** Past this, the position is old enough that showing a map is a lie. */
export const VERY_STALE_AFTER_MS = 5 * 60_000;

/** Roughly 110 m at the equator: enough to see a courier's street, not their door. */
export const COARSE_DECIMALS = 3;

export interface Point {
  lat: number;
  lng: number;
}

/**
 * A point, or null. A latitude outside ±90, a longitude outside ±180, a NaN,
 * an Infinity, a string or a missing half are all null — an unvalidated point
 * rendered a map of the middle of the ocean and called it a courier.
 */
export function validPoint(lat: unknown, lng: unknown): Point | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null; // null island is a missing fix, not a place
  return { lat, lng };
}

/** Reduce precision before a point leaves for a third party. */
export function coarsen(point: Point, decimals = COARSE_DECIMALS): Point {
  const factor = 10 ** decimals;
  return {
    lat: Math.round(point.lat * factor) / factor,
    lng: Math.round(point.lng * factor) / factor,
  };
}

/**
 * The map URLs, built from a COARSENED point. The embed keeps a wide-enough
 * box to stay useful at that precision.
 */
export function mapEmbedUrl(point: Point): string {
  const { lat, lng } = coarsen(point);
  const box = 0.008;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - box}%2C${lat - box}%2C${lng + box}%2C${lat + box}&layer=mapnik&marker=${lat}%2C${lng}`;
}

export function mapLinkUrl(point: Point): string {
  const { lat, lng } = coarsen(point);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`;
}

export type Freshness =
  | { kind: 'none' }
  | { kind: 'fresh'; ageSeconds: number; label: string }
  | { kind: 'stale'; ageSeconds: number; label: string }
  | { kind: 'lost'; ageSeconds: number; label: string };

/**
 * How old the POSITION is, and what to say about it.
 *
 * `positionAt` is the server's own timestamp for the point. When the server
 * does not send one the caller passes the time the response arrived, and the
 * page says "received" rather than "updated" — a weaker claim, honestly made.
 *
 * `now` is passed in rather than read here so a test can drive a fake clock,
 * and so a caller can tick it on a timer instead of only on a successful poll.
 */
export function freshness(positionAt: number | null, now: number): Freshness {
  if (positionAt === null) return { kind: 'none' };
  const ageMs = Math.max(0, now - positionAt);
  const ageSeconds = Math.round(ageMs / 1000);
  if (ageMs >= VERY_STALE_AFTER_MS) {
    return { kind: 'lost', ageSeconds, label: `No update for ${Math.floor(ageMs / 60_000)} min — this may not be where they are now` };
  }
  if (ageMs >= STALE_AFTER_MS) {
    return { kind: 'stale', ageSeconds, label: `Not updating — last position ${ageSeconds}s ago` };
  }
  return { kind: 'fresh', ageSeconds, label: ageSeconds < 3 ? 'Updated just now' : `Updated ${ageSeconds}s ago` };
}

/**
 * A monotonic acceptance guard. Each request takes the next number; a response
 * is applied only if no newer request has already been applied, so a slow
 * response cannot move the position backwards.
 */
export interface Sequence {
  /** The number for a request about to go out. */
  next: () => number;
  /** True only if this response is newer than the last one applied. */
  accept: (_seq: number) => boolean;
}

export function createSequence(): Sequence {
  let issued = 0;
  let applied = 0;
  return {
    next: () => (issued += 1),
    accept: (seq: number) => {
      if (seq <= applied) return false;
      applied = seq;
      return true;
    },
  };
}
