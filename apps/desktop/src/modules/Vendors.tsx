import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchPaymentMix, fetchVendors } from '../lib/api';

// Vendors & Billing (spec §5.5): the vendor book + the money picture.
// Platform revenue = weekly subscriptions only; the payment mix shows how
// customers pay STORES (cash vs MMG) — context, never Swift's money.

// [VG-013] Explicit currency — Money.tsx says G$; a bare $ here made the two
// finance surfaces drift.
const money = (n: unknown) => `G$${Math.round(Number(n ?? 0)).toLocaleString()}`;

export default function Vendors() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const vendors = useQuery({ queryKey: ['d-vendors', q], queryFn: () => fetchVendors({ search: q || undefined }) });
  const mix = useQuery({ queryKey: ['payment-mix'], queryFn: fetchPaymentMix });

  const rows: any[] = vendors.data?.rows ?? [];
  const byMethod: any[] = mix.data?.byMethod ?? [];

  return (
    <div className="max-w-4xl space-y-5">
      {byMethod.length > 0 && (
        <div className="flex gap-4">
          {/* [WR-017] The server sends {method,count,total} (same contract
              Money.tsx consumes); this card was still reading the old Prisma
              group-by shape and rendered "undefined" labels and $0 totals. */}
          {byMethod.map((m) => (
            <div key={m.method} className="rounded-2xl border border-neutral-200 bg-neutral-100 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-400">
                {m.method === 'MOBILE_MONEY' ? 'MMG · 30d' : `${String(m.method).replaceAll('_', ' ')} · 30d`}
              </p>
              <p className="mt-1 text-xl font-extrabold">{money(m.total)}</p>
              <p className="text-xs text-neutral-400">{m.count} order{m.count === 1 ? '' : 's'} — customer→store money, not Swift's</p>
            </div>
          ))}
          {typeof mix.data?.mmgUnconfirmed === 'number' && mix.data.mmgUnconfirmed > 0 && (
            <div className="rounded-2xl border border-[var(--swift-red)]/40 bg-[var(--swift-red)]/10 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-400">MMG unconfirmed</p>
              <p className="mt-1 text-xl font-extrabold text-[var(--swift-red)]">{mix.data.mmgUnconfirmed}</p>
              <p className="text-xs text-neutral-400">stores haven't tapped “payment received”</p>
            </div>
          )}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); setQ(search.trim()); }} className="flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search stores…"
          className="w-80 rounded-lg border border-neutral-200 bg-black/30 px-3 py-2 text-sm outline-none focus:border-[var(--swift-red)]"
        />
        <button className="rounded-lg border border-neutral-200 px-4 py-2 text-sm">Search</button>
      </form>

      {vendors.isLoading && <p className="text-sm text-neutral-400">Loading…</p>}
      {vendors.isError && (
        <div className="rounded-2xl border border-neutral-200 bg-neutral-100 p-6 text-center">
          <p className="text-sm text-neutral-600">{(vendors.error as Error).message}</p>
          <button onClick={() => vendors.refetch()} className="mt-3 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">Try again</button>
        </div>
      )}
      {!vendors.isLoading && rows.length === 0 && !vendors.isError && (
        <p className="rounded-2xl border border-dashed border-neutral-200 p-10 text-center text-sm text-neutral-400">
          No stores match.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        {rows.map((v) => (
          <div key={v.id} className="rounded-xl border border-neutral-200 bg-neutral-100 p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">{v.name}</p>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  v.status === 'ACTIVE' ? 'bg-green-100 text-green-600'
                  : v.status === 'PENDING_APPROVAL' ? 'bg-amber-500/15 text-amber-600'
                  : 'bg-neutral-100 text-neutral-500'
                }`}
              >
                {String(v.status).replaceAll('_', ' ')}
              </span>
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              {v.vendorType} · {v.city ?? '—'} · {v.isCurrentlyOpen ? 'open' : 'closed'} ·{' '}
              {v.acceptingOrders ? 'accepting' : 'paused'}
            </p>
            {v.subscription && (
              <p className="mt-1 text-xs text-neutral-400">
                sub {v.subscription.status} · {money(v.subscription.weeklyRate)}/wk
              </p>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-neutral-400">
        Verification decisions live in Review; storefront edits live with the vendor. This is the book + the money picture.
      </p>
    </div>
  );
}
