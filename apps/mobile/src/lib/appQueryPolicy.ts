import { hashKey, onlineManager, type Query, type QueryClient } from '@tanstack/react-query';

export const BROWSE_FRESH_MS = 60_000;
export const QUERY_GC_MS = 5 * 60_000;
export const RECONNECT_COOLDOWN_MS = 10_000;

/** Failures remain stale, but bouncing Wi-Fi must not restart a full retry
 * budget for every mounted screen on each native reconnect notification. */
export function reconnectPolicy(client: () => QueryClient) {
  const attempted = new WeakMap<Query, number>();
  const pending = new Map<Query, { timer?: ReturnType<typeof setTimeout>; due: boolean }>();
  let unsubscribe: (() => void) | undefined;
  const remove = (query: Query) => {
    const timer = pending.get(query)?.timer;
    if (timer !== undefined) clearTimeout(timer);
    pending.delete(query);
    if (pending.size === 0) { unsubscribe?.(); unsubscribe = undefined; }
  };
  const flush = (query: Query) => {
    const intent = pending.get(query);
    if (!intent?.due) return;
    // Old scopes, inactive screens and offline reads must not be revived.
    if (!onlineManager.isOnline() || client().getQueryCache().get(query.queryHash) !== query ||
        !query.isActive() || !query.isStale()) { remove(query); return; }
    // Keep intent until the existing retry/request chain settles, including
    // failure. Cache events wake this once; no polling or new retry loop.
    if (query.state.fetchStatus !== 'idle') return;
    remove(query);
    attempted.set(query, Date.now());
    void client().refetchQueries({ predicate: (entry) => entry === query, type: 'active' }, { cancelRefetch: false });
  };
  return (query: Query): boolean => {
    if (!query.isStale()) return false;
    const now = Date.now();
    const previous = attempted.get(query);
    if (previous !== undefined && (now - previous < RECONNECT_COOLDOWN_MS || pending.has(query) || query.state.fetchStatus !== 'idle')) {
      if (!pending.has(query)) {
        unsubscribe ??= client().getQueryCache().subscribe((event) => {
          if (event.type === 'removed' || !event.query.isActive()) remove(event.query);
          else if (event.type === 'updated') flush(event.query);
        });
        const intent: { timer?: ReturnType<typeof setTimeout>; due: boolean } = { due: false };
        pending.set(query, intent);
        intent.timer = setTimeout(() => {
          intent.timer = undefined;
          intent.due = true;
          flush(query);
        }, Math.max(0, RECONNECT_COOLDOWN_MS - (now - previous)));
      }
      return false;
    }
    remove(query);
    attempted.set(query, now);
    return true; // React Query still checks staleness and deduplicates in-flight work.
  };
}

export function retryRead(failures: number, error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  // Auth/session handling owns rejection; don't repeat other permanent 4xx.
  return failures < 2 && (status === undefined || status === 408 || status === 429 || status >= 500);
}

export function readRetryDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 500);
}

/** Only reviewed non-live families get a freshness window. Availability,
 * stock, prices, ETA and fees refresh behind the immediately visible cache. */
export function installQueryFreshness(client: QueryClient): void {
  for (const key of [
    ['customer', 'profile'], ['customer', 'addresses'], ['customer', 'my-rating'],
    ['customer', 'search-suggestions'],
  ]) client.setQueryDefaults(key, { staleTime: BROWSE_FRESH_MS });

  for (const key of [
    ['customer', 'home'], ['customer', 'order'], ['customer', 'orders'],
    ['customer', 'cart'], ['customer', 'slots'], ['customer', 'blocks'],
    ['customer', 'vendors'], ['customer', 'vendor'], ['customer', 'favorites'],
    ['customer', 'search'], ['market', 'items'],
    ['mover'], ['vendor'], ['rides'], ['courier'], ['payments'], ['wallet'],
    ['verification'], ['safety'], ['chat'], ['services', 'jobs'], ['services', 'provider-me'],
    ['ads', 'invoices'], ['ads', 'advertiser'], ['ads', 'availability'],
  ]) client.setQueryDefaults(key, { staleTime: 0 });
}

interface CacheScope {
  adEventScopeId: string;
  sessionGeneration: number;
}
interface ScopeSource {
  getState: () => CacheScope;
  subscribe: (listener: (state: CacheScope) => void) => () => void;
}

/** Cache-only subscription, installed before hydration/render. The hash closes
 * over an immutable opaque boundary (never tokens or a live auth lookup).
 * Existing raw query keys still support all prefix invalidations. Offline
 * persistence separately stores only reviewed display projections. */
export function bindQueryCacheScope(client: QueryClient, source: ScopeSource): () => void {
  let previous: string | undefined;
  const apply = ({ adEventScopeId, sessionGeneration }: CacheScope) => {
    const scope = hashKey([adEventScopeId, sessionGeneration]);
    if (scope === previous) return;
    previous = scope;
    client.clear(); // Cancel old reads/retries and discard query + mutation caches.
    const defaults = client.getDefaultOptions();
    client.setDefaultOptions({
      ...defaults,
      queries: { ...defaults.queries, queryKeyHashFn: (key) => hashKey([scope, key]) },
    });
  };
  apply(source.getState());
  return source.subscribe(apply);
}
