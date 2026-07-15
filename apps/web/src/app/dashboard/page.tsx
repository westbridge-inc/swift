'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Star } from 'lucide-react';
import { getLowStock, getOverview, toggleOpen, toggleOrders } from '@/lib/vendor-api';

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--swift-muted)]">{label}</p>
      <p className="mt-2 text-2xl font-extrabold">{value}</p>
      {sub && <p className="mt-1 text-xs text-[var(--swift-muted)]">{sub}</p>}
    </div>
  );
}

function Toggle({ label, on, onChange, busy }: { label: string; on: boolean; onChange: (_next: boolean) => void; busy: boolean }) {
  return (
    <button
      onClick={() => onChange(!on)}
      disabled={busy}
      className="flex items-center justify-between gap-4 rounded-2xl border border-black/5 bg-white p-5 text-left disabled:opacity-60"
    >
      <div>
        <p className="font-semibold">{label}</p>
        <p className={`mt-0.5 text-sm font-medium ${on ? 'text-green-600' : 'text-[var(--swift-red)]'}`}>{on ? 'On' : 'Off'}</p>
      </div>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-green-500' : 'bg-black/15'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

export default function TodayPage() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, refetchInterval: 30_000 });
  const lowStock = useQuery({ queryKey: ['low-stock'], queryFn: getLowStock, refetchInterval: 60_000 });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['overview'] });
  const openMut = useMutation({ mutationFn: toggleOpen, onSettled: invalidate });
  const ordersMut = useMutation({ mutationFn: toggleOrders, onSettled: invalidate });

  const d = overview.data;
  if (overview.isLoading) return <p className="text-sm text-[var(--swift-muted)]">Loading…</p>;
  if (!d) return <p className="text-sm text-[var(--swift-red)]">Could not load the overview — is the API reachable?</p>;

  const low = lowStock.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-extrabold">Today</h1>
        <div className="flex items-center gap-1 text-sm text-[var(--swift-muted)]">
          <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
          {Number(d.vendor.averageRating).toFixed(1)} ({d.vendor.totalRatings} ratings)
        </div>
      </div>

      {d.pendingOrders > 0 && (
        <Link
          href="/dashboard/orders"
          className="block rounded-2xl bg-[var(--swift-red)] p-5 font-semibold text-white"
        >
          {d.pendingOrders} new {d.pendingOrders === 1 ? 'order needs' : 'orders need'} a decision → open the queue
        </Link>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Orders today" value={String(d.today.orders)} sub={`${d.week.orders} this week`} />
        <Stat label="Revenue today" value={money(d.today.revenue)} sub={`${money(d.week.revenue)} this week`} />
        <Stat label="Revenue · 30 days" value={money(d.month.revenue)} sub={`${d.month.orders} orders`} />
        <Stat label="Live items" value={String(d.activeMenuItems)} sub={`${d.vendor.totalOrders} lifetime orders`} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Toggle
          label="Store open"
          on={d.vendor.isCurrentlyOpen}
          busy={openMut.isPending}
          onChange={(v) => openMut.mutate(v)}
        />
        <Toggle
          label="Accepting orders"
          on={d.vendor.acceptingOrders}
          busy={ordersMut.isPending}
          onChange={(v) => ordersMut.mutate(v)}
        />
      </div>

      {low.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <p className="flex items-center gap-2 font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4" /> Low stock ({low.length})
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {low.slice(0, 12).map((i) => (
              <span key={i.id} className="rounded-full bg-white px-3 py-1 text-sm">
                {i.name} <span className="font-bold text-amber-700">{i.stockQuantity ?? 0}</span>
              </span>
            ))}
          </div>
          <Link href="/dashboard/inventory" className="mt-3 inline-block text-sm font-semibold text-amber-800 underline">
            Restock in Inventory →
          </Link>
        </div>
      )}
    </div>
  );
}
