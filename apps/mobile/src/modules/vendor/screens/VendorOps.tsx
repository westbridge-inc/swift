/** @jsxImportSource react */
import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { color, elevation, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  Card,
  Chip,
  IconChip,
  LabeledInput,
  LoadingBlock,
  PillButton,
  PopupCard,
  PopupTitle,
  Screen,
  T,
  TonePill,
} from '../../../kit';
import { afterDismiss } from '../../../kit/after-dismiss';
import {
  BoardFirstRun,
  BoardFirstRunRow,
  DAY_LABELS,
  DeltaBadge,
  FulfillmentTag,
  GUTTER,
  OrderStatusPill,
  fmtDate,
  fmtClock as fmtLocalClock,
  fmtWhen,
  formatSlot,
  orderActions,
  type VendorOrderActionKind,
} from '../shared';
import { disconnectSocket } from '../../../services/socket';
import { docLabel } from '../../../components/onboarding/DocumentUploadCard';
import { useVerificationStatus } from '../../../hooks/verification';
import {
  useVendorProfile,
  useVendorOrderHistory,
  useVendorOrders,
  useToggleOpen,
  useToggleOrders,
  useSetSelfDelivery,
  useOrderAction,
  useVendorMenu,
  useVendorQr,
  useVendorSubscription,
  useVendorAnalytics,
  useVendorRevenue,
  useVendorOps,
  useVendorHours,
} from '../../../hooks/vendorops';
import { useAuthStore } from '../../../stores/authStore';
import { useStoreSwitcher } from '../../../stores/storeSwitcher';
import { useVendorPreview } from '../../../stores/vendorPreview';
import { money } from '../../../lib/money';
import { canAttestPayment, paymentAttestBlockedReason } from '../../../lib/orderStatus';
import { vendorSurfaceForRole } from '../../../lib/vendorRbac';
import { Switch as AvailabilitySwitch } from '../../../kit/switch';
import {
  TYPES,
  catalogueMeta,
  safeVendorRole,
  TabHeader,
  numericFact,
  guyanaDate,
  guyanaDayKey,
  hasTrailingGuyanaDays,
  reconciledRevenueDays,
  windowTotals,
} from '../shared';

