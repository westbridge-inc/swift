'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchRiders } from '@/lib/api';
import { ENUM_LABELS, label, ratingText } from '@/lib/labels';
import { EMPTY_LIST_STATE, listQueryString, type ListState } from '@/lib/list-query';
import { maskedPhone } from '@/lib/review-center';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';
import { ListToolbar, Pager } from '@/components/mc/ListControls';

// [MC-PR3] Riders: server paging, search and filters, test data hidden by
// default, masked phones, plain words, a failed read said as one.
// [MC-PR2] Verifying a rider's documents happens on their page, beside the
// checklist that shows what is approved and what is missing — never blind from
// a list row (the old button also dropped the server's refusal).

interface RiderRow {
  id: string;
  riderType: string;
  isOnline: boolean;
  documentsVerified: boolean;
  averageRating?: number | null;
  totalRatings?: number | null;
  user?: { firstName?: string | null; lastName?: string | null; phone?: string | null } | null;
}

const STATUS_OPTIONS: Array<[string, string]> = [
  ['', 'Anyone'], ['online', 'Online now'], ['offline', 'Offline'], ['verified', 'Documents verified'], ['unverified', 'Documents not verified'],
];

export default function RidersPage() {
  const [state, setState] = useState<ListState>(EMPTY_LIST_STATE);
  const list = useQuery({ queryKey: ['riders', state], queryFn: () => fetchRiders(listQueryString(state)), placeholderData: keepPreviousData });
  const rows: RiderRow[] = list.data?.data ?? [];

  return (
    <div className="mc-page">
      <h1 className="mc-numbers text-2xl font-semibold mb-4" style={{ letterSpacing: '-0.02em' }}>Riders</h1>
      <ListToolbar
        state={state}
        onChange={setState}
        searchLabel="Search by name or phone"
        filters={[
          { key: 'status', label: 'Status', options: STATUS_OPTIONS },
          { key: 'type', label: 'Work', options: [['', 'All riders'], ...Object.entries(ENUM_LABELS.RiderType)] },
        ]}
      />
      {list.isLoading ? (
        <div className="mc-card" aria-busy="true">Loading riders…</div>
      ) : list.isError ? (
        <QueryFailed error={list.error} what="the rider list" onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <>
          <DataTable<RiderRow>
            label="Riders"
            rows={rows}
            rowKey={(r) => r.id}
            empty={state.search || Object.values(state.filters).some(Boolean) ? 'No rider matches this search.' : 'No riders yet.'}
            columns={[
              {
                key: 'name', header: 'Name', width: '28%', primary: true,
                cell: (r) => (
                  <Link href={`/riders/${r.id}`} className="block min-w-0">
                    <Truncate text={[r.user?.firstName, r.user?.lastName].filter(Boolean).join(' ') || 'Unnamed rider'} />
                  </Link>
                ),
              },
              { key: 'phone', header: 'Phone', width: '15%', cell: (r) => <span className="mc-numbers">{maskedPhone(r.user?.phone ?? undefined)}</span> },
              { key: 'work', header: 'Work', width: '16%', cell: (r) => label('RiderType', r.riderType) },
              { key: 'online', header: 'Now', width: '11%', cell: (r) => <span className={`mc-badge${r.isOnline ? ' mc-tone-good' : ''}`}>{r.isOnline ? 'Online' : 'Offline'}</span> },
              {
                key: 'docs', header: 'Documents', width: '17%',
                cell: (r) => (r.documentsVerified
                  ? <span className="mc-badge mc-tone-good">Verified</span>
                  : <Link href={`/riders/${r.id}`} className="mc-badge mc-tone-warn">Check documents</Link>),
              },
              { key: 'rating', header: 'Rating', width: '13%', cell: (r) => <span className="mc-numbers">{ratingText(r.averageRating, r.totalRatings)}</span> },
            ]}
          />
          <Pager meta={list.data?.meta} shown={rows.length} onPage={(page) => setState({ ...state, page })} onShowTestData={() => setState({ ...state, showTestData: true, page: 1 })} />
        </>
      )}
    </div>
  );
}
