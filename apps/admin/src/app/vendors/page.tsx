'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchVendors, approveVendor } from '@/lib/api';
import { label, ratingText } from '@/lib/labels';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';

// [MISSION CONTROL · PR-1] The store list's errors, in words: a failed read is
// "Couldn't load the store list — Retry", never an empty table that reads as
// "no stores"; an approval answers in the page (the 409 "approve the documents
// first" included). Paging, search, filters and hiding test data come in PR-3.

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
  const queryClient = useQueryClient();
  const dialog = useActionDialog();
  const [result, setResult] = useState<Outcome | null>(null);
  const list = useQuery({ queryKey: ['vendors'], queryFn: () => fetchVendors() });
  const rows: VendorRow[] = list.data?.data ?? [];

  const approve = async (vendor: VendorRow) => {
    const outcome = await dialog.run({
      title: `Approve ${vendor.name}?`,
      body: (
        <p>
          The store goes live and can take orders. Swift first checks that every required document is approved; if one
          is not, nothing changes and you are told what is missing.
        </p>
      ),
      confirmLabel: 'Approve store',
      reason: { hint: 'Kept on the permanent record; not sent to the owner.' },
      context: { applicantId: vendor.owner?.user?.id },
      submit: ({ reason }) => approveVendor(vendor.id, reason),
      success: () => `${vendor.name} is live and can take orders.`,
    });
    if (!outcome) return;
    setResult(outcome);
    void queryClient.invalidateQueries({ queryKey: ['vendors'] });
  };

  return (
    <div className="mc-page">
      <h1 className="mc-numbers text-2xl font-semibold mb-4" style={{ letterSpacing: '-0.02em' }}>Vendors</h1>
      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-4" />
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
            { key: 'orders', header: 'Orders', width: '9%', align: 'right', cell: (v) => <span className="mc-numbers">{v.totalOrders ?? 0}</span> },
            {
              key: 'actions', header: 'Actions', width: '8.5rem', align: 'right',
              cell: (v) => (v.status === 'PENDING_APPROVAL' ? (
                <button type="button" className="mc-btn mc-btn-primary" onClick={() => void approve(v)} aria-label={`Approve ${v.name}…`}>
                  Approve…
                </button>
              ) : null),
            },
          ]}
        />
      )}
    </div>
  );
}
