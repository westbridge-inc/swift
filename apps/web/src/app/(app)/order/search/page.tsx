'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { searchVendors, type Vendor } from '@/lib/customer';
import { VendorCard, VendorGridSkeleton, EmptyNote } from '@/components/order-ui';

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Vendor[] | null>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
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

  return (
    <div className="space-y-5">
      <div className="flex h-[50px] items-center gap-2 rounded-full border border-black/10 bg-white px-4">
        <Search className="h-5 w-5 text-[var(--swift-muted)]" />
        <input autoFocus value={q} onChange={(e) => onChange(e.target.value)} aria-label="Search stores" placeholder="Search stores, cuisines…" className="w-full outline-none" />
      </div>
      {busy && <VendorGridSkeleton />}
      {!busy && results !== null && (results.length === 0 ? <EmptyNote>No stores match “{q}”.</EmptyNote>
        : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{results.map((v) => <VendorCard key={v.id} v={v} />)}</div>)}
    </div>
  );
}
