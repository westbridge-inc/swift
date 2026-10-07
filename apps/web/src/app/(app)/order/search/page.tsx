'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchVendors, type Vendor } from '@/lib/customer';
import { BackButton, useOwnBackButton } from '@/components/customer-shell';
import { VendorCard, VendorGridSkeleton, EmptyNote, VENDOR_GRID } from '@/components/order-ui';

/**
 * [WEB-REDESIGN] Search, in the owner's design: back and the search field in
 * one row, kind chips, and the matching stores as list cards. It searches
 * stores (their names, descriptions and cuisines) — the one search the server
 * offers — and the chips narrow those results by kind.
 */
const KINDS: { key: string; label: string; types: string[] | null }[] = [
  { key: 'all', label: 'All', types: null },
  { key: 'food', label: 'Food', types: ['RESTAURANT'] },
  { key: 'groceries', label: 'Groceries', types: ['SUPERMARKET', 'PHARMACY'] },
  { key: 'shops', label: 'Shops', types: ['STORE'] },
  { key: 'services', label: 'Services', types: ['SERVICE'] },
];

export default function SearchPage() {
  useOwnBackButton();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('all');
  const [results, setResults] = useState<Vendor[] | null>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); sequence.current += 1; }, []);

  function onChange(v: string) {
    setQ(v);
    if (debounce.current) clearTimeout(debounce.current);
    const request = ++sequence.current;
    if (v.trim().length < 2) { setResults(null); setBusy(false); return; }
    setBusy(true);
    debounce.current = setTimeout(() => {
      searchVendors(v.trim()).then((r) => { if (sequence.current === request) setResults(r); }).catch(() => { if (sequence.current === request) setResults([]); }).finally(() => { if (sequence.current === request) setBusy(false); });
    }, 300);
  }

  const types = KINDS.find((k) => k.key === kind)?.types ?? null;
  const shown = (results ?? []).filter((v) => !types || types.includes(v.vendorType));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <BackButton />
        <label className="flex h-12 max-w-[640px] flex-1 items-center gap-2 rounded-full border border-[var(--swift-border-strong)] bg-[var(--swift-card)] pl-4 pr-2 focus-within:border-[var(--swift-red)]">
          <Search size={17} className="flex-none text-[var(--swift-muted-soft)]" aria-hidden />
          <input ref={input} autoFocus value={q} onChange={(e) => onChange(e.target.value)} aria-label="Search stores" placeholder="Restaurants, groceries, shops…"
            className="min-w-0 flex-1 border-0 bg-transparent text-base leading-[22px] text-[var(--swift-ink)] outline-none placeholder:text-[var(--swift-muted-soft)]" />
          {q ? (
            <button type="button" onClick={() => { onChange(''); input.current?.focus(); }} aria-label="Clear" className="grid h-8 w-8 min-h-0 min-w-0 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent text-[var(--swift-muted-soft)]"><X size={16} aria-hidden /></button>
          ) : null}
        </label>
      </div>
      <div className="sw-chip-row" role="group" aria-label="Kinds of store">
        {KINDS.map((k) => <button key={k.key} type="button" aria-pressed={kind === k.key} onClick={() => setKind(k.key)} className="sw-chip">{k.label}</button>)}
      </div>
      {results === null && !busy ? (
        <p className="sw-caption pt-2 text-[15px] leading-[22px]">Search for a store by its name or what it serves — pepperpot, roti, hardware.</p>
      ) : null}
      {busy && <VendorGridSkeleton label="Searching" />}
      {!busy && results !== null ? (
        <>
          <h2 className="sw-title mt-2">{`Results for “${q.trim()}”`}</h2>
          {shown.length === 0
            ? <EmptyNote>{results.length === 0 ? `Nothing matches “${q.trim()}” — try a store’s name or a cuisine.` : `No ${KINDS.find((k) => k.key === kind)?.label.toLowerCase()} stores match “${q.trim()}”.`}</EmptyNote>
            : <div className={VENDOR_GRID}>{shown.map((v) => <VendorCard key={v.id} v={v} />)}</div>}
        </>
      ) : null}
    </div>
  );
}
