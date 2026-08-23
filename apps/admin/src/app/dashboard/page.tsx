'use client';

import { MetricCard } from '@/components/dashboard/MetricCard';
import { RevenueBreakdown } from '@/components/dashboard/RevenueBreakdown';
import { LiveOrderFeed } from '@/components/dashboard/LiveOrderFeed';
import { AlertsPanel } from '@/components/dashboard/AlertsPanel';
import { useQuery } from '@tanstack/react-query';
import { fetchDashboard } from '@/lib/api';

export default function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: fetchDashboard,
    refetchInterval: 30_000,
  });

  const stats = data?.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-[var(--muted)] text-sm">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard
          title="Weekly Revenue"
          value={stats ? `$${Number(stats.revenue?.weeklySubscriptionRevenue ?? 0).toLocaleString()}` : '—'}
          subtitle="GYD · subscriptions"
          loading={isLoading}
        />
        {/* Placed alone is not a health signal [F-260]: 40 placed against 12
            completed is a bad day that reads as a good one. The overview has
            computed todayCompletedOrders all along and the card dropped it. */}
        <MetricCard
          title="Orders Today"
          value={stats?.todayOrders?.toString() ?? '—'}
          subtitle={
            stats?.todayCompletedOrders != null
              ? `${stats.todayCompletedOrders} completed`
              : undefined
          }
          loading={isLoading}
        />
        {/* Riders and drivers each had a card and MERCHANTS had none — on a
            marketplace where merchants are the constrained side of supply.
            activeVendors/totalVendors were computed and rendered nowhere in
            the whole admin app [F-260]. */}
        <MetricCard
          title="Live Merchants"
          value={stats?.activeVendors?.toString() ?? '—'}
          subtitle={stats?.totalVendors != null ? `of ${stats.totalVendors} onboarded` : undefined}
          loading={isLoading}
        />
        <MetricCard
          title="Active Riders"
          value={stats?.activeRiders?.toString() ?? '—'}
          subtitle="online"
          loading={isLoading}
        />
        <MetricCard
          title="Active Drivers"
          value={stats?.activeDrivers?.toString() ?? '—'}
          subtitle="online"
          loading={isLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RevenueBreakdown data={stats?.subscriptionBreakdown} weeklyTotal={stats?.revenue?.weeklySubscriptionRevenue} />
        <LiveOrderFeed />
      </div>

      <AlertsPanel alerts={stats?.alerts} />
    </div>
  );
}
