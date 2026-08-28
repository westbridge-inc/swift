/** @jsxImportSource react */
import React, { useEffect } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';

import { color, radius, space } from '@swift/ui';
import { useLiveOrders, useOrdersInfinite, useReorder } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { vendorPhoto } from '../../../lib/images';
// The single authority for what a status is CALLED — type-aware, so a ride is
// never described with a store's words. This screen owns tone, never wording.
import { orderStatusLabel } from '../../../lib/orderStatus';
import {
  Photo,
  EmptyState, ErrorState, LoadingBlock, Money,
  Pictogram, PillButton, Screen, T,
} from '../../../kit';
import { TonePill } from '../../../kit/controls';

// [design-100x Flow-7] The activity LEDGER, re-read off the rendered slides.
//
// THE CHROME IS PAPER, NOT BRAND. This screen used to open with a full-bleed
// maroon GradientMasthead slab holding a white eyebrow and a white title.
// There is no such slab anywhere in the design: the top of Activity is the
// same warm paper as the rest of it, with an INK title sitting directly on it —
// exactly the shape Home now uses. `GradientMasthead` is NOT deleted and is still exported from the kit (FG-2), but this screen was the last caller: it now has ZERO call sites app-wide and is dead code awaiting a founder decision. Logged as an FG-2 deletion candidate — not removed here.
//
// CONTENT SITS ON OPEN PAPER. Completed activity is not a stack of floating
// white cards — it is a ledger: hairline-divided rows on the page ground,
// grouped under truthful date eyebrows, with the amount in INK (money is never
// brand). The ONE exception the design grants a card chassis is a LIVE order:
// an in-flight journey is an interruption, not history, so it earns a bordered
// card and the screen's maroon CTA.

type PillTone = 'brand' | 'success' | 'neutral' | 'error' | 'warning' | 'info';

/**
 * TONE only. The WORDS come from `lib/orderStatus.ts`.
 *
 * This map used to carry both, and it carried the same defect that file was
 * written to kill: a `READY` key against an enum whose member is
 * `READY_FOR_PICKUP`. The key never matched, so a real order fell to the
 * fallback below — which prints the status back at the customer. The activity
 * list showed a live order as literally "READY_FOR_PICKUP", in a pill, twice.
 * Four more statuses had no entry at all and leaked the same way
 * (RIDER_EN_ROUTE_PICKUP, RIDER_ARRIVED_PICKUP, EN_ROUTE_DELIVERY, ARRIVED).
 *
 * Those are the very five the comment below already names — an earlier fix
 * caught them dropping out of the LIVE partition and stopped one line short of
 * the labels beside it. A second copy of the label table is why: the fix landed
 * on the authority and never reached the fork.
 *
 * So the fork is gone. Words have one owner, which is also type-aware (a ride
 * is not "waiting for the store"); tone stays here because it is this screen's
 * own concern and that file has no opinion about pill colour.
 */
const STATUS_TONE: Record<string, PillTone> = {
  PENDING: 'warning',
  ACCEPTED: 'warning',
  PREPARING: 'warning',
  READY_FOR_PICKUP: 'warning',
  RIDER_ASSIGNED: 'info',
  RIDER_EN_ROUTE_PICKUP: 'info',
  RIDER_ARRIVED_PICKUP: 'info',
  PICKED_UP: 'info',
  EN_ROUTE_DELIVERY: 'info',
  ARRIVED: 'info',
  DELIVERED: 'success',
  COMPLETED: 'success',
  CANCELLED: 'error',
  REFUNDED: 'error',
  // Taxi lifecycle — rides are orders too and land in the same history.
  DRIVER_ASSIGNED: 'info',
  DRIVER_EN_ROUTE: 'info',
  DRIVER_ARRIVED: 'info',
  RIDE_IN_PROGRESS: 'info',
  FAILED: 'error',
};

/** The pill: never the raw enum. An unknown status keeps a neutral tone and
 *  gets the authority's honest "In progress" rather than its own name. */
