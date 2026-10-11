'use client';

/**
 * The Orders home's cards, copied from the phone app's business board
 * (apps/mobile/src/modules/vendor/screens/VendorOps.tsx) — same words, same
 * server reads, laid out wider on a computer. Owner ruling, 11 Oct 2026. The
 * logic helpers are the app's own (lib/vendor-hub.ts, census-tested).
 */
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, BarChart3, BookOpen, CalendarClock, Check, ChevronRight, History, QrCode, Receipt, ToggleRight, UserCog } from 'lucide-react';
import { apiFetch } from '@/lib/auth';
import { rejectReasonsFor } from '@/lib/reject-reasons';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { catalogueName } from '@/lib/catalogue-name';
import {
  DAY_LABELS, billingSummary, canAttestPayment, financialDeltaLabel, fmtWhen, guyanaDate, guyanaDayKey, hasTrailingGuyanaDays, hoursSummary,
  numericFact, orderActions, reconciledRevenueDays, storeStatusEyebrow, subscriptionTone, windowTotals,
} from '@/lib/vendor-hub';
import {
  acceptOrder, getHours, getItems, getOps, getOverview, getProfile, getQr, getRevenue, getSubscription, markPreparing, markReady,
  money, rejectOrder, toggleOpen, toggleOrders, updateProfile, type VendorOrder,
} from '@/lib/vendor-api';
import { MutationNotice } from './mutation-notice';
import { pickProfileStore, type HubStore } from '@/lib/profile-store';
import { acceptHeldForPayment, mmgMovedLabel, mmgMoneyMoved, mmgPayBlockedReason } from '@/lib/mmg-pay-words';
// Plain app files, imported as is (and copied into the web image by the Dockerfile).
import { MMG_DISPUTE_NOTICE, mmgDisputePaused } from '../../../mobile/src/modules/vendor/order-dispute';

export type { HubStore };

export function useHubStore() {
  const storeId = useStoreId();
  // Re-read every 20 s, as the app does (vendorops.ts useVendorProfile): the
  // open / pause endpoints flip the stored value, so a tab left open must not
  // act on a state the phone has since changed.
  const q = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile, refetchInterval: 20_000 });
  return { ...q, data: pickProfileStore(q.data, storeId) };
}
function useOverview(enabled: boolean) {
  const storeId = useStoreId();
  return useQuery({ queryKey: storeKey(storeId, 'overview'), queryFn: getOverview, refetchInterval: 30_000, enabled });
}
function useRevenue(enabled: boolean) {
  const storeId = useStoreId();
  return useQuery({ queryKey: storeKey(storeId, 'analytics', 'revenue', 14), queryFn: () => getRevenue(14), enabled });
}
function useItems() {
  const storeId = useStoreId();
  return useQuery({ queryKey: storeKey(storeId, 'items', 'all'), queryFn: () => getItems() });
}
function useQr(enabled: boolean) {
  const storeId = useStoreId();
  return useQuery({ queryKey: storeKey(storeId, 'qr'), queryFn: getQr, enabled });
}

const micro = 'text-[11px] font-semibold tracking-[0.08em] text-[var(--swift-muted)]';

function DeltaBadge({ cur, prev }: { cur: number; prev: number | null }) {
  if (prev == null) return null;
  if (prev <= 0) return cur > 0 ? <span className="text-[13px] font-semibold text-[var(--swift-success)]">new</span> : null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return <span className="text-[13px] font-semibold text-[var(--swift-muted)]">level</span>;
  const up = pct > 0;
  return <span className={`text-[13px] font-semibold ${up ? 'text-[var(--swift-success)]' : 'text-[var(--swift-muted)]'}`}>{up ? '▲' : '▼'} {Math.abs(pct)}%</span>;
}

