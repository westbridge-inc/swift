'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getDriverProfile, getDriverRides, getRiderDeliveries, getRiderProfile } from '@/lib/mover-api';
import { DataUnavailable } from '@/components/data-unavailable';
import { formatMoney as money, parseAmount } from '@/lib/money';

const when = (iso: unknown) => (iso ? new Date(String(iso)).toLocaleString() : '—');

function statusChip(s: string) {
  const done = ['DELIVERED', 'COMPLETED'].includes(s);
  const dead = s === 'CANCELLED';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${done ? 'bg-green-100 text-green-700' : dead ? 'bg-black/5 text-[var(--swift-muted)]' : 'bg-[var(--swift-red)]/10 text-[var(--swift-red)]'}`}>
      {s.replaceAll('_', ' ')}
    </span>
  );
}

function Pager({ page, setPage, meta }: { page: number; setPage: (_p: number) => void; meta?: { totalPages?: number; total?: number } }) {
  const totalPages = meta?.totalPages ?? 1;
  if (totalPages <= 1) return null;
  return (
    <div className="mt-3 flex items-center gap-3 text-sm">
      <button onClick={() => setPage(page - 1)} disabled={page <= 1} className="rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-1.5 disabled:opacity-40">← Prev</button>
      <span className="text-[var(--swift-muted)]">Page {page} of {totalPages}</span>
      <button onClick={() => setPage(page + 1)} disabled={page >= totalPages} className="rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-1.5 disabled:opacity-40">Next →</button>
    </div>
  );
}

function DeliveriesTable() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['p-deliveries', page], queryFn: () => getRiderDeliveries(page) });
  const rows = q.data?.rows ?? [];
  return (
    <>
    <div className="space-y-3 sm:hidden">
      {q.isLoading && <p className="rounded-2xl bg-[var(--swift-card)] p-4 text-sm text-[var(--swift-muted)]">Loading…</p>}
      {q.isError && <DataUnavailable what="your deliveries" error={q.error} onRetry={() => void q.refetch()} />}
      {q.isSuccess && rows.length === 0 && <p className="rounded-2xl bg-[var(--swift-card)] p-4 text-sm text-[var(--swift-muted)]">No deliveries yet.</p>}
      {rows.map((o) => (
        <article key={String(o['id'])} aria-label={`Delivery ${String(o['orderNumber'] ?? '')}`} className="min-w-0 sw-card p-4 text-sm sm:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>#{String(o['orderNumber'] ?? '')}</strong>
            {statusChip(String(o['status'] ?? ''))}
          </div>
          <p className="mt-2 break-words text-[var(--swift-muted)]">Store: {(o['vendor'] as { name?: string } | null)?.name ?? '—'}</p>
          <p className="mt-2 font-semibold">Your fee: {money(o['deliveryFee'])}</p>
          <p className="mt-1 text-[var(--swift-muted)]">{when(o['placedAt'])}</p>
        </article>
      ))}
      <Pager page={page} setPage={setPage} meta={q.data?.meta} />
    </div>
    <div className="hidden max-w-full overflow-x-auto sw-card sm:block">
      <table className="min-w-[680px] w-full text-sm">
        <thead className="border-b border-[var(--swift-border)] bg-[var(--swift-subtle)] text-left text-xs  text-[var(--swift-muted)]">
          <tr>
            <th className="px-4 py-3">Order</th>
            <th className="px-4 py-3">Store</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Your fee</th>
            <th className="px-4 py-3">When</th>
          </tr>
        </thead>
        <tbody>
          {q.isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--swift-muted)]">Loading…</td></tr>}
          {/* [W-10] a failed read used to render this same sentence, so an
              outage told a mover they had earned nothing. */}
          {q.isError && (
            <tr><td colSpan={5} className="p-4">
              <DataUnavailable what="your deliveries" error={q.error} onRetry={() => void q.refetch()} />
            </td></tr>
          )}
          {!q.isLoading && !q.isError && rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--swift-muted)]">No deliveries yet.</td></tr>}
          {rows.map((o) => (
            <tr key={String(o['id'])} className="border-b border-[var(--swift-border)] last:border-0">
              <td className="px-4 py-3 font-medium">#{String(o['orderNumber'] ?? '')}</td>
              <td className="px-4 py-3 text-[var(--swift-muted)]">{(o['vendor'] as { name?: string } | null)?.name ?? '—'}</td>
              <td className="px-4 py-3">{statusChip(String(o['status'] ?? ''))}</td>
              <td className="px-4 py-3 font-medium">{money(o['deliveryFee'])}</td>
              <td className="px-4 py-3 text-[var(--swift-muted)]">{when(o['placedAt'])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 pb-4"><Pager page={page} setPage={setPage} meta={q.data?.meta} /></div>
    </div>
    </>
  );
}

function RidesTable() {
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['p-rides', page], queryFn: () => getDriverRides(page) });
  const rows = q.data?.rows ?? [];
  return (
    <>
    <div className="space-y-3 sm:hidden">
      {q.isLoading && <p className="rounded-2xl bg-[var(--swift-card)] p-4 text-sm text-[var(--swift-muted)]">Loading…</p>}
      {q.isError && <DataUnavailable what="your rides" error={q.error} onRetry={() => void q.refetch()} />}
      {q.isSuccess && rows.length === 0 && <p className="rounded-2xl bg-[var(--swift-card)] p-4 text-sm text-[var(--swift-muted)]">No rides yet.</p>}
      {rows.map((r) => (
        <article key={String(r['id'])} aria-label={`Ride ${String(r['orderNumber'] ?? '')}`} className="min-w-0 sw-card p-4 text-sm sm:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>#{String(r['orderNumber'] ?? '')}</strong>
            {statusChip(String(r['status'] ?? ''))}
          </div>
          <p className="mt-2 break-words text-[var(--swift-muted)]">{String(r['taxiPickupAddress'] ?? '')} → {String(r['taxiDropoffAddress'] ?? '')}</p>
          <p className="mt-2 font-semibold">Fare: {money(r['taxiFareTotal'] ?? r['totalAmount'])}</p>
          <p className="mt-1 text-[var(--swift-muted)]">Tip: {(parseAmount(r['tipAmount']) ?? 0) > 0 ? money(r['tipAmount']) : '—'}</p>
        </article>
      ))}
      <Pager page={page} setPage={setPage} meta={q.data?.meta} />
    </div>
    <div className="hidden max-w-full overflow-x-auto sw-card sm:block">
      <table className="min-w-[680px] w-full text-sm">
        <thead className="border-b border-[var(--swift-border)] bg-[var(--swift-subtle)] text-left text-xs  text-[var(--swift-muted)]">
          <tr>
            <th className="px-4 py-3">Ride</th>
            <th className="px-4 py-3">Route</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Fare</th>
            <th className="px-4 py-3">Tip</th>
          </tr>
        </thead>
        <tbody>
          {q.isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--swift-muted)]">Loading…</td></tr>}
          {/* [W-10] a failed read used to render this same sentence, so an
              outage told a mover they had earned nothing. */}
          {q.isError && (
            <tr><td colSpan={5} className="p-4">
              <DataUnavailable what="your rides" error={q.error} onRetry={() => void q.refetch()} />
            </td></tr>
          )}
          {!q.isLoading && !q.isError && rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--swift-muted)]">No rides yet.</td></tr>}
          {rows.map((r) => (
            <tr key={String(r['id'])} className="border-b border-[var(--swift-border)] last:border-0">
              <td className="px-4 py-3 font-medium">#{String(r['orderNumber'] ?? '')}</td>
              <td className="max-w-72 px-4 py-3 text-[var(--swift-muted)]">
                <span className="line-clamp-1">{String(r['taxiPickupAddress'] ?? '')} → {String(r['taxiDropoffAddress'] ?? '')}</span>
              </td>
              <td className="px-4 py-3">{statusChip(String(r['status'] ?? ''))}</td>
              <td className="px-4 py-3 font-medium">{money(r['taxiFareTotal'] ?? r['totalAmount'])}</td>
              <td className="px-4 py-3 text-[var(--swift-muted)]">{(parseAmount(r['tipAmount']) ?? 0) > 0 ? money(r['tipAmount']) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-4 pb-4"><Pager page={page} setPage={setPage} meta={q.data?.meta} /></div>
    </div>
    </>
  );
}

export default function HistoryPage() {
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile, retry: 0 });
  const driver = useQuery({ queryKey: ['p-driver'], queryFn: getDriverProfile, retry: 0 });
  const both = !!rider.data && !!driver.data;
  const [tab, setTab] = useState<'deliveries' | 'rides'>('deliveries');
  const active = both ? tab : rider.data ? 'deliveries' : 'rides';

  return (
    <div className="space-y-5">
      <h1 className="sw-title">History</h1>
      {both && (
        <div className="flex gap-2">
          {(['deliveries', 'rides'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-2 text-sm font-semibold capitalize ${active === t ? 'bg-[var(--swift-red)] text-white' : 'border border-[var(--swift-border)] bg-[var(--swift-card)]'}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {rider.isLoading || driver.isLoading ? (
        <p className="text-sm text-[var(--swift-muted)]">Loading…</p>
      ) : active === 'deliveries' && rider.data ? (
        <DeliveriesTable />
      ) : driver.data ? (
        <RidesTable />
      ) : (
        <p className="text-sm text-[var(--swift-muted)]">No earner profile on this account.</p>
      )}
    </div>
  );
}
