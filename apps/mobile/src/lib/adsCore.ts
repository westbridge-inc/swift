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

export type AdEventVerdict = 'accepted' | 'duplicate' | 'invalid';

const AD_EVENT_TYPES: ReadonlySet<string> = new Set<AdEventType>([
  'IMPRESSION',
  'VIEWABLE_IMPRESSION',
  'CLICK',
  'VIDEO_START',
  'VIDEO_Q25',
  'VIDEO_Q50',
  'VIDEO_Q75',
  'VIDEO_COMPLETE',
]);

export function isAdEventType(value: unknown): value is AdEventType {
  return typeof value === 'string' && AD_EVENT_TYPES.has(value);
}

/** Local-only attribution boundary. scopeId is a random per-auth-boundary
 * nonce stored with encrypted auth state; it is not a user ID or credential. */
export interface AdEventScope {
  kind: 'ANONYMOUS' | 'AUTHENTICATED';
  scopeId: string;
  generation: number;
}

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
  id: string;
  scope: AdEventScope;
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

export function isAdEventScope(value: unknown): value is AdEventScope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AdEventScope>;
  return (candidate.kind === 'ANONYMOUS' || candidate.kind === 'AUTHENTICATED')
    && typeof candidate.scopeId === 'string'
    && candidate.scopeId.length > 0
    && Number.isSafeInteger(candidate.generation)
    && (candidate.generation ?? -1) >= 0;
}

export function sameAdEventScope(left: AdEventScope, right: AdEventScope): boolean {
  return left.kind === right.kind
    && left.scopeId === right.scopeId
    && left.generation === right.generation;
}

export function isQueuedAdEvent(value: unknown): value is QueuedAdEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<QueuedAdEvent>;
  return typeof candidate.id === 'string'
    && candidate.id.length > 0
    && isAdEventScope(candidate.scope)
    && typeof candidate.token === 'string'
    && isAdEventType(candidate.eventType)
    && typeof candidate.occurredAt === 'string'
    && Number.isFinite(Date.parse(candidate.occurredAt))
    && typeof candidate.attempts === 'number'
    && Number.isFinite(candidate.attempts)
    && typeof candidate.retryAt === 'number'
    && Number.isFinite(candidate.retryAt);
}

/** Safe queue migration: legacy ownerless rows are ambiguous and therefore
 * dropped instead of being attributed to the next account or treated as guest. */
export function restoreQueue(value: unknown, now: number): QueuedAdEvent[] {
  if (!Array.isArray(value)) return [];
  return pruneQueue(value.filter(isQueuedAdEvent), now);
}

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

/** Auth batches are exact-boundary only; anonymous scopes may share a request
 * because the transport is forcibly unauthenticated for the whole batch. */
export function takeBatchForScope(
  queue: QueuedAdEvent[],
  scope: AdEventScope,
  now: number,
): QueuedAdEvent[] {
  const eligible = scope.kind === 'ANONYMOUS'
    ? queue.filter((event) => event.scope.kind === 'ANONYMOUS')
    : queue.filter((event) => sameAdEventScope(event.scope, scope));
  return takeBatch(eligible, now);
}

export function retireQueueScope(
  queue: QueuedAdEvent[],
  scope: AdEventScope,
): QueuedAdEvent[] {
  return queue.filter((event) => !sameAdEventScope(event.scope, scope));
}

/** Apply per-item verdicts: accepted/duplicate/invalid leave the queue (done or
 *  permanently dead); anything else backs off exponentially (30 s · 2^attempts,
 *  capped 15 min) and retries. A whole-batch transport failure passes
 *  verdicts=null: every sent event backs off. */
export function applyVerdicts(
  queue: QueuedAdEvent[],
  sent: QueuedAdEvent[],
  verdicts: AdEventVerdict[] | null,
  now: number,
): QueuedAdEvent[] {
  const sentEvents = new Map(sent.map((event, index) => [event.id, index]));
  const done = new Set<string>();
  if (verdicts) {
    for (const [id, i] of sentEvents) {
      const v = verdicts[i];
      if (v === 'accepted' || v === 'duplicate' || v === 'invalid') done.add(id);
    }
  }
  return queue
    .map((e) => {
      if (!sentEvents.has(e.id)) return e;
      if (done.has(e.id)) return null;
      const attempts = e.attempts + 1;
      const backoff = Math.min(30_000 * 2 ** attempts, 15 * 60_000);
      return { ...e, attempts, retryAt: now + backoff };
    })
    .filter((e): e is QueuedAdEvent => e !== null);
}