function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'success' | 'warning' | 'error' | 'brand' | 'neutral' }) {
  const tones = {
    success: 'bg-[var(--swift-soft-success)] text-[var(--swift-success)]',
    warning: 'bg-[var(--swift-soft-warning)] text-[var(--swift-warning)]',
    error: 'bg-[var(--swift-soft-danger)] text-[var(--swift-error)]',
    brand: 'bg-[var(--swift-red-50)] text-[var(--swift-red)]',
    neutral: 'bg-[var(--swift-sunken)] text-[var(--swift-muted)]',
  };
  return <span className={`whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${tones[tone]}`}>{children}</span>;
}

/** The app's TabHeader on the board: the store's state as an eyebrow, then its name. */
export function StoreHeader({ store, action }: { store: HubStore | undefined; action: ReactNode }) {
  const status = store ? storeStatusEyebrow(store, store.status != null && store.status !== 'ACTIVE') : null;
  const dot = status?.tone === 'success' ? 'bg-[var(--swift-success)]' : status?.tone === 'warning' ? 'bg-[var(--swift-warning)]' : 'bg-[var(--swift-muted)]';
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {status && <p className={`${micro} flex items-center gap-2`}><span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />{status.label}</p>}
        <h1 className="sw-title mt-1">{store?.name ?? 'Orders'}</h1>
      </div>
      {action}
    </div>
  );
}

function HubFact({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl bg-[var(--swift-sunken)] p-4">
      <p className={micro}>{label}</p>
      <p className="sw-title mt-1 truncate">{value}</p>
      <p className="sw-caption mt-1">{detail}</p>
    </div>
  );
}

