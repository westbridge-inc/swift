'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchRecentOrders } from '@/lib/api';
import { label } from '@/lib/labels';
import { DataUnavailable } from './DataUnavailable';

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-[var(--mc-bad)]',
  ACCEPTED: 'bg-[var(--mc-warn)]',
  PREPARING: 'bg-[var(--mc-warn)]',
  READY_FOR_PICKUP: 'bg-[var(--mc-info)]',
  RIDER_ASSIGNED: 'bg-[var(--mc-info)]',
  PICKED_UP: 'bg-[var(--mc-info)]',
  EN_ROUTE_DELIVERY: 'bg-[var(--mc-info)]',
  DELIVERED: 'bg-[var(--mc-good)]',
  COMPLETED: 'bg-[var(--mc-good)]',
  CANCELLED: 'bg-[var(--mc-line-strong)]',
};

export function LiveOrderFeed() {
  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['recentOrders'],
    queryFn: fetchRecentOrders,
    refetchInterval: 10_000,
  });
  // [A-06] "No recent orders" was rendered for a failed read too, so an outage
  // looked like a quiet evening on the busiest surface in the console.
  // [U59] ...and while the first read was still loading, and an empty answer
  // left a blank panel. Four states, each said once: loading, failed, none, rows.
  const orders: any[] | undefined = Array.isArray(data?.data) ? data.data : undefined;
  // A failed read, or an answer that is not a list, is never shown as "none".
  const blind = !orders && (isError || !isLoading);

  return (
    <div className="mc-card">
      <h3 className="mc-section-title">Live order feed</h3>
      <div className="space-y-2 max-h-80 overflow-auto">
        {isLoading ? (
          <p className="mc-muted" role="status">Loading recent orders…</p>
        ) : blind ? (
          <DataUnavailable
            what="The order feed"
            notAnAllClear="This is not an empty queue — orders may be flowing that this list cannot see."
            lastSuccessAt={dataUpdatedAt || undefined}
            onRetry={() => void refetch()}
          />
        ) : orders && orders.length === 0 ? (
          <p className="mc-muted">No recent orders</p>
        ) : (
          orders!.map((order: any) => (
            <Link key={order.id} href={`/orders/${order.id}`} className="flex min-h-[44px] items-center gap-3 rounded-[var(--mc-radius-sm)] p-2 hover:bg-[var(--mc-surface)]">
              <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[order.status] || 'bg-[var(--mc-line-strong)]'}`} />
              <span className="mc-numbers font-semibold">#{order.orderNumber}</span>
              <span className="mc-muted text-xs">{label('OrderStatus', order.status)}</span>
              <span className="mc-numbers mc-muted ml-auto text-xs">
                ${Number(order.totalAmount).toLocaleString()}
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
