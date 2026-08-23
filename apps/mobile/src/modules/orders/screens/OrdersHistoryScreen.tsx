/** @jsxImportSource react */
import React, { useEffect } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';

import { color, radius, space } from '@swift/ui';
import { useOrdersInfinite, useReorder } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { vendorPhoto } from '../../../lib/images';
import {
  Photo,
  Card, EmptyState, ErrorState, GradientMasthead, LoadingBlock, Money,
  Pictogram, PillButton, Screen, T,
} from '../../../kit';
import { TonePill } from '../../../kit/controls';

// [design-100x Flow-7] The activity LEDGER: live journeys first on a sunken
// band, then completed rows grouped under truthful date eyebrows. The
// masthead ends in the kit's clean curve [founder veto 08-22: no toothed edges].

type PillTone = 'brand' | 'success' | 'neutral' | 'error' | 'warning' | 'info';
const STATUS_TONE: Record<string, { label: string; tone: PillTone }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  ACCEPTED: { label: 'Accepted', tone: 'warning' },
  PREPARING: { label: 'Preparing', tone: 'warning' },
  READY: { label: 'Ready', tone: 'warning' },
  RIDER_ASSIGNED: { label: 'On the way', tone: 'info' },
  PICKED_UP: { label: 'On the way', tone: 'info' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'error' },
  REFUNDED: { label: 'Refunded', tone: 'error' },
  // Taxi lifecycle — rides are orders too and land in the same history.
  DRIVER_ASSIGNED: { label: 'Driver assigned', tone: 'info' },
  DRIVER_EN_ROUTE: { label: 'Driver on the way', tone: 'info' },
  DRIVER_ARRIVED: { label: 'Driver arrived', tone: 'info' },
  RIDE_IN_PROGRESS: { label: 'On trip', tone: 'info' },
  FAILED: { label: 'Failed', tone: 'error' },
};

// Partition by the CLOSED set: a status is history only when the server says
// the order is over. Enumerating live states here instead once dropped five
// real ones (READY_FOR_PICKUP, both pickup-leg rider states, EN_ROUTE_DELIVERY,
// ARRIVED) into "completed" and hid Track order on live deliveries — a new
// enum member must default to the live (recoverable) side, never to history.
const TERMINAL = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED']);
const isLive = (status: string) => !TERMINAL.has(status);

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

type LedgerItem =
  | { kind: 'eyebrow'; id: string; label: string }
  | { kind: 'row'; id: string; order: any; index: number };

