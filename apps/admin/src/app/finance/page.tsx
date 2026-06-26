'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchRevenue } from '@/lib/api';

const gyd = (n: unknown) => `$${Number(n || 0).toLocaleString()}`;

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
