/**
 * [GO-LOC-1] One current position, never an endless wait.
 *
 * Android serves a "Balanced" request from Wi-Fi and cell towers. With no
 * network location (weak signal out of town, Google Location Accuracy off, no
 * SIM or Wi-Fi) the request never answers: GO spun, then said it couldn't get
 * the location, and every surface that waits on a fix (pickup, SOS position,
 * the mover's lease) waited with it. Now, in order:
 *
 *  1. Balanced, bounded at BALANCED_FIX_TIMEOUT_MS: the normal low-power answer.
 *  2. The OS's last known fix, but only when it is fresh (no older than
 *     LAST_KNOWN_MAX_AGE_MS) and accurate (within LAST_KNOWN_MAX_ACCURACY_M, the
 *     class of fix Balanced itself gives) — then it is as good as a new one.
 *     A cached fix with no reported accuracy or time is never trusted.
 *  3. High accuracy (GPS), bounded at GPS_FIX_TIMEOUT_MS: satellites need no
 *     network.
 *
 * When nothing answers in time, the call rejects and every caller's existing
 * "unavailable" path and retries run exactly as before. This decides only how
 * a fix is obtained, never whether one may be used: the permission rules (no
 * fix without a current foreground grant) stay where they are.
 */

export const BALANCED_FIX_TIMEOUT_MS = 5_000;
export const LAST_KNOWN_TIMEOUT_MS = 1_000;
export const GPS_FIX_TIMEOUT_MS = 20_000;
/** A cached fix older than this is history, not a position. */
export const LAST_KNOWN_MAX_AGE_MS = 60_000;
/** Dispatch and pickup need block-level accuracy: what Balanced gives, no worse. */
export const LAST_KNOWN_MAX_ACCURACY_M = 100;

export interface PositionFix {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
  timestamp?: number;
}

export interface PositionSource {
  /** The low-power request (Android: Wi-Fi and cell). */
  balanced: () => Promise<PositionFix>;
  /** The OS's cached fix, if any. */
  lastKnown: () => Promise<PositionFix | null>;
  /** The satellite request. */
  gps: () => Promise<PositionFix>;
}

export type PositionFixSource = 'balanced' | 'last-known' | 'gps';

export class PositionFixTimeoutError extends Error {
  constructor(readonly step: PositionFixSource, readonly ms: number) {
    super(`No ${step} location fix within ${ms} ms`);
    this.name = 'PositionFixTimeoutError';
  }
}

/** The one request, bounded. The native request may still answer later; nobody is waiting for it. */
function bounded<T>(step: PositionFixSource, ms: number, request: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The request starts now, in this turn (as it always did); a synchronous
  // throw is a failed step like any other.
  let pending: Promise<T>;
  try {
    pending = request();
  } catch (error) {
    pending = Promise.reject(error);
  }
  return Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PositionFixTimeoutError(step, ms)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function hasFiniteCoords(fix: PositionFix | null | undefined): fix is PositionFix {
  return !!fix
    && Number.isFinite(fix.coords?.latitude)
    && Number.isFinite(fix.coords?.longitude);
}

/** A cached fix is used only when it says how old and how accurate it is, and both are good enough. */
export function isUsableLastKnownFix(fix: PositionFix | null | undefined, now: number): fix is PositionFix {
  if (!hasFiniteCoords(fix)) return false;
  const accuracy = fix.coords.accuracy;
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > LAST_KNOWN_MAX_ACCURACY_M) return false;
  const timestamp = fix.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return false;
  // A fix "from the future" beyond the same window is a clock that cannot be trusted.
  return Math.abs(now - timestamp) <= LAST_KNOWN_MAX_AGE_MS;
}

/**
 * `cached: false` is for a caller whose fix is published as "now" without its
 * time (the mover's lease heartbeat): it must never renew a lease from a cached
 * fix, however fresh, so it gets Balanced or GPS only.
 */
export async function currentPositionWithFallback(
  source: PositionSource,
  now: () => number = Date.now,
  { cached: useCached = true }: { cached?: boolean } = {},
): Promise<PositionFix & { source: PositionFixSource }> {
  try {
    const fix = await bounded('balanced', BALANCED_FIX_TIMEOUT_MS, source.balanced);
    if (hasFiniteCoords(fix)) return { ...fix, source: 'balanced' };
  } catch {
    // No network location (or none in time): the next step decides.
  }

  if (useCached) {
    try {
      const cached = await bounded('last-known', LAST_KNOWN_TIMEOUT_MS, source.lastKnown);
      if (isUsableLastKnownFix(cached, now())) return { ...cached, source: 'last-known' };
    } catch {
      // No cached fix is not an error; satellites are next.
    }
  }

  const fix = await bounded('gps', GPS_FIX_TIMEOUT_MS, source.gps);
  if (!hasFiniteCoords(fix)) throw new Error('The GPS fix was not a position');
  return { ...fix, source: 'gps' };
}
