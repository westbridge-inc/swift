import { MMKV } from 'react-native-mmkv';
import { AppState, Linking } from 'react-native';
import * as Crypto from 'expo-crypto';
import axios from 'axios';
import { api, API_URL } from '../services/api';
import {
  getAdEventTrackingScope,
  getAuthSessionSnapshot,
} from '../stores/authStore';
import {
  cacheUsable,
  cacheTrackable,
  isAdEventScope,
  sameAdEventScope,
  SERVE_TIMEOUT_MS,
  FLUSH_INTERVAL_MS,
  type AdServeResponse,
  type AdEventScope,
  type AdEventType,
  type AdEventVerdict,
  type QueuedAdEvent,
} from './adsCore';
import {
  enqueueAdEvent,
  hasQueuedAdEvents,
  prepareAdEventBatch,
  settleAdEventBatch,
} from './adsQueue';

// Ads runtime (spec §12.2/§13): one batched serve per home mount with an 800 ms
// timeout and a ≤1 h cached fallback (home NEVER waits on ads, ads NEVER break
// home); a persisted event queue that batches every 10 s and on app-background,
// retries with backoff, and drops events older than 24 h. Ad content is public
// data — the cache rides a plain MMKV store (the encrypted store is for auth).
// Queue ownership adds only a random per-login scope ID—never an account ID or
// auth credential (the server still derives the daily userHash).

// Guarded store creation: a stale binary without the native module must degrade
// to "no cache, no queue persistence", never crash at import
// [reference_swift_native_module_crash].
let store: MMKV | null = null;
try {
  store = new MMKV({ id: 'swift-ads' });
} catch {
  store = null;
}

const CACHE_KEY = 'serve';
let serveCacheEpoch = 0;
let fallbackSuppressed = false;

/** Remove any pre-block serve so an offline refetch cannot resurrect content
 * from an account the current user just blocked. Also retire in-flight serves
 * that began before this boundary; they must not repopulate the cache. */
export function clearAdServeCache(): void {
  serveCacheEpoch += 1;
  fallbackSuppressed = true;
  try {
    store?.delete(CACHE_KEY);
  } catch {
    /* fail closed for this process via fallbackSuppressed */
  }
}

