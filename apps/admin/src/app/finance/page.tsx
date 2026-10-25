'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchRevenue,
  fetchCashSettlements,
  fetchPaymentMix,
  fetchSettlements,
  processSettlement,
  type CashSettlementRow,
} from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';

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
  WALLET: 'Not in use',
};

const LEDGER_STATUS: Record<CashSettlementRow['status'], { label: string; cls: string }> = {
  OWED: { label: 'Owed', cls: 'bg-[var(--mc-warn-soft)] mc-text-warn' },
  RIDER_CONFIRMED: { label: 'Rider confirmed', cls: 'bg-[var(--mc-info-soft)] mc-text-info' },
  STORE_CONFIRMED: { label: 'Store confirmed', cls: 'bg-[var(--mc-info-soft)] mc-text-info' },
  SETTLED: { label: 'Settled', cls: 'bg-[var(--mc-good-soft)] mc-text-good' },
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
        <div className="mc-card">
          <p className="mc-muted text-sm">Payment mix (30d, completed)</p>
          {mixQ.isLoading ? (
            <p className="text-3xl font-bold mt-1">—</p>
          ) : mixQ.isError ? (
            <QueryFailed error={mixQ.error} what="the payment mix" onRetry={() => void mixQ.refetch()} retrying={mixQ.isFetching} className="mt-2" />
          ) : (
            <div className="mt-2 space-y-1">
              {(mix?.byMethod ?? []).map((m) => (
                <div key={m.method} className="flex items-center justify-between text-sm">
                  <span className="mc-muted">{METHOD_LABELS[m.method] ?? m.method}</span>
                  <span>
                    {m.count.toLocaleString()} orders · {gyd(m.total)}
                  </span>
                </div>
              ))}
              {(mix?.byMethod ?? []).length === 0 && <p className="text-sm mc-muted">No completed orders yet.</p>}
            </div>
          )}
        </div>
        <div className="mc-card">
          <p className="mc-muted text-sm">Store → rider fees outstanding</p>
          <p className="text-3xl font-bold mt-1">{ledgerQ.isLoading || ledgerQ.isError ? '—' : gyd(outstanding.total)}</p>
          <p className="mc-muted text-xs mt-1">
            {ledgerQ.isError ? 'Not loaded — see the ledger below' : `${ledgerQ.isLoading ? '—' : outstanding.count} unsettled handovers (MMG orders)`}
          </p>
        </div>
        <div className="mc-card">
          <p className="mc-muted text-sm">MMG deliveries unconfirmed</p>
          <p className="text-3xl font-bold mt-1">{mixQ.isLoading || mixQ.isError ? '—' : Number(mix?.mmgUnconfirmed ?? 0).toLocaleString()}</p>
          <p className="mc-muted text-xs mt-1">delivered, vendor never marked the payment received</p>
        </div>
      </div>

      <div className="mc-card mb-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="mc-section-title mb-0">MMG cash ledger (store ⇄ rider)</h2>
          <div className="flex gap-1">
            {LEDGER_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className="mc-tab"
              >
                {f === 'ALL' ? 'All' : LEDGER_STATUS[f].label}
              </button>
            ))}
          </div>
        </div>
        <p className="mc-muted text-xs mb-4">
          On MMG orders the customer pays the store (fee included), so the store hands the rider their
          delivery fee in cash. Swift tracks the debt until both sides confirm — it never moves the money.
        </p>
        {ledgerQ.isLoading ? (
          <p className="mc-muted text-sm">Loading…</p>
        ) : ledgerQ.isError ? (
          <QueryFailed error={ledgerQ.error} what="the MMG cash ledger" onRetry={() => void ledgerQ.refetch()} retrying={ledgerQ.isFetching} />
        ) : rows.length === 0 ? (
          <p className="mc-muted text-sm">Nothing here — no {filter === 'ALL' ? '' : `${LEDGER_STATUS[filter as CashSettlementRow['status']].label.toLowerCase()} `}entries.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 p-2 rounded-lg bg-[var(--mc-surface)] text-sm">
                <span className="mc-muted w-28 shrink-0">{r.orderNumber ? `#${r.orderNumber}` : r.orderId.slice(0, 8)}</span>
                <span className="flex-1 truncate">
                  {r.vendor?.name ?? 'Store'} <span className="mc-muted">owes</span> {r.rider?.name ?? 'rider'}
                </span>
                <span className="font-medium shrink-0">{gyd(r.amount)}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs shrink-0 ${LEDGER_STATUS[r.status].cls}`}>
                  {LEDGER_STATUS[r.status].label}
                </span>
                <span className="mc-muted text-xs shrink-0">{new Date(r.createdAt).toLocaleDateString()}</span>
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
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['settlements'], queryFn: () => fetchSettlements('limit=50&status=PENDING') });
  // [U28] Acknowledging is classified C4: its first answer can be a second
  // admin's approval, which used to print as "Settlement update failed".
  const actions = useActionRunner(() => qc.invalidateQueries({ queryKey: ['settlements'] }));
  const [queuedRows, setQueuedRows] = useState<Record<string, true>>({});
  const acknowledge = (s: any) => void actions.run({
    title: `Acknowledge the sales digest for ${s.vendor?.name ?? 'this vendor'}?`,
    body: <p>Swift moves no money: this records that you reviewed it.</p>,
    confirmLabel: 'Acknowledge',
    fields: [{ kind: 'text', name: 'note', label: 'Note', hint: 'Optional: a reference to the report you checked it against' }],
    submit: ({ reason, values }) => processSettlement(s.id, String(values['note'] ?? '') || undefined, reason),
    success: () => 'Digest acknowledged.',
  }).then((outcome) => { if (outcome?.tone === 'queued') setQueuedRows((all) => ({ ...all, [s.id]: true })); });
  const rows: any[] = data?.data ?? [];
  // Nothing pending → no noise. A failed read is not "nothing pending": it shows below.
  if (!isLoading && !isError && rows.length === 0) return null;

  return (
    <div className="mc-card mb-5">
      <h2 className="text-lg font-semibold mb-1">Vendor sales digests to review</h2>
      <p className="mc-muted text-xs mb-4">
        Each vendor’s own completed sales for the week. Swift takes no cut and pays nothing out — acknowledge a digest once you have reviewed it.
      </p>
      {actions.banner}
      {isLoading ? (
        <p className="text-sm mc-muted">Loading…</p>
      ) : isError ? (
        <QueryFailed error={error} what="the sales digests" onRetry={() => void refetch()} retrying={isFetching} />
      ) : (
        <div className="space-y-2">
          {rows.map((s: any) => (
            <div key={s.id} className="flex items-center gap-3 p-3 rounded-lg bg-[var(--mc-surface)] text-sm">
              <span className="font-medium">{s.vendor?.name ?? 'Vendor'}</span>
              <span className="mc-muted text-xs">
                {s.periodStart ? new Date(s.periodStart).toLocaleDateString() : ''} –{' '}
                {s.periodEnd ? new Date(s.periodEnd).toLocaleDateString() : ''}
              </span>
              <span className="ml-auto font-semibold">{gyd(s.netSales ?? s.totalBase ?? s.amount)}</span>
              <button
                type="button"
                onClick={() => acknowledge(s)}
                disabled={queuedRows[s.id] === true}
                className="px-3 py-1 rounded-lg text-xs bg-[var(--mc-accent)] disabled:opacity-50"
              >
                {queuedRows[s.id] ? 'Waiting for approval' : 'Acknowledge'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FinancePage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['revenue'], queryFn: fetchRevenue });
  const summary = data?.data?.summary;
  const daily = data?.data?.dailyRevenue ?? [];

  return (
    <div className="mc-page">
      <p className="mc-muted text-sm mb-6">
        Platform revenue is <span className="font-semibold text-[var(--mc-ink)]">weekly subscriptions only</span> — no
        commission, no markup, no customer fees.
      </p>

      {isError ? (
        <QueryFailed error={error} what="the revenue figures" onRetry={() => void refetch()} retrying={isFetching} className="mb-6" />
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="mc-card">
          <p className="mc-muted text-sm">Weekly Subscription Revenue</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : gyd(summary?.weeklySubscriptionRevenue)}</p>
          <p className="mc-muted text-xs mt-1">GYD / week</p>
        </div>
        <div className="mc-card">
          <p className="mc-muted text-sm">Monthly Subscription Revenue</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : gyd(summary?.monthlySubscriptionRevenue)}</p>
          <p className="mc-muted text-xs mt-1">GYD / month (approx.)</p>
        </div>
        <div className="mc-card">
          <p className="mc-muted text-sm">Active Subscriptions</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : Number(summary?.activeSubscriptions || 0).toLocaleString()}</p>
          <p className="mc-muted text-xs mt-1">paying participants</p>
        </div>
      </div>
      )}

      {/* Manual vendor payouts awaiting a transfer reference */}
      <SettlementsSection />

      {/* MMG visibility — payment mix + the store⇄rider fee ledger */}
      <MmgSection />

      {/* Context only — money that flows to movers, NOT platform revenue. */}
      <div className="mc-card mb-5">
        <h2 className="text-lg font-semibold mb-1">Delivery volume (context)</h2>
        <p className="mc-muted text-xs mb-4">
          Last 30 days. Delivery fees are collected by movers in cash — shown for operational context,
          not counted as platform revenue.
        </p>
        <div className="flex items-center justify-between rounded-[var(--mc-radius-sm)] bg-[var(--mc-surface)] p-3">
          <span className="text-sm">Delivery fees (mover earnings, 30d)</span>
          <span className="text-sm font-semibold">{isLoading || isError ? '—' : `${gyd(summary?.thirtyDayDeliveryFees)} GYD`}</span>
        </div>
      </div>

      <div className="mc-card">
        <h2 className="text-lg font-semibold mb-1">Daily completed orders (30 days)</h2>
        <p className="mc-muted text-xs mb-4">
          Each row is a <span className="font-semibold text-[var(--mc-ink)]">Guyana day</span> (midnight to midnight,
          UTC-4) — not the day your browser is in.
        </p>
        {isLoading ? (
          <p className="mc-muted text-sm">Loading…</p>
        ) : isError ? (
          <p className="mc-muted text-sm">Not loaded — the revenue read failed (see above).</p>
        ) : daily.length === 0 ? (
          <p className="mc-muted text-sm">No completed orders in the last 30 days.</p>
        ) : (
          <div className="space-y-2">
            {daily.map((row: { date: string; order_count: number; delivery_fees: number }) => (
              <div key={row.date} className="flex items-center justify-between p-2 rounded-lg bg-[var(--mc-surface)] text-sm">
                <span className="mc-muted">{gyDay(row.date)}</span>
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