// Memoized: the live board re-renders on every socket event, but react-query's
// structural sharing keeps the SAME reference for orders that didn't change, so
// comparing `order` by reference re-renders only the card whose order actually
// moved — not the whole list (D6-MOB-03). The inline onAction/onOpen closures
// change each render but are equivalent for a given order id, so ignoring them
// is safe.
const VendorOrderCard = React.memo(function VendorOrderCard({
  order,
  onAction,
  onOpen,
  busy,
  showStore,
}: {
  order: any;
  onAction: (action: VendorOrderActionKind, code?: string) => void;
  onOpen?: () => void;
  busy: boolean;
  showStore?: boolean;
}) {
  const actions = orderActions(order);
  const isMmg = order.paymentMethod === 'MOBILE_MONEY';
  const mmgPaid = order.paymentStatus === 'CAPTURED';
  const terminal = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'].includes((order.status || '').toUpperCase());
  // [W-25] The states where a store's word is admissible, and the reason when
  // it is not. "Not captured and not terminal" used to offer the button on a
  // FAILED, REFUNDED or unresolved payment, so a tap on a reversed payment
  // recaptured a refund. The words live in lib/orderStatus (one vocabulary),
  // and the server enforces the same matrix.
  const attestable = isMmg && canAttestPayment(order.paymentStatus) && !terminal;
  const payBlockedReason = isMmg && !mmgPaid && !attestable ? paymentAttestBlockedReason(order.paymentStatus) : null;
  const [mmgRef, setMmgRef] = useState('');
  const items = order.itemCount ?? order.items?.length ?? 0;
  const lines: any[] = order.items ?? [];
  const isPickup = order.fulfillment === 'PICKUP';
  const isAppt = order.fulfillment === 'APPOINTMENT';
  // A mobile service stores the customer's address (≠ the store's pickup address).
  const apptMobile = isAppt && !!order.deliveryAddress && order.deliveryAddress !== order.pickupAddress;
  return (
    <Pressable onPress={onOpen} disabled={!onOpen}>
      {({ pressed }) => (
    <View style={{ marginBottom: space.md, opacity: pressed && onOpen ? 0.88 : 1 }}>
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <T variant="body" weight="bold">
            {order.orderNumber ? `#${order.orderNumber}` : 'Order'}
          </T>
          {isPickup ? (
            <FulfillmentTag icon="bag-personal-outline" label="Takeaway" />
          ) : isAppt ? (
            <FulfillmentTag icon="calendar-clock" label="Appointment" />
          ) : order.isExpress ? (
            <FulfillmentTag icon="lightning-bolt" label="Express" />
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <OrderStatusPill status={order.status} />
          {onOpen ? <Feather name="chevron-right" size={16} color={color.text.muted} /> : null}
        </View>
      </View>
      {showStore && order.vendor?.name ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
          <MaterialCommunityIcons name="storefront-outline" size={12} color={color.brand[500]} />
          <T variant="caption" weight="bold" tone="brand" numberOfLines={1}>
            {order.vendor.name}
          </T>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 4 }}>
        <Feather name="clock" size={13} color={color.text.muted} />
        <T variant="caption" tone="muted">
          {fmtWhen(order.placedAt)}
          {items ? ` · ${items} item${items === 1 ? '' : 's'}` : ''}
          {` · ${order.paymentMethod === 'CASH' ? 'Cash' : order.paymentMethod ?? ''}`}
        </T>
      </View>
      {/* What to make — the kitchen reads this off the card */}
      {lines.length > 0 ? (
        <View style={{ marginTop: space.sm, borderRadius: radius.md, backgroundColor: color.surface.subtle, paddingHorizontal: space.md, paddingVertical: space.sm }}>
          {lines.slice(0, 3).map((it: any) => (
            <View key={it.id} style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <T variant="label" weight="bold" tone="brand" style={{ width: 30 }}>
                {it.quantity}×
              </T>
              <T variant="label" numberOfLines={1} style={{ flex: 1 }}>
                {it.name}
              </T>
            </View>
          ))}
          {lines.length > 3 ? (
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              +{lines.length - 3} more — tap for the full order
            </T>
          ) : null}
        </View>
      ) : null}
      {isAppt ? (
        <View style={{ marginTop: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <MaterialCommunityIcons name="calendar-clock" size={14} color={color.brand[500]} />
            <T variant="label" weight="bold">
              {formatSlot(order.appointmentSlot)}
            </T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
            <Feather name={apptMobile ? 'navigation' : 'home'} size={12} color={color.text.muted} />
            <T variant="caption" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
              {apptMobile ? `You travel to: ${order.deliveryAddress}` : 'At your store'}
            </T>
          </View>
        </View>
      ) : isPickup ? (
        // [MOB-050 · A-15] The store is the VERIFIER of the collection code, so
        // the store never sees it. This row printed the customer's code on the
        // order board; it now says only that a code is due, and the code itself
        // is typed on the order screen, where the server compares it.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.sm }}>
          <MaterialCommunityIcons name="form-textbox-password" size={13} color={color.text.muted} />
          <T variant="label" tone="muted">
            Ask the customer for their code at collection
          </T>
        </View>
      ) : !isPickup && order.deliveryAddress ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: space.sm }}>
          <Feather name="map-pin" size={13} color={color.text.muted} />
          <T variant="label" tone="muted" numberOfLines={1} style={{ flex: 1 }}>
            {order.deliveryAddress}
          </T>
        </View>
      ) : null}
      <T variant="heading" style={{ marginTop: space.sm }}>
        {money(order.totalAmount ?? order.total)}
      </T>
      {/* MMG direct-pay: the customer paid the store's own MMG. The vendor
          confirms they got it → the customer's screen flips to Paid. */}
      {isMmg ? (
        <View style={{ marginTop: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <MaterialCommunityIcons
              name={mmgPaid ? 'check-circle' : 'cellphone-check'}
              size={14}
              color={mmgPaid ? color.success : color.warning}
            />
            <T variant="label" weight="semibold" style={{ color: mmgPaid ? color.success : color.warning }}>
              {mmgPaid ? 'MMG payment received' : 'Awaiting MMG payment'}
            </T>
          </View>
          {/* [W-25] "Not captured and not terminal" offered this button on a
              FAILED, REFUNDED or unresolved payment, so a tap on a reversed
              payment recaptured a refund. A store may attest only where money
              plausibly landed and nothing has reversed it — and only with the
              reference from its own wallet message, which is what a later
              reconciliation matches on. The server enforces the same matrix. */}
          {attestable ? (
            <>
              <LabeledInput
                label="MMG transaction reference"
                value={mmgRef}
                onChangeText={setMmgRef}
                autoCapitalize="characters"
                placeholder="From the message in your wallet"
                style={{ marginTop: space.sm }}
              />
              <PillButton
                label={`${money(order.totalAmount ?? order.total)} received in my MMG`}
                size="md"
                icon="check"
                style={{ marginTop: space.sm }}
                disabled={busy || mmgRef.trim().length < 4}
                onPress={() => onAction('confirm-payment', mmgRef.trim())}
              />
            </>
          ) : payBlockedReason ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
              {payBlockedReason}
            </T>
          ) : null}
        </View>
      ) : null}
      {actions.length > 0 ? (
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          {actions.map((a) => (
            <PillButton
              key={a.action}
              label={a.label}
              variant={a.action === 'reject' ? 'outline' : 'primary'}
              size="md"
              style={{ flex: 1 }}
              disabled={busy}
              onPress={() => onAction(a.action)}
            />
          ))}
        </View>
      ) : null}
    </Card>
    </View>
      )}
    </Pressable>
  );
}, (prev, next) => prev.order === next.order && prev.busy === next.busy && prev.showStore === next.showStore);

/**
 * THE EMPTY BOARD [UXR-W-003 · audit item 01].
 *
 * Owns the decision between "you are new" and "you are quiet", and owns its own
 * reads so they only ever fire when the board is actually empty — which is the
 * only moment any of it matters.
 *
 * The split is lifetime orders, a real server number from the profile store's
 * `_count.orders`, never a guess. While that number is unknown — loading, or
 * the read failed — we show the QUIET tile, because claiming someone is brand
 * new is the more damaging of the two mistakes and an outage already has its
 * own card upstream.
 */
/** The EXPERIENCED quiet board — unchanged, plus the one line that keeps quiet
 *  from reading as broken. */
function VendorBoardQuiet() {
  // One page, for one field: the newest order's timestamp.
  const historyQ = useVendorOrderHistory({ page: 1 });
  const lastOrderAt = (historyQ.data as any)?.data?.[0]?.createdAt;
  return (
    <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: color.brand[50], paddingVertical: space.xl, marginBottom: space.xl }}>
      <MaterialCommunityIcons name="check-circle-outline" size={28} color={color.text.muted} />
      <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
        You are all caught up
      </T>
      {lastOrderAt ? (
        <T variant="caption" tone="faint" style={{ marginTop: 2 }}>
          Last order {fmtLocalClock(lastOrderAt)}
        </T>
      ) : null}
    </View>
  );
}

