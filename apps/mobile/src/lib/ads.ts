import { MMKV } from 'react-native-mmkv';
import { AppState, Linking } from 'react-native';
import * as Crypto from 'expo-crypto';
import { api } from '../services/api';
import {
  cacheUsable,
  cacheTrackable,
  pruneQueue,
  takeBatch,
  applyVerdicts,
  SERVE_TIMEOUT_MS,
  FLUSH_INTERVAL_MS,
  type AdServeResponse,
  type AdEventType,
  type QueuedAdEvent,
} from './adsCore';

// Ads runtime (spec §12.2/§13): one batched serve per home mount with an 800 ms
// timeout and a ≤1 h cached fallback (home NEVER waits on ads, ads NEVER break
// home); a persisted event queue that batches every 10 s and on app-background,
// retries with backoff, and drops events older than 24 h. Ad content is public
// data — the cache rides a plain MMKV store (the encrypted store is for auth);
// no user identifier ever enters this file (the server derives userHash).

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
const QUEUE_KEY = 'events';

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
}

interface CachedServe {
  at: number;
  city: string;
  data: AdServeResponse;
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
  try {
    const { data } = await api.get('/ads/serve', {
      params: { placements: keys.join(','), city, sessionId: adsSessionId },
      timeout: SERVE_TIMEOUT_MS,
    });
    const payload = (data?.data ?? null) as AdServeResponse | null;
    if (payload) {
      try {
        store?.set(CACHE_KEY, JSON.stringify({ at: Date.now(), city, data: payload } satisfies CachedServe));
      } catch {
        /* cache write is best-effort */
      }
      return { data: payload, trackable: true };
    }
    return { data: null, trackable: false };
  } catch {
    const cached = readCache();
    if (!cached || cached.city !== city || !cacheUsable(cached.at, Date.now())) return { data: null, trackable: false };
    const ttl = Math.min(...Object.values(cached.data.placements).map((p) => p.ttlSeconds), 300);
    return { data: cached.data, trackable: cacheTrackable(cached.at, ttl, Date.now()) };
  }
}

// ── Event queue (§12.2) ────────────────────────────────────────────────────────

let queue: QueuedAdEvent[] = (() => {
  try {
    const raw = store?.getString(QUEUE_KEY);
    return raw ? pruneQueue(JSON.parse(raw) as QueuedAdEvent[], Date.now()) : [];
  } catch {
    return [];
  }
})();

let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

function persistQueue(): void {
  try {
    store?.set(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* persistence is best-effort; the in-memory queue still flushes */
  }
}

/** Record an ad event. Tokens come from the serve response; anonymous-safe. */
export function trackAdEvent(token: string | undefined, eventType: AdEventType, meta?: Record<string, unknown>): void {
  if (!token) return; // house ads carry no token — untracked by design (§11.1)
  queue.push({ token, eventType, occurredAt: new Date().toISOString(), meta, attempts: 0, retryAt: 0 });
  persistQueue();
  startAdEventLoop();
}

export async function flushAdEvents(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const now = Date.now();
    queue = pruneQueue(queue, now);
    const batch = takeBatch(queue, now);
    if (batch.length === 0) return;
    let verdicts: Array<{ status: string }> | null = null;
    try {
      const { data } = await api.post(
        '/ads/events',
        { events: batch.map(({ token, eventType, occurredAt, meta }) => ({ token, eventType, occurredAt, ...(meta ? { meta } : {}) })) },
        { timeout: 5000 },
      );
      verdicts = (data?.data?.results ?? null) as Array<{ status: string }> | null;
    } catch {
      verdicts = null; // transport failure → whole batch backs off
    }
    queue = applyVerdicts(queue, batch, verdicts, Date.now());
    persistQueue();
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
