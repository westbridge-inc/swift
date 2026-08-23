'use client';

import { useQuery } from '@tanstack/react-query';
import { QueryFailed } from '@/components/MutationNotice';
import { fetchCountries } from '@/lib/api';

/** Weekly tier prices live in subscriptionTiers JSON: { mover, smallVendor, largeVendor, ... }. */
function tier(c: any, key: string) {
  const v = c?.subscriptionTiers?.[key];
  return v != null ? `${c.currencySymbol}${Number(v).toLocaleString()}` : '—';
}

export default function MarketsPage() {
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['countries'], queryFn: fetchCountries });
  const rows: any[] = data?.data ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Markets</h1>
      <p className="text-[var(--muted)] text-sm mb-6">
        Every live market&apos;s money rules — currency, ID gate, rider float caps, weekly tiers. Read-only:
        these numbers gate real money, so edits ship with the billing-rail work, not a free-text box.
      </p>

      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-4 text-[var(--muted)] font-medium">Market</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Currency</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">per USD</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">ID gate (USD)</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Float L1 / L2 / L3</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Mover / wk</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Small vendor / wk</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Large vendor / wk</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={8} className="p-8 text-center text-[var(--muted)]">Loading…</td></tr>
            ) : isError ? (
              <QueryFailed error={error} what="markets" onRetry={() => refetch()} />
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="p-8 text-center text-[var(--muted)]">No markets configured.</td></tr>
            ) : (
              rows.map((c: any) => (
                <tr key={c.id} className="border-b border-[var(--border)] hover:bg-white/5">
                  <td className="p-4 font-medium">
                    {c.name} <span className="text-xs text-[var(--muted)] font-mono ml-1">{c.code}</span>
                  </td>
                  <td className="p-4">{c.currencyCode} ({c.currencySymbol})</td>
                  <td className="p-4 text-right">{Number(c.usdExchangeRate).toLocaleString()}</td>
                  <td className="p-4 text-right">${Number(c.idGateThresholdUsd).toLocaleString()}</td>
                  <td className="p-4 text-right text-[var(--muted)]">
                    {Number(c.floatL1).toLocaleString()} / {Number(c.floatL2).toLocaleString()} / {Number(c.floatL3).toLocaleString()}
                  </td>
                  <td className="p-4 text-right">{tier(c, 'mover')}</td>
                  <td className="p-4 text-right">{tier(c, 'smallVendor')}</td>
                  <td className="p-4 text-right">{tier(c, 'largeVendor')}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