function statusPill(o: { status: string; orderType?: string | null }): { label: string; tone: PillTone } {
  return {
    label: orderStatusLabel(o.status, o.orderType),
    tone: STATUS_TONE[o.status] ?? 'neutral',
  };
}

// THE PARTITION IS THE SERVER'S, AND IT IS NOT A FILTER.
//
// This screen used to hold its own copy of the terminal set and split the rows
// it had loaded with it. Both halves of that were wrong.
//
// The set was a duplicate: `TERMINAL_ORDER_STATUSES` already exists beside the
// enum, and an earlier bug here — five live statuses landing in "completed"
// because the LIVE side was the one enumerated — is exactly what a second copy
// produces. It is gone; the server answers `live` now.
//
// The filter was worse, because it looked correct. History is `placedAt` DESC
// and pages at 20, so filtering loaded rows can only ever find live orders
// among the most recent few. A real account had 19 open, 6 of them on page one:
// thirteen orders — three still awaiting pickup since March — sat under a
// heading that said "IN PROGRESS" and listed six. Scrolling revealed them one
// page at a time, so the list also grew upward under the reader's thumb.
//
// Live orders are now fetched as live orders. History is the other query, and
// the two are reconciled BY ID below, never by re-deriving liveness here.

/** Truthful date eyebrow for a completed row. */
function dateEyebrow(iso: string | undefined): string {
  if (!iso) return 'EARLIER';
  const d = new Date(iso);
  const today = new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / oneDay);
  if (diff <= 0) return 'TODAY';
  if (diff === 1) return 'YESTERDAY';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }).toUpperCase();
}

/** Time of day for a row, or null when the server sent nothing usable. A row
 *  with no timestamp simply drops the clock — it never invents one. */
function timeOfDay(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** WHAT WAS ORDERED — assembled from the server's own line items (the list
 *  endpoint returns `items: [{ name, quantity, price }]`). No items on the
 *  payload → null, and the line is omitted entirely. Never a placeholder. */
function itemsSummary(o: any): string | null {
  const items: any[] = Array.isArray(o?.items) ? o.items : [];
  const named = items.filter((i) => typeof i?.name === 'string' && i.name.trim().length > 0);
  if (named.length === 0) return null;
  const head = named.slice(0, 2).map((i) => {
    const q = Number(i.quantity);
    return Number.isFinite(q) && q > 1 ? `${q}× ${String(i.name).trim()}` : String(i.name).trim();
  });
  const rest = named.length - head.length;
  return rest > 0 ? `${head.join(', ')} +${rest} more` : head.join(', ');
}

/** The amount the row is allowed to show, or null. `money()` turns a missing
 *  value into "$0", which is a lie on a ledger — so a row with no server
 *  amount prints an em-dash instead. */
function rowAmount(o: any, isRide: boolean): number | null {
  const raw = isRide ? (o.taxiFareTotal ?? o.totalAmount) : (o.totalAmount ?? o.total);
  const n = Number(raw);
  return raw === null || raw === undefined || !Number.isFinite(n) ? null : n;
}

const isRideOrder = (o: any) => o?.orderType === 'TAXI';

/** A ride has no storefront, so its identity is the class it was booked at. */
const rideTitle = (o: any) =>
  `Taxi${o.rideClass ? ` · ${String(o.rideClass).charAt(0)}${String(o.rideClass).slice(1).toLowerCase()}` : ''}`;

type LedgerItem =
  | { kind: 'eyebrow'; id: string; label: string }
  | { kind: 'row'; id: string; order: any; index: number; divided: boolean };

