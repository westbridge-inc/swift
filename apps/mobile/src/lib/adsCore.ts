// Ads client core — PURE decision logic (ads-platform spec §12.2/§13), no RN
// imports so it unit-tests in node. The runtime shell (lib/ads.ts) wires this
// to MMKV, axios, timers, and AppState.

export type AdEventType =
  | 'IMPRESSION'
  | 'VIEWABLE_IMPRESSION'
  | 'CLICK'
  | 'VIDEO_START'
  | 'VIDEO_Q25'
  | 'VIDEO_Q50'
  | 'VIDEO_Q75'
  | 'VIDEO_COMPLETE';

export interface AdServeItem {
  campaignId: string;
  creativeId: string;
  kind: 'IMAGE' | 'VIDEO';
  mediaUrl: string;
  posterUrl: string | null;
  headline: string | null;
  advertiserName: string;
  ctaLabel: string | null;
  destination: { type: 'NONE' | 'URL' | 'DEEPLINK'; value: string | null };
  impressionToken?: string;
}

export interface AdSlot {
  rotationSeconds: number | null;
  ttlSeconds: number;
  items: AdServeItem[];
}

export interface AdServeResponse {
  placements: Record<string, AdSlot>;
  _house: Record<string, boolean>;
}

export interface QueuedAdEvent {
  token: string;
  eventType: AdEventType;
  occurredAt: string; // ISO
  meta?: Record<string, unknown>;
  attempts: number;
  retryAt: number; // epoch ms; 0 = eligible now
}

export const SERVE_TIMEOUT_MS = 800; // §13 — home never waits longer
export const CACHE_TTL_MS = 60 * 60 * 1000; // §13 — 1 h offline fallback
export const EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // §12.2 — drop older
export const FLUSH_INTERVAL_MS = 10_000; // §12.2 — batch every 10 s
export const BATCH_MAX = 50;

/** A cached serve usable as a fallback? (≤1 h old — else collapse, E7.) */
export function cacheUsable(cachedAt: number, now: number): boolean {
  return now - cachedAt <= CACHE_TTL_MS;
}

/** Past the serve's own ttl the tokens are dead — display is fine (≤1 h) but
 *  tracking must NOT fire (§13 "TTL-expired cache is display-only"). */
export function cacheTrackable(cachedAt: number, ttlSeconds: number, now: number): boolean {
  return now - cachedAt <= ttlSeconds * 1000;
}

/** Drop events past their 24 h shelf life (§12.2). */
export function pruneQueue(queue: QueuedAdEvent[], now: number): QueuedAdEvent[] {
  return queue.filter((e) => now - Date.parse(e.occurredAt) <= EVENT_MAX_AGE_MS);
}

/** The next batch: retry-eligible events, oldest first, ≤50 (§12.2). */
export function takeBatch(queue: QueuedAdEvent[], now: number): QueuedAdEvent[] {
  return queue
    .filter((e) => e.retryAt <= now)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .slice(0, BATCH_MAX);
}

/** Apply per-item verdicts: accepted/duplicate/invalid leave the queue (done or
 *  permanently dead); anything else backs off exponentially (30 s · 2^attempts,
 *  capped 15 min) and retries. A whole-batch transport failure passes
 *  verdicts=null: every sent event backs off. */
export function applyVerdicts(
  queue: QueuedAdEvent[],
  sent: QueuedAdEvent[],
  verdicts: Array<{ status: string }> | null,
  now: number,
): QueuedAdEvent[] {
  const sentTokens = new Map(sent.map((e, i) => [`${e.token}|${e.eventType}`, i]));
  const done = new Set<string>();
  if (verdicts) {
    for (const [key, i] of sentTokens) {
      const v = verdicts[i]?.status;
      if (v === 'accepted' || v === 'duplicate' || v === 'invalid') done.add(key);
    }
  }
  return queue
    .map((e) => {
      const key = `${e.token}|${e.eventType}`;
      if (!sentTokens.has(key)) return e;
      if (done.has(key)) return null;
      const attempts = e.attempts + 1;
      const backoff = Math.min(30_000 * 2 ** attempts, 15 * 60_000);
      return { ...e, attempts, retryAt: now + backoff };
    })
    .filter((e): e is QueuedAdEvent => e !== null);
}
