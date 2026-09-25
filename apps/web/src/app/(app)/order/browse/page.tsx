'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getVendors, type Vendor } from '@/lib/customer';
import { VendorCard, VendorGridSkeleton, EmptyNote } from '@/components/order-ui';
import { DataUnavailable } from '@/components/data-unavailable';

const TABS = [
  { key: '', label: 'All' },
  { key: 'RESTAURANT', label: 'Food' },
  { key: 'SUPERMARKET', label: 'Groceries' },
  { key: 'STORE', label: 'Shops' },
  { key: 'SERVICE', label: 'Services' },
];
const TITLE: Record<string, string> = { RESTAURANT: 'Food & takeaway', SUPERMARKET: 'Groceries', STORE: 'Shops', SERVICE: 'Services', '': 'All stores' };

function BrowseInner() {
  const params = useSearchParams();
  const type = params.get('type') ?? '';
  // [Q7b] Each list is kept per category, so going back to it is instant.
  const vendors = useQuery<Vendor[]>({ queryKey: ['customer', 'vendors', type], queryFn: () => getVendors(type || undefined) });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">{TITLE[type] ?? 'Stores'}</h1>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [overscroll-behavior-x:contain] [scrollbar-width:none]">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key ? `/order/browse?type=${t.key}` : '/order/browse'} replace
            aria-current={type === t.key ? 'page' : undefined}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${type === t.key ? 'bg-[var(--swift-red)] text-white' : 'border border-black/10 bg-white hover:bg-[var(--swift-subtle)]'}`}>
            {t.label}
          </Link>
        ))}
      </div>
      {vendors.isError && !vendors.data ? <DataUnavailable what="these stores" error={vendors.error} onRetry={() => void vendors.refetch()} />
        : !vendors.data ? <VendorGridSkeleton />
        : vendors.data.length === 0 ? <EmptyNote>No open stores in this category right now.</EmptyNote>
        : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{vendors.data.map((v) => <VendorCard key={v.id} v={v} />)}</div>}
    </div>
  );
}

export default function BrowsePage() {
  return <Suspense fallback={<VendorGridSkeleton />}><BrowseInner /></Suspense>;
}
