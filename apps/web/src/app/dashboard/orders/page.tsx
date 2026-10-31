'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import NewOrderTakeover from '@/components/NewOrderTakeover';
import { mmgDisputePaused } from '@/lib/mmg-dispute';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useFeedPollInterval } from '@/lib/store-live-feed';
import { BUCKETS, type BucketKey, completeness, groupOrders } from '@/lib/order-buckets';
import { BoardQuiet, FirstOrderGuide, LoadedBoard, ManageGrid, OrderCardActions, PickupCodeCard, RevenuePulse, SelfDeliveryCard, StaffAvailability, StoreHeader, StoreStatusCard, useHubStore } from '@/components/orders-home';
import { useStoreRole } from '@/lib/store-role';
import { DataUnavailable } from '@/components/data-unavailable';
import { focusableIn } from '@/components/modal';
import { formatAppointmentSlot } from '@/lib/appointmentTime';
import { getOrders, money, type VendorOrder } from '@/lib/vendor-api';
import { preloadedPart } from '@/lib/preloaded-part';
import { BoardNames, statusChip, timeAgo } from './order-chip';
import { DeliveryStatusNotice } from '../delivery-status-notice';

// [PERF · UI-FIX-WEB note 05:18Z] The order window is its own chunk, fetched as soon as this page
// mounts and drawn without Suspense once here: the page's first load is lighter and the tap that
// opens an order still draws it in the same frame.
const orderDetail = preloadedPart(() => import('./order-detail').then((module) => module.OrderDetail));

/** Only if the tap beats the background fetch: the same view as an order still loading. */
function OrderWindowLoading({ onClose }: { onClose: () => void }) {
  return (
    <div className="sw-card p-6 text-sm text-[var(--swift-muted)]">
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-[var(--swift-ink)]">Order detail</p>
        <button onClick={onClose} aria-label="Close order detail" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-xl text-[var(--swift-muted)] hover:text-[var(--swift-ink)]">✕</button>
      </div>
      <p className="mt-3">Loading…</p>
    </div>
  );
}

