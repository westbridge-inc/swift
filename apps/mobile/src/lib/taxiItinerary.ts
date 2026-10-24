import { money } from './money';

// ---------------------------------------------------------------------------
// [TAXI multi-stop · parts 6–7] The phone's half of a taxi ride's itinerary:
//
//   pickup → stop 1 → … → stop n → final destination   (n = 0..3)
//
// held to the API contract the server lanes publish (CONTRACT.md Rev 2). A
// "stop" is an INTERMEDIATE stop only: the pickup and the final destination
// stay where they always were, so a ride without stops is exactly today's.
//
// Pure on purpose — no React, no network, no clock — so every rule here is
// proved on its own: the flag the app reads, the list the passenger edits, the
// wire shape it sends, the reads it renders, and the words it uses.
// ---------------------------------------------------------------------------

/** The database cap (taxi_trip_stops sequence 1..3). The server's flag can
 *  lower it, never raise it. */
export const TAXI_STOP_CAP = 3;

/** What the driver app declares at go-online so a part-4 server offers it
 *  rides with stops (CONTRACT §6.4). */
export const TAXI_STOPS_CAPABILITY = 'TAXI_STOPS_V1';

/** The address bounds the server checks after trimming (CONTRACT §2). */
const ADDRESS_MIN = 3;
const ADDRESS_MAX = 200;

/** A place the passenger picked (search, saved address or a pin on the map). */
export type StopPlace = { lat: number; lng: number; label: string; placeId?: string };
/** One stop as /rides/estimate and /rides/request take it: no sequence — the
 *  server numbers the stops in the order they arrive. */
export type WireStop = { lat: number; lng: number; address: string };

// ─── The flag ────────────────────────────────────────────────────────────────

/**
 * How many stops this server takes, from `GET /rides/capabilities` (§1).
 * Anything but a whole number from 1 up is OFF: a server without the read (an
 * older API answers 404, so there is no data), a 0, or junk all give 0, and
 * with 0 the booking screen is exactly today's. Above the cap is held to it.
 */
export function maxStopsFrom(data: unknown): number {
  const raw = (data as { maxStops?: unknown } | null | undefined)?.maxStops;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return 0;
  return Math.min(TAXI_STOP_CAP, raw);
}

// ─── The passenger's list ────────────────────────────────────────────────────

export function canAddStop(stops: readonly unknown[], maxStops: number): boolean {
  return maxStops > 0 && stops.length < maxStops;
}

/** Adds a stop after the others (before the final destination). Beyond the
 *  max the SAME list comes back: the extra stop is refused, never sent. */
export function addStop<T>(stops: readonly T[], stop: T, maxStops: number): readonly T[] {
  return canAddStop(stops, maxStops) ? [...stops, stop] : stops;
}

export function replaceStop<T>(stops: readonly T[], index: number, stop: T): readonly T[] {
  if (index < 0 || index >= stops.length) return stops;
  return stops.map((s, i) => (i === index ? stop : s));
}

export function removeStop<T>(stops: readonly T[], index: number): readonly T[] {
  if (index < 0 || index >= stops.length) return stops;
  return stops.filter((_s, i) => i !== index);
}

