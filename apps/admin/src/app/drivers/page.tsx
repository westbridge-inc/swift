'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDrivers, setDriverRideClass } from '@/lib/api';
import { label, ratingText } from '@/lib/labels';
import { EMPTY_LIST_STATE, listQueryString, type ListState } from '@/lib/list-query';
import { maskedPhone } from '@/lib/review-center';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';
import { ListToolbar, Pager } from '@/components/mc/ListControls';

// [MC-PR3] Drivers: server paging, search and filters, test data hidden by
// default, masked phones, plain words. A ride-class change goes through the
// reason panel and its answer is shown — the old select snapped back silently
// when the server refused. Group (minibus) rides stay off at launch.
// [MC-PR2] Verifying a driver's documents happens on their page, beside the
// checklist — never blind from a list row.

const RIDE_CLASSES = ['ECONOMY', 'COMFORT', 'XL'] as const;

interface DriverRow {
  id: string;
  isOnline: boolean;
  documentsVerified: boolean;
  rideClass?: string | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  averageRating?: number | null;
  totalRatings?: number | null;
  totalTrips?: number | null;
  user?: { firstName?: string | null; lastName?: string | null; phone?: string | null } | null;
}

const STATUS_OPTIONS: Array<[string, string]> = [
  ['', 'Anyone'], ['online', 'Online now'], ['offline', 'Offline'], ['verified', 'Documents verified'], ['unverified', 'Documents not verified'],
];

const nameOf = (d: DriverRow) => [d.user?.firstName, d.user?.lastName].filter(Boolean).join(' ') || 'Unnamed driver';

export default function DriversPage() {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const [state, setState] = useState<ListState>(EMPTY_LIST_STATE);
  const [result, setResult] = useState<Outcome | null>(null);
  const list = useQuery({ queryKey: ['drivers', state], queryFn: () => fetchDrivers(listQueryString(state)), placeholderData: keepPreviousData });
  const rows: DriverRow[] = list.data?.data ?? [];

  const changeClass = async (d: DriverRow, cls: string) => {
    const outcome = await dialog.run({
      title: `Set ${nameOf(d)}'s ride class to ${label('RideClass', cls)}?`,
      body: <p>Riders asking for a {label('RideClass', cls)} can be matched to them. Confirm the vehicle fits before you change it.</p>,
      confirmLabel: 'Change ride class',
      reason: { hint: 'Kept on the permanent record.' },
      submit: ({ reason }) => setDriverRideClass(d.id, cls, reason),
      success: () => `${nameOf(d)} now drives ${label('RideClass', cls)} rides.`,
    });
    if (!outcome) return;
    setResult(outcome);
    void qc.invalidateQueries({ queryKey: ['drivers'] });
  };

  return (
    <div className="mc-page">
      <h1 className="mc-numbers text-2xl font-semibold mb-4" style={{ letterSpacing: '-0.02em' }}>Drivers</h1>
      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-4" />
      <ListToolbar state={state} onChange={setState} searchLabel="Search by name or phone" filters={[{ key: 'status', label: 'Status', options: STATUS_OPTIONS }]} />
      {list.isLoading ? (
        <div className="mc-card" aria-busy="true">Loading drivers…</div>
      ) : list.isError ? (
        <QueryFailed error={list.error} what="the driver list" onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <>
          <DataTable<DriverRow>
            label="Drivers"
            rows={rows}
            rowKey={(d) => d.id}
            empty={state.search || Object.values(state.filters).some(Boolean) ? 'No driver matches this search.' : 'No drivers yet.'}
            columns={[
              {
                key: 'name', header: 'Name', width: '24%', primary: true,
                cell: (d) => (
                  <Link href={`/drivers/${d.id}`} className="block min-w-0">
                    <Truncate text={nameOf(d)} />
                    <span className="mc-cell-sub"><Truncate text={[d.vehicleMake, d.vehicleModel].filter(Boolean).join(' ') || 'No vehicle yet'} /></span>
                  </Link>
                ),
              },
              { key: 'phone', header: 'Phone', width: '14%', cell: (d) => <span className="mc-numbers">{maskedPhone(d.user?.phone ?? undefined)}</span> },
              {
                key: 'class', header: 'Ride class', width: '16%',
                cell: (d) => (
                  <select
                    aria-label={`Ride class for ${nameOf(d)}`}
                    className="mc-select"
                    value={d.rideClass ?? 'ECONOMY'}
                    onChange={(e) => { if (e.target.value !== (d.rideClass ?? 'ECONOMY')) void changeClass(d, e.target.value); }}
                  >
                    {RIDE_CLASSES.map((c) => <option key={c} value={c}>{label('RideClass', c)}</option>)}
                  </select>
                ),
              },
              { key: 'online', header: 'Now', width: '10%', cell: (d) => <span className={`mc-badge${d.isOnline ? ' mc-tone-good' : ''}`}>{d.isOnline ? 'Online' : 'Offline'}</span> },
              {
                key: 'docs', header: 'Documents', width: '16%',
                cell: (d) => (d.documentsVerified
                  ? <span className="mc-badge mc-tone-good">Verified</span>
                  : <Link href={`/drivers/${d.id}`} className="mc-badge mc-tone-warn">Check documents</Link>),
              },
              { key: 'rating', header: 'Rating', width: '12%', cell: (d) => <span className="mc-numbers">{ratingText(d.averageRating, d.totalRatings)}</span> },
              { key: 'trips', header: 'Trips', width: '8%', align: 'right', cell: (d) => <span className="mc-numbers">{d.totalTrips ?? 0}</span> },
            ]}
          />
          <Pager meta={list.data?.meta} shown={rows.length} onPage={(page) => setState({ ...state, page })} onShowTestData={() => setState({ ...state, showTestData: true, page: 1 })} />
        </>
      )}
    </div>
  );
}
