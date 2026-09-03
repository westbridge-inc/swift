'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchRecentOrders } from '@/lib/api';
import { DataUnavailable } from './DataUnavailable';

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-red-500',
  ACCEPTED: 'bg-yellow-500',
  PREPARING: 'bg-yellow-500',
  READY_FOR_PICKUP: 'bg-blue-500',
  RIDER_ASSIGNED: 'bg-blue-500',
  PICKED_UP: 'bg-indigo-500',
  EN_ROUTE_DELIVERY: 'bg-indigo-500',
  DELIVERED: 'bg-green-500',
  COMPLETED: 'bg-green-500',
  CANCELLED: 'bg-gray-500',
};

export function LiveOrderFeed() {
  const { data, isError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['recentOrders'],
    queryFn: fetchRecentOrders,
    refetchInterval: 10_000,
  });
  // [A-06] "No recent orders" was rendered for a failed read too, so an outage
  // looked like a quiet evening on the busiest surface in the console.
  const blind = isError && !data?.data;

  return (
    <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
      <h3 className="text-lg font-semibold mb-4">Live Order Feed</h3>
      <div className="space-y-2 max-h-80 overflow-auto">
        {data?.data?.map((order: any) => (
          <Link key={order.id} href={`/orders/${order.id}`} className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 transition-colors">
            <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[order.status] || 'bg-gray-500'}`} />
            <span className="text-sm font-mono">#{order.orderNumber}</span>
            <span className="text-xs text-[var(--muted)]">{order.status}</span>
            <span className="text-xs text-[var(--muted)] ml-auto">
              ${Number(order.totalAmount).toLocaleString()}
            </span>
          </Link>
        )) ||
          (blind ? (
            <DataUnavailable
              what="The order feed"
              notAnAllClear="This is not an empty queue — orders may be flowing that this list cannot see."
              lastSuccessAt={dataUpdatedAt || undefined}
              onRetry={() => void refetch()}
            />
          ) : (
            <p className="text-[var(--muted)] text-sm">No recent orders</p>
          ))}
      </div>
    </div>
  );
}