/** Moves a stop one place up (-1) or down (+1). The ends stay put. */
export function moveStop<T>(stops: readonly T[], index: number, by: -1 | 1): readonly T[] {
  const to = index + by;
  if (index < 0 || index >= stops.length || to < 0 || to >= stops.length) return stops;
  const next = [...stops];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** The address a stop is sent with, inside the server's 3..200 bounds. A
 *  label too short to say anything (a blank pin) is named by its place in the
 *  list; the point itself is what the driver drives to. */
export function stopAddress(label: string | null | undefined, sequence: number): string {
  const text = (label ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < ADDRESS_MIN) return `Stop ${sequence}`;
  return text.length > ADDRESS_MAX ? text.slice(0, ADDRESS_MAX).trim() : text;
}

/** The stops as the wire takes them, in the passenger's order. */
export function wireStops(stops: readonly StopPlace[]): WireStop[] {
  return stops.map((s, i) => ({ lat: s.lat, lng: s.lng, address: stopAddress(s.label, i + 1) }));
}

/** Two stop lists are the same itinerary: the same places, in the same order. */
export function sameWireStops(a: readonly WireStop[] | null | undefined, b: readonly WireStop[]): boolean {
  const left = a ?? [];
  return left.length === b.length
    && left.every((s, i) => s.lat === b[i]!.lat && s.lng === b[i]!.lng && s.address === b[i]!.address);
}

// ─── The reads (rider §5, driver §6) ─────────────────────────────────────────

export type RideStopStatus = 'PENDING' | 'ARRIVED' | 'DEPARTED' | 'SKIPPED';

/** One stop as the server reports it. The board and offer send the first four
 *  fields; the ride reads add the rest. */
export interface RideStop {
  sequence: number;
  address: string;
  lat: number | null;
  lng: number | null;
  status?: string;
  skipReason?: string | null;
  waitMinutes?: number | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A ride's (or a board item's) intermediate stops, sorted by sequence; [] for
 *  a ride without stops — an absent key means no stops (§5). */
export function rideStops(ride: unknown): RideStop[] {
  const raw = (ride as { stops?: unknown } | null | undefined)?.stops;
  if (!Array.isArray(raw)) return [];
  const out: RideStop[] = [];
  for (const entry of raw) {
    const s = entry as Record<string, unknown> | null;
    if (!s || typeof s !== 'object') continue;
    const sequence = s['sequence'];
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 1) continue;
    const address = typeof s['address'] === 'string' && s['address'].trim() ? s['address'].trim() : `Stop ${sequence}`;
    const lat = finite(s['lat']) && Math.abs(s['lat']) <= 90 ? s['lat'] : null;
    const lng = finite(s['lng']) && Math.abs(s['lng']) <= 180 ? s['lng'] : null;
    out.push({
      sequence,
      address,
      lat: lat != null && lng != null ? lat : null,
      lng: lat != null && lng != null ? lng : null,
      ...(typeof s['status'] === 'string' ? { status: s['status'] } : {}),
      ...(typeof s['skipReason'] === 'string' && s['skipReason'].trim() ? { skipReason: s['skipReason'].trim() } : {}),
      ...(finite(s['waitMinutes']) ? { waitMinutes: s['waitMinutes'] } : {}),
    });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

/** The board's and the live offer's stops (§6.1, §6.2) — the same shape. */
export const boardStops = rideStops;

/** The server's next stop (§5): the first one still PENDING or ARRIVED, or
 *  null when every stop is done and the final destination is next. */
export function nextStopSequence(ride: unknown): number | null {
  const n = (ride as { nextStopSequence?: unknown } | null | undefined)?.nextStopSequence;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null;
}

const inProgress = (ride: unknown) => String((ride as { status?: unknown } | null | undefined)?.status ?? '').toUpperCase() === 'RIDE_IN_PROGRESS';

/** A ride with stops that still has one open: the part-3 guard refuses
 *  "Fare collected" until there is none (§6.4). */
export function hasOpenStop(ride: unknown): boolean {
  return rideStops(ride).length > 0 && nextStopSequence(ride) != null;
}

export type StopPhase = 'upcoming' | 'next' | 'arrived' | 'done' | 'skipped';

/** Where a stop is in the trip. "Next" only once the passenger is aboard —
 *  before the pickup, the pickup is next. */
export function stopPhase(stop: RideStop, ride: unknown): StopPhase {
  const status = String(stop.status ?? '').toUpperCase();
  if (status === 'DEPARTED') return 'done';
  if (status === 'SKIPPED') return 'skipped';
  if (status === 'ARRIVED') return 'arrived';
  return inProgress(ride) && stop.sequence === nextStopSequence(ride) ? 'next' : 'upcoming';
}

// ─── The driver's stop step (part 4) ─────────────────────────────────────────

/**
 * Whether this server takes the driver's stop actions. The contract gives the
 * app no explicit flag; `stopWait` (an object or null) is part 4's own field on
 * `GET /driver/rides/active`, so its KEY is the signal. Without it the stops are
 * shown read-only.
 */
export function stopActionsSupported(ride: unknown): boolean {
  return !!ride && typeof ride === 'object' && 'stopWait' in (ride as object);
}

export type DriverStopStep = { action: 'arrived' | 'depart'; sequence: number; label: string };

/** The ONE next stop step while the passenger is aboard: arrive at the next
 *  stop, then finish it. None before the trip starts or once every stop is
 *  done (then "Fare collected" is the step, as today). */
export function driverStopStep(ride: unknown): DriverStopStep | null {
  if (!inProgress(ride)) return null;
  const sequence = nextStopSequence(ride);
  if (sequence == null) return null;
  const stop = rideStops(ride).find((s) => s.sequence === sequence);
  if (!stop) return null;
  return String(stop.status ?? '').toUpperCase() === 'ARRIVED'
    ? { action: 'depart', sequence, label: `Done at stop ${sequence}` }
    : { action: 'arrived', sequence, label: `Arrived at stop ${sequence}` };
}

// ─── Navigation ──────────────────────────────────────────────────────────────

/** The phone's own maps, turn-by-turn to one point: Apple Maps on iOS, Google
 *  Maps on Android. `web` is the fallback when the app link cannot open. */
export function stopNavigationUrls(point: { lat: number; lng: number }, os: string): { app: string; web: string } {
  const q = `${point.lat},${point.lng}`;
  return os === 'ios'
    ? { app: `maps://?daddr=${q}`, web: `https://maps.apple.com/?daddr=${q}` }
    : { app: `google.navigation:q=${q}`, web: `https://www.google.com/maps/dir/?api=1&destination=${q}` };
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** The contract's place codes (PICKUP, STOP_n, DESTINATION) in plain words. */
export function placeName(code: unknown): string {
  if (code === 'PICKUP') return 'your pickup';
  if (code === 'DESTINATION') return 'your destination';
  const m = /^STOP_(\d+)$/.exec(String(code ?? ''));
  return m ? `stop ${m[1]}` : 'a place on your route';
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const legEnd = (code: unknown) => (code === 'PICKUP' ? 'pickup' : code === 'DESTINATION' ? 'destination' : placeName(code));

/** One leg of the estimate's route (§2): "Pickup to stop 1 · 2.5 km". */
export function legLine(leg: unknown): string | null {
  const l = leg as { from?: unknown; to?: unknown; meters?: unknown; seconds?: unknown } | null;
  if (!l || !finite(l.meters) || l.from == null || l.to == null) return null;
  const km = (l.meters / 1000).toFixed(1);
  const mins = finite(l.seconds) && l.seconds > 0 ? ` · about ${Math.max(1, Math.round(l.seconds / 60))} min` : '';
  return `${sentence(legEnd(l.from))} to ${legEnd(l.to)} · ${km} km${mins}`;
}

/**
 * The passenger-facing words for a refusal about stops (§3.1, §4). Other codes
 * (NO_DRIVERS_NEARBY, the identity doors…) keep the server's own message, as
 * they always have: this returns null for them.
 */
export function stopRefusalCopy(code: string | undefined, details: unknown): string | null {
  const d = (details ?? {}) as Record<string, unknown>;
  switch (code) {
    case 'MULTI_STOP_UNAVAILABLE':
      return 'Stops aren’t available right now. Remove your stops to book this ride.';
    case 'TOO_MANY_STOPS': {
      const max = typeof d['maxStops'] === 'number' ? d['maxStops'] : null;
      if (max == null || max <= 0) return 'Stops aren’t available right now. Remove your stops to book this ride.';
      return max === 1 ? 'You can add 1 stop. Remove a stop to continue.' : `You can add up to ${max} stops. Remove a stop to continue.`;
    }
    case 'STOP_TOO_CLOSE':
      return `${sentence(placeName(d['from']))} and ${placeName(d['to'])} are too close together. Move or remove that stop.`;
    case 'STOP_OUT_OF_MARKET':
      return `${sentence(placeName(d['place']))} is outside the area Swift serves.`;
    case 'MULTI_STOP_ZONE_PRICED':
      return 'This route has a fixed price, so it can’t take stops. Remove your stops to book it.';
    case 'ROUTE_UNAVAILABLE':
      return 'We can’t plan a route with these stops right now. Try again in a minute, or remove your stops.';
    case 'FARE_CHANGED':
      return typeof d['fare'] === 'number'
        ? `The fare for this trip is now ${money(d['fare'])}. Check it, then tap Request again.`
        : 'The fare for this trip has changed. Check it, then tap Request again.';
    case 'EXPECTED_FARE_REQUIRED':
      return 'We couldn’t confirm the fare for this trip. Wait for it to load, then tap Request again.';
    case 'MULTI_STOP_QUEUE_UNSUPPORTED':
      return 'The queue can’t hold stops. Remove your stops to join it.';
    default:
      return null;
  }
}
