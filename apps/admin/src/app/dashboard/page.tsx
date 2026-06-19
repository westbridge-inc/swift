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
          <p className="text-[#8E8E93] text-sm">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Weekly Revenue"
          value={stats ? `$${Number(stats.weeklySubscriptionRevenue ?? 0).toLocaleString()}` : '—'}
          subtitle="GYD · subscriptions"
          loading={isLoading}
        />
        <MetricCard
          title="Orders Today"
          value={stats?.todayOrders?.toString() ?? '—'}
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
        <RevenueBreakdown data={stats?.subscriptionBreakdown} weeklyTotal={stats?.weeklySubscriptionRevenue} />
        <LiveOrderFeed />
      </div>

      <AlertsPanel />
    </div>
  );
}