/** VendorRevenuePulse: today's revenue against the same day last week, orders and waiting. Owners and managers. */
export function RevenuePulse({ newOrders }: { newOrders: VendorOrder[] }) {
  const storeId = useStoreId();
  const analyticsQ = useOverview(true);
  const revenueQ = useRevenue(true);
  const opsQ = useQuery({ queryKey: storeKey(storeId, 'analytics', 'ops', 7), queryFn: () => getOps(7) });
  const analytics = analyticsQ.data;
  const analyticsError = analyticsQ.isError;
  const analyticsUpdatedAt = analyticsQ.dataUpdatedAt;
  const refetchRevenue = revenueQ.refetch;
  const revenueBehindAnalytics = analyticsUpdatedAt > 0 && analyticsUpdatedAt > revenueQ.dataUpdatedAt;
  useEffect(() => {
    if (analyticsUpdatedAt > 0) void refetchRevenue();
  }, [analyticsUpdatedAt, refetchRevenue]);
  const todayRevenue = numericFact(analytics?.today?.revenue ?? analytics?.today?.total);
  const todayOrders = numericFact(analytics?.today?.orders ?? analytics?.today?.count);
  const pendingOrders = numericFact(analytics?.pendingOrders);
  const pendingCatchingUp = pendingOrders != null && newOrders.length > pendingOrders;
  const pendingLoadedFallback = pendingOrders == null && newOrders.length > 0;
  const pendingDisplay = pendingCatchingUp || pendingLoadedFallback ? newOrders.length : pendingOrders;
  const daily = reconciledRevenueDays(revenueQ.data, analytics, 14);
  const previousSameDay = daily.find((row) => row.date === guyanaDayKey(-7));
  const previousLabel = DAY_LABELS[guyanaDate(-7).getUTCDay()];
  const avgAccept = numericFact(opsQ.data?.avgAcceptMinutes);
  const ordersDetail = opsQ.isLoading && !opsQ.data
    ? 'Average accept time loading…'
    : opsQ.isError && !opsQ.data
      ? 'Average accept time unavailable'
      : avgAccept == null
        ? 'No acceptance time reported · 7d'
        : `${avgAccept}m avg to accept · 7d${opsQ.isError ? ' · last loaded' : ''}`;
  const showingStale = (analyticsError && !!analytics) || (revenueQ.isError && !!revenueQ.data);
  const factsUnavailable = analyticsError && !analytics;
  const oldestKnown = pendingOrders != null && pendingOrders === newOrders.length;
  const oldestTimestamp = oldestKnown
    ? newOrders.map((order) => order.placedAt).filter(Boolean).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]
    : undefined;
  const waitingDetail = pendingCatchingUp
    ? 'updating live total'
    : pendingOrders === 0
      ? 'Nothing waiting'
      : oldestTimestamp
        ? `oldest ${fmtWhen(oldestTimestamp)}`
        : pendingOrders == null
          ? 'Total unavailable'
          : 'live queue total';
  return (
    <section aria-label="Revenue today" className="sw-card p-5 wide:p-6">
      <p className={micro}>REVENUE TODAY</p>
      {(showingStale || factsUnavailable || analyticsQ.isLoading) && (
        <p className="sw-caption mt-1">
          {showingStale ? 'Showing last loaded figures — refresh did not complete.' : factsUnavailable ? 'Live business facts are unavailable — refresh to retry.' : 'Loading live business facts…'}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <p className="text-[40px] font-semibold leading-[48px] [font-family:var(--swift-face-display)]">{todayRevenue == null ? '—' : money(todayRevenue)}</p>
        {todayRevenue != null && previousSameDay && !analyticsError && !revenueQ.isError && !revenueBehindAnalytics && (
          <div className="flex flex-col items-end pb-1">
            <DeltaBadge cur={todayRevenue} prev={previousSameDay.revenue} />
            <span className="sw-caption">vs last {previousLabel}</span>
          </div>
        )}
      </div>
      <div className="mt-4 flex gap-3">
        <HubFact label="ORDERS" value={todayOrders == null ? '—' : String(todayOrders)} detail={ordersDetail} />
        <HubFact label="WAITING" value={pendingDisplay == null ? '—' : `${pendingDisplay}${pendingCatchingUp || pendingLoadedFallback ? '+' : ''}`} detail={waitingDetail} />
      </div>
    </section>
  );
}

/** The staff view's card in place of the money (VendorOps "LOADED BOARD"). */
export function LoadedBoard({ loading, unavailable, total, newCount, progressCount }: { loading: boolean; unavailable: boolean; total: number; newCount: number; progressCount: number }) {
  return (
    <section aria-label="Loaded board" className="rounded-2xl bg-[var(--swift-sunken)] p-5">
      <p className={micro}>LOADED BOARD</p>
      <p className="sw-title mt-1">{loading || unavailable ? '—' : String(total)}</p>
      <p className="sw-caption mt-1">
        {loading ? 'Loading the latest queue…' : unavailable ? 'Board unreachable — orders may be waiting' : `${newCount} new · ${progressCount} in progress in the latest page`}
      </p>
    </section>
  );
}

function GuideRow({ index, label, detail, done, href, external }: { index: number; label: string; detail: string; done?: boolean; href?: string; external?: boolean }) {
  const body = (
    <>
      <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-white/15 text-[12px] font-semibold">{done ? <Check size={14} aria-hidden="true" /> : index}</span>
      <span className="min-w-0 flex-1"><span className="block font-semibold">{label}</span><span className="block truncate text-[13px] opacity-90">{detail}</span></span>
      {href && <ChevronRight size={16} aria-hidden="true" />}
    </>
  );
  const cls = 'flex min-h-11 items-center gap-3 rounded-xl bg-white/10 px-3 py-2';
  if (!href) return <div className={cls}>{body}</div>;
  if (external) return <a href={href} target="_blank" rel="noreferrer" className={`${cls} hover:bg-white/15`}>{body}</a>;
  return <Link href={href} className={`${cls} hover:bg-white/15`}>{body}</Link>;
}

/** VendorBoardEmpty's first-morning card: "The board is live." with three real next steps. */
export function FirstOrderGuide({ store, manager, listening }: { store: HubStore; manager: boolean; listening: boolean }) {
  const itemsQ = useItems();
  const qrQ = useQr(manager);
  const catalogue = catalogueName(store.vendorType).toLowerCase();
  const items = itemsQ.data ?? [];
  const missingPhotos = items.filter((i) => !i.imageUrl).length;
  const shortUrl = qrQ.data?.shortUrl ?? undefined;
  const open = !!store.isCurrentlyOpen;
  return (
    <section aria-label="Your first order" className="rounded-2xl bg-[var(--swift-red-600)] p-6 text-white">
      <p className="text-[11px] font-bold tracking-[0.1em] opacity-80">YOUR FIRST ORDER</p>
      <p className="mt-1 text-[24px] font-semibold leading-8 [font-family:var(--swift-face-display)]">The board is live.</p>
      <p className="mt-2 opacity-90">Orders land here the second they&apos;re placed, with a sound you can&apos;t miss. These bring the first one sooner:</p>
      <div className="mt-4 space-y-2">
        {manager && !itemsQ.isSuccess ? (
          <GuideRow index={1} label={itemsQ.isError ? 'Menu status unavailable' : 'Checking your menu'} detail={itemsQ.isError ? 'Open the menu to check its items' : 'Loading your menu details'} href="/dashboard/inventory" />
        ) : manager && items.length === 0 ? (
          <GuideRow index={1} label="Add your first item" detail={`Your ${catalogue} is empty — nothing to order yet`} href="/dashboard/inventory" />
        ) : manager ? (
          <GuideRow index={1} label={`Add photos to your ${catalogue}`} done={missingPhotos === 0}
            detail={missingPhotos === 0 ? `All ${items.length} items have a photo` : `Photos missing on ${missingPhotos} of ${items.length} items`} href="/dashboard/inventory" />
        ) : null}
        <GuideRow index={manager ? 2 : 1} label={open ? 'You are open' : 'Your store is closed'} done={open}
          detail={open ? 'Customers can order right now' : manager ? 'Use the switch below to start taking orders' : 'Ask a manager or owner to open the store'} />
        {manager && <GuideRow index={3} label="Share your store link" detail={shortUrl ?? (qrQ.isError ? 'Link unavailable — try again shortly' : 'Loading your live store link')} href={shortUrl} external />}
      </div>
      <p className="mt-4 flex items-center gap-2 text-[11px] font-bold tracking-[0.1em]">
        <span className={`h-2 w-2 rounded-full ${listening ? 'bg-[var(--swift-success)]' : 'bg-white/40'}`} aria-hidden="true" />
        {listening ? 'LISTENING FOR ORDERS' : 'RECONNECTING TO THE BOARD'}
      </p>
    </section>
  );
}

/** VendorBoardQuiet: an experienced store with nothing open. */
export function BoardQuiet({ lastOrderAt }: { lastOrderAt?: string }) {
  return (
    <div className="flex flex-col items-center rounded-2xl bg-[var(--swift-red-50)] px-4 py-8 text-center">
      <Check size={28} className="text-[var(--swift-muted)]" aria-hidden="true" />
      <p className="mt-2 font-semibold text-[var(--swift-muted)]">You are all caught up</p>
      {lastOrderAt && <p className="sw-caption mt-1">Last order {fmtWhen(lastOrderAt)}</p>}
    </div>
  );
}

function Tile({ icon: Icon, label, detail, badge, badgeLabel, href, onClick, external }: {
  icon: typeof BookOpen; label: string; detail: string; badge?: ReactNode; badgeLabel?: string; href: string; onClick?: () => void; external?: boolean;
}) {
  const body = (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--swift-red-50)] text-[var(--swift-red-600)]"><Icon size={20} aria-hidden="true" /></span>
        {badge}
      </span>
      <span className="sw-heading mt-3 block">{label}</span>
      <span className="sw-caption mt-1 block break-words">{detail}</span>
      <ArrowUpRight size={16} className="mt-3 text-[var(--swift-red)]" aria-hidden="true" />
    </>
  );
  const props = { 'aria-label': [label, detail, badgeLabel].filter(Boolean).join('. '), className: 'sw-card block min-w-0 p-5 hover:outline hover:outline-1 hover:outline-[var(--swift-border-strong)]' };
  if (external) return <a href={href} target="_blank" rel="noreferrer" {...props}>{body}</a>;
  return <Link href={href} onClick={onClick} {...props}>{body}</Link>;
}

