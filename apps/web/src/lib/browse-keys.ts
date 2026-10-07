/**
 * [W2] The query keys the public browse pages are read under — Home, a store's
 * menu, a category list and the Market. The server seeds these keys with what
 * it rendered into the page (lib/browse-server.ts) and the browser reads the
 * same keys, so the two can never disagree about which answer is which.
 *
 * Home is keyed by whose answer it is. `public` is the guest feed — the only
 * one the server ever renders or caches, read with no session at all. `me` is
 * the signed-in person's own feed (their live order, their usuals), read by the
 * browser with their session and never seeded, cached or shared by the server.
 */
export type HomeOwner = 'public' | 'me';

export const homeFeedKey = (epoch: number, owner: HomeOwner, lat: number | null, lng: number | null) =>
  ['customer', 'home', epoch, owner, lat, lng] as const;


export const vendorDetailKey = (id: string) => ['customer', 'vendor', id] as const;
export const vendorListKey = (type: string) => ['customer', 'vendors', type] as const;
export const marketDepthKey = ['market', 'depth'] as const;
export const marketCategoriesKey = ['market', 'categories'] as const;
export const marketItemsKey = (category: string) => ['market', 'items', category] as const;

/** Browse data is the same for everyone and changes by the minute, not the
 *  second: a minute before the browser asks again, and no re-read just
 *  because the tab regained focus. */
export const BROWSE_STALE_MS = 60_000;

/** The Market's category chips: only goods (RETAIL) categories with a live store.
 *  One function for the browser's read and the server's seed. */
export function retailCategories(rail: unknown): Array<{ slug: string; name: string; vertical: string }> {
  const list = (rail && typeof rail === 'object' ? (rail as { categories?: unknown }).categories : undefined);
  return Array.isArray(list) ? list.filter((category) => category?.vertical === 'RETAIL') : [];
}

/** An answer the server read as a guest and drew into the page, with when the API produced it. */
export interface GuestRead<T> {
  data: T;
  /** When the API produced this answer (its Date header), so the browser knows how old it is. */
  at: number;
}

/** A query's first answer from the page itself: used only while the query has
 *  no answer of its own, and re-read once it is older than the query allows. */
export function fromPage<T>(seed: GuestRead<T> | null | undefined): { initialData: T; initialDataUpdatedAt: number } | Record<string, never> {
  return seed ? { initialData: seed.data, initialDataUpdatedAt: seed.at } : {};
}
