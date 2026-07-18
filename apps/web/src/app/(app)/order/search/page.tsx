'use client';

import { useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { searchVendors, type Vendor } from '@/lib/customer';
import { VendorCard, EmptyNote } from '@/components/order-ui';

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Vendor[] | null>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<any>(null);

  function onChange(v: string) {
    setQ(v);
    clearTimeout(debounce.current);
    if (v.trim().length < 2) { setResults(null); return; }
    setBusy(true);
    debounce.current = setTimeout(() => {
      searchVendors(v.trim()).then((r) => setResults(r)).catch(() => setResults([])).finally(() => setBusy(false));
    }, 300);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 rounded-full border border-black/10 bg-white px-4 py-3">
        <Search className="h-5 w-5 text-[var(--swift-muted)]" />
        <input autoFocus value={q} onChange={(e) => onChange(e.target.value)} placeholder="Search stores, cuisines…" className="w-full outline-none" />
      </div>
      {busy && <p className="text-sm text-[var(--swift-muted)]">Searching…</p>}
      {results !== null && (results.length === 0 ? <EmptyNote>No stores match “{q}”.</EmptyNote>
        : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{results.map((v) => <VendorCard key={v.id} v={v} />)}</div>)}
    </div>
  );
}