/** VendorManagerManageGrid: "MANAGE — The whole business". Owners and managers. */
export function ManageGrid({ store, owner, onOrderHistory }: { store: HubStore | undefined; owner: boolean; onOrderHistory: () => void }) {
  const storeId = useStoreId();
  const itemsQ = useItems();
  const analyticsQ = useOverview(true);
  const revenueQ = useRevenue(true);
  const hoursQ = useQuery({ queryKey: storeKey(storeId, 'hours'), queryFn: getHours });
  const qrQ = useQr(true);
  const subQ = useQuery({ queryKey: storeKey(storeId, 'subscription'), queryFn: getSubscription, enabled: owner });
  const analytics = analyticsQ.data;
  const analyticsStale = analyticsQ.isError;
  const items = itemsQ.data ?? [];
  const soldOut = items.filter((item) => item.isAvailable === false).length;
  const active = Math.max(0, items.length - soldOut);
  const daily = reconciledRevenueDays(revenueQ.data, analytics, 14);
  const revenueWindow = windowTotals(daily, 7);
  const revenueBehindAnalytics = analyticsQ.dataUpdatedAt > 0 && analyticsQ.dataUpdatedAt > revenueQ.dataUpdatedAt;
  const revenueKnown = revenueQ.isSuccess && !analyticsStale && !revenueBehindAnalytics && !!analytics && hasTrailingGuyanaDays(daily, 7);
  const schedule = hoursSummary(hoursQ.data ?? store?.operatingHours);
  const sub = subQ.data;
  const rollingOrders = analyticsStale ? null : numericFact(analytics?.week?.orders);
  const menuDetail = itemsQ.isError && !itemsQ.data ? 'Menu unavailable' : itemsQ.isLoading && !itemsQ.data ? 'Checking your menu…' : `${active} active · ${soldOut} sold out${itemsQ.isError && itemsQ.data ? ' · last loaded' : ''}`;
  const revenueDetail = revenueKnown
    ? `7d ${money(revenueWindow.cur.revenue)}`
    : revenueBehindAnalytics && revenueQ.isError
      ? 'Revenue refresh failed'
      : revenueQ.isLoading || revenueBehindAnalytics || (!analytics && !analyticsStale)
        ? 'Checking 7-day revenue…'
        : analyticsStale && analytics ? 'Revenue · last loaded' : 'Revenue unavailable';
  const qrDetail = qrQ.isError && !qrQ.data ? 'Store link unavailable' : qrQ.data?.shortUrl ? qrQ.data.shortUrl : qrQ.isLoading ? 'Checking store link…' : 'Customers scan to order';
  const scheduleDetail = hoursQ.isError && !store?.operatingHours ? 'Hours unavailable' : schedule ?? 'Schedule not set';
  const qrStatus = qrQ.data?.status ? String(qrQ.data.status) : null;
  return (
    <section aria-label="Manage">
      <p className={micro}>MANAGE</p>
      <h2 className="sw-heading mt-1">The whole business</h2>
      <div className="mt-4 grid grid-cols-2 gap-3 wide:grid-cols-3">
        <Tile icon={BookOpen} label="Menu & inventory" detail={menuDetail} href="/dashboard/inventory"
          badge={soldOut > 0 ? <Pill tone="warning">{soldOut} SOLD OUT</Pill> : undefined} badgeLabel={soldOut > 0 ? `${soldOut} sold out` : undefined} />
        <Tile icon={BarChart3} label="Insights" detail={revenueDetail} href="/dashboard/insights"
          badge={revenueKnown ? <DeltaBadge cur={revenueWindow.cur.revenue} prev={revenueWindow.prev?.revenue ?? null} /> : undefined}
          badgeLabel={revenueKnown ? financialDeltaLabel(revenueWindow.cur.revenue, revenueWindow.prev?.revenue ?? null) : undefined} />
        <Tile icon={CalendarClock} label="Hours & schedule" detail={scheduleDetail} href="/dashboard/account#hours" />
        <Tile icon={QrCode} label={owner ? 'My QR & number' : 'My QR'} detail={qrDetail} href={qrQ.data?.shortUrl ?? '/dashboard/account'} external={!!qrQ.data?.shortUrl}
          badge={qrStatus ? <Pill tone={qrStatus === 'ACTIVE' ? 'success' : 'neutral'}>{qrStatus.replace(/_/g, ' ')}</Pill> : undefined}
          badgeLabel={qrStatus ? `QR ${qrStatus.replace(/_/g, ' ').toLowerCase()}` : undefined} />
        <Tile icon={History} label="Order history" detail={rollingOrders == null ? 'Past orders' : `${rollingOrders} recent orders`} href="#other-orders" onClick={onOrderHistory} />
        {owner ? (
          <Tile icon={Receipt} label="Billing" detail={subQ.isError && !sub ? 'Billing unavailable' : billingSummary(sub)} href="/dashboard/weekly-fee"
            badge={sub ? <Pill tone={subscriptionTone(sub)}>{String(sub.status ?? 'Subscription').replace(/_/g, ' ')}</Pill> : undefined}
            badgeLabel={sub ? `Subscription ${String(sub.status ?? '').replace(/_/g, ' ').toLowerCase()}` : undefined} />
        ) : (
          <Tile icon={UserCog} label="Account" detail="Store settings & promos" href="/dashboard/account" />
        )}
      </div>
    </section>
  );
}

