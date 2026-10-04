'use client';

import BrowseLoading from './loading';
import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getVendors, type Vendor } from '@/lib/customer';
import { VendorCard, VendorGridSkeleton, EmptyNote, VENDOR_GRID } from '@/components/order-ui';
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
    <div className="flex flex-col gap-4">
      <div>
        <span className="sw-eyebrow">Stores on Swift</span>
        <h1 className="sw-title mt-1">{TITLE[type] ?? 'Stores'}</h1>
      </div>
      <nav aria-label="Kinds of store" className="sw-chip-row">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key ? `/order/browse?type=${t.key}` : '/order/browse'} replace
            aria-current={type === t.key ? 'page' : undefined}
            className="sw-chip">
            {t.label}
          </Link>
        ))}
      </nav>
      {vendors.isError && !vendors.data ? <DataUnavailable what="these stores" error={vendors.error} onRetry={() => void vendors.refetch()} />
        : !vendors.data ? <VendorGridSkeleton />
        : vendors.data.length === 0 ? <EmptyNote>No open stores in this category right now.</EmptyNote>
        : <div className={VENDOR_GRID}>{vendors.data.map((v) => <VendorCard key={v.id} v={v} />)}</div>}
    </div>
  );
}

export default function BrowsePage() {
  return <Suspense fallback={<BrowseLoading />}><BrowseInner /></Suspense>;
}
