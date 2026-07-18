'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { getVendors, type Vendor } from '@/lib/customer';
import { VendorCard, VendorGridSkeleton, EmptyNote } from '@/components/order-ui';

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
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVendors(null); setError(null);
    getVendors(type || undefined).then(setVendors).catch((e) => setError(e.message));
  }, [type]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold">{TITLE[type] ?? 'Stores'}</h1>
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key ? `/order/browse?type=${t.key}` : '/order/browse'}
            className={`rounded-full px-4 py-2 text-sm font-semibold ${type === t.key ? 'bg-[var(--swift-red)] text-white' : 'border border-black/10 bg-white hover:bg-[var(--swift-subtle)]'}`}>
            {t.label}
          </Link>
        ))}
      </div>
      {error ? <EmptyNote>Couldn’t load stores — {error}</EmptyNote>
        : vendors === null ? <VendorGridSkeleton />
        : vendors.length === 0 ? <EmptyNote>No open stores in this category right now.</EmptyNote>
        : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{vendors.map((v) => <VendorCard key={v.id} v={v} />)}</div>}
    </div>
  );
}

export default function BrowsePage() {
  return <Suspense fallback={<VendorGridSkeleton />}><BrowseInner /></Suspense>;
}