/** VendorStaffAvailability: the floor's one tile. */
export function StaffAvailability() {
  const itemsQ = useItems();
  const items = itemsQ.data ?? [];
  const soldOut = items.filter((item) => item.isAvailable === false).length;
  const detail = itemsQ.isError && !itemsQ.data ? 'Availability unavailable' : itemsQ.isLoading && !itemsQ.data ? 'Checking your menu…' : `${soldOut} sold out · one-tap updates`;
  return (
    <section aria-label="Floor tools">
      <p className={micro}>FLOOR TOOLS</p>
      <div className="mt-3"><Tile icon={ToggleRight} label="Item availability" detail={detail} href="/dashboard/inventory"
        badge={soldOut > 0 ? <Pill tone="warning">{soldOut} SOLD OUT</Pill> : undefined} badgeLabel={soldOut > 0 ? `${soldOut} sold out` : undefined} /></div>
    </section>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span className={`relative h-8 w-[52px] flex-none rounded-full transition-colors ${on ? 'bg-[var(--swift-red)]' : 'bg-[var(--swift-border-strong)]'}`} aria-hidden="true">
      <span className={`absolute top-[3px] h-[26px] w-[26px] rounded-full bg-white shadow transition-all ${on ? 'left-[23px]' : 'left-[3px]'}`} />
    </span>
  );
}

