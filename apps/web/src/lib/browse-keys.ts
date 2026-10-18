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
import type { VendorDetail } from '@/lib/customer';

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
  /** [PERF #2] The answer carried no readable Date header, so `at` is only when
   *  this server received it. Never treated as fresh where an order depends on it. */
  undated?: true;
}

/** A query's first answer from the page itself: used only while the query has
 *  no answer of its own, and re-read once it is older than the query allows. */
export function fromPage<T>(seed: GuestRead<T> | null | undefined): { initialData: T; initialDataUpdatedAt: number } | Record<string, never> {
  return seed ? { initialData: seed.data, initialDataUpdatedAt: seed.at } : {};
}

/**
 * [PERF #2] The oldest live menu a store page takes orders from without
 * reading it again: the page's own background re-read cadence, so a menu the
 * server drew into the page is never older than one the browser would have
 * read itself. The API re-checks every choice at add and at checkout anyway.
 */
export const LIVE_MENU_MAX_AGE_MS = 30_000;

/** [PERF #2] A store's live menu, drawn into its page by the server (browse-server.ts `storeMenuForPage`). */
export interface ServerStoreMenu {
  /** The guest menu (GET /customer/vendors/:id): the one that carries every item's required choices. */
  vendor: VendorDetail;
  /** When the API produced it (its Date header). */
  at: number;
  /** Its age when the server drew the page, by the server's own clock. */
  ageMs: number;
  /** One server render. The page takes the menu as live at most once per
   *  render: Back/Forward shows a kept copy of the page, which reads again. */
  renderId: string;
}
