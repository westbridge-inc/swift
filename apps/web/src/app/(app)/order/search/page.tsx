'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchCatalogue, searchSuggestions, type CatalogueResults, type SearchSuggestion } from '@/lib/customer-search';
import { BackButton, useOwnBackButton } from '@/components/customer-shell';
import { VendorCard, VendorGridSkeleton, EmptyNote, ItemCard, VENDOR_GRID } from '@/components/order-ui';
import { MARKET_GRID } from '@/components/customer-skeletons';

/**
 * [WEB-REDESIGN] Search, in the owner's design: back and the search field in
 * one row, kind chips, and the matches as list cards.
 *
 * [SEARCH 13 Oct] It asks the same search engine as the phone app's Search tab
 * (GET /search): stores AND the dishes and products inside them, forgiving of
 * a misspelling, a plural or the words in another order. It used to search
 * store names and descriptions only, as one exact piece of text. The chips
 * narrow the STORES by kind; dishes and products show under "All", because a
 * dish carries no kind of its own to narrow by.
 *
 * [Owner 13 Oct] Closed stores and their dishes are shown too, after the open
 * ones (the server orders them): a closed store's card says "Closed right now"
 * (VendorCard), and a closed store's dish says so under its store's name.
 *
 * [row 110] The browse pages' search bar (CatalogueSearchBar) hands its words
 * and category over in the address, `?q=…&type=RESTAURANT`, as the phone's
 * category screens open Search with `{ q, type }`: the page starts with them.
 * As you type it also offers the engine's suggestions (GET /search/
 * suggestions) as tappable words, as the phone does ([B2] "did you mean").
 */
const KINDS: { key: string; label: string; types: string[] | null }[] = [
  { key: 'all', label: 'All', types: null },
  { key: 'food', label: 'Food', types: ['RESTAURANT'] },
  { key: 'groceries', label: 'Groceries', types: ['SUPERMARKET'] },
  { key: 'shops', label: 'Shops', types: ['STORE'] },
  { key: 'services', label: 'Services', types: ['SERVICE'] },
];

const NONE: CatalogueResults = { stores: [], items: [] };

export default function SearchPage() {
  useOwnBackButton();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [results, setResults] = useState<CatalogueResults | null>(null);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  // A search that could not be asked is not "nothing matches" (DS1081 S4).
  const [failed, setFailed] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); sequence.current += 1; }, []);

  function onChange(v: string) {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    const request = ++sequence.current;
    if (v.trim().length < 2) { setResults(null); setSuggestions([]); setFailed(false); setBusy(false); return; }
    setBusy(true);
    debounce.current = setTimeout(() => {
      const words = v.trim();
      // Suggestions are garnish: a failed read shows none, never an error.
      searchSuggestions(words)
        .then((list) => { if (sequence.current === request) setSuggestions(list.filter((s) => s.text.toLowerCase() !== words.toLowerCase()).slice(0, 6)); })
        .catch(() => { if (sequence.current === request) setSuggestions([]); });
      searchCatalogue(words)
        .then((r) => { if (sequence.current === request) { setResults(r); setFailed(false); } })
        .catch(() => { if (sequence.current === request) { setResults(NONE); setFailed(true); } })
        .finally(() => { if (sequence.current === request) setBusy(false); });
    }, 300);
  }

  // [row 110] On arrival: the words and category a search bar handed over.
  // Mount-only on purpose (onChange only touches state setters and refs); it
  // runs again on a StrictMode remount, after the cleanup above cleared its timer.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const handed = KINDS.find((k) => k.types?.includes(params.get('type') ?? ''));
    if (handed) setKind(handed.key);
    const words = params.get('q');
    if (words) onChange(words.slice(0, 100));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = KINDS.find((k) => k.key === kind);
  const types = current?.types ?? null;
  const stores = (results?.stores ?? []).filter((v) => !types || types.includes(v.vendorType));
  const dishes = types ? [] : (results?.items ?? []);
  const nothingAtAll = results !== null && results.stores.length === 0 && results.items.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <BackButton />
        <label className="flex h-12 max-w-[640px] flex-1 items-center gap-2 rounded-full border border-[var(--swift-border-strong)] bg-[var(--swift-card)] pl-4 pr-2 focus-within:border-[var(--swift-red)]">
          <Search size={17} className="flex-none text-[var(--swift-muted-soft)]" aria-hidden />
          <input ref={input} autoFocus value={q} onChange={(e) => onChange(e.target.value)} aria-label="Search stores and dishes" placeholder="Stores, dishes, products…"
            className="min-w-0 flex-1 border-0 bg-transparent text-base leading-[22px] text-[var(--swift-ink)] outline-none placeholder:text-[var(--swift-muted-soft)]" />
          {q ? (
            <button type="button" onClick={() => { onChange(''); input.current?.focus(); }} aria-label="Clear" className="grid h-8 w-8 min-h-0 min-w-0 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent text-[var(--swift-muted-soft)]"><X size={16} aria-hidden /></button>
          ) : null}
        </label>
      </div>
      {suggestions.length > 0 ? (
        <div className="sw-chip-row" role="group" aria-label="Suggestions">
          {suggestions.map((s) => <button key={`${s.type}-${s.text}`} type="button" onClick={() => onChange(s.text)} className="sw-chip">{s.text}</button>)}
        </div>
      ) : null}
      <div className="sw-chip-row" role="group" aria-label="Kinds of store">
        {KINDS.map((k) => <button key={k.key} type="button" aria-pressed={kind === k.key} onClick={() => setKind(k.key)} className="sw-chip">{k.label}</button>)}
      </div>
      {results === null && !busy ? (
        <p className="sw-caption pt-2 text-[15px] leading-[22px]">Search for a store, a dish or a product — pepperpot, roti, hardware.</p>
      ) : null}
      {busy && <VendorGridSkeleton label="Searching" />}
      {!busy && results !== null ? (
        <>
          <h2 className="sw-title mt-2">{`Results for “${q.trim()}”`}</h2>
          {failed ? (
            <EmptyNote>Search isn’t answering right now. Please try again in a moment.</EmptyNote>
          ) : stores.length === 0 && dishes.length === 0 ? (
            <EmptyNote>{nothingAtAll
              ? `Nothing matches “${q.trim()}” — try a store’s name, a dish or a cuisine.`
              : `No ${current?.label.toLowerCase()} stores match “${q.trim()}”.`}</EmptyNote>
          ) : null}
          {stores.length > 0 ? (
            <section aria-label="Stores" className="flex flex-col gap-3">
              {dishes.length > 0 ? <h3 className="sw-heading">Stores</h3> : null}
              <div className={VENDOR_GRID}>{stores.map((v) => <VendorCard key={v.id} v={v} />)}</div>
            </section>
          ) : null}
          {dishes.length > 0 ? (
            <section aria-label="Dishes and products" className="flex flex-col gap-3">
              <h3 className="sw-heading">Dishes and products</h3>
              <ul className={MARKET_GRID}>
                {dishes.map((item) => (
                  <li key={item.id} className="min-w-0">
                    <ItemCard
                      href={`/order/vendor/${encodeURIComponent(item.vendorId)}?item=${encodeURIComponent(item.id)}`}
                      name={item.name}
                      price={item.basePrice}
                      imageUrl={item.imageUrl}
                      meta={item.vendorIsCurrentlyOpen === false ? `${item.vendorName} · Closed right now` : item.vendorName}
                      isNew={item.isNew}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
