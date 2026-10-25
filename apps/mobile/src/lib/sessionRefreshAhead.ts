import type { AuthSessionSnapshot } from './authSession';

/**
 * [PERF #9] The access token lives 15 minutes (set by the API, unchanged
 * here). The first request after it lapsed used to pay two extra trips before
 * it could run: a 401, then the refresh, then the request again. While the app
 * is on screen, the session is now refreshed shortly BEFORE the token lapses,
 * and at once when the app comes back to the screen with a lapsed or nearly
 * lapsed token, through the same single refresh the 401 path uses (the
 * coordinator in services/api.ts: one flight per session, every rotation
 * bound to the exact session that asked). Nothing about the token's lifetime,
 * the refresh call or the server changes.
 */

/** Refresh this long before the access token lapses. */
export const REFRESH_AHEAD_MS = 60_000;
/** Never more than one early refresh in this long, so a phone clock that
 *  runs ahead of the server's can never turn this into a refresh loop. */
export const REFRESH_AHEAD_MIN_GAP_MS = 10 * 60_000;

/**
 * When an access token lapses (epoch ms), read from its own `exp` claim, or
 * null when it carries none. Used ONLY to time a refresh: nothing here trusts
 * the token, and an unreadable one simply leaves the 401 path to it.
 */
export function accessTokenExpiresAt(accessToken: string): number | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    const exp = claims?.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface RefreshAheadDeps {
  /** The signed-in session right now, or null. */
  current: () => AuthSessionSnapshot | null;
  /** The app's one refresh (services/api.ts refreshSessionAhead). */
  refresh: (session: AuthSessionSnapshot) => Promise<unknown>;
  /** Whether the app is on screen. */
  isActive: () => boolean;
  /** Called on every app state change (foreground, background). */
  onAppStateChange: (listener: () => void) => () => void;
  /** Called whenever the signed-in session's tokens change. */
  onSessionChange: (listener: () => void) => () => void;
  now?: () => number;
}

/** Keeps the session's access token fresh while the app is on screen. Returns a stop function. */
export function keepSessionFresh(deps: RefreshAheadDeps): () => void {
  const now = deps.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastEarlyRefresh = -Infinity;
  let stopped = false;

  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (stopped || !deps.isActive()) return;
    const session = deps.current();
    const expiresAt = session ? accessTokenExpiresAt(session.accessToken) : null;
    if (!session || expiresAt === null) return;
    const at = now();
    const due = Math.max(expiresAt - REFRESH_AHEAD_MS, lastEarlyRefresh + REFRESH_AHEAD_MIN_GAP_MS);
    if (due > at) {
      timer = setTimeout(schedule, due - at);
      return;
    }
    lastEarlyRefresh = at;
    // Rotated tokens schedule the next one; a failed refresh leaves the token
    // as it was (the 401 path still covers it) and is tried again no sooner
    // than REFRESH_AHEAD_MIN_GAP_MS later.
    void deps.refresh(session).catch(() => undefined).finally(schedule);
  };

  const stopAppState = deps.onAppStateChange(schedule);
  const stopSession = deps.onSessionChange(schedule);
  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    stopAppState();
    stopSession();
  };
}