export function OrdersHistoryScreen() {
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin } = useAuthStore();
  const orders = useOrdersInfinite();
  const reorder = useReorder();

  // Tab screens stay mounted, so without this the list NEVER updates after
  // first load (found live: a delivered order stuck on "Pending" forever).
  const isFocused = useIsFocused();
  useEffect(() => {
    if (isFocused && isAuthenticated) orders.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  const masthead = (
    <>
      <GradientMasthead style={{ paddingTop: 76, paddingBottom: space.xl, paddingHorizontal: space['2xl'] }}>
        <T variant="micro" tone="onBrand">ORDERS & RIDES</T>
        <T variant="title" tone="onBrand" style={{ marginTop: 2 }}>Your activity</T>
      </GradientMasthead>
    </>
  );

  if (!isAuthenticated) {
    return (
      <Screen bleed>
        {masthead}
        <EmptyState picto="orders" title="Sign in to see orders" body="Your order history lives on your account." actionLabel="Sign in" onAction={promptLogin} />
      </Screen>
    );
  }

  const rows: any[] = orders.data?.pages.flatMap((p: any) => p.items) ?? [];
  const live = rows.filter((o) => isLive(o.status));
  const done = rows.filter((o) => !isLive(o.status));
  const ledger: LedgerItem[] = [];
  let lastEyebrow = '';
  let rowIndex = 0;
  for (const o of done) {
    const eyebrow = dateEyebrow(o.placedAt);
    if (eyebrow !== lastEyebrow) {
      ledger.push({ kind: 'eyebrow', id: `eb-${eyebrow}-${o.id}`, label: eyebrow });
      lastEyebrow = eyebrow;
    }
    ledger.push({ kind: 'row', id: o.id, order: o, index: rowIndex });
    rowIndex += 1;
  }

  const renderOrder = (o: any, index: number, sunken: boolean) => {
    const st = STATUS_TONE[o.status] ?? { label: o.status, tone: 'neutral' as PillTone };
    const active = isLive(o.status);
    const isRide = o.orderType === 'TAXI';
    const inner = (
      <Card style={{ padding: space.md, ...(sunken ? {} : {}) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          {isRide ? (
            // A ride has no storefront — a car tile is its identity.
            <View style={{ width: 64, height: 64, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
              <Pictogram name="taxi" size={32} color={color.brand[600]} />
            </View>
          ) : (
            <Photo
              uri={vendorPhoto(o.vendor)}
              label={o.vendor?.name}
              glyph="shops"
              transition={150}
              style={{ width: 64, height: 64, borderRadius: radius.md }}
              contentFit="cover"
            />
          )}
          <View style={{ flex: 1, gap: 3 }}>
            <T variant="body" weight="semibold" numberOfLines={1}>
              {isRide
                ? `Taxi${o.rideClass ? ` · ${String(o.rideClass).charAt(0)}${String(o.rideClass).slice(1).toLowerCase()}` : ''}`
                : o.vendor?.name ?? 'Order'}
            </T>
            <T variant="caption" tone="muted" numberOfLines={1}>
              {isRide && (o.pickupAddress || o.deliveryAddress)
                ? `${o.pickupAddress ?? 'Pickup'} → ${o.deliveryAddress ?? 'Drop-off'}`
                : `#${o.orderNumber} · ${o.placedAt ? new Date(o.placedAt).toLocaleDateString() : ''}`}
            </T>
            <Money amount={isRide ? (o.taxiFareTotal ?? o.totalAmount) : (o.totalAmount ?? o.total)} tone="brand" />
          </View>
          <TonePill label={st.label} tone={st.tone} />
        </View>
        <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
          {active ? (
            <PillButton
              label={isRide ? 'Track ride' : 'Track order'}
              size="md"
              onPress={() => navigation.navigate(isRide ? 'Taxi' : 'Delivery', isRide ? undefined : { orderId: o.id })}
              style={{ flex: 1 }}
            />
          ) : isRide ? (
            // No storefront to reorder from — rebook the same trip instead.
            <PillButton
              label="Book again"
              variant="soft"
              size="md"
              onPress={() => navigation.navigate('Taxi')}
              style={{ flex: 1 }}
            />
          ) : (
            <>
              <PillButton
                label="Reorder"
                size="md"
                loading={reorder.isPending && reorder.variables === o.id}
                onPress={() =>
                  reorder.mutate(o.id, {
                    onSuccess: () => navigation.navigate('Tabs', { screen: 'Cart' }),
                  })
                }
                style={{ flex: 1 }}
              />
              <PillButton
                label="Details"
                variant="soft"
                size="md"
                onPress={() => navigation.navigate('Delivery', { orderId: o.id })}
                style={{ flex: 1 }}
              />
            </>
          )}
        </View>
      </Card>
    );
    // Stagger only the first six rows — a ledger is quiet, not a parade.
    return index < 6 ? (
      <Animated.View entering={FadeInDown.duration(280).delay(index * 40).reduceMotion(ReduceMotion.System)}>
        {inner}
      </Animated.View>
    ) : inner;
  };

  return (
    <Screen bleed>
      {orders.isLoading ? (
        <>
          {masthead}
          <LoadingBlock />
        </>
      ) : orders.isError ? (
        <>
          {masthead}
          <ErrorState onRetry={() => orders.refetch()} />
        </>
      ) : rows.length === 0 ? (
        <>
          {masthead}
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
            <View style={{ marginHorizontal: -space['2xl'] }}>
              {masthead}
              {live.length > 0 ? (
                <View style={{ backgroundColor: color.surface.sunken, paddingHorizontal: space['2xl'], paddingTop: space.lg, paddingBottom: space.md, gap: space.md }}>
                  <T variant="micro" tone="muted">IN PROGRESS</T>
                  {live.map((o, i) => (
                    <View key={o.id}>{renderOrder(o, i, true)}</View>
                  ))}
                </View>
              ) : null}
              {ledger.length > 0 ? <View style={{ height: space.md }} /> : null}
            </View>
          }
          refreshControl={<RefreshControl refreshing={orders.isRefetching} onRefresh={() => orders.refetch()} tintColor={color.brand[500]} />}
          contentContainerStyle={{ paddingHorizontal: space['2xl'], gap: space.md, paddingBottom: space['3xl'] }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (orders.hasNextPage && !orders.isFetchingNextPage) orders.fetchNextPage();
          }}
          ListFooterComponent={
            orders.isFetchingNextPage ? (
              <T variant="caption" tone="muted" center style={{ paddingVertical: space.lg }}>
                Loading more…
              </T>
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === 'eyebrow' ? (
              <T variant="micro" tone="muted" style={{ marginTop: space.sm }}>
                {item.label}
              </T>
            ) : (
              renderOrder(item.order, item.index + live.length, false)
            )
          }
        />
      )}
    </Screen>
  );
}
