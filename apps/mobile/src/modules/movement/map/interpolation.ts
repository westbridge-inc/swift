/**
 * Driver-marker interpolation math (rides spec 6.3) — the pure core, kept
 * free of Reanimated so every branch is unit-testable. Raw pings arrive every
 * 3–5s; animating between them at the OBSERVED cadence is what turns a
 * teleporting dot into a car driving. The hook (useInterpolatedDriver) wraps
 * this on shared values; screens render its animatedProps.
 */

export interface DriverPing {
  latitude: number;
  longitude: number;
  /** Degrees clockwise from north, when the stream carries one. */
  heading?: number | null;
  /** Epoch ms the fix landed client-side. */
  receivedAt: number;
}

/** Spec 6.3: animate over the observed ping interval, clamped 2–8s. */
export const MIN_INTERVAL_MS = 2_000;
export const MAX_INTERVAL_MS = 8_000;

/** Spec 6.3: a fix older than this is STALE — freeze the car, tell the truth
 *  (S-56 "Location last updated {n}s ago"), never glide on fiction. */
export const STALE_AFTER_MS = 15_000;

export const clampInterval = (ms: number): number =>
  Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));

/** Normalize any angle into [0, 360). */
export const normalizeBearing = (deg: number): number => ((deg % 360) + 360) % 360;

/**
 * Shortest-arc delta from `from` to `to`, in (−180, 180]: 350°→10° is +20,
 * never −340 — the car turns the short way.
 */
export function shortestArcDelta(from: number, to: number): number {
  const raw = normalizeBearing(to) - normalizeBearing(from);
  if (raw > 180) return raw - 360;
  if (raw <= -180) return raw + 360;
  return raw;
}

/**
 * Bearing of travel between two points (degrees clockwise from north) — the
 * fallback when a ping carries no heading. Near-zero movement returns null:
 * a parked car must not spin to face "north of nothing".
 */
export function bearingBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number | null {
  const dLat = b.latitude - a.latitude;
  const dLng = b.longitude - a.longitude;
  // ~1.5m at the equator — below GPS noise, treat as stationary.
  if (Math.abs(dLat) < 0.000014 && Math.abs(dLng) < 0.000014) return null;
  const toRad = Math.PI / 180;
  const y = Math.sin(dLng * toRad) * Math.cos(b.latitude * toRad);
  const x =
    Math.cos(a.latitude * toRad) * Math.sin(b.latitude * toRad) -
    Math.sin(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.cos(dLng * toRad);
  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
}

export interface InterpolationPlan {
  /** Animate position over this long (observed cadence, clamped). */
  durationMs: number;
  /** Absolute target bearing the shared value should run TO — computed as
   *  current + shortest-arc delta so withTiming turns the short way. */
  bearingTarget: number | null;
}

/**
 * Plan the sweep from the currently-rendered state to a fresh ping.
 * `observedIntervalMs` is the measured gap between the last two pings
 * (callers keep a rolling measure); `renderedBearing` is whatever the shared
 * value currently shows.
 */
export function planSweep(
  rendered: { latitude: number; longitude: number; bearing: number },
  next: DriverPing,
  observedIntervalMs: number,
): InterpolationPlan {
  const durationMs = clampInterval(observedIntervalMs);
  const targetBearing =
    next.heading != null && Number.isFinite(next.heading)
      ? normalizeBearing(next.heading)
      : bearingBetween(rendered, next);
  return {
    durationMs,
    bearingTarget:
      targetBearing == null ? null : rendered.bearing + shortestArcDelta(rendered.bearing, targetBearing),
  };
}

/** True once the newest fix has aged past the honesty line. */
export const isStale = (lastPing: DriverPing | null, now: number): boolean =>
  lastPing != null && now - lastPing.receivedAt > STALE_AFTER_MS;

/** Whole seconds since the last fix — S-56's "{n}s ago". */
export const staleAgeSeconds = (lastPing: DriverPing, now: number): number =>
  Math.max(0, Math.round((now - lastPing.receivedAt) / 1000));
