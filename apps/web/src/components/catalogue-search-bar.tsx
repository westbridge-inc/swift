import { Search } from 'lucide-react';

/** Where the search bar hands its words over: the one catalogue search page. */
export const CATALOGUE_SEARCH_PATH = '/order/search';

/** The store kinds a browse page can be narrowed to (the server's vendorType). */
export const SEARCHABLE_STORE_TYPES = ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'] as const;

/**
 * [row 110] The search bar the browse pages show: the store directory
 * (/stores) and each category (/order/browse?type=…). It used to be reachable
 * only from the home page's search link.
 *
 * The phone's Home and category screens open Search with the words and the
 * category (`navigate('Search', { q, type })`); this is that hand-off for the
 * website. A plain GET form, so it works before (or without) any script:
 * `/order/search?q=…&type=…`. The search page reads both and asks the one
 * search engine (GET /search) for stores AND the dishes and products inside
 * them, the same way it does when you type there.
 */
export function CatalogueSearchBar({ type, className = '' }: { type?: string | null; className?: string }) {
  const narrowTo = SEARCHABLE_STORE_TYPES.find((known) => known === type);
  return (
    <form role="search" action={CATALOGUE_SEARCH_PATH} method="get" aria-label="Search stores and dishes" className={`flex max-w-[640px] items-center gap-2 ${className}`}>
      <label className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-full border border-[var(--swift-border-strong)] bg-[var(--swift-card)] pl-4 pr-2 focus-within:border-[var(--swift-red)]">
        <Search size={17} className="flex-none text-[var(--swift-muted-soft)]" aria-hidden />
        <input type="search" name="q" required minLength={2} enterKeyHint="search" autoComplete="off"
          aria-label="Search stores and dishes" placeholder="Stores, dishes, products…"
          className="min-w-0 flex-1 border-0 bg-transparent text-base leading-[22px] text-[var(--swift-ink)] outline-none placeholder:text-[var(--swift-muted-soft)]" />
      </label>
      {narrowTo ? <input type="hidden" name="type" value={narrowTo} /> : null}
      <button type="submit" className="sw-btn sw-btn-sm flex-none">Search</button>
    </form>
  );
}
