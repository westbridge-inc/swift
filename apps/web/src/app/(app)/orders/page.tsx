'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getOrders, money } from '@/lib/customer';
import { DataUnavailable } from '@/components/data-unavailable';

const LABEL: Record<string, string> = {
  PENDING: 'Pending', ACCEPTED: 'Accepted', PREPARING: 'Preparing', READY_FOR_PICKUP: 'Ready',
  RIDER_ASSIGNED: 'Rider on the way', PICKED_UP: 'Picked up', EN_ROUTE_DELIVERY: 'On the way',
  RETURNING: 'Returning to sender', RETURNED: 'Returned to sender',
  DELIVERED: 'Delivered', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};

export default function OrdersPage() {
  // [Q7b] Kept while you look at one order, so coming back is instant. Only
  // its owner can see it: signed out, this page is a sign-in door, and signing
  // in as someone else leaves the app shell — and this cache — behind.
  const orders = useQuery<any[]>({ queryKey: ['customer', 'orders'], queryFn: getOrders });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">Your orders</h1>
      {orders.isError && !orders.data ? <DataUnavailable what="your orders" error={orders.error} onRetry={() => void orders.refetch()} />
        : !orders.data ? <div className="h-40 animate-pulse rounded-2xl bg-[var(--swift-subtle)] motion-reduce:animate-none" />
        : orders.data.length === 0 ? (
          <div className="py-16 text-center text-[var(--swift-muted)]">
            <p>No orders yet.</p>
            <Link href="/" className="mt-3 inline-block rounded-full bg-[var(--swift-red)] px-5 py-2.5 font-bold text-white">Start an order</Link>
          </div>
        ) : orders.data.map((o) => (
          <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between rounded-2xl border border-black/5 bg-white p-4 transition-transform duration-100 hover:shadow-md active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100">
            <div>
              <p className="font-bold">{o.vendorName ?? o.vendor?.name ?? 'Order'}</p>
              <p className="text-sm text-[var(--swift-muted)]">{o.orderNumber} · {o.items?.length ?? o.itemCount ?? 0} item(s)</p>
            </div>
            <div className="text-right">
              <span className="rounded-full bg-[var(--swift-red-50)] px-2.5 py-1 text-xs font-bold text-[var(--swift-red)]">{LABEL[o.status] ?? o.status}</span>
              <p className="mt-1 font-bold">{money(o.totalAmount ?? o.total ?? 0)}</p>
            </div>
          </Link>
        ))}
    </div>
  );
}