// One session id per app launch (§11.1) — random, never the user id.
export const adsSessionId: string = (() => {
  try {
    return Crypto.randomUUID();
  } catch {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
})();

export interface AdsResult {
  data: AdServeResponse | null;
  /** false → display-only (TTL-expired cache): render, fire NO tracking. */
  trackable: boolean;
  /** Exact serve-time owner. Never substitute the account current at callback. */
  trackingScope: AdEventScope | null;
}

interface CachedServe {
  at: number;
  city: string;
  data: AdServeResponse;
  trackingScope: AdEventScope;
}

function readCache(): CachedServe | null {
  try {
    const raw = store?.getString(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedServe) : null;
  } catch {
    return null;
  }
}

/** The §13 fetch: serve → cache; on timeout/failure → last-good ≤1 h (same
 *  city) marked display-only when past the serve ttl; else null (collapse). */
export async function fetchAds(city: string, keys: string[]): Promise<AdsResult> {
  const requestEpoch = serveCacheEpoch;
  const trackingScope = getAdEventTrackingScope();
  const session = getAuthSessionSnapshot();
  try {
    const { data } = await api.get('/ads/serve', {
      params: { placements: keys.join(','), city, sessionId: adsSessionId },
      timeout: SERVE_TIMEOUT_MS,
      ...(session ? { headers: { Authorization: `Bearer ${session.accessToken}` } } : {}),
    });
    const payload = (data?.data ?? null) as AdServeResponse | null;
    if (requestEpoch !== serveCacheEpoch) {
      return { data: null, trackable: false, trackingScope: null };
    }
    if (payload) {
      let cacheIsSafe = store === null;
      try {
        if (store) {
          store.set(CACHE_KEY, JSON.stringify({
            at: Date.now(),
            city,
            data: payload,
            trackingScope,
          } satisfies CachedServe));
          cacheIsSafe = true;
        }
      } catch {
        /* cache write is best-effort */
      }
      if (cacheIsSafe) fallbackSuppressed = false;
      const stillCurrent = sameAdEventScope(trackingScope, getAdEventTrackingScope());
      return {
        data: payload,
        trackable: stillCurrent,
        trackingScope: stillCurrent ? trackingScope : null,
      };
    }
    return { data: null, trackable: false, trackingScope: null };
  } catch {
    if (requestEpoch !== serveCacheEpoch || fallbackSuppressed) {
      return { data: null, trackable: false, trackingScope: null };
    }
    const cached = readCache();
    if (!cached || cached.city !== city || !cacheUsable(cached.at, Date.now())) {
      return { data: null, trackable: false, trackingScope: null };
    }
    const ttl = Math.min(...Object.values(cached.data.placements).map((p) => p.ttlSeconds), 300);
    const scopeMatches = isAdEventScope(cached.trackingScope)
      && sameAdEventScope(cached.trackingScope, getAdEventTrackingScope());
    const trackable = scopeMatches && cacheTrackable(cached.at, ttl, Date.now());
    return {
      data: cached.data,
      trackable,
      trackingScope: trackable ? cached.trackingScope : null,
    };
  }
}

// ── Event queue (§12.2) ────────────────────────────────────────────────────────

let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

function newEventId(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Record against the serve-time owner. Authenticated callbacks from a retired
 * A boundary are ignored; explicit anonymous serves remain anonymous. */
export function trackAdEvent(
  token: string | undefined,
  eventType: AdEventType,
  trackingScope: AdEventScope | null,
  meta?: Record<string, unknown>,
): void {
  if (!token || !trackingScope) return; // house/display-only ads are untracked
  if (
    trackingScope.kind === 'AUTHENTICATED'
    && !sameAdEventScope(trackingScope, getAdEventTrackingScope())
  ) return;
  enqueueAdEvent({
    id: newEventId(),
    scope: trackingScope,
    token,
    eventType,
    occurredAt: new Date().toISOString(),
    meta,
    attempts: 0,
    retryAt: 0,
  });
  startAdEventLoop();
}

function eventPayload(batch: QueuedAdEvent[]) {
  return {
    events: batch.map(({ token, eventType, occurredAt, meta }) => ({
      token,
      eventType,
      occurredAt,
      ...(meta ? { meta } : {}),
    })),
  };
}

async function postBatch(
  batch: QueuedAdEvent[],
  accessToken: string | null,
): Promise<AdEventVerdict[] | null> {
  try {
    const response = accessToken
      ? await api.post('/ads/events', eventPayload(batch), {
          timeout: 5000,
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      : await axios.post(`${API_URL}/api/v1/ads/events`, eventPayload(batch), {
          timeout: 5000,
          headers: { 'Content-Type': 'application/json' },
        });
    return (response.data?.data?.results ?? null) as AdEventVerdict[] | null;
  } catch {
    return null;
  }
}

export async function flushAdEvents(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    // Auth first: capture the freshest token and pin it explicitly. A later B
    // login can never be substituted by the generic API interceptor.
    const session = getAuthSessionSnapshot();
    if (session?.adEventScopeId) {
      const scope: AdEventScope = {
        kind: 'AUTHENTICATED',
        scopeId: session.adEventScopeId,
        generation: session.generation,
      };
      const batch = prepareAdEventBatch(scope, Date.now());
      if (batch.length > 0) {
        const verdicts = await postBatch(batch, session.accessToken);
        settleAdEventBatch(batch, verdicts, Date.now());
      }
    }

    // Anonymous is a separate forced-no-auth request even while B is signed in.
    const anonymousBatch = prepareAdEventBatch({
      kind: 'ANONYMOUS',
      scopeId: 'all-anonymous-scopes',
      generation: 0,
    }, Date.now());
    if (anonymousBatch.length > 0) {
      const verdicts = await postBatch(anonymousBatch, null);
      settleAdEventBatch(anonymousBatch, verdicts, Date.now());
    }
  } finally {
    flushing = false;
  }
}

/** Idempotent: starts the 10 s flush loop + the on-background flush once. */
export function startAdEventLoop(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushAdEvents();
  }, FLUSH_INTERVAL_MS);
  AppState.addEventListener('change', (state) => {
    if (state === 'background' || state === 'inactive') void flushAdEvents();
  });
}

// A cold restore may land directly in mover/vendor/advertiser UI and never
// mount customer Home. Resume only when persisted work exists, avoiding an
// idle polling timer for installations with an empty queue.
if (hasQueuedAdEvents()) startAdEventLoop();

// ── Destination (§13) — URL opens the in-app browser (guarded, same pattern as
//    payLink), DEEPLINK goes through the router/Linking. Never throws. ─────────
let WebBrowser: typeof import('expo-web-browser') | null = null;
try {
  WebBrowser = require('expo-web-browser');
} catch {
  WebBrowser = null;
}

export async function openAdDestination(destination: { type: 'NONE' | 'URL' | 'DEEPLINK'; value: string | null }): Promise<void> {
  if (!destination.value || destination.type === 'NONE') return;
  try {
    if (destination.type === 'URL' && WebBrowser) {
      await WebBrowser.openBrowserAsync(destination.value);
    } else {
      await Linking.openURL(destination.value);
    }
  } catch {
    /* a broken destination never breaks the surface it sits on */
  }
}
