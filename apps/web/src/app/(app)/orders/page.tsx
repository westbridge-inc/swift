'use client';

import { useCustomerSession } from '@/components/customer-session';
import { OrdersListSkeleton, ORDER_ROW } from '@/components/customer-skeletons';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { money } from '@/lib/customer';
import { getLiveOrders, getOrderHistoryPage, reorder } from '@/lib/customer-orders';
import { orderStatusLabel, presentedVertical, reorderNotice } from '@/lib/order-words';
import { DataUnavailable } from '@/components/data-unavailable';
import { Pictogram, verticalPictogram, type PictogramName } from '@/components/glyphs';

/** [UI-SWEEP U14] The phone's words for a status (lib/orderStatus.ts), by the order's own vertical. */
const statusWords = (order: any): string => orderStatusLabel(order?.status, presentedVertical(order ?? {}));

/** [UI-SWEEP U17] Only a store order can be put back in the cart: a ride has no
 *  storefront, a parcel has no store, and a booking is a time, not a basket. */
function canReorder(order: any): boolean {
  const vertical = presentedVertical(order ?? {});
  return (vertical === 'FOOD_DELIVERY' || vertical === 'GROCERY_DELIVERY') && order?.fulfillment !== 'APPOINTMENT'
    && (order?.status === 'DELIVERED' || order?.status === 'COMPLETED');
}