/** The store status card: open switch and pause for owners and managers, the state for everyone. */
/** Said when the store's state could not be re-read: the controls wait for a fresh read. */
function ReadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="alert" className="mt-3 text-[13px] text-[var(--swift-error)]">
      Couldn’t check your store’s current state, so these controls are paused.{' '}
      <button type="button" onClick={onRetry} className="font-semibold underline">Try again</button>
    </p>
  );
}

export function StoreStatusCard({ store, manager, readFailed = false, onRetryRead = () => {} }: { store: HubStore; manager: boolean; readFailed?: boolean; onRetryRead?: () => void }) {
  const storeId = useStoreId();
  const client = useQueryClient();
  // The server FLIPS the stored value (it ignores the body), so a second tap
  // before the fresh state lands would flip it straight back: each control
  // stays locked until the store has been re-read.
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: storeKey(storeId, 'profile') }),
    client.invalidateQueries({ queryKey: storeKey(storeId, 'overview') }),
    client.invalidateQueries({ queryKey: ['stores'] }),
  ]);
  const open = !!store.isCurrentlyOpen;
  const accepting = !!store.acceptingOrders;
  // A store that is not live yet (being reviewed) cannot open: as in the app,
  // the switch is locked and Pause is not offered.
  const inPreview = store.status != null && store.status !== 'ACTIVE';
  const openMut = useMutation({ mutationFn: () => toggleOpen(!open), onSettled: refresh });
  const ordersMut = useMutation({ mutationFn: () => toggleOrders(!accepting), onSettled: refresh });
  const text = (
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2 font-semibold"><span className={`h-2.5 w-2.5 rounded-full ${open && accepting ? 'bg-[var(--swift-success)]' : 'bg-[var(--swift-muted)]'}`} aria-hidden="true" />
        {inPreview ? 'Not open yet' : !open ? 'Store closed' : accepting ? 'Open for orders' : 'Orders paused'}</span>
      <span className="sw-caption mt-1 block">{inPreview ? 'Your store opens for orders once verification is approved.' : !open ? 'Not currently open to customers' : accepting ? 'Accepting new orders' : 'You’re open but not taking new orders'}</span>
    </span>
  );
  return (
    <section aria-label="Store status" className="sw-card p-5">
      {manager ? (
        <button type="button" role="switch" aria-label="Store open to customers" aria-checked={!inPreview && open} disabled={inPreview || readFailed || openMut.isPending} onClick={() => openMut.mutate()}
          className="flex min-h-12 w-full items-center justify-between gap-3 text-left disabled:opacity-60">{text}<Switch on={!inPreview && open} /></button>
      ) : <div className="flex min-h-12 items-center">{text}</div>}
      {openMut.isError && <p className="mt-2 text-[13px] text-[var(--swift-error)]">Store status didn’t update — check your connection and try again.</p>}
      {manager && !inPreview && (
        <button type="button" disabled={readFailed || ordersMut.isPending} onClick={() => ordersMut.mutate()} className="sw-btn sw-btn-md mt-4 w-full bg-[var(--swift-red-50)] text-[var(--swift-red-600)]">
          {accepting ? 'Pause new orders' : 'Resume orders'}
        </button>
      )}
      <MutationNotice errors={[ordersMut.error]} className="mt-2" />
      {manager && readFailed && <ReadFailed onRetry={onRetryRead} />}
    </section>
  );
}

