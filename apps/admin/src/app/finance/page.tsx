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

const gyd = (n: unknown) => `$${Number(n || 0).toLocaleString()}`;

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
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">Payment mix (30d, completed)</p>
          {mixQ.isLoading ? (
            <p className="text-3xl font-bold mt-1">—</p>
          ) : (
            <div className="mt-2 space-y-1">
              {(mix?.byMethod ?? []).map((m) => (
                <div key={m.method} className="flex items-center justify-between text-sm">
                  <span className="text-[#8E8E93]">{METHOD_LABELS[m.method] ?? m.method}</span>
                  <span>
                    {m.count.toLocaleString()} orders · {gyd(m.total)}
                  </span>
                </div>
              ))}
              {(mix?.byMethod ?? []).length === 0 && <p className="text-sm text-[#8E8E93]">No completed orders yet.</p>}
            </div>
          )}
        </div>
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">Store → rider fees outstanding</p>
          <p className="text-3xl font-bold mt-1">{ledgerQ.isLoading ? '—' : gyd(outstanding.total)}</p>
          <p className="text-[#8E8E93] text-xs mt-1">{outstanding.count} unsettled handovers (MMG orders)</p>
        </div>
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">MMG deliveries unconfirmed</p>
          <p className="text-3xl font-bold mt-1">{mixQ.isLoading ? '—' : Number(mix?.mmgUnconfirmed ?? 0).toLocaleString()}</p>
          <p className="text-[#8E8E93] text-xs mt-1">delivered, vendor never marked the payment received</p>
        </div>
      </div>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-6 mb-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold">MMG cash ledger (store ⇄ rider)</h2>
          <div className="flex gap-1">
            {LEDGER_FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-lg text-xs ${
                  filter === f ? 'bg-white text-black font-semibold' : 'bg-white/5 text-[#8E8E93] hover:bg-white/10'
                }`}
              >
                {f === 'ALL' ? 'All' : LEDGER_STATUS[f].label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[#8E8E93] text-xs mb-4">
          On MMG orders the customer pays the store (fee included), so the store hands the rider their
          delivery fee in cash. Swift tracks the debt until both sides confirm — it never moves the money.
        </p>
        {ledgerQ.isLoading ? (
          <p className="text-[#8E8E93] text-sm">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-[#8E8E93] text-sm">Nothing here — no {filter === 'ALL' ? '' : `${LEDGER_STATUS[filter as CashSettlementRow['status']].label.toLowerCase()} `}entries.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 p-2 rounded-lg bg-white/5 text-sm">
                <span className="text-[#8E8E93] w-28 shrink-0">{r.orderNumber ? `#${r.orderNumber}` : r.orderId.slice(0, 8)}</span>
                <span className="flex-1 truncate">
                  {r.vendor?.name ?? 'Store'} <span className="text-[#8E8E93]">owes</span> {r.rider?.name ?? 'rider'}
                </span>
                <span className="font-medium shrink-0">{gyd(r.amount)}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs shrink-0 ${LEDGER_STATUS[r.status].cls}`}>
                  {LEDGER_STATUS[r.status].label}
                </span>
                <span className="text-[#8E8E93] text-xs shrink-0">{new Date(r.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Manual weekly vendor payouts: mark PAID with a transfer reference. */
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
    <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-6 mb-6">
      <h2 className="text-lg font-semibold mb-1">Vendor settlements pending</h2>
      <p className="text-[#8E8E93] text-xs mb-4">
        Manual transfers — mark each PAID with its bank reference once the money has moved.
      </p>
      {isLoading ? (
        <p className="text-sm text-[#8E8E93]">Loading…</p>
      ) : (
        <div className="space-y-2">
          {rows.map((s: any) => (
            <div key={s.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 text-sm">
              <span className="font-medium">{s.vendor?.name ?? 'Vendor'}</span>
              <span className="text-xs text-[#8E8E93]">
                {s.periodStart ? new Date(s.periodStart).toLocaleDateString() : ''} –{' '}
                {s.periodEnd ? new Date(s.periodEnd).toLocaleDateString() : ''}
              </span>
              <span className="ml-auto font-semibold">{gyd(s.totalBase ?? s.amount)}</span>
              <button
                onClick={() => {
                  const ref = window.prompt(`Bank/transfer reference for ${s.vendor?.name ?? 'this settlement'} (optional):`) ?? undefined;
                  if (window.confirm(`Mark this settlement PAID?`)) process.mutate({ id: s.id, reference: ref || undefined });
                }}
                disabled={process.isPending}
                className="px-3 py-1 rounded-lg text-xs bg-[#E8192C] hover:bg-[#E8192C]/80 disabled:opacity-50"
              >
                Mark paid
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
      <p className="text-[#8E8E93] text-sm mb-6">
        Platform revenue is <span className="text-white">weekly subscriptions only</span> — no
        commission, no markup, no customer fees.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">Weekly Subscription Revenue</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : gyd(summary?.weeklySubscriptionRevenue)}</p>
          <p className="text-[#8E8E93] text-xs mt-1">GYD / week</p>
        </div>
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">Monthly Subscription Revenue</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : gyd(summary?.monthlySubscriptionRevenue)}</p>
          <p className="text-[#8E8E93] text-xs mt-1">GYD / month (approx.)</p>
        </div>
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">Active Subscriptions</p>
          <p className="text-3xl font-bold mt-1">{isLoading ? '—' : Number(summary?.activeSubscriptions || 0).toLocaleString()}</p>
          <p className="text-[#8E8E93] text-xs mt-1">paying participants</p>
        </div>
      </div>

      {/* Manual vendor payouts awaiting a transfer reference */}
      <SettlementsSection />

      {/* MMG visibility — payment mix + the store⇄rider fee ledger */}
      <MmgSection />

      {/* Context only — money that flows to movers, NOT platform revenue. */}
      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-6 mb-6">
        <h2 className="text-lg font-semibold mb-1">Delivery volume (context)</h2>
        <p className="text-[#8E8E93] text-xs mb-4">
          Last 30 days. Delivery fees are collected by movers in cash — shown for operational context,
          not counted as platform revenue.
        </p>
        <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
          <span className="text-sm">Delivery fees (mover earnings, 30d)</span>
          <span className="text-sm font-semibold">{isLoading ? '—' : `${gyd(summary?.thirtyDayDeliveryFees)} GYD`}</span>
        </div>
      </div>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-6">
        <h2 className="text-lg font-semibold mb-4">Daily completed orders (30 days)</h2>
        {isLoading ? (
          <p className="text-[#8E8E93] text-sm">Loading…</p>
        ) : daily.length === 0 ? (
          <p className="text-[#8E8E93] text-sm">No completed orders in the last 30 days.</p>
        ) : (
          <div className="space-y-2">
            {daily.map((row: { date: string; order_count: number; delivery_fees: number }) => (
              <div key={row.date} className="flex items-center justify-between p-2 rounded-lg bg-white/5 text-sm">
                <span className="text-[#8E8E93]">{new Date(row.date).toLocaleDateString()}</span>
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
