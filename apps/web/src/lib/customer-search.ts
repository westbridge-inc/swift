'use client';

// [PERF · web shared bundle] The catalogue search call, moved verbatim from
// lib/customer.ts; only the search page uses it.
import { apiFetch } from './auth';
import type { MarketItem } from './customer';

/** A store as GET /search returns it — one wire shape whichever engine answered. */
export interface SearchStore {
  id: string; name: string; slug: string | null; vendorType: string;
  logoUrl: string | null; coverImageUrl: string | null; cuisineTypes: string[];
  city: string | null; estimatedPrepTime: number | null; isCurrentlyOpen: boolean;
  displayRating: number | null; ratingCount: number; topRated: boolean;
}
export interface CatalogueResults { stores: SearchStore[]; items: MarketItem[] }
/** How many stores and how many dishes one search shows. */
export const SEARCH_PAGE = 30;
/**
 * [SEARCH 13 Oct] The search engine the phone app's Search tab uses: stores
 * AND the dishes and products inside them, forgiving of a misspelling, a
 * plural or the words in another order. The website searched store names and
 * descriptions only (the store list's `?search=`), so "pepperpot" never found
 * the stores that sell it.
 */
export async function searchCatalogue(q: string): Promise<CatalogueResults> {
  const data = (await apiFetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=${SEARCH_PAGE}`)).data as { vendors?: SearchStore[]; items?: MarketItem[] } | undefined;
  return { stores: data?.vendors ?? [], items: data?.items ?? [] };
}

/** One "did you mean" word from GET /search/suggestions: a store's or a dish's name. */
export interface SearchSuggestion { text: string; type: 'vendor' | 'item'; isCurrentlyOpen?: boolean }

/** [row 110] The engine's suggestions while you type, as the phone's Search
 *  shows them (open stores' first; prohibited items never, server-side). */
export async function searchSuggestions(q: string): Promise<SearchSuggestion[]> {
  const data = (await apiFetch(`/api/v1/search/suggestions?q=${encodeURIComponent(q)}`)).data;
  return Array.isArray(data) ? data.filter((s): s is SearchSuggestion => typeof s?.text === 'string' && s.text.trim() !== '') : [];
}
