'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchRevenue,
  fetchCashSettlements,
  fetchPaymentMix,
  fetchSettlements,
  processSettlement,
  type CashSettlementRow,
} from '@/lib/api';
import { MutationError } from '@/components/MutationError';

/**
 * `Number(n || 0)` rendered a MISSING amount as `$0` — and on a finance page a
 * real zero and an invented zero look identical while meaning opposite things
 * ("this store owes nothing" vs "we have no idea what this store owes").
 * A real 0 still prints `$0`; anything absent or unparseable prints an em-dash.
 *
 * Strings are accepted on purpose: the API coerces Prisma `Decimal`s to numbers
 * at its own seam, and this is the second line of defence for any endpoint that
 * has not been swept yet — a `"1200.00"` renders as $1,200, never as `—`.
 */
const gyd = (n: unknown) => {
  const v = typeof n === 'string' && n.trim() !== '' ? Number(n) : n;
  return typeof v === 'number' && Number.isFinite(v) ? `$${v.toLocaleString()}` : '—';
};

/**
 * A daily-revenue `date` is a GUYANA calendar day — the server buckets it at
 * Guyana-local midnight (`admin.routes.ts`, DASH-06) and sends the bare label
 * `YYYY-MM-DD`.
 *
 * `new Date('2026-08-23')` parses a date-only string as UTC midnight, and
 * `toLocaleDateString()` then re-renders it in the BROWSER's zone — so the same
 * bucket printed "22 Aug" for an operator in Georgetown and "23 Aug" for one in
 * London. Anchor at UTC midnight and format in UTC, so the three fields printed
 * are exactly the three fields the server sent, in every timezone.
 *
 * Anything that is not a `YYYY-MM-DD` renders as an em-dash: a wrong date is a
 * lie, a missing one is only missing.
 */
const gyDay = (ymd: unknown) =>
  typeof ymd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ymd)
    ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' })
    : '—';

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  MOBILE_MONEY: 'MMG',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Card',
  WALLET: 'Wallet',
};

const LEDGER_STATUS: Record<CashSettlementRow['status'], { label: string; cls: string }> = {
  OWED: { label: 'Owed', cls: 'bg-amber-500/15 text-amber-400' },
  RIDER_CONFIRMED: { label: 'Rider confirmed', cls: 'bg-sky-500/15 text-sky-400' },
  STORE_CONFIRMED: { label: 'Store confirmed', cls: 'bg-sky-500/15 text-sky-400' },
  SETTLED: { label: 'Settled', cls: 'bg-emerald-500/15 text-emerald-400' },
};

const LEDGER_FILTERS = ['ALL', 'OWED', 'RIDER_CONFIRMED', 'STORE_CONFIRMED', 'SETTLED'] as const;

/** MMG-vs-cash mix + the store⇄rider delivery-fee cash ledger. Visibility
 *  only — Swift records these debts, it never moves the money. */