export function OrdersHistoryScreen() {
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin } = useAuthStore();
  const orders = useOrdersInfinite();
  const liveOrders = useLiveOrders();
  const reorder = useReorder();

  // Tab screens stay mounted, so without this the list NEVER updates after
  // first load (found live: a delivered order stuck on "Pending" forever).
  // BOTH queries refresh: an order that finishes while the tab sits in the
  // background leaves the live list and joins history, and refreshing only one
  // of them would show it in neither — or in both.
  const isFocused = useIsFocused();
  useEffect(() => {
    if (isFocused && isAuthenticated) {
      orders.refetch();
      liveOrders.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  // THE PAPER HEADER — ink on the page ground, no slab, no white pill.
  const header = (
    <View style={{ paddingTop: space.lg, paddingBottom: space.lg }}>
      <T variant="micro" tone="muted">ORDERS & RIDES</T>
      <T variant="title" style={{ marginTop: 2 }}>Your activity</T>
    </View>
  );
  const headerBlock = <View style={{ paddingHorizontal: space['2xl'] }}>{header}</View>;

  if (!isAuthenticated) {
    return (
      <Screen>
        {headerBlock}
        <EmptyState picto="orders" title="Sign in to see orders" body="Your order history lives on your account." actionLabel="Sign in" onAction={promptLogin} />
      </Screen>
    );
  }

  const pages: any[] = (orders.data?.pages as any[]) ?? [];
  const rows: any[] = pages.flatMap((p: any) => p.items) ?? [];
  // HONEST ENDS: the count on the footer is the server's own `meta.total`.
  // When the endpoint does not say how many there are, there is no footer at
  // all — a "load more" that cannot state what it is loading towards is a
  // guess wearing a control's clothes.
  const lastMeta: any = pages.length > 0 ? pages[pages.length - 1]?.meta : undefined;
  const serverTotal: number | null =
    typeof lastMeta?.total === 'number' && Number.isFinite(lastMeta.total) ? lastMeta.total : null;

  const live: any[] = liveOrders.data?.items ?? [];

  // Reconciled BY ID, not by re-deriving what "live" means. If the history feed
  // ever hands back an order that the live query also returned — an older API
  // that ignores `live`, a status that changed between the two round-trips — it
  // is dropped from history rather than rendered twice. This cannot drift the
  // way a second status list would, because it never names a status.
  const liveIds = new Set(live.map((o) => String(o.id)));
  const done = rows.filter((o) => !liveIds.has(String(o.id)));

  // NO SILENT CAP. The live query asks for one generous page; if a customer
  // somehow has more open orders than that, the screen says so instead of
  // quietly showing a prefix.
  const liveTotal: number | null = liveOrders.data?.total ?? null;
  const liveHidden = liveTotal != null && liveTotal > live.length ? liveTotal - live.length : 0;
  const ledger: LedgerItem[] = [];
  let lastEyebrow = '';
  let rowIndex = 0;
  for (const o of done) {
    const eyebrow = dateEyebrow(o.placedAt);
    const opensGroup = eyebrow !== lastEyebrow;
    if (opensGroup) {
      ledger.push({ kind: 'eyebrow', id: `eb-${eyebrow}-${o.id}`, label: eyebrow });
      lastEyebrow = eyebrow;
    }
    // The hairline belongs BETWEEN rows of the same day — the row that opens a
    // date group is already separated by its eyebrow.
    ledger.push({ kind: 'row', id: o.id, order: o, index: rowIndex, divided: !opensGroup });
    rowIndex += 1;
  }

  /** The 56pt identity square. Photography carries its own radius and sits on
   *  paper; a ride, having no storefront, gets a hairline-bordered tile. */
  const identity = (o: any, isRide: boolean, size: number) =>
    isRide ? (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius.md,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: color.surface.base,
          borderWidth: 1,
          borderColor: color.border.subtle,
        }}
      >
        <Pictogram name="taxi" size={26} color={color.text.primary} />
      </View>
    ) : (
      <Photo
        uri={vendorPhoto(o.vendor)}
        label={o.vendor?.name}
        glyph="shops"
        transition={150}
        style={{ width: size, height: size, borderRadius: radius.md }}
        contentFit="cover"
      />
    );

  /** Money in INK, or an em-dash when the server sent no amount. */
  const amountText = (o: any, isRide: boolean) => {
    const amount = rowAmount(o, isRide);
    return amount === null ? (
      <T variant="numM" tone="faint">—</T>
    ) : (
      <Money amount={amount} />
    );
  };

  // ── LIVE: the one card chassis this design allows ────────────────────────
  // An in-flight order is an interruption, not history. It gets a bordered
  // card, its live status pill, and the screen's single maroon CTA.
  const renderLive = (o: any, index: number) => {
    const st = statusPill(o);
    const isRide = isRideOrder(o);
    const sub = isRide && (o.pickupAddress || o.deliveryAddress)
      ? `${o.pickupAddress ?? 'Pickup'} → ${o.deliveryAddress ?? 'Drop-off'}`
      : itemsSummary(o);
    const inner = (
      <View
        style={{
          backgroundColor: color.surface.base,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: color.border.subtle,
          padding: space.lg,
          gap: space.md,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          {identity(o, isRide, 56)}
          <View style={{ flex: 1, gap: 3 }}>
            <T variant="heading" numberOfLines={1}>
              {isRide ? rideTitle(o) : o.vendor?.name ?? 'Order'}
            </T>
            {sub ? (
              <T variant="body" tone="muted" numberOfLines={1}>
                {sub}
              </T>
            ) : null}
          </View>
          {amountText(o, isRide)}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <TonePill label={st.label} tone={st.tone} />
          {o.orderNumber ? (
            <T variant="label" tone="muted" numberOfLines={1}>
              #{o.orderNumber}
            </T>
          ) : null}
        </View>
        <PillButton
          label={isRide ? 'Track ride' : 'Track order'}
          size="md"
          onPress={() => navigation.navigate(isRide ? 'Taxi' : 'Delivery', isRide ? undefined : { orderId: o.id })}
        />
      </View>
    );
    // Same stagger gate as the ledger below — a queue is quiet, not a parade.
    return index < 6 ? (
      <Animated.View entering={FadeInDown.duration(280).delay(index * 40).reduceMotion(ReduceMotion.System)}>
        {inner}
      </Animated.View>
    ) : inner;
  };

  // ── HISTORY: open paper, hairline-divided ────────────────────────────────
  const renderHistory = (o: any, index: number, divided: boolean) => {
    const st = statusPill(o);
    const isRide = isRideOrder(o);
    const sub = isRide && (o.pickupAddress || o.deliveryAddress)
      ? `${o.pickupAddress ?? 'Pickup'} → ${o.deliveryAddress ?? 'Drop-off'}`
      : itemsSummary(o);
    // Status · time · order number — every part dropped when the server did
    // not send it, so the line never carries an invented value.
    const meta = [st.label, timeOfDay(o.placedAt), o.orderNumber ? `#${o.orderNumber}` : null]
      .filter(Boolean)
      .join(' · ');
    const inner = (
      <View
        style={{
          flexDirection: 'row',
          gap: space.md,
          paddingVertical: space.lg,
          borderTopWidth: divided ? 1 : 0,
          borderTopColor: color.border.subtle,
        }}
      >
        {identity(o, isRide, 56)}
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
            <View style={{ flex: 1, gap: 3 }}>
              <T variant="label" tone="muted" numberOfLines={1}>
                {meta}
              </T>
              <T variant="heading" numberOfLines={1}>
                {isRide ? rideTitle(o) : o.vendor?.name ?? 'Order'}
              </T>
              {sub ? (
                <T variant="body" tone="muted" numberOfLines={1}>
                  {sub}
                </T>
              ) : null}
            </View>
            {amountText(o, isRide)}
          </View>
          {/* Actions stay on paper: hairline-bordered pills, never maroon —
              brand is reserved for the live card's one CTA. */}
          <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
            {isRide ? (
              // No storefront to reorder from — rebook the same trip instead.
              <PillButton
                label="Book again"
                variant="outline"
                size="md"
                onPress={() => navigation.navigate('Taxi')}
              />
            ) : (
              <>
                <PillButton
                  label="Reorder"
                  variant="outline"
                  size="md"
                  loading={reorder.isPending && reorder.variables === o.id}
                  onPress={() =>
                    reorder.mutate(o.id, {
                      onSuccess: () => navigation.navigate('Tabs', { screen: 'Cart' }),
                    })
                  }
                />
                <PillButton
                  label="Details"
                  variant="outline"
                  size="md"
                  onPress={() => navigation.navigate('Delivery', { orderId: o.id })}
                />
              </>
            )}
          </View>
        </View>
      </View>
    );
    // Stagger only the first six rows — a ledger is quiet, not a parade.
    return index < 6 ? (
      <Animated.View entering={FadeInDown.duration(280).delay(index * 40).reduceMotion(ReduceMotion.System)}>
        {inner}
      </Animated.View>
    ) : inner;
  };

  return (
    <Screen>
      {orders.isLoading || liveOrders.isLoading ? (
        <>
          {headerBlock}
          <LoadingBlock />
        </>
      ) : orders.isError && live.length === 0 ? (
        // Only when there is genuinely nothing to show. A history failure must
        // not blank out live orders that loaded fine — those are the ones the
        // customer opened this tab for.
        <>
          {headerBlock}
          <ErrorState
            onRetry={() => {
              orders.refetch();
              liveOrders.refetch();
            }}
          />
        </>
      ) : rows.length === 0 && live.length === 0 ? (
        <>
          {headerBlock}
          <EmptyState
            picto="orders"
            title="No activity yet"
            body="Orders and rides will show here."
            actionLabel="Browse Swift"
            onAction={() => navigation.navigate('Search')}
          />
        </>
      ) : (
        <FlatList
          data={ledger}
          keyExtractor={(it) => it.id}
          ListHeaderComponent={
            <View>
              {header}
              {liveOrders.isError ? (
                // The live query failed. Saying nothing here would render an
                // absence as "nothing is in progress", which is the one thing
                // this section must never imply.
                <Pressable
                  onPress={() => liveOrders.refetch()}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading orders in progress"
                  style={{ paddingBottom: space.md }}
                >
                  <T variant="caption" tone="muted">
                    Couldn’t load orders in progress. Tap to retry.
                  </T>
                </Pressable>
              ) : null}
              {live.length > 0 ? (
                <View style={{ gap: space.md, paddingBottom: space.sm }}>
                  <T variant="micro" tone="muted">IN PROGRESS</T>
                  {live.map((o, i) => (
                    <View key={o.id}>{renderLive(o, i)}</View>
                  ))}
                  {liveHidden > 0 ? (
                    <T variant="caption" tone="muted">
                      +{liveHidden} more in progress
                    </T>
                  ) : null}
                </View>
              ) : null}
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={orders.isRefetching || liveOrders.isRefetching}
              onRefresh={() => {
                orders.refetch();
                liveOrders.refetch();
              }}
              tintColor={color.brand[500]}
            />
          }
          contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (orders.hasNextPage && !orders.isFetchingNextPage) orders.fetchNextPage();
          }}
          ListFooterComponent={
            orders.isFetchingNextPage ? (
              <T variant="caption" tone="muted" center style={{ paddingVertical: space.lg }}>
                Loading more…
              </T>
            ) : orders.hasNextPage && serverTotal !== null ? (
              <Pressable
                onPress={() => orders.fetchNextPage()}
                accessibilityRole="button"
                accessibilityLabel={`Show more. ${rows.length} of ${serverTotal} shown`}
                style={{ paddingVertical: space.lg, alignItems: 'center' }}
              >
                {({ pressed }) => (
                  <View style={{ alignItems: 'center', gap: 2, opacity: pressed ? 0.6 : 1 }}>
                    <T variant="label" weight="semibold">Show more</T>
                    <T variant="caption" tone="muted">
                      {rows.length} of {serverTotal} shown
                    </T>
                  </View>
                )}
              </Pressable>
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === 'eyebrow' ? (
              <T variant="micro" tone="muted" style={{ marginTop: space.xl, marginBottom: space.sm }}>
                {item.label}
              </T>
            ) : (
              renderHistory(item.order, item.index + live.length, item.divided)
            )
          }
        />
      )}
    </Screen>
  );
}
