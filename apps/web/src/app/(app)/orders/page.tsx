'use client';

import { useCustomerSession } from '@/components/customer-session';
import { OrdersListSkeleton, ORDER_ROW } from '@/components/customer-skeletons';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getOrders, money } from '@/lib/customer';
import { DataUnavailable } from '@/components/data-unavailable';
import { Pictogram, verticalPictogram, type PictogramName } from '@/components/glyphs';

const LABEL: Record<string, string> = {
  PENDING: 'Pending', ACCEPTED: 'Accepted', PREPARING: 'Preparing', READY_FOR_PICKUP: 'Ready',
  RIDER_ASSIGNED: 'Rider on the way', PICKED_UP: 'Picked up', EN_ROUTE_DELIVERY: 'On the way',
  RETURNING: 'Returning to sender', RETURNED: 'Returned to sender',
  DELIVERED: 'Delivered', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};

/** The status pill's tone: done is green, stopped is grey, money trouble is red, the rest is live. */
function tone(status: string): string {
  if (status === 'DELIVERED' || status === 'COMPLETED') return 'sw-status sw-status-success';
  if (status === 'CANCELLED' || status === 'RETURNED') return 'sw-status sw-status-neutral';
  if (status === 'REFUNDED' || status === 'FAILED') return 'sw-status sw-status-error';
  return 'sw-status';
}

const FINISHED = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'RETURNED', 'REFUNDED', 'FAILED']);

function pictogramFor(order: any): PictogramName {
  if (order.orderType === 'TAXI') return 'taxi';
  if (order.orderType === 'COURIER') return 'send';
  return verticalPictogram(order.vendor?.vendorType ?? (order.orderType === 'GROCERY_DELIVERY' ? 'SUPERMARKET' : null));
}

function nameOf(order: any): string {
  if (order.orderType === 'TAXI') return 'Taxi ride';
  if (order.orderType === 'COURIER') return 'Parcel';
  return order.vendorName ?? order.vendor?.name ?? 'Order';
}

function summaryOf(order: any): string {
  const names = Array.isArray(order.items) ? order.items.map((line: any) => line?.name).filter(Boolean) : [];
  const count = order.itemCount ?? order.items?.length ?? 0;
  return names.length ? names.join(' · ') : `${order.orderNumber ?? ''} · ${count} item(s)`;
}

/** "Today", "Yesterday", or the day — by the clock in Georgetown. */
function dayGroup(iso: string | undefined, now = new Date()): string {
  if (!iso) return 'Earlier';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const key = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guyana' }).format(d);
  if (key(date) === key(now)) return 'Today';
  if (key(date) === key(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'America/Guyana' }).format(date);
}

/**
 * [WEB-REDESIGN] "Orders & rides" in the owner's design: what is in
 * progress in a band at the top with Track, then the history by day as
 * hairline rows — the order, what was in it, its total and status.
 */
export default function OrdersPage() {
  // [Q7b] Kept while you look at one order, so coming back is instant. Only
  // its owner can see it: signed out, this page is a sign-in door, and signing
  // in as someone else leaves the app shell — and this cache — behind. The
  // person and epoch also isolate a session restored without leaving the shell.
  const { scope, epoch } = useCustomerSession();
  const orders = useQuery<any[]>({ queryKey: ['customer', 'orders', scope, epoch], queryFn: getOrders });

  const list = orders.data ?? [];
  const live = list.filter((o) => !FINISHED.has(o.status));
  const groups: { label: string; rows: any[] }[] = [];
  for (const order of list) {
    const label = dayGroup(order.placedAt ?? order.createdAt);
    const group = groups.find((g) => g.label === label);
    if (group) group.rows.push(order); else groups.push({ label, rows: [order] });
  }

  return (
    <div className="flex flex-col">
      <span className="sw-eyebrow">Orders &amp; rides</span>
      <h1 className="sw-title mt-1">Your activity</h1>
      {orders.isError && !orders.data ? <div className="mt-5"><DataUnavailable what="your orders" error={orders.error} onRetry={() => void orders.refetch()} /></div>
        : !orders.data ? <OrdersListSkeleton />
        : list.length === 0 ? (
          <div className="sw-empty">
            <span className="sw-empty-tile"><Pictogram name="orders" size={40} /></span>
            <p className="sw-heading">No orders yet</p>
            <p className="sw-caption text-[15px] leading-[22px]">What you order on Swift shows up here, with live tracking.</p>
            <Link href="/" className="sw-btn sw-btn-block mt-4 max-w-[400px]">Start an order</Link>
          </div>
        ) : (
          <>
            {live.length > 0 ? (
              <div className="sw-bleed sw-band mt-5 py-4">
                <span className="sw-eyebrow">In progress</span>
                {live.map((order) => (
                  <div key={order.id} className="mt-2 flex items-center gap-3">
                    <span aria-hidden className={`h-2 w-2 flex-none rounded-full ${order.status === 'PENDING' ? 'bg-[var(--swift-warning)]' : 'bg-[var(--swift-success)]'}`} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[15px] font-semibold leading-5">{nameOf(order)} · {LABEL[order.status] ?? order.status}</span>
                      <span className="truncate text-[13px] leading-[18px] text-[var(--swift-muted)]">{order.orderNumber}</span>
                    </span>
                    <Link href={`/orders/${order.id}`} aria-label={`Track ${nameOf(order)} ${order.orderNumber}`} className="sw-btn sw-btn-sm sw-btn-ink">Track</Link>
                  </div>
                ))}
              </div>
            ) : null}
            {groups.map((group) => (
              <section key={group.label} className="mt-6" aria-label={group.label}>
                <span className="sw-eyebrow sw-eyebrow-soft">{group.label}</span>
                <div className="mt-1">
                  {group.rows.map((o) => (
                    <Link key={o.id} href={`/orders/${o.id}`} className={`${ORDER_ROW} text-[var(--swift-ink)] active:opacity-70`}>
                      <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-[var(--swift-sunken)]"><Pictogram name={pictogramFor(o)} size={22} /></span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[15px] font-semibold leading-5">{nameOf(o)}</span>
                        <span className="truncate text-[13px] leading-[18px] text-[var(--swift-muted)]">{summaryOf(o)}</span>
                      </span>
                      <span className="flex flex-col items-end gap-1">
                        <span className="sw-money">{money(o.totalAmount ?? o.total)}</span>
                        <span className={tone(o.status)}>{LABEL[o.status] ?? o.status}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
    </div>
  );
}