function MmgSection() {
  const [filter, setFilter] = useState<(typeof LEDGER_FILTERS)[number]>('ALL');
  const mixQ = useQuery({ queryKey: ['payment-mix'], queryFn: fetchPaymentMix });
  const ledgerQ = useQuery({
    queryKey: ['cash-settlements', filter],
    queryFn: () => fetchCashSettlements(filter === 'ALL' ? 'limit=50' : `limit=50&status=${filter}`),
  });

  const mix = mixQ.data?.data;
  const rows = ledgerQ.data?.data ?? [];
  const summary = ledgerQ.data?.summary ?? {};
  const outstanding = (['OWED', 'RIDER_CONFIRMED', 'STORE_CONFIRMED'] as const).reduce(
    (acc, s) => ({ total: acc.total + (summary[s]?.total ?? 0), count: acc.count + (summary[s]?.count ?? 0) }),
    { total: 0, count: 0 },
  );

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">Payment mix (30d, completed)</p>
          {mixQ.isLoading ? (
            <p className="text-3xl font-bold mt-1">—</p>
          ) : (
            <div className="mt-2 space-y-1">
              {(mix?.byMethod ?? []).map((m) => (
                <div key={m.method} className="flex items-center justify-between text-sm">
                  <span className="text-[var(--muted)]">{METHOD_LABELS[m.method] ?? m.method}</span>
                  <span>
                    {m.count.toLocaleString()} orders · {gyd(m.total)}
                  </span>
                </div>
              ))}
              {(mix?.byMethod ?? []).length === 0 && <p className="text-sm text-[var(--muted)]">No completed orders yet.</p>}
            </div>
          )}
        </div>
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">Store → rider fees outstanding</p>
          <p className="text-3xl font-bold mt-1">{ledgerQ.isLoading ? '—' : gyd(outstanding.total)}</p>
          <p className="text-[var(--muted)] text-xs mt-1">{outstanding.count} unsettled handovers (MMG orders)</p>
        </div>
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">MMG deliveries unconfirmed</p>
          <p className="text-3xl font-bold mt-1">{mixQ.isLoading ? '—' : Number(mix?.mmgUnconfirmed ?? 0).toLocaleString()}</p>
          <p className="text-[var(--muted)] text-xs mt-1">delivered, vendor never marked the payment received</p>
        </div>
      </div>

      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 mb-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold">MMG cash ledger (store ⇄ rider)</h2>
          <div className="flex gap-1">
            {LEDGER_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-lg text-xs ${
                  filter === f ? 'bg-white text-black font-semibold' : 'bg-white/5 text-[var(--muted)] hover:bg-white/10'
                }`}
              >
                {f === 'ALL' ? 'All' : LEDGER_STATUS[f].label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[var(--muted)] text-xs mb-4">
          On MMG orders the customer pays the store (fee included), so the store hands the rider their
          delivery fee in cash. Swift tracks the debt until both sides confirm — it never moves the money.
        </p>
        {ledgerQ.isLoading ? (
          <p className="text-[var(--muted)] text-sm">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-[var(--muted)] text-sm">Nothing here — no {filter === 'ALL' ? '' : `${LEDGER_STATUS[filter as CashSettlementRow['status']].label.toLowerCase()} `}entries.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 p-2 rounded-lg bg-white/5 text-sm">
                <span className="text-[var(--muted)] w-28 shrink-0">{r.orderNumber ? `#${r.orderNumber}` : r.orderId.slice(0, 8)}</span>
                <span className="flex-1 truncate">
                  {r.vendor?.name ?? 'Store'} <span className="text-[var(--muted)]">owes</span> {r.rider?.name ?? 'rider'}
                </span>
                <span className="font-medium shrink-0">{gyd(r.amount)}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs shrink-0 ${LEDGER_STATUS[r.status].cls}`}>
                  {LEDGER_STATUS[r.status].label}
                </span>
                <span className="text-[var(--muted)] text-xs shrink-0">{new Date(r.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** [M-27] Weekly SALES DIGESTS: each vendor's own completed sales for one
 *  calendar week. Swift takes no cut and moves no vendor money, so a digest
 *  is acknowledged as reviewed — it is a record, never a payout. */
function SettlementsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['settlements'], queryFn: () => fetchSettlements('limit=50&status=PENDING') });
  const process = useMutation({
    mutationFn: ({ id, reference }: { id: string; reference?: string }) => processSettlement(id, reference),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settlements'] }),
  });
  const rows: any[] = data?.data ?? [];
  if (!isLoading && rows.length === 0) return null; // nothing pending → no noise

  return (
    <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 mb-6">
      <h2 className="text-lg font-semibold mb-1">Vendor sales digests to review</h2>
      <p className="text-[var(--muted)] text-xs mb-4">
        Each vendor’s own completed sales for the week. Swift takes no cut and pays nothing out — acknowledge a digest once you have reviewed it.
      </p>
      {process.error && (
        <div className="mb-3">
          <MutationError error={process.error} label="Settlement update failed" />
        </div>
      )}
      {isLoading ? (
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      ) : (
        <div className="space-y-2">
          {rows.map((s: any) => (
            <div key={s.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 text-sm">
              <span className="font-medium">{s.vendor?.name ?? 'Vendor'}</span>
              <span className="text-xs text-[var(--muted)]">
                {s.periodStart ? new Date(s.periodStart).toLocaleDateString() : ''} –{' '}
                {s.periodEnd ? new Date(s.periodEnd).toLocaleDateString() : ''}
              </span>
              <span className="ml-auto font-semibold">{gyd(s.netSales ?? s.totalBase ?? s.amount)}</span>
              <button
                onClick={() => {
                  const ref = window.prompt(`Note for ${s.vendor?.name ?? 'this digest'} (optional):`) ?? undefined;
                  if (window.confirm(`Acknowledge this sales digest? Swift moves no money — this records that you reviewed it.`)) process.mutate({ id: s.id, reference: ref || undefined });
                }}
                disabled={process.isPending}
                className="px-3 py-1 rounded-lg text-xs bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
              >
                Acknowledge
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FinancePage() {
  const { data, isLoading } = useQuery({ queryKey: ['revenue'], queryFn: fetchRevenue });
  const summary = data?.data?.summary;
  const daily = data?.data?.dailyRevenue ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Finance</h1>
      <p className="text-[var(--muted)] text-sm mb-6">
        Platform revenue is <span className="text-white">weekly subscriptions only</span> — no
        commission, no markup, no customer fees.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">Weekly Subscription Revenue</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : gyd(summary?.weeklySubscriptionRevenue)}</p>
          <p className="text-[var(--muted)] text-xs mt-1">GYD / week</p>
        </div>
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">Monthly Subscription Revenue</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : gyd(summary?.monthlySubscriptionRevenue)}</p>
          <p className="text-[var(--muted)] text-xs mt-1">GYD / month (approx.)</p>
        </div>
        <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
          <p className="text-[var(--muted)] text-sm">Active Subscriptions</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : Number(summary?.activeSubscriptions || 0).toLocaleString()}</p>
          <p className="text-[var(--muted)] text-xs mt-1">paying participants</p>
        </div>
      </div>

      {/* Manual vendor payouts awaiting a transfer reference */}
      <SettlementsSection />

      {/* MMG visibility — payment mix + the store⇄rider fee ledger */}
      <MmgSection />

      {/* Context only — money that flows to movers, NOT platform revenue. */}
      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 mb-6">
        <h2 className="text-lg font-semibold mb-1">Delivery volume (context)</h2>
        <p className="text-[var(--muted)] text-xs mb-4">
          Last 30 days. Delivery fees are collected by movers in cash — shown for operational context,
          not counted as platform revenue.
        </p>
        <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
          <span className="text-sm">Delivery fees (mover earnings, 30d)</span>
          <span className="text-sm font-semibold">{isLoading ? '—' : `${gyd(summary?.thirtyDayDeliveryFees)} GYD`}</span>
        </div>
      </div>

      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6">
        <h2 className="text-lg font-semibold mb-1">Daily completed orders (30 days)</h2>
        <p className="text-[var(--muted)] text-xs mb-4">
          Each row is a <span className="text-white">Guyana day</span> (midnight to midnight,
          UTC-4) — not the day your browser is in.
        </p>
        {isLoading ? (
          <p className="text-[var(--muted)] text-sm">Loading…</p>
        ) : daily.length === 0 ? (
          <p className="text-[var(--muted)] text-sm">No completed orders in the last 30 days.</p>
        ) : (
          <div className="space-y-2">
            {daily.map((row: { date: string; order_count: number; delivery_fees: number }) => (
              <div key={row.date} className="flex items-center justify-between p-2 rounded-lg bg-white/5 text-sm">
                <span className="text-[var(--muted)]">{gyDay(row.date)}</span>
                <span>{Number(row.order_count || 0).toLocaleString()} orders</span>
                <span className="font-medium">{gyd(row.delivery_fees)} GYD fees</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
