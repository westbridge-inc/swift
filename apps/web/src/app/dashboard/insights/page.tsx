'use client';

import { useQuery } from '@tanstack/react-query';
import { getOverview, money } from '@/lib/vendor-api';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { DataUnavailable } from '@/components/data-unavailable';
import { CheckingLatest, useCheckingLatest } from '@/components/checking-latest';

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 sw-card p-5">
      <p className="break-words text-xs font-medium text-[var(--swift-muted)]">{label}</p>
      <p className="mt-2 break-words sw-title">{value}</p>
      {sub && <p className="mt-1 text-xs text-[var(--swift-muted)]">{sub}</p>}
    </div>
  );
}

/**
 * The app's Insights section (owners and managers only, as in the app). This
 * first version carries the figures the old web Today page showed; the app's
 * full Insights screen (revenue chart, acceptance, most ordered, busy hours,
 * standing, reviews, sales statement) follows in its own change.
 */
export default function InsightsPage() {
  const storeId = useStoreId();
  const { manager, known } = useStoreRole();
  const overview = useQuery({ queryKey: storeKey(storeId, 'overview'), queryFn: getOverview, enabled: manager, refetchInterval: 30_000 });
  const d = overview.data;
  const checkingLatest = useCheckingLatest(overview);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="sw-caption font-semibold uppercase tracking-wide text-[var(--swift-red)]">Money earned · GYD</p>
          <h1 className="sw-title">Insights</h1>
        </div>
      </div>
      {known && !manager && <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">Insights are for the store&apos;s owner and managers.</p>}
      {manager && overview.isLoading && <div role="status" className="sw-skeleton h-28"><span className="sr-only">Loading your figures…</span></div>}
      {manager && overview.isError && <DataUnavailable what="your figures" error={overview.error} onRetry={() => void overview.refetch()} />}
      {manager && d && <CheckingLatest show={checkingLatest} />}
      {manager && d && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Orders today" value={String(d.today.orders)} sub={`${d.week.orders} this week`} />
          <Stat label="Revenue today" value={money(d.today.revenue)} sub={`${money(d.week.revenue)} this week`} />
          <Stat label="Revenue · 30 days" value={money(d.month.revenue)} sub={`${d.month.orders} orders`} />
          <Stat label="Live items" value={String(d.activeMenuItems)} sub={`${d.vendor.totalOrders} lifetime orders`} />
        </div>
      )}
      <p className="text-center text-xs text-[var(--swift-muted)]">Reconciled numbers only — a beautiful wrong number is still a lie.</p>
    </div>
  );
}