function VendorBoardEmpty({ store, navigation, reachable, canManage }: any) {
  // The profile endpoint already carries `_count.orders` — the store's true
  // lifetime order count, loaded with the store itself. No extra request, and
  // no inference: if the count is absent we do NOT guess that someone is new.
  const lifetimeOrders: number | undefined = store?._count?.orders;
  const firstMorning = lifetimeOrders === 0;

  // Only the first-morning branch needs these, and it is the branch that runs
  // once in a store's life.
  const menuQ = useVendorMenu(firstMorning && canManage);
  const qrQ = useVendorQr(firstMorning && canManage);

  if (!firstMorning) return <VendorBoardQuiet />;

  const menuKnown = menuQ.isSuccess;
  const categories: any[] = menuKnown ? ((menuQ.data as any) ?? []) : [];
  const items: any[] = categories.flatMap((c: any) => c.items ?? []);
  const missingPhotos = items.filter((i: any) => !i.imageUrl).length;
  const shortUrl = (qrQ.data as any)?.shortUrl;
  const open = !!store.isCurrentlyOpen;

  return (
    <BoardFirstRun listening={reachable}>
      {canManage && !menuKnown ? (
        <BoardFirstRunRow
          index={1}
          label={menuQ.isError ? 'Menu status unavailable' : 'Checking your menu'}
          detail={menuQ.isError ? 'Open the menu to check its live items' : 'Loading your live catalogue facts'}
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
      ) : canManage && items.length === 0 ? (
        <BoardFirstRunRow
          index={1}
          label="Add your first item"
          detail={`Your ${catalogueMeta(store.vendorType).label.toLowerCase()} is empty — nothing to order yet`}
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
      ) : canManage ? (
        <BoardFirstRunRow
          index={1}
          label={`Add photos to your ${catalogueMeta(store.vendorType).label.toLowerCase()}`}
          done={missingPhotos === 0}
          // Phrased so it stays grammatical at every count, including one.
          detail={
            missingPhotos === 0
              ? `All ${items.length} items have a photo`
              : `Photos missing on ${missingPhotos} of ${items.length} items`
          }
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
      ) : null}
      <BoardFirstRunRow
        index={canManage ? 2 : 1}
        label={open ? 'You are open' : 'Your store is closed'}
        done={open}
        detail={
          open
            ? 'Customers can order right now'
            : canManage
              ? 'Use the switch below to start taking orders'
              : 'Ask a manager or owner to open the store'
        }
      />
      {canManage ? (
        <BoardFirstRunRow
          index={3}
          label="Share your store link"
          detail={shortUrl ?? (qrQ.isError ? 'Link unavailable — open My QR to retry' : 'Loading your live store link')}
          onPress={() => navigation.navigate('VendorMyQr')}
        />
      ) : null}
    </BoardFirstRun>
  );
}

type HoursRow = {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
};