/** The status pill's tone: done is green, stopped is grey, money trouble is red, the rest is live. */
function tone(status: string): string {
  if (status === 'DELIVERED' || status === 'COMPLETED') return 'sw-status sw-status-success';
  if (status === 'CANCELLED' || status === 'RETURNED') return 'sw-status sw-status-neutral';
  if (status === 'REFUNDED' || status === 'FAILED') return 'sw-status sw-status-error';
  return 'sw-status';
}

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
  // [UI-SWEEP U13] Two reads, as on the phone: every live order asked for as
  // such, and the finished ones paged. Filtering the newest 20 for live orders
  // missed an older order still in progress, and older history was unreachable.
  const liveOrders = useQuery({ queryKey: ['customer', 'orders', 'live', scope, epoch], queryFn: getLiveOrders });
  const history = useInfiniteQuery({
    queryKey: ['customer', 'orders', 'history', scope, epoch],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => getOrderHistoryPage(pageParam),
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
  const queryClient = useQueryClient();
  const router = useRouter();
  const [leftOut, setLeftOut] = useState<{ id: string; title: string; description: string } | null>(null);
  const again = useMutation({
    mutationFn: (id: string) => reorder(id),
    onSuccess: async (result, id) => {
      await queryClient.invalidateQueries({ queryKey: ['customer', 'cart'] });
      // [L09] Lines left out are named before the cart opens, as on the phone.
      const notice = reorderNotice(result);
      if (notice) setLeftOut({ id, ...notice });
      else router.push('/cart');
    },
  });

  const live: any[] = liveOrders.data?.items ?? [];
  const liveIds = new Set(live.map((o) => String(o.id)));
  // Reconciled BY ID, never by re-deriving liveness: an order both reads
  // returned (it changed between them) is shown once, as live.
  const loaded: any[] = (history.data?.pages ?? []).flatMap((page) => page.items);
  const rows = loaded.filter((o) => !liveIds.has(String(o.id)));
  const lastPage = history.data?.pages.at(-1);
  const historyTotal = lastPage?.total ?? null;
  const liveHidden = liveOrders.data?.total != null && liveOrders.data.total > live.length ? liveOrders.data.total - live.length : 0;
  const groups: { label: string; rows: any[] }[] = [];
  for (const order of rows) {
    const label = dayGroup(order.placedAt ?? order.createdAt);
    const group = groups.find((g) => g.label === label);
    if (group) group.rows.push(order); else groups.push({ label, rows: [order] });
  }
  const failed = liveOrders.isError ? liveOrders : history.isError && !history.data ? history : null;
  const ready = liveOrders.data !== undefined && history.data !== undefined;

  return (
    <div className="flex flex-col">
      <span className="sw-eyebrow">Orders &amp; rides</span>
      <h1 className="sw-title mt-1">Your activity</h1>
      {failed ? <div className="mt-5"><DataUnavailable what="your orders" error={failed.error} onRetry={() => { void liveOrders.refetch(); void history.refetch(); }} /></div>
        : !ready ? <OrdersListSkeleton />
        : live.length === 0 && rows.length === 0 ? (
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
                      <span className="truncate text-[15px] font-semibold leading-5">{nameOf(order)} · {statusWords(order)}</span>
                      <span className="truncate text-[13px] leading-[18px] text-[var(--swift-muted)]">{order.orderNumber}</span>
                    </span>
                    <Link href={`/orders/${order.id}`} aria-label={`Track ${nameOf(order)} ${order.orderNumber}`} className="sw-btn sw-btn-sm sw-btn-ink">Track</Link>
                  </div>
                ))}
                {liveHidden > 0 ? <p className="mt-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">+{liveHidden} more in progress</p> : null}
              </div>
            ) : null}
            {groups.map((group) => (
              <section key={group.label} className="mt-6" aria-label={group.label}>
                <span className="sw-eyebrow sw-eyebrow-soft">{group.label}</span>
                <div className="mt-1">
                  {group.rows.map((o) => (
                    <div key={o.id}>
                      <Link href={`/orders/${o.id}`} className={`${ORDER_ROW} text-[var(--swift-ink)] active:opacity-70`}>
                        <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-[var(--swift-sunken)]"><Pictogram name={pictogramFor(o)} size={22} /></span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[15px] font-semibold leading-5">{nameOf(o)}</span>
                          <span className="truncate text-[13px] leading-[18px] text-[var(--swift-muted)]">{summaryOf(o)}</span>
                        </span>
                        <span className="flex flex-col items-end gap-1">
                          <span className="sw-money">{money(o.totalAmount ?? o.total)}</span>
                          <span className={tone(o.status)}>{statusWords(o)}</span>
                        </span>
                      </Link>
                      {canReorder(o) ? (
                        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--swift-border)] py-2">
                          <button
                            type="button"
                            onClick={() => { setLeftOut(null); again.mutate(String(o.id)); }}
                            disabled={again.isPending}
                            aria-label={`Reorder ${nameOf(o)} ${o.orderNumber ?? ''}`.trim()}
                            className="sw-btn sw-btn-sm sw-btn-outline"
                          >
                            {again.isPending && again.variables === String(o.id) ? 'Adding…' : 'Reorder'}
                          </button>
                          {again.isError && again.variables === String(o.id) ? (
                            <span role="alert" className="text-[13px] leading-[18px] text-[var(--swift-red-600)]">
                              {again.error instanceof Error ? again.error.message : 'Couldn’t add this order to your cart. Try again.'}
                            </span>
                          ) : null}
                          {leftOut?.id === String(o.id) ? (
                            <span role="status" className="flex min-w-0 flex-col text-[13px] leading-[18px]">
                              <b>{leftOut.title}</b>
                              <span className="text-[var(--swift-muted)]">{leftOut.description}</span>
                              <Link href="/cart" className="font-semibold underline">Go to your cart</Link>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ))}
            {history.isFetchingNextPage ? (
              <p role="status" className="py-4 text-center text-[13px] text-[var(--swift-muted)]">Loading more…</p>
            ) : history.isFetchNextPageError ? (
              <div className="py-4 text-center">
                <p role="alert" className="text-[13px] text-[var(--swift-red-600)]">Couldn&apos;t load more orders.</p>
                <button type="button" onClick={() => void history.fetchNextPage()} className="sw-btn sw-btn-sm sw-btn-outline mt-2">Try again</button>
              </div>
            ) : history.hasNextPage && historyTotal !== null ? (
              <button type="button" onClick={() => void history.fetchNextPage()} aria-label={`Show more. ${loaded.length} of ${historyTotal} shown`} className="mx-auto mt-4 flex flex-col items-center py-2">
                <span className="text-[15px] font-semibold">Show more</span>
                <span className="text-[13px] text-[var(--swift-muted)]">{loaded.length} of {historyTotal} shown</span>
              </button>
            ) : null}
          </>
        )}
    </div>
  );
}
