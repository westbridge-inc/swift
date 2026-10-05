/** The last key member is the opaque auth boundary, including for guests. */
export function homeQueryKey(lat: number | undefined, lng: number | undefined, scope: string) {
  return ['customer', 'home', lat ?? null, lng ?? null, scope] as const;
}

/** Coordinates may change while the same person browses. Auth may not. */
export function homePlaceholderData<T>(
  previous: T | undefined,
  previousQuery: { queryKey: readonly unknown[] } | undefined,
  scope: string,
): T | undefined {
  return previousQuery?.queryKey.at(-1) === scope ? previous : undefined;
}

export function retainedHomeData<T>(
  current: T | undefined,
  last: { scope: string; data: T } | null,
  scope: string,
): T | undefined {
  return current ?? (last?.scope === scope ? last.data : undefined);
}

export function homeFeedState(query: {
  data: unknown;
  fetchStatus: 'idle' | 'fetching' | 'paused';
  isError: boolean;
}): 'content' | 'offline' | 'error' | 'loading' {
  if (query.data != null) return 'content';
  if (query.fetchStatus === 'paused') return 'offline';
  if (query.isError) return 'error';
  return 'loading';
}

/** Reject a malformed success envelope so missing rails do not read as a
 * healthy empty marketplace. The server always supplies these six arrays. */
export function isHomeFeed(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const feed = value as Record<string, unknown>;
  return ['popularItems', 'featured', 'nearby', 'orderAgain', 'categories', 'openVendors', 'closedVendors']
    .every((key) => Array.isArray(feed[key]));
}

/** A complete server verdict is the only launch-depth authority. */
export function marketDepthVerdict(body: unknown): 'visible' | 'hidden' | 'unknown' {
  if (!body || typeof body !== 'object') return 'unknown';
  const value = body as Record<string, unknown>;
  if (typeof value['visible'] !== 'boolean') return 'unknown';
  if (!Number.isSafeInteger(value['items']) || (value['items'] as number) < 0) return 'unknown';
  if (!Number.isSafeInteger(value['vendors']) || (value['vendors'] as number) < 0) return 'unknown';
  return value['visible'] ? 'visible' : 'hidden';
}

/** Unknown depth never opens a cold Market tab. React Query retains a prior
 * successful verdict through a refetch error, so a known-visible tab stays. */
export function marketTabVisible(body: unknown): boolean {
  return marketDepthVerdict(body) === 'visible';
}

/** Focus and foreground often arrive in the same instant. */
export function createHomeRefreshGate(refresh: () => void, cooldownMs: number) {
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  return (now: number, isFetching: boolean): boolean => {
    if (isFetching || now - lastRefreshAt < cooldownMs) return false;
    lastRefreshAt = now;
    refresh();
    return true;
  };
}

/** The focus effect owns one foreground listener and removes it on blur. */
export function subscribeToHomeAttention(
  initialState: string,
  addListener: (callback: (state: string) => void) => { remove: () => void },
  refresh: () => void,
): () => void {
  refresh();
  let previousState = initialState;
  const subscription = addListener((next) => {
    if (next === 'active' && previousState !== 'active') refresh();
    previousState = next;
  });
  return () => subscription.remove();
}