function formatBusinessTime(value?: string | null) {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [rawHour, minute] = value.split(':').map(Number);
  const suffix = rawHour! >= 12 ? 'PM' : 'AM';
  const hour = rawHour! % 12 || 12;
  return `${hour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function normalizeHours(rows: any): HoursRow[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: any) => {
      const namedDay = typeof row?.day === 'string' ? DAY_LABELS.findIndex((d) => d.toLowerCase() === row.day.toLowerCase().slice(0, 3)) : -1;
      const dayOfWeek = Number.isInteger(row?.dayOfWeek) ? row.dayOfWeek : namedDay;
      if (dayOfWeek < 0 || dayOfWeek > 6) return null;
      return {
        dayOfWeek,
        openTime: String(row.openTime ?? row.open ?? ''),
        closeTime: String(row.closeTime ?? row.close ?? ''),
        isClosed: Boolean(row.isClosed ?? row.closed),
      };
    })
    .filter((row): row is HoursRow => row !== null)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

function hoursSummary(rows: any): string | null {
  const hours = normalizeHours(rows);
  if (hours.length === 0) return null;
  const open = hours.filter((row) => !row.isClosed);
  if (open.length === 0) return 'Closed all week';
  const first = open[0]!;
  const sameWindow = open.every((row) => row.openTime === first.openTime && row.closeTime === first.closeTime);
  const from = formatBusinessTime(first.openTime);
  const to = formatBusinessTime(first.closeTime);
  const window = from && to ? `${from}–${to}` : null;
  if (open.length === 7 && sameWindow && window) return `Daily · ${window}`;
  if (open.length === 1 && window) return `${DAY_LABELS[first.dayOfWeek]} · ${window}`;
  if (sameWindow && window) return `${open.length} open days · ${window}`;
  return `${open.length} open days · hours vary`;
}

function storeStatusEyebrow(store: any, inPreview: boolean) {
  if (inPreview) return { label: 'PREVIEW · READ ONLY', tone: 'brand' as const };
  const open = !!store?.isCurrentlyOpen;
  const accepting = !!store?.acceptingOrders;
  const today = normalizeHours(store?.operatingHours).find((row) => row.dayOfWeek === guyanaDate().getUTCDay());
  const schedule = today && !today.isClosed
    ? [formatBusinessTime(today.openTime), formatBusinessTime(today.closeTime)].filter(Boolean).join('–')
    : null;
  const status = !open ? 'CLOSED' : accepting ? 'OPEN' : 'OPEN · ORDERS PAUSED';
  return {
    label: schedule ? `${status} · TODAY ${schedule}` : status,
    tone: !open ? ('muted' as const) : accepting ? ('success' as const) : ('warning' as const),
  };
}

function HubFact({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <View style={{ flex: 1, borderRadius: radius.md, backgroundColor: color.surface.sunken, padding: space.md }}>
      <T variant="micro" tone="muted">
        {label}
      </T>
      <T variant="numM" numberOfLines={1} style={{ marginTop: space.xs }}>
        {value}
      </T>
      <T variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: space.xs }}>
        {detail}
      </T>
    </View>
  );
}

function VendorRevenuePulse({
  analytics,
  newOrders,
  analyticsError,
  analyticsLoading,
  analyticsUpdatedAt,
}: {
  analytics: any;
  newOrders: any[];
  analyticsError: boolean;
  analyticsLoading: boolean;
  analyticsUpdatedAt: number;
}) {
  const revenueQ = useVendorRevenue(14);
  const opsQ = useVendorOps(7);
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
    ? newOrders
        .map((order) => order.placedAt ?? order.createdAt)
        .filter(Boolean)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0]
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
    <View style={[{ borderRadius: radius.lg, backgroundColor: color.surface.base, padding: space.xl, marginBottom: space.lg }, elevation.card]}>
      <T variant="micro" tone="muted">
        REVENUE TODAY
      </T>
      {showingStale || factsUnavailable || analyticsLoading ? (
        <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
          {showingStale
            ? 'Showing last loaded figures — refresh did not complete.'
            : factsUnavailable
              ? 'Live business facts are unavailable — pull to retry.'
              : 'Loading live business facts…'}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md }}>
        <T variant="displayXl" numberOfLines={1} style={{ flexShrink: 1, marginTop: space.xs }}>
          {todayRevenue == null ? '—' : money(todayRevenue)}
        </T>
        {todayRevenue != null && previousSameDay && !analyticsError && !revenueQ.isError && !revenueBehindAnalytics ? (
          <View style={{ alignItems: 'flex-end', paddingBottom: space.xs }}>
            <DeltaBadge cur={todayRevenue} prev={previousSameDay.revenue} />
            <T variant="caption" tone="muted">
              vs last {previousLabel}
            </T>
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.lg }}>
        <HubFact
          label="ORDERS"
          value={todayOrders == null ? '—' : String(todayOrders)}
          detail={ordersDetail}
        />
        <HubFact
          label="WAITING"
          value={pendingDisplay == null ? '—' : `${pendingDisplay}${pendingCatchingUp || pendingLoadedFallback ? '+' : ''}`}
          detail={waitingDetail}
        />
      </View>
    </View>
  );
}

function ManageTile({
  icon,
  label,
  detail,
  badge,
  badgeLabel,
  onPress,
  wide,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  detail: string;
  badge?: React.ReactNode;
  badgeLabel?: string;
  onPress: () => void;
  wide?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[label, detail, badgeLabel].filter(Boolean).join('. ')}
      accessibilityHint={`Open ${label}`}
      style={{ flexGrow: 1, flexBasis: wide ? '100%' : '46%' }}
    >
      {({ pressed }) => (
        <View
          style={[
            {
              flex: 1,
              borderRadius: radius.lg,
              backgroundColor: color.surface.base,
              padding: space.lg,
              opacity: pressed ? 0.82 : 1,
            },
            elevation.card,
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm }}>
            <View
              style={{
                width: space['4xl'],
                height: space['4xl'],
                borderRadius: radius.full,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: color.brand[50],
              }}
            >
              <MaterialCommunityIcons name={icon} size={20} color={color.brand[600]} />
            </View>
            {badge ?? null}
          </View>
          <T variant="heading" numberOfLines={2} style={{ marginTop: space.md }}>
            {label}
          </T>
          <T variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: space.xs }}>
            {detail}
          </T>
          <Feather name="arrow-up-right" size={16} color={color.brand[500]} style={{ marginTop: space.md }} />
        </View>
      )}
    </Pressable>
  );
}

function financialDeltaLabel(cur: number, prev: number | null) {
  if (prev == null) return undefined;
  if (prev <= 0) return cur > 0 ? 'New revenue in this period' : undefined;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (Math.abs(pct) < 1) return 'Revenue level with previous period';
  return `Revenue ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)} percent`;
}

function subscriptionTone(sub: any): 'brand' | 'success' | 'neutral' | 'error' | 'warning' {
  if (sub?.status === 'ACTIVE') return 'success';
  if (sub?.status === 'PAST_DUE') return 'warning';
  if (sub?.status === 'SUSPENDED' || sub?.status === 'CHURNED') return 'error';
  if (sub?.isTrialActive || sub?.status === 'TRIAL') return 'brand';
  return 'neutral';
}

function billingSummary(sub: any) {
  if (!sub) return 'Subscription not active';
  if (sub.isInGracePeriod && sub.gracePeriodEnd) return `Pay by ${fmtDate(sub.gracePeriodEnd)}`;
  const next = sub.nextBillingDate ? `Next bill ${fmtDate(sub.nextBillingDate)}` : null;
  const rail = sub.billingMethod === 'MOBILE_MONEY' ? 'MMG' : sub.billingMethod === 'CASH' ? 'cash' : null;
  return [next, rail].filter(Boolean).join(' · ') || String(sub.status ?? 'Subscription').toLowerCase();
}

function VendorManagerManageGrid({ navigation, store, myRole, analytics, analyticsStale, analyticsUpdatedAt }: any) {
  const [shareOpen, setShareOpen] = useState(false);
  const menuQ = useVendorMenu();
  const revenueQ = useVendorRevenue(14);
  const hoursQ = useVendorHours();
  const qrQ = useVendorQr();
  const isOwner = myRole === 'OWNER';
  const subQ = useVendorSubscription(isOwner);
  const categories: any[] = menuQ.data ?? [];
  const items = categories.flatMap((category: any) => category.items ?? []);
  const soldOut = items.filter((item: any) => item.isAvailable === false).length;
  const active = Math.max(0, items.length - soldOut);
  const daily = reconciledRevenueDays(revenueQ.data, analytics, 14);
  const revenueWindow = windowTotals(daily, 7);
  const revenueBehindAnalytics = analyticsUpdatedAt > 0 && analyticsUpdatedAt > revenueQ.dataUpdatedAt;
  const revenueKnown = revenueQ.isSuccess && !analyticsStale && !revenueBehindAnalytics && !!analytics && hasTrailingGuyanaDays(daily, 7);
  const schedule = hoursSummary(hoursQ.data ?? store?.operatingHours);
  const sub = subQ.data ?? store?.subscription;
  const rollingOrders = analyticsStale ? null : numericFact(analytics?.week?.orders);
  const menuStale = menuQ.isError && !!menuQ.data;
  const hoursStale = hoursQ.isError && !!hoursQ.data;
  const qrStale = qrQ.isError && !!qrQ.data;
  const subStale = subQ.isError && !!sub;
  const menuDetail = menuQ.isError && !menuQ.data
    ? 'Catalogue unavailable'
    : menuQ.isLoading && !menuQ.data
      ? 'Checking live catalogue…'
      : `${active} active · ${soldOut} sold out${menuStale ? ' · last loaded' : ''}`;
  const revenueDetail = revenueKnown
    ? `7d ${money(revenueWindow.cur.revenue)}`
    : revenueBehindAnalytics && revenueQ.isError
      ? 'Revenue refresh failed'
      : revenueQ.isLoading || revenueBehindAnalytics || (!analytics && !analyticsStale)
      ? 'Checking 7-day revenue…'
      : analyticsStale && analytics
        ? 'Revenue · last loaded'
        : 'Revenue unavailable';
  const revenueDelta = revenueKnown ? financialDeltaLabel(revenueWindow.cur.revenue, revenueWindow.prev?.revenue ?? null) : undefined;
  const qrDetail = qrQ.isError && !qrQ.data
    ? 'Store link unavailable'
    : qrQ.data?.shortUrl
      ? `${qrQ.data.shortUrl}${qrStale ? ' · last loaded' : ''}`
      : qrQ.isLoading
        ? 'Checking store link…'
        : 'Customers scan to order';
  const scheduleDetail = hoursQ.isError && !store?.operatingHours
    ? 'Hours unavailable'
    : `${schedule ?? 'Schedule not set'}${hoursStale ? ' · last loaded' : ''}`;

  return (
    <View style={{ marginTop: space.lg, marginBottom: space.xl }}>
      <T variant="micro" tone="muted">
        MANAGE
      </T>
      <T variant="heading" style={{ marginTop: space.xs, marginBottom: space.md }}>
        The whole business
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        <ManageTile
          icon="book-open-outline"
          label="Menu & inventory"
          detail={menuDetail}
          badge={soldOut > 0 ? <TonePill label={`${soldOut} SOLD OUT`} tone="warning" /> : undefined}
          badgeLabel={soldOut > 0 ? `${soldOut} sold out` : undefined}
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
        <ManageTile
          icon="chart-bar"
          label="Insights"
          detail={revenueDetail}
          badge={revenueKnown ? <DeltaBadge cur={revenueWindow.cur.revenue} prev={revenueWindow.prev?.revenue ?? null} /> : undefined}
          badgeLabel={revenueDelta}
          onPress={() => navigation.navigate('Insights')}
        />
        <ManageTile
          icon="calendar-clock-outline"
          label="Hours & schedule"
          detail={scheduleDetail}
          onPress={() => navigation.navigate(store?.vendorType === 'SERVICE' ? 'Schedule' : 'Account')}
        />
        <ManageTile
          icon="qrcode-scan"
          label={isOwner ? 'My QR & number' : 'My QR'}
          detail={qrDetail}
          badge={qrQ.data?.status ? <TonePill label={String(qrQ.data.status).replace(/_/g, ' ')} tone={qrQ.data.status === 'ACTIVE' ? 'success' : 'neutral'} /> : undefined}
          badgeLabel={qrQ.data?.status ? `QR ${String(qrQ.data.status).replace(/_/g, ' ').toLowerCase()}` : undefined}
          onPress={() => (isOwner ? setShareOpen(true) : navigation.navigate('VendorMyQr'))}
        />
        <ManageTile
          icon="history"
          label="Order history"
          detail={rollingOrders == null ? 'Past orders' : `${rollingOrders} recent orders`}
          onPress={() => navigation.navigate('VendorOrderHistory')}
        />
        <ManageTile
          icon={isOwner ? 'cash-check' : 'account-cog-outline'}
          label={isOwner ? 'Billing' : 'Account'}
          detail={isOwner ? (subQ.isError && !sub ? 'Billing unavailable' : `${billingSummary(sub)}${subStale ? ' · last loaded' : ''}`) : 'Store settings & promos'}
          badge={isOwner && sub ? <TonePill label={String(sub.status ?? 'Subscription').replace(/_/g, ' ')} tone={subscriptionTone(sub)} /> : undefined}
          badgeLabel={isOwner && sub ? `Subscription ${String(sub.status ?? '').replace(/_/g, ' ').toLowerCase()}` : undefined}
          onPress={() => navigation.navigate('Account')}
        />
      </View>
      <PopupCard visible={shareOpen} onClose={() => setShareOpen(false)}>
        <IconChip icon="share-2" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Share or pay
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Your store QR is for customers. Your Swift Number is for the weekly fee.
        </T>
        <PillButton
          label="Open store QR"
          icon="grid"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          onPress={() => {
            setShareOpen(false);
            afterDismiss(() => navigation.navigate('VendorMyQr'));
          }}
        />
        <PillButton
          label="Open Swift Number"
          icon="hash"
          variant="soft"
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          onPress={() => {
            setShareOpen(false);
            afterDismiss(() => navigation.navigate('VendorMySwiftNumber'));
          }}
        />
      </PopupCard>
    </View>
  );
}

function VendorStaffAvailability({ navigation }: any) {
  const menuQ = useVendorMenu();
  const items = ((menuQ.data ?? []) as any[]).flatMap((category: any) => category.items ?? []);
  const soldOut = items.filter((item: any) => item.isAvailable === false).length;
  const detail = menuQ.isError && !menuQ.data
    ? 'Availability unavailable'
    : menuQ.isLoading && !menuQ.data
      ? 'Checking live catalogue…'
      : `${soldOut} sold out · one-tap updates${menuQ.isError && menuQ.data ? ' · last loaded' : ''}`;
  return (
    <View style={{ marginTop: space.lg, marginBottom: space.xl }}>
      <T variant="micro" tone="muted" style={{ marginBottom: space.md }}>
        FLOOR TOOLS
      </T>
      <View style={{ flexDirection: 'row' }}>
        <ManageTile
          wide
          icon="toggle-switch-outline"
          label="Item availability"
          detail={detail}
          badge={soldOut > 0 ? <TonePill label={`${soldOut} SOLD OUT`} tone="warning" /> : undefined}
          badgeLabel={soldOut > 0 ? `${soldOut} sold out` : undefined}
          onPress={() => navigation.navigate('Menu', { screen: 'VendorMenu' })}
        />
      </View>
    </View>
  );
}

export function VendorOps({ store, navigation }: any) {
  const [queueOpen, setQueueOpen] = useState(false);
  const [switchingStore, setSwitchingStore] = useState(false);
  const toggleOpen = useToggleOpen();
  const toggleOrders = useToggleOrders();
  const setSelfDelivery = useSetSelfDelivery();
  const orderAction = useOrderAction();
  const ordersQ = useVendorOrders(true);
  const { stores, owner } = useVendorProfile();
  const myRole = safeVendorRole(owner?.myRole);
  const canManage = myRole === 'OWNER' || myRole === 'MANAGER';
  // Client mirror of the lane's least-privilege surface: STAFF gets the queue
  // plus availability, while money, authoring and settings stay with managers.
  // In sample/pending preview myRole is OWNER, so the full owner view still shows.
  const surface = vendorSurfaceForRole(myRole);
  const analyticsQ = useVendorAnalytics(surface.canSeeMoney);
  // §B preview: the board renders for a not-yet-ACTIVE store (pending vendor) OR
  // for a prospective vendor walking a read-only SAMPLE dashboard (previewType).
  const previewType = useVendorPreview((s) => s.previewType);
  const inPreview = store.status !== 'ACTIVE' || !!previewType;
  const exitPreview = useVendorPreview((s) => s.exitPreview);
  const setPreviewType = useVendorPreview((s) => s.setPreviewType);
  const setPreviewIntent = useAuthStore((s) => s.setIntent);
  // Only fetched to NAME the failing document in the suspension banner.
  const vstatus = useVerificationStatus<any>(store.vendorType);
  // §B5 progress: N of M checklist documents currently approved (unexpired).
  const checklist: string[] = vstatus.data?.checklist ?? [];
  const checklistTotal = checklist.length;
  const checklistApproved = checklist.filter((dt: string) =>
    (vstatus.data?.documents ?? []).some(
      (d: any) => d.docType === dt && d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date()),
    ),
  ).length;
  const failingDocs: string[] = store.isVerified === false
    ? (vstatus.data?.checklist ?? []).filter((dt: string) => {
        const docs = (vstatus.data?.documents ?? []).filter((d: any) => d.docType === dt);
        return !docs.some((d: any) => d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date()));
      })
    : [];
  const setSelectedStore = useStoreSwitcher((s) => s.setSelectedStore);
  const qc = useQueryClient();
  const switchStore = async (id: string) => {
    if (id === store.id || switchingStore) return;
    setSwitchingStore(true);
    disconnectSocket();
    setSelectedStore(id);
    try {
      // Store-aware query keys live outside this lane. Reset the shared cache
      // so the next store never inherits the previous store's role or facts.
      await Promise.all([
        qc.resetQueries({ queryKey: ['vendor'] }),
        qc.resetQueries({ queryKey: ['verification'] }),
      ]);
    } finally {
      setSwitchingStore(false);
    }
  };
  const fetched: any[] = ordersQ.data ?? [];
  const boardLoading = ordersQ.isLoading && !ordersQ.data;
  const boardUnavailable = ordersQ.isError && !ordersQ.data;
  const open = !!store.isCurrentlyOpen;
  const accepting = !!store.acceptingOrders;
  const selfDelivery = !!store.selfDeliveryEnabled;
  const busy = orderAction.isPending;

  // The live board works the open queue; finished orders live in History.
  const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];
  const orders = fetched.filter((o) => !TERMINAL.includes((o.status || '').toUpperCase()));
  const isNew = (s: string) => ['PENDING', 'PLACED'].includes((s || '').toUpperCase());
  // Express bought its place at the FRONT of the kitchen queue — the customer
  // paid for it and the rider cascade runs on a shorter clock.
  const expressFirst = (a: any, b: any) => {
    const priority = Number(!!b.isExpress) - Number(!!a.isExpress);
    if (priority !== 0) return priority;
    const time = (order: any) => {
      const value = new Date(order.placedAt ?? order.createdAt ?? '').getTime();
      return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    };
    return time(a) - time(b);
  };
  const newOrders = orders.filter((o) => isNew(o.status)).sort(expressFirst);
  const inProgress = orders.filter((o) => !isNew(o.status)).sort(expressFirst);
  const status = storeStatusEyebrow(store, inPreview);
  const storeStatusText = (
    <View style={{ flex: 1, paddingRight: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <View style={{ width: space.md, height: space.md, borderRadius: radius.full, backgroundColor: !inPreview && open && accepting ? color.success : color.text.muted }} />
        <T variant="body" weight="bold">
          {inPreview ? 'Not open yet' : !open ? 'Store closed' : accepting ? 'Open for orders' : 'Orders paused'}
        </T>
      </View>
      <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
        {inPreview
          ? 'Your store opens for orders once verification is approved.'
          : !open ? 'Not currently open to customers' : accepting ? 'Accepting new orders' : 'You’re open but not taking new orders'}
      </T>
    </View>
  );

  if (switchingStore) {
    return (
      <Screen>
        <TabHeader title="Switching store…" eyebrow="LOADING BUSINESS" statusTone="muted" />
        <LoadingBlock />
      </Screen>
    );
  }

  return (
    <Screen>
      <TabHeader
        title={store.name}
        eyebrow={status.label}
        statusTone={status.tone}
        avatar={String(store.name ?? 'S').trim().charAt(0).toUpperCase() || 'S'}
      />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={ordersQ.isRefetching || analyticsQ.isRefetching}
            onRefresh={() => void qc.invalidateQueries({ queryKey: ['vendor'] })}
            tintColor={color.brand[500]}
          />
        }
      >
        {/* Multi-store switcher — only when the owner has more than one store. */}
        {stores.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.lg }} contentContainerStyle={{ gap: space.md }}>
            {stores.map((s: any) => (
              <Chip key={s.id} label={s.name} selected={s.id === store.id} onPress={() => void switchStore(s.id)} />
            ))}
          </ScrollView>
        ) : null}

        {/* Gated-trials spec §B: a pending store browses in PREVIEW — encouraging
            copy with live progress (§B5), not the suspension scare. Tap returns
            to the checklist. */}
        {previewType ? (
          // Unauthenticated SAMPLE preview (R4): labelled read-only, with a
          // one-tap switch between the four business types so a prospective owner
          // sees how the dashboard reshapes to theirs.
          <View style={{ borderRadius: radius.lg, backgroundColor: color.brand[50], padding: space.md, marginBottom: space.lg, gap: space.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, flex: 1 }}>
                <Feather name="eye" size={15} color={color.brand[500]} />
                <T variant="label" tone="brand" weight="bold">Preview · sample data, read-only</T>
              </View>
              <Pressable
                testID="vendor-preview-exit"
                accessibilityRole="button"
                accessibilityLabel="Exit business preview"
                accessibilityHint="Return to the Swift role picker"
                onPress={() => { exitPreview(); setPreviewIntent(null); }}
                style={{ minWidth: space['5xl'], minHeight: space['5xl'], alignItems: 'center', justifyContent: 'center' }}
              >
                <T variant="label" tone="brand" weight="bold">Exit</T>
              </Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs }}>
              {TYPES.map((t) => (
                <Chip key={t.key} label={t.label} selected={previewType === t.key} onPress={() => setPreviewType(t.key)} />
              ))}
            </ScrollView>
          </View>
        ) : inPreview ? (
          <Pressable onPress={exitPreview}>
            {({ pressed }) => (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.brand[50], padding: space.md, marginBottom: space.lg, opacity: pressed ? 0.85 : 1 }}>
                <Feather name="eye" size={15} color={color.brand[500]} style={{ marginTop: 1 }} />
                <View style={{ flex: 1 }}>
                  <T variant="label" tone="brand" weight="bold">
                    {checklistTotal > 0
                      ? `Finish verification to start earning — ${checklistApproved} of ${checklistTotal} documents approved.`
                      : 'Finish verification to start earning.'}
                  </T>
                  <T variant="caption" tone="brand" style={{ marginTop: 2 }}>
                    You&apos;re in preview: selling unlocks the moment you&apos;re approved. Tap to track your verification.
                  </T>
                </View>
              </View>
            )}
          </Pressable>
        ) : null}

        {/* Verification suspension — commerce is off until documents are renewed.
            Only a store that has BEEN live can be suspended; pending stores get
            the preview banner above instead. */}
        {!inPreview && store.isVerified === false ? (
          <Pressable onPress={() => navigation?.navigate?.('Account')}>
            {({ pressed }) => (
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.soft.danger, padding: space.md, marginBottom: space.lg, opacity: pressed ? 0.85 : 1 }}>
                <Feather name="alert-circle" size={15} color={color.error} style={{ marginTop: 1 }} />
                <T variant="label" tone="error" style={{ flex: 1 }}>
                  {failingDocs.length > 0
                    ? `Store suspended — ${failingDocs.map((d) => docLabel(d)).join(', ')} ${failingDocs.length === 1 ? 'needs' : 'need'} renewal, so new orders are off. Tap to fix it under Account.`
                    : 'Store suspended — a required document is missing or expired, so new orders are off. Tap to renew it under Account.'}
                </T>
              </View>
            )}
          </Pressable>
        ) : null}

        {surface.canSeeMoney ? (
          <VendorRevenuePulse
            analytics={analyticsQ.data}
            newOrders={newOrders}
            analyticsError={analyticsQ.isError}
            analyticsLoading={analyticsQ.isLoading}
            analyticsUpdatedAt={analyticsQ.dataUpdatedAt}
          />
        ) : (
          <View style={{ borderRadius: radius.lg, backgroundColor: color.surface.sunken, padding: space.lg, marginBottom: space.lg }}>
            <T variant="micro" tone="muted">
              LOADED BOARD
            </T>
            <T variant="numL" style={{ marginTop: space.xs }}>
              {boardLoading || boardUnavailable ? '—' : String(orders.length)}
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              {boardLoading
                ? 'Loading the latest queue…'
                : boardUnavailable
                ? 'Board unreachable — orders may be waiting'
                : `${newOrders.length} new · ${inProgress.length} in progress in the latest page`}
            </T>
          </View>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: space.md }}>
          <View>
            <T variant="micro" tone="muted">
              LATEST QUEUE VIEW
            </T>
            <T variant="heading" style={{ marginTop: space.xs }}>
              {boardLoading
                ? 'Loading active orders…'
                : boardUnavailable
                  ? 'Queue status unavailable'
                : orders.length === 0
                  ? 'No active orders shown'
                  : `${orders.length} shown · ${newOrders.length} waiting here`}
            </T>
          </View>
          {newOrders.length > 0 ? <TonePill label={`${newOrders.length} NEW`} tone="warning" /> : null}
        </View>
        {ordersQ.isError && ordersQ.data ? (
          <T variant="caption" tone="muted" style={{ marginBottom: space.md }}>
            Showing the last loaded queue — refresh did not complete.
          </T>
        ) : null}
        {!ordersQ.isLoading && !(ordersQ.isError && !ordersQ.data) && newOrders.length === 0 && orders.length > 0 ? (
          <VendorBoardEmpty
            store={store}
            navigation={navigation}
            reachable={!ordersQ.isError}
            canManage={canManage}
          />
        ) : null}
        {ordersQ.isLoading ? (
          <LoadingBlock />
        ) : ordersQ.isError && !ordersQ.data ? (
          // [WR-016] An outage must never wear the "caught up" costume: with no
          // data at all, say so and offer retry — orders may be waiting.
          <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: color.brand[50], paddingVertical: space.xl, marginBottom: space.xl }}>
            <MaterialCommunityIcons name="wifi-off" size={28} color={color.text.muted} />
            <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
              Can&apos;t reach the order board — orders may be waiting.
            </T>
            <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.md }} onPress={() => ordersQ.refetch()} />
          </View>
        ) : orders.length === 0 ? (
          <VendorBoardEmpty
            store={store}
            navigation={navigation}
            reachable={!ordersQ.isError}
            canManage={canManage}
          />
        ) : queueOpen ? (
          <>
            <T variant="micro" tone="muted" style={{ marginBottom: space.sm }}>
              NEW ORDERS
            </T>
            {newOrders.length === 0 ? (
              <T variant="label" tone="muted" style={{ marginBottom: space.md }}>
                Nothing is waiting for an answer.
              </T>
            ) : null}
            {newOrders.map((o) => (
              <VendorOrderCard
                key={o.id}
                order={o}
                busy={busy}
                onAction={(action, code) => orderAction.mutate({ id: o.id, action, code })}
                onOpen={() => navigation.navigate('VendorOrderDetail', { orderId: o.id, orderNumber: o.orderNumber })}
              />
            ))}
            {inProgress.length > 0 ? (
              <>
                <T variant="micro" tone="muted" style={{ marginTop: space.md, marginBottom: space.sm }}>
                  IN PROGRESS · {inProgress.length}
                </T>
                {inProgress.map((o) => (
                  <VendorOrderCard
                    key={o.id}
                    order={o}
                    busy={busy}
                    onAction={(action, code) => orderAction.mutate({ id: o.id, action, code })}
                    onOpen={() => navigation.navigate('VendorOrderDetail', { orderId: o.id, orderNumber: o.orderNumber })}
                  />
                ))}
              </>
            ) : null}
          </>
        ) : (
          <>
            <T variant="micro" tone="muted" style={{ marginBottom: space.sm }}>
              {newOrders.length > 0 ? 'WAITING FOR ANSWER' : 'IN PROGRESS'}
            </T>
            <VendorOrderCard
              order={newOrders[0] ?? inProgress[0]}
              busy={busy}
              onAction={(action, code) => orderAction.mutate({ id: (newOrders[0] ?? inProgress[0]).id, action, code })}
              onOpen={() => {
                const order = newOrders[0] ?? inProgress[0];
                navigation.navigate('VendorOrderDetail', { orderId: order.id, orderNumber: order.orderNumber });
              }}
            />
          </>
        )}
        {orders.length > 0 && !(ordersQ.isError && !ordersQ.data) ? (
          <PillButton
            label={queueOpen ? 'Collapse loaded queue' : `Open loaded queue · ${orders.length}`}
            variant="soft"
            size="md"
            icon={queueOpen ? 'chevron-up' : 'list'}
            style={{ marginBottom: space.lg }}
            onPress={() => setQueueOpen((value) => !value)}
          />
        ) : null}

        {canManage ? (
          <VendorManagerManageGrid
            navigation={navigation}
            store={store}
            myRole={myRole}
            analytics={analyticsQ.data}
            analyticsStale={analyticsQ.isError}
            analyticsUpdatedAt={analyticsQ.dataUpdatedAt}
          />
        ) : (
          <VendorStaffAvailability navigation={navigation} />
        )}

        {/* Store status. In §B preview the controls are honestly locked — the
            server refuses commerce-on for an unverified business anyway. */}
        <Card style={{ marginBottom: space.lg }}>
          {/* Open/close is MANAGER-only server-side. The whole 48pt row owns
              the switch semantics so the control is named and easy to hit. */}
          {surface.canToggleOpen ? (
            <Pressable
              disabled={inPreview || toggleOpen.isPending}
              onPress={() => toggleOpen.mutate()}
              accessibilityRole="switch"
              accessibilityLabel="Store open to customers"
              accessibilityHint={open ? 'Close the store to new customers' : 'Open the store to new customers'}
              accessibilityState={{ checked: !inPreview && open, disabled: inPreview || toggleOpen.isPending, busy: toggleOpen.isPending }}
            >
              {({ pressed }) => (
                <View style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', opacity: pressed ? 0.82 : 1 }}>
                  {storeStatusText}
                  <AvailabilitySwitch value={!inPreview && open} disabled={inPreview || toggleOpen.isPending} accessible={false} pointerEvents="none" />
                </View>
              )}
            </Pressable>
          ) : (
            <View style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center' }}>{storeStatusText}</View>
          )}
          {toggleOpen.isError ? (
            <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
              Store status didn’t update — check your connection and try again.
            </T>
          ) : null}
          {!inPreview && canManage ? (
            <PillButton
              label={accepting ? 'Pause new orders' : 'Resume orders'}
              variant="soft"
              size="md"
              style={{ marginTop: space.md }}
              loading={toggleOrders.isPending}
              onPress={() => toggleOrders.mutate()}
            />
          ) : null}
          {toggleOrders.isError ? (
            <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
              {(toggleOrders.error as any)?.response?.data?.error?.message ?? 'Couldn’t update — try again.'}
            </T>
          ) : null}
        </Card>

        {/* Who delivers — self-delivery vs a Swift rider. When on, the server
            routes this store's delivery orders to the vendor (no rider sent).
            MANAGER-only setting, so STAFF don't see a control that would 403. */}
        {!inPreview && surface.canSetSelfDelivery ? (
          <Card style={{ marginBottom: space.lg }}>
            <Pressable
              disabled={setSelfDelivery.isPending}
              onPress={() => setSelfDelivery.mutate(!selfDelivery)}
              accessibilityRole="switch"
              accessibilityLabel="Deliver my own orders"
              accessibilityHint={selfDelivery ? 'Use Swift riders for delivery orders' : 'Route delivery orders to this store'}
              accessibilityState={{ checked: selfDelivery, disabled: setSelfDelivery.isPending, busy: setSelfDelivery.isPending }}
            >
              {({ pressed }) => (
                <View style={{ minHeight: space['5xl'], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', opacity: pressed ? 0.82 : 1 }}>
                  <View style={{ flex: 1, paddingRight: space.md }}>
                    <T variant="body" weight="bold">
                      Deliver my own orders
                    </T>
                    <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                      {selfDelivery
                        ? 'You deliver your orders yourself — Swift won’t send a rider.'
                        : 'Swift sends the nearest rider for your delivery orders.'}
                    </T>
                  </View>
                  <AvailabilitySwitch value={selfDelivery} disabled={setSelfDelivery.isPending} accessible={false} pointerEvents="none" />
                </View>
              )}
            </Pressable>
            {setSelfDelivery.isError ? (
              <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
                Couldn’t update — try again.
              </T>
            ) : null}
          </Card>
        ) : null}

        <T variant="caption" tone="muted" center style={{ marginBottom: space.xl }}>
          You keep 100% of every order — Swift takes no commission.
        </T>

      </ScrollView>
    </Screen>
  );
}
