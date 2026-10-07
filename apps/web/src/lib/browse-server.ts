// [W2] Server-side reads for the public browse pages (Home, a store's menu, a
// category list, the Market), so a phone receives the stores and the menu in
// the HTML itself instead of a skeleton that fills in after the scripts run.
//
// THE RULE: these are GUEST reads. Nothing here sends a cookie, a token or any
// header that names a person, and nothing here reads the visitor's request
// (no next/headers). What the server renders and caches is exactly what a
// signed-out visitor sees — the same answer for everyone — so a personal
// answer can never land in a shared page or data cache. A signed-in person's
// own feed is read by their browser, with their session, after the page loads.
import { cache } from 'react';
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { isHomeFeed, marketTabVisible } from '@/lib/app-rules';
import type { HomeFeed, MarketCategory, MarketDepth, MarketItem, Vendor, VendorDetail } from '@/lib/customer';
import type { ServiceCatalog } from '@swift/types';
import type { ProviderPage } from '@/lib/service-jobs';
import { retailCategories, type GuestRead } from '@/lib/browse-keys';

export type { GuestRead };

const API_URL = process.env['API_URL'] ?? BROWSER_API_ORIGIN;

/** How long the server keeps a browse answer before asking the API again. */
export const BROWSE_REVALIDATE_SECONDS = 60;
/** A store's menu: shorter. The page re-checks the live menu as soon as it opens anyway. */
export const STORE_REVALIDATE_SECONDS = 30;

/**
 * `next build` never calls the API: the build machine is not where the stores
 * are read from, and a release must not depend on the API being up while it
 * builds. A page built empty still works — the browser loads its stores, as
 * before — and the server fills it at its first refresh (Home: within a
 * minute), after which visitors get it with the stores in it.
 */
function building(): boolean {
  return process.env['NEXT_PHASE'] === 'phase-production-build';
}

/** One guest GET. Any failure is "no answer" — the page then loads it in the browser as before. */
export async function guestRead<T>(path: string, revalidate: number, tags: string[], valid: (_data: unknown) => boolean): Promise<GuestRead<T> | null> {
  if (building()) return null;
  try {
    const response = await fetch(`${API_URL}${path}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate, tags },
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || body.success === false || !valid(body.data)) return null;
    const stamped = Date.parse(response.headers.get('date') ?? '');
    return { data: body.data as T, at: Number.isFinite(stamped) ? Math.min(stamped, Date.now()) : Date.now() };
  } catch {
    return null;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

export const fetchGuestHome = cache(() =>
  guestRead<HomeFeed>('/api/v1/customer/home', BROWSE_REVALIDATE_SECONDS, ['browse:home'], isHomeFeed));

export const fetchGuestVendor = cache((id: string) =>
  guestRead<VendorDetail>(`/api/v1/customer/vendors/${encodeURIComponent(id)}`, STORE_REVALIDATE_SECONDS, [`store:${id}`],
    (data) => isObject(data) && data['id'] === id && Array.isArray(data['categories'])));

export const fetchGuestVendors = cache((type: string) =>
  guestRead<Vendor[]>(`/api/v1/customer/vendors${type ? `?type=${encodeURIComponent(type)}` : ''}`, BROWSE_REVALIDATE_SECONDS, ['browse:vendors'],
    (data) => Array.isArray(data)));

/** A store's menu, read on the server only for an id that can be a store id. */
const STORE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export async function vendorSeed(id: string): Promise<GuestRead<VendorDetail> | null> {
  return STORE_ID.test(id) ? fetchGuestVendor(id) : null;
}

/** Only the kinds of store the browse page offers are read on the server, so a
 *  made-up `?type=` can never fill the server's cache. */
const KINDS = new Set(['', 'RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']);
export async function vendorListSeed(type: string): Promise<GuestRead<Vendor[]> | null> {
  return KINDS.has(type) ? fetchGuestVendors(type) : null;
}

export interface MarketSeed {
  depth: GuestRead<MarketDepth> | null;
  categories: GuestRead<MarketCategory[]> | null;
  items: GuestRead<{ items: MarketItem[]; nextCursor: string | null }> | null;
}

/**
 * The Market's first screen: the server's depth verdict, and — only when it
 * says the Market is open — the category chips and the first page of goods.
 * Goods are read for "All" or for a category the server itself listed, so a
 * made-up `?category=` never fills the server's cache.
 */
export async function marketSeed(category: string): Promise<MarketSeed> {
  const depth = await guestRead<MarketDepth>('/api/v1/market/depth', BROWSE_REVALIDATE_SECONDS, ['browse:market'],
    (data) => isObject(data) && typeof data['visible'] === 'boolean');
  if (!depth || !marketTabVisible(depth.data)) return { depth, categories: null, items: null };
  const rail = await guestRead<unknown>('/api/v1/discovery/categories?vertical=RETAIL', BROWSE_REVALIDATE_SECONDS, ['browse:market'], isObject);
  const categories = rail ? { data: retailCategories(rail.data) as MarketCategory[], at: rail.at } : null;
  const listed = category === '' || (categories !== null && categories.data.some((entry) => entry.slug === category));
  const qs = new URLSearchParams({ sort: 'popular' });
  if (category) qs.set('category', category);
  const items = listed
    ? await guestRead<{ items: MarketItem[]; nextCursor: string | null }>(`/api/v1/market/items?${qs}`, BROWSE_REVALIDATE_SECONDS, ['browse:market'],
      (data) => isObject(data) && Array.isArray(data['items']))
    : null;
  return { depth, categories, items };
}

// ── [W11] Local services ──────────────────────────────────────────────────────

/** The services taxonomy changes with a release, not by the minute. */
export const CATALOG_REVALIDATE_SECONDS = 600;

export interface ServicesSeed {
  trade: string;
  catalog: GuestRead<ServiceCatalog> | null;
  providers: GuestRead<ProviderPage> | null;
}

/**
 * The services page's first screen: the public catalogue, and — only for a
 * trade the catalogue itself says takes requests — that trade's first
 * providers. A made-up `?trade=` never reaches the API.
 */
export async function servicesSeed(trade: string): Promise<ServicesSeed> {
  const catalog = await guestRead<ServiceCatalog>('/api/v1/services/catalog', CATALOG_REVALIDATE_SECONDS, ['browse:services'],
    (data) => isObject(data) && Array.isArray(data['categories']));
  const requestable = Boolean(trade) && catalog !== null
    && catalog.data.categories.some((category) => category.id === trade && category.quoteRequestsEnabled && category.modes.includes('QUOTE_JOB'));
  const providers = requestable
    ? await guestRead<ProviderPage>(`/api/v1/services/providers?${new URLSearchParams({ trade })}`, BROWSE_REVALIDATE_SECONDS, ['browse:services'],
      (data) => isObject(data) && Array.isArray(data['providers']))
    : null;
  return { trade, catalog, providers };
}
