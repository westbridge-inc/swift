import type { QueryClient } from '@tanstack/react-query';

export const SLOW_QUERY_MS = 5_000;
let slowConnection = false;
export function isSlowConnection(): boolean { return slowConnection; }

/** One timer for the app, irrespective of the number of mounted query hooks.
 * Only active, fetching reads count; cached content is never gated by this. */
export function watchSlowQueries(client: QueryClient, publish: (slow: boolean) => void): () => void {
  const starts = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const active = new Set<string>();
    let oldest = Infinity;
    for (const query of client.getQueryCache().getAll()) {
      if (query.state.fetchStatus !== 'fetching' || query.getObserversCount() === 0) continue;
      active.add(query.queryHash);
      const start = starts.get(query.queryHash) ?? Date.now();
      starts.set(query.queryHash, start);
      oldest = Math.min(oldest, start);
    }
    for (const key of starts.keys()) if (!active.has(key)) starts.delete(key);
    const remaining = oldest + SLOW_QUERY_MS - Date.now();
    slowConnection = remaining <= 0;
    publish(slowConnection);
    if (Number.isFinite(remaining) && remaining > 0) timer = setTimeout(update, remaining);
  };
  const off = client.getQueryCache().subscribe(update);
  update();
  return () => { off(); if (timer !== undefined) clearTimeout(timer); slowConnection = false; };
}