export default function OrdersPage() {
  const storeId = useStoreId();
  const [bucket, setBucket] = useState<BucketKey>('new');
  const [selected, setSelected] = useState<string | null>(null);
  // Fetched from mount; here (and drawn in the tap's frame) long before an order can be tapped.
  const OrderDetail = orderDetail.usePart(!!selected);
  const dialog = useRef<HTMLDivElement | null>(null);
  const store = useHubStore();
  const { role, manager } = useStoreRole();
  useEffect(() => {
    if (!selected) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLButtonElement>('[aria-label="Close order detail"]')?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null); };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKeyDown);
      // An action may have moved the order to another lane, which remounts its
      // card: go back to the order's card as it is now, not a detached node.
      const card = document.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(selected)}"]`);
      (card ?? (previousFocus?.isConnected ? previousFocus : null))?.focus();
    };
  }, [selected]);
  // The order window is a modal dialog: Tab and Shift+Tab stay inside it. A
  // local cycle, not the shared Modal — that one makes the rest of the page
  // inert, which would freeze the new-order takeover above it.
  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const inside = focusableIn(dialog.current);
    if (!inside.length) return;
    const first = inside[0]!;
    const last = inside[inside.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };

  // One read feeds every lane. The store's live feed re-reads it on every
  // order event (PERF row 8); the poll is the fallback, slower only while live.
  const ordersPoll = useFeedPollInterval(storeId, 10_000, 30_000);
  const orders = useQuery({
    queryKey: storeKey(storeId, 'orders'),
    queryFn: () => getOrders({ limit: 100 }),
    refetchInterval: ordersPoll,
  });

  const all = useMemo(() => orders.data?.orders ?? [], [orders.data]);
  // [W-11] Exhaustive: every order lands in exactly one lane, including an
  // `unknown` lane for a status this build does not recognise. The old loop
  // pushed only on a match and silently dropped everything else.
  const byBucket = useMemo(() => groupOrders(all), [all]);
  const shown = useMemo(() => completeness(all.length, orders.data?.meta), [all.length, orders.data?.meta]);

  const board = [
    { key: 'new' as const, label: 'New', hint: 'Waiting for a decision' },
    { key: 'kitchen' as const, label: 'Preparing', hint: 'In progress' },
    // This lane also holds orders a rider has claimed that may still be cooking,
    // so it keeps main's truthful name (independent review of #1601, S3-5).
    { key: 'handoff' as const, label: 'Ready / handoff', hint: 'Ready, or a rider is on the way' },
  ];
  const other = BUCKETS.filter(b => !board.some(c => c.key === b.key));
  // A card is the order's summary (opens the order window) and, under it, the
  // app's one-tap actions for its state (VendorOrderCard).
  const row = (o: VendorOrder) => <article key={o.id} aria-label={`Order ${o.orderNumber}`} className="sw-order-card">
    <button data-order-id={o.id} onClick={() => setSelected(o.id)} className="block w-full text-left">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="sw-label">#{o.orderNumber}</p>{statusChip((o.status || '').toUpperCase(), mmgDisputePaused(o))}</div>
      <p className="sw-caption mt-1">{timeAgo(o.placedAt)}</p>
      <BoardNames order={o} />
      <div className="my-3 space-y-1">{o.items.slice(0, 3).map(item => <p key={item.id} className="sw-label">{item.quantity}× {item.name}</p>)}{o.items.length > 3 && <p className="sw-caption">+{o.items.length - 3} more</p>}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--swift-border)] pt-3"><span className="sw-caption">{o.paymentMethod === 'MOBILE_MONEY' ? 'MMG' : 'Cash'}</span><span className="sw-title text-[17px]">{money(o.totalAmount)}</span></div>
      {o.fulfillment === 'APPOINTMENT' && o.appointmentSlot && <p className="sw-caption mt-2">Appointment: {formatAppointmentSlot(o.appointmentSlot)}</p>}
      {o.vendor?.name && <p className="sw-caption mt-1">{o.vendor.name}</p>}
      <span className="mt-2 block text-[13px] font-semibold text-[var(--swift-red)]">View order</span>
    </button>
    <OrderCardActions order={o} onOpen={() => setSelected(o.id)} />
  </article>;
  const newOrders = byBucket.get('new') ?? [];
  const activeCount = (['new', 'kitchen', 'handoff', 'moving'] as const).reduce((n, key) => n + (byBucket.get(key)?.length ?? 0), 0);
  // "All caught up" only when truly nothing is open: an order in a status this
  // build does not know may still be open, so it keeps the board up.
  const openOrUnknown = activeCount + (byBucket.get('unknown')?.length ?? 0);
  const storeLive = store.data?.status == null || store.data.status === 'ACTIVE';
  const lastOrderAt = all.map((o) => o.placedAt).filter(Boolean).sort().at(-1);
  return <div className="space-y-6">
    <NewOrderTakeover orders={all} onOpenOrder={setSelected} />
    {/* [RIDER-SAFE 4/5] Why customers cannot order delivery right now (pickup stays open). */}
    <DeliveryStatusNotice storeId={storeId} />
    <StoreHeader store={store.data} action={<button onClick={() => orders.refetch()} className="sw-btn sw-btn-md sw-btn-outline"><RefreshCw size={16} className={orders.isFetching ? 'animate-spin' : ''} aria-hidden />Refresh</button>} />
    {manager ? <RevenuePulse newOrders={newOrders} /> : <LoadedBoard loading={orders.isLoading} unavailable={orders.isError && !orders.data} total={activeCount} newCount={newOrders.length} progressCount={activeCount - newOrders.length} />}
    <div>
      <p className="text-[11px] font-semibold tracking-[0.08em] text-[var(--swift-muted)]">LATEST QUEUE VIEW</p>
      <h2 className="sw-heading mt-1">{orders.isLoading ? 'Loading active orders…' : orders.isError && !orders.data ? 'Queue status unavailable' : activeCount === 0 ? 'No active orders shown' : `${activeCount} shown · ${newOrders.length} waiting here`}</h2>
    </div>
    {orders.isLoading && <div role="status" className="sw-empty"><span className="sw-skeleton h-24 w-full" />Loading your orders…</div>}
    {orders.isError && <DataUnavailable what="your orders" error={orders.error} onRetry={() => void orders.refetch()} />}
    {!orders.isError && !orders.isLoading && shown.missing > 0 && <p role="status" className="sw-note">Showing {shown.shown} of {shown.total} orders — {shown.missing} not shown on this page.</p>}
    {/* The board stays up whenever orders were loaded: a failed refresh keeps
        the known orders on screen under the banner above (review S2-1). Only
        the calm "nothing here" texts need the last read to have succeeded. */}
    {orders.data && <>
      {!orders.isError && openOrUnknown === 0 ? (
        store.data?._count?.orders === 0
          ? <FirstOrderGuide store={store.data} manager={manager} listening={!orders.isError} />
          : <BoardQuiet lastOrderAt={lastOrderAt} />
      ) : <div className="sw-order-board">{board.map(c => <section key={c.key} aria-label={`${c.label} orders`} className="min-w-0 space-y-3">
        <div className="flex items-baseline gap-2"><h2 className="sw-heading">{c.label}</h2><span className="sw-caption">{byBucket.get(c.key)?.length ?? 0}</span></div><p className="sw-caption">{c.hint}</p>
        {(byBucket.get(c.key) ?? []).map(row)}
        {!orders.isError && !byBucket.get(c.key)?.length && <p className="sw-board-empty">Nothing here right now</p>}
      </section>)}</div>}
      <section id="other-orders" aria-label="Other orders" className="scroll-mt-6 space-y-4 border-t border-[var(--swift-border)] pt-6">
        <div className="flex flex-wrap gap-2">{other.map(b => {
          const count = byBucket.get(b.key)?.length ?? 0;
          if ((b.key === 'attention' || b.key === 'unknown') && !count) return null;
          return <button key={b.key} onClick={() => setBucket(b.key)} aria-pressed={bucket === b.key} className={`sw-btn sw-btn-md ${bucket === b.key ? '' : 'sw-btn-outline'}`}>{b.label}{count > 0 ? ` · ${count}` : ''}</button>;
        })}</div>
        {other.some(b => b.key === bucket) && <div className="grid gap-4 wide:grid-cols-2">{(byBucket.get(bucket) ?? []).map(row)}{!orders.isError && !byBucket.get(bucket)?.length && <p className="sw-board-empty">Nothing in “{BUCKETS.find(b => b.key === bucket)?.label}”.</p>}</div>}
      </section>
    </>}
    {manager ? <ManageGrid store={store.data} owner={role === 'OWNER'} onOrderHistory={() => setBucket('done')} /> : <StaffAvailability />}
    {store.data && <div className="grid gap-4 wide:grid-cols-2">
      <StoreStatusCard store={store.data} manager={manager} readFailed={store.isError} onRetryRead={() => void store.refetch()} />
      {manager && storeLive && <SelfDeliveryCard store={store.data} readFailed={store.isError} onRetryRead={() => void store.refetch()} />}
      {/* [STORE-DASH · O-2] Shown once the server serves the setting. */}
      {manager && storeLive && typeof store.data.requirePickupCode === 'boolean' && <PickupCodeCard store={store.data} readFailed={store.isError} onRetryRead={() => void store.refetch()} />}
    </div>}
    <p className="text-center text-[13px] text-[var(--swift-muted)]">You keep 100% of every order — Swift takes no commission.</p>
    {selected && <div ref={dialog} className="sw-scrim items-start overflow-y-auto p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] wide:items-center" role="dialog" aria-modal="true" aria-label="Order details" onKeyDown={e => { if (e.key === 'Escape') setSelected(null); else trapTab(e); }}>
      <div className="relative max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[var(--swift-canvas)]">{OrderDetail ? <OrderDetail id={selected} onClose={() => setSelected(null)} /> : <OrderWindowLoading onClose={() => setSelected(null)} />}</div>
    </div>}
  </div>;
}