/** "Deliver my own orders" — the store-wide self-delivery setting (owners and managers). */
export function SelfDeliveryCard({ store, readFailed = false, onRetryRead = () => {} }: { store: HubStore; readFailed?: boolean; onRetryRead?: () => void }) {
  const storeId = useStoreId();
  const client = useQueryClient();
  const selfDelivery = !!store.selfDeliveryEnabled;
  const mut = useMutation({
    mutationFn: () => updateProfile({ selfDeliveryEnabled: !selfDelivery }),
    // Locked until the store is re-read, so a quick second tap cannot send the stale opposite.
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: storeKey(storeId, 'profile') }),
      client.invalidateQueries({ queryKey: storeKey(storeId, 'orders') }),
    ]),
  });
  return (
    <section aria-label="Who delivers" className="sw-card p-5">
      <button type="button" role="switch" aria-label="Deliver my own orders" aria-checked={selfDelivery} disabled={readFailed || mut.isPending} onClick={() => mut.mutate()}
        className="flex min-h-12 w-full items-center justify-between gap-3 text-left disabled:opacity-60">
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">Deliver my own orders</span>
          <span className="sw-caption mt-1 block">{selfDelivery ? 'You deliver your orders yourself — Swift won’t send a rider.' : 'Swift sends the nearest rider for your delivery orders.'}</span>
        </span>
        <Switch on={selfDelivery} />
      </button>
      {mut.isError && <p className="mt-2 text-[13px] text-[var(--swift-error)]">Couldn’t update — try again.</p>}
      {readFailed && <ReadFailed onRetry={onRetryRead} />}
    </section>
  );
}

/**
 * The app's actions on an order card (VendorOrderCard): Accept, Reject with a
 * reason, Start preparing, Mark ready, Mark complete. Steps that need more
 * than a tap — the collection code, confirming a store delivery — open the
 * order window, where those checks live.
 */
