'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getOrders, money } from '@/lib/customer';

const LABEL: Record<string, string> = {
  PENDING: 'Pending', ACCEPTED: 'Accepted', PREPARING: 'Preparing', READY_FOR_PICKUP: 'Ready',
  RIDER_ASSIGNED: 'Rider on the way', PICKED_UP: 'Picked up', EN_ROUTE_DELIVERY: 'On the way',
  DELIVERED: 'Delivered', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getOrders().then(setOrders).catch((e) => setError(e.message)); }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">Your orders</h1>
      {error ? <p className="text-[var(--swift-muted)]">{error}</p>
        : orders === null ? <div className="h-40 animate-pulse rounded-2xl bg-[var(--swift-subtle)]" />
        : orders.length === 0 ? (
          <div className="py-16 text-center text-[var(--swift-muted)]">
            <p>No orders yet.</p>
            <Link href="/order" className="mt-3 inline-block rounded-full bg-[var(--swift-red)] px-5 py-2.5 font-bold text-white">Start an order</Link>
          </div>
        ) : orders.map((o) => (
          <Link key={o.id} href={`/orders/${o.id}`} className="flex items-center justify-between rounded-2xl border border-black/5 bg-white p-4 hover:shadow-md">
            <div>
              <p className="font-bold">{o.vendorName ?? o.vendor?.name ?? 'Order'}</p>
              <p className="text-sm text-[var(--swift-muted)]">{o.orderNumber} · {o.items?.length ?? o.itemCount ?? 0} item(s)</p>
            </div>
            <div className="text-right">
              <span className="rounded-full bg-[var(--swift-red-50)] px-2.5 py-1 text-xs font-bold text-[var(--swift-red)]">{LABEL[o.status] ?? o.status}</span>
              <p className="mt-1 font-bold">{money(o.total ?? o.grandTotal ?? 0)}</p>
            </div>
          </Link>
        ))}
    </div>
  );
}
