import { hashKey, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';
interface Scope { adEventScopeId: string; sessionGeneration: number; user?: { id: string } | null }
interface Source { getState: () => Scope; subscribe: (cb: (scope: Scope) => void) => () => void }
interface Storage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }
const STORAGE_KEY = 'swift-offline-query-v1';
export const OFFLINE_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
const record = (value: unknown): Record<string, any> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
function pick(value: unknown, fields: string[]): Record<string, any> {
  const input = record(value); const out: Record<string, any> = {};
  for (const key of fields) {
    const v = input?.[key];
    if (typeof v === 'string' && v.length <= 500 || typeof v === 'number' && Number.isFinite(v) || typeof v === 'boolean') out[key] = v;
  }
  return out;
}
function publicRow(value: unknown): Record<string, any> {
  const input = record(value);
  const out = pick(input, ['id', 'name', 'slug', 'vendorId', 'vendorType', 'type', 'price', 'rating', 'ratingCount', 'deliveryFee', 'deliveryMinutes', 'isOpen', 'isAvailable', 'distanceKm']);
  for (const key of ['logoUrl', 'coverUrl', 'imageUrl', 'photoUrl', 'thumbnailUrl']) {
    const url = input?.[key];
    // Do not retain signed private URLs or embedded credentials/query strings.
    if (typeof url === 'string' && /^https:\/\/[^/@?#]+\/[^?#]*$/.test(url)) out[key] = url;
  }
  if (input?.['vendor']) out['vendor'] = pick(input['vendor'], ['id', 'name', 'vendorType']);
  return out;
}
function orderSummary(value: unknown): Record<string, any> | null {
  const input = record(value);
  if (!input || typeof input['id'] !== 'string') return null;
  return { ...pick(input, ['id', 'orderNumber', 'status', 'orderType', 'vertical', 'fulfillment', 'placedAt']),
    vendor: input['vendor'] ? publicRow(pick(input['vendor'], ['id', 'name', 'vendorType', 'logoUrl'])) : null,
    holdExpiresAt: null, promise: null, _offlineSnapshot: true };
}
const publicRows = (value: unknown) => Array.isArray(value) ? value.slice(0, 50).map(publicRow) : [];
const orders = (value: unknown) => Array.isArray(value) ? value.slice(0, 50).map(orderSummary).filter(Boolean) : [];
/** Explicit display projections only. New server fields are excluded by default. */
export function projectOfflineData(key: QueryKey, data: unknown): unknown {
  if (key[0] !== 'customer') return undefined;
  const input = record(data);
  if (key[1] === 'home' && input) return {
    activeOrder: orderSummary(input['activeOrder']),
    ...Object.fromEntries(['popularItems', 'featured', 'nearby', 'categories', 'openVendors', 'closedVendors'].map((field) => [field, publicRows(input[field])])),
    orderAgain: [], _offlineSnapshot: true,
  };
  if (key[1] === 'vendors' && Array.isArray(data)) return publicRows(data);
  if (key[1] === 'order') return orderSummary(data) ?? undefined;
  if (key[1] !== 'orders') return undefined;
  if (Array.isArray(data)) return orders(data);
  if (key[2] === 'live' && input) return { items: orders(input['items']), total: typeof input['total'] === 'number' ? input['total'] : null };
  if (key[2] === 'infinite' && input && Array.isArray(input['pages'])) return {
    pages: input['pages'].slice(0, 3).map((page: unknown) => ({ items: orders(record(page)?.['items']), meta: pick(record(page)?.['meta'], ['page', 'totalPages']) })),
    pageParams: Array.isArray(input['pageParams']) ? input['pageParams'].slice(0, 3).filter((n: unknown) => Number.isSafeInteger(n)) : [1],
  };
  return undefined;
}
export function isOfflineSnapshot(data: unknown): boolean { return record(data)?.['_offlineSnapshot'] === true; }
interface Entry { hash: string; updatedAt: number; data: unknown }
/** A React Query cache persister over the existing encrypted MMKV adapter.
 * Query keys are one-way digested: coordinates and search parameters never go
 * to disk. Matching queries hydrate when created, before the offline read can
 * complete. No mutations, errors, auth, contacts or payment payloads persist. */
export async function bindOfflineQueryCache(client: QueryClient, source: Source, storage: Storage, digest: (value: string) => Promise<string>): Promise<() => void> {
  const boundary = () => { const s = source.getState(); return hashKey([s.adEventScopeId, s.sessionGeneration, s.user?.id ?? null]); };
  let owner = boundary(); let epoch = 0; let stopped = false;
  let scope = await digest(owner);
  if (owner !== boundary()) return bindOfflineQueryCache(client, source, storage, digest);
  let scopeReady = Promise.resolve(scope);
  const entries = new Map<string, Entry>();
  const restored = new WeakMap<Query, unknown>();
  const fresh = (at: number) => Number.isFinite(at) && at <= Date.now() && Date.now() - at < OFFLINE_CACHE_MAX_AGE;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    const saved = raw && raw.length <= 2_000_000 ? JSON.parse(raw) : null;
    if (saved?.version === 1 && saved.scope === scope && Array.isArray(saved.entries)) {
      for (const entry of saved.entries.slice(0, 100)) if (typeof entry.hash === 'string' && fresh(entry.updatedAt)) entries.set(entry.hash, entry);
      if (entries.size === 0) storage.removeItem(STORAGE_KEY);
      else if (entries.size !== saved.entries.length) storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, scope, entries: [...entries.values()] }));
    } else if (raw) storage.removeItem(STORAGE_KEY);
  } catch { storage.removeItem(STORAGE_KEY); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    timer = undefined;
    if (stopped || owner !== boundary()) return;
    for (const [key, entry] of entries) if (!fresh(entry.updatedAt)) entries.delete(key);
    const payload = JSON.stringify({ version: 1, scope, entries: [...entries.values()].slice(-100) });
    if (payload.length <= 2_000_000) {
      try { storage.setItem(STORAGE_KEY, payload); } catch { /* Optional cache must not interrupt the app on a full disk. */ }
    }
  };
  const process = async (query: Query, restore: boolean) => {
    if (projectOfflineData(query.queryKey, query.state.data) === undefined && !['home', 'vendors', 'order', 'orders'].includes(String(query.queryKey[1]))) return;
    const started = epoch;
    if (!await scopeReady) return;
    const hash = await digest(hashKey(query.queryKey));
    if (stopped || started !== epoch || owner !== boundary() || client.getQueryCache().get(query.queryHash) !== query) return;
    if (restore && query.state.data === undefined) {
      const entry = entries.get(hash);
      const data = entry && fresh(entry.updatedAt) ? projectOfflineData(query.queryKey, entry.data) : undefined;
      if (data !== undefined) {
        // Set the guard before setQueryData synchronously publishes an update.
        restored.set(query, data);
        client.setQueryData(query.queryKey, data, { updatedAt: entry!.updatedAt });
      }
    } else if (query.state.status === 'success' && query.state.data !== restored.get(query)) {
      const data = projectOfflineData(query.queryKey, query.state.data);
      if (data === undefined || !fresh(query.state.dataUpdatedAt)) return;
      entries.set(hash, { hash, updatedAt: query.state.dataUpdatedAt, data });
      if (timer === undefined) timer = setTimeout(write, 500);
    }
  };
  const offQueries = client.getQueryCache().subscribe((event) => {
    if (event.type === 'added' || event.type === 'updated') void process(event.query, event.type === 'added').catch(() => {});
  });
  const offScope = source.subscribe(() => {
    if (owner === boundary()) return;
    epoch++; owner = boundary(); entries.clear(); storage.removeItem(STORAGE_KEY);
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    const started = epoch;
    scopeReady = digest(owner).then((next) => { if (epoch === started) scope = next; return next; }).catch(() => '');
  });
  for (const query of client.getQueryCache().getAll()) void process(query, query.state.data === undefined).catch(() => {});
  return () => { stopped = true; epoch++; offQueries(); offScope(); if (timer !== undefined) clearTimeout(timer); };
}