export function OrderCardActions({ order, onOpen }: { order: VendorOrder; onOpen: () => void }) {
  const storeId = useStoreId();
  const client = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: storeKey(storeId, 'orders') });
    void client.invalidateQueries({ queryKey: storeKey(storeId, 'order', order.id) });
  };
  const act = useMutation({
    mutationFn: (kind: string) => {
      if (kind === 'accept') return acceptOrder(order.id);
      if (kind === 'preparing') return markPreparing(order.id);
      if (kind === 'ready') return markReady(order.id);
      if (kind === 'complete-appointment') return apiFetch(`/api/v1/vendor/orders/${order.id}/complete-appointment`, { method: 'PUT', body: '{}' });
      throw new Error(`Unknown action ${kind}`);
    },
    onSettled: refresh,
  });
  const reject = useMutation({ mutationFn: (why: string) => rejectOrder(order.id, why), onSettled: () => { setRejecting(false); refresh(); } });
  // The app card's MMG step (VendorOrderCard): the payment's state, and the
  // store's confirmation where money plausibly landed. Payment-first — the
  // server accepts an MMG order only after that confirmation — so an unpaid
  // MMG order offers the confirmation instead of an Accept it would refuse.
  const status = (order.status || '').toUpperCase();
  const isMmg = order.paymentMethod === 'MOBILE_MONEY';
  const moneyMoved = mmgMoneyMoved(order.paymentStatus);
  const terminal = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'].includes(status);
  const attestable = isMmg && canAttestPayment(order.paymentStatus) && !terminal;
  const canConfirm = attestable && order.canConfirmPayment === true;
  const blockedReason = isMmg && !moneyMoved && !attestable && !terminal ? mmgPayBlockedReason(order.paymentStatus) : null;
  const paused = mmgDisputePaused(order);
  const actions = orderActions(order).filter((a) => !(a.action === 'accept' && acceptHeldForPayment(order)));
  if (actions.length === 0 && !isMmg && !paused) return null;
  const busy = act.isPending || reject.isPending;
  return (
    <div className="mt-3 space-y-2">
      {isMmg && !terminal && !blockedReason && (
        <p className={`text-[13px] font-semibold ${moneyMoved ? 'text-[var(--swift-success)]' : 'text-[var(--swift-warning)]'}`}>
          {moneyMoved ? mmgMovedLabel(order.paymentStatus) : 'Awaiting MMG payment'}
        </p>
      )}
      {blockedReason && <p className="sw-caption">{blockedReason}</p>}
      {canConfirm && <button type="button" onClick={onOpen} className="sw-btn sw-btn-md sw-btn-outline w-full">Confirm MMG payment</button>}
      {attestable && !canConfirm && <p className="sw-caption">Only the owner or a manager can confirm MMG payments.</p>}
      {paused && (
        <div role="alert" className="rounded-xl bg-[var(--swift-soft-warning)] p-3">
          <p className="text-[13px] font-semibold">{MMG_DISPUTE_NOTICE.title}</p>
          <p className="sw-caption mt-1">{MMG_DISPUTE_NOTICE.body}</p>
        </div>
      )}
      <MutationNotice errors={[act.error, reject.error]} />
      {rejecting ? (
        <div className="rounded-xl bg-[var(--swift-red-50)] p-3">
          <p className="text-[13px] font-semibold text-[var(--swift-red-600)]">{order.fulfillment === 'APPOINTMENT' ? 'Decline this booking?' : 'Reject this order?'}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {rejectReasonsFor(order.fulfillment).map((why) => (
              <button key={why} type="button" disabled={busy} onClick={() => reject.mutate(why)} className="sw-btn sw-btn-md sw-btn-outline">{why}</button>
            ))}
            <button type="button" disabled={busy} onClick={() => setRejecting(false)} className="sw-btn sw-btn-md">Keep it</button>
          </div>
        </div>
      ) : actions.length > 0 && (
        <div className="flex gap-2">
          {actions.map((a) => (
            <button key={a.action} type="button" disabled={busy}
              onClick={() => (a.action === 'reject' ? setRejecting(true) : ['complete-pickup', 'delivered', 'confirm-payment'].includes(a.action) ? onOpen() : act.mutate(a.action))}
              className={`sw-btn sw-btn-md flex-1 ${a.action === 'reject' ? 'sw-btn-outline' : ''}`}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
