'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchVendors } from '@/lib/api';
import { label, ratingText } from '@/lib/labels';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';

// [MISSION CONTROL · PR-1] The store list's errors, in words: a failed read is
// "Couldn't load the store list — Retry", never an empty table that reads as
// "no stores". Paging, search, filters and hiding test data come in PR-3.
//
// [MC-PR2] No "Approve" from the list: a store goes live by itself when its
// last required document is approved. The store's page shows which documents
// are still waiting, with a link to the Review Center.

interface VendorRow {
  id: string;
  name: string;
  vendorType: string;
  status: string;
  city?: string | null;
  averageRating?: number | null;
  totalRatings?: number | null;
  totalOrders?: number | null;
  owner?: { user?: { id?: string } | null } | null;
}

export default function VendorsPage() {
  const list = useQuery({ queryKey: ['vendors'], queryFn: () => fetchVendors() });
  const rows: VendorRow[] = list.data?.data ?? [];

  return (
    <div className="mc-page">
      <h1 className="mc-numbers text-2xl font-semibold mb-4" style={{ letterSpacing: '-0.02em' }}>Vendors</h1>
      {list.isLoading ? (
        <div className="mc-card" aria-busy="true">Loading the store list…</div>
      ) : list.isError ? (
        <QueryFailed error={list.error} what="the store list" onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <DataTable<VendorRow>
          label="Stores"
          rows={rows}
          rowKey={(v) => v.id}
          empty="No stores yet."
          columns={[
            {
              key: 'name', header: 'Name', width: '30%', primary: true,
              cell: (v) => (
                <Link href={`/vendors/${v.id}`} className="block min-w-0">
                  <Truncate text={v.name} />
                  {v.city ? <span className="mc-cell-sub"><Truncate text={v.city} /></span> : null}
                </Link>
              ),
            },
            { key: 'type', header: 'Type', width: '16%', cell: (v) => label('VendorType', v.vendorType) },
            { key: 'status', header: 'Status', width: '20%', cell: (v) => <StatusBadge group="VendorStatus" value={v.status} /> },
            { key: 'rating', header: 'Rating', width: '12%', cell: (v) => <span className="mc-numbers">{ratingText(v.averageRating, v.totalRatings)}</span> },
            { key: 'orders', header: 'Orders', width: '10%', align: 'right', cell: (v) => <span className="mc-numbers">{v.totalOrders ?? 0}</span> },
          ]}
        />
      )}
    </div>
  );
}
