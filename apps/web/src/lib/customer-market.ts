'use client';

// [PERF · web shared bundle] The Market tab's goods and category reads, moved
// verbatim from lib/customer.ts; only the Market page uses them. The market
// depth (whether the tab shows) stays in lib/customer: the frame reads it.
import { publicGet, type MarketCategory, type MarketItem } from './customer';
import { retailCategories } from './browse-keys';

export function getMarketItems(params: { category?: string; cursor?: string }): Promise<{ items: MarketItem[]; nextCursor: string | null }> {
  const qs = new URLSearchParams({ sort: 'popular' });
  if (params.category) qs.set('category', params.category);
  if (params.cursor) qs.set('cursor', params.cursor);
  return publicGet(`/api/v1/market/items?${qs}`);
}
/** The goods categories the Market chips offer — only ones with a live store. */
export async function getMarketCategories(): Promise<MarketCategory[]> {
  return retailCategories(await publicGet<unknown>('/api/v1/discovery/categories?vertical=RETAIL'));
}
