'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCustomerSession } from '@/components/customer-session';
import { Search } from 'lucide-react';
import { searchVendors } from '@/lib/customer';
import { VendorCard, VendorGridSkeleton, EmptyNote } from '@/components/order-ui';

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const { status, scope, epoch } = useCustomerSession();
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const ready = q.trim().length >= 2 && term === q.trim();
  const search = useQuery({
    // Checking is its own scope: an early cookie-bearing answer must never
    // become the later guest's cache. No previous-query placeholder is used.
    queryKey: ['customer', 'search', status, scope, epoch, term],
    queryFn: () => searchVendors(term), enabled: ready,
    staleTime: 30_000, gcTime: 5 * 60_000, retry: false,
  });
  const busy = q.trim().length >= 2 && (!ready || search.isPending);
  const results = ready && !search.isPending ? search.data ?? [] : null;

  return (
    <div className="space-y-5">
      <div className="flex h-[50px] items-center gap-2 rounded-full border border-black/10 bg-white px-4">
        <Search className="h-5 w-5 text-[var(--swift-muted)]" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search stores" placeholder="Search stores, cuisines…" className="w-full outline-none" />
      </div>
      {busy && <VendorGridSkeleton label="Searching" />}
      {!busy && results !== null && (results.length === 0 ? <EmptyNote>No stores match “{q}”.</EmptyNote>
        : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{results.map((v) => <VendorCard key={v.id} v={v} />)}</div>)}
    </div>
  );
}
