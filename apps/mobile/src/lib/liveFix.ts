/**
 * [MOB-024] A LIVE COURIER FIX BELONGS TO ONE ORDER.
 *
 * The delivery screen accepted `rider:location` and moved the courier marker
 * and the ETA without checking which order the event was for. The handler for
 * `driver:location` three lines below it DID check — one law, written twice,
 * and the copy that mattered was the one that forgot.
 *
 * An event from another room — a retained subscription, a reconnect that
 * rejoined an old room, a customer with two orders open — moved the courier on
 * the wrong customer's screen. That is a privacy failure (someone else's
 * courier position), a safety one (the map says a rider is somewhere they are
 * not), and a trust one (an ETA that belongs to another delivery).
 *
 * This is that law, once, for both events: the fix must NAME this order, carry
 * a usable coordinate and timestamp, and not be older than the last fix
 * already shown. Everything else is dropped, by a named reason.
 */

export interface MapCoordinate { readonly latitude: number; readonly longitude: number }

export type FixDropReason =
  /** the event named a different order, or named none at all */
  | 'foreign_order'
  /** live tracking is not permitted for this order right now */
  | 'not_permitted'
  /** latitude/longitude missing or off the globe */
  | 'bad_coordinate'
  /** no parsable server timestamp */
  | 'bad_timestamp'
  /** older than a fix already accepted — out-of-order delivery */
  | 'stale';

export type FixDecision =
  | { readonly accepted: true; readonly coordinate: MapCoordinate; readonly fixedAt: number; readonly etaMinutes: number | null }
  | { readonly accepted: false; readonly reason: FixDropReason };

/** The raw event, with each transport's field names already mapped. */
export interface LiveFixEvent {
  readonly orderId: unknown;
  readonly latitude: unknown;
  readonly longitude: unknown;
  readonly timestamp: unknown;
  readonly etaMinutes: unknown;
}

export interface LiveFixContext {
  /** The order this screen is showing. */
  readonly orderId: string;
  /** The newest server timestamp already accepted, or null. */
  readonly lastFixAt: number | null;
  /** Whether the screen may show a live position at all. */
  readonly allowed: boolean;
}

export function coordinateOf(latitudeRaw: unknown, longitudeRaw: unknown): MapCoordinate | null {
  if (latitudeRaw == null || longitudeRaw == null) return null;
  const latitude = Number(latitudeRaw);
  const longitude = Number(longitudeRaw);
  if (
    !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90
    || Math.abs(longitude) > 180
  ) return null;
  return { latitude, longitude };
}

/**
 * One decision for every live position event.
 *
 * The identity check comes FIRST and is strict: an event with no `orderId` is
 * as foreign as one naming another order. The server names the order on every
 * emit — it is emitting into that order's room, so it knows — and an
 * unidentified event is exactly the shape this defect was.
 */
export function decideLiveFix(event: LiveFixEvent, ctx: LiveFixContext): FixDecision {
  if (typeof event.orderId !== 'string' || event.orderId !== ctx.orderId) {
    return { accepted: false, reason: 'foreign_order' };
  }
  if (!ctx.allowed) return { accepted: false, reason: 'not_permitted' };
  const coordinate = coordinateOf(event.latitude, event.longitude);
  if (!coordinate) return { accepted: false, reason: 'bad_coordinate' };
  const fixedAt = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Number.NaN;
  if (!Number.isFinite(fixedAt)) return { accepted: false, reason: 'bad_timestamp' };
  if (ctx.lastFixAt != null && fixedAt < ctx.lastFixAt) return { accepted: false, reason: 'stale' };
  const eta = event.etaMinutes == null ? null : Number(event.etaMinutes);
  return {
    accepted: true,
    coordinate,
    fixedAt,
    etaMinutes: eta != null && Number.isFinite(eta) && eta >= 0 ? eta : null,
  };
}

/**
 * Why fixes were dropped, since the app started.
 *
 * The clause asks for a `live_event_drop_reason` metric. This app has no
 * metrics pipeline, so the honest version is a counter the screen can surface
 * and a test can read — a number that is supposed to stay at zero for
 * `foreign_order`, because anything else means rooms are leaking.
 */
export const liveFixDrops: Record<FixDropReason, number> = {
  foreign_order: 0,
  not_permitted: 0,
  bad_coordinate: 0,
  bad_timestamp: 0,
  stale: 0,
};

export function recordFixDrop(reason: FixDropReason): void {
  liveFixDrops[reason] += 1;
}

export function resetFixDrops(): void {
  for (const key of Object.keys(liveFixDrops) as FixDropReason[]) liveFixDrops[key] = 0;
}
