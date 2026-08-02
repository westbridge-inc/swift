/** @jsxImportSource react */
import React, { useEffect } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useIsFocused } from '@react-navigation/native';

import { color, radius, space } from '@swift/ui';
import { useOrdersInfinite, useReorder } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { DARK_BLURHASH, vendorImage } from '../../../lib/images';
import { Money, Pictogram, Card, EmptyState, ErrorState, LoadingBlock, PillButton, Screen, T } from '../../../kit';

// No kit frame for order history — composed from the kit's Recent Order card
// pattern (thumb · name · meta · trailing action).
const STATUS_TONE: Record<string, { label: string; color: string; bg: string }> = {
  PENDING: { label: 'Pending', color: color.warning, bg: color.soft.warning },
  ACCEPTED: { label: 'Accepted', color: color.warning, bg: color.soft.warning },
  PREPARING: { label: 'Preparing', color: color.warning, bg: color.soft.warning },
  READY: { label: 'Ready', color: color.warning, bg: color.soft.warning },
  RIDER_ASSIGNED: { label: 'On the way', color: color.info, bg: color.soft.info },
  PICKED_UP: { label: 'On the way', color: color.info, bg: color.soft.info },
  DELIVERED: { label: 'Delivered', color: color.success, bg: color.soft.success },
  COMPLETED: { label: 'Completed', color: color.success, bg: color.soft.success },
  CANCELLED: { label: 'Cancelled', color: color.error, bg: color.soft.danger },
  REFUNDED: { label: 'Refunded', color: color.error, bg: color.soft.danger },
  // Taxi lifecycle — rides are orders too and land in the same history.
  DRIVER_ASSIGNED: { label: 'Driver assigned', color: color.info, bg: color.soft.info },
  DRIVER_EN_ROUTE: { label: 'Driver on the way', color: color.info, bg: color.soft.info },
  DRIVER_ARRIVED: { label: 'Driver arrived', color: color.info, bg: color.soft.info },
  RIDE_IN_PROGRESS: { label: 'On trip', color: color.info, bg: color.soft.info },
  FAILED: { label: 'Failed', color: color.error, bg: color.soft.danger },
};

const ACTIVE = new Set([
  'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'RIDER_ASSIGNED', 'PICKED_UP',
  'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS',
]);

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

  if (!isAuthenticated) {
    return (
      <Screen>
        <View style={{ height: 56, alignItems: 'center', justifyContent: 'center' }}>
        <T variant="heading">Activity</T>
      </View>
        <EmptyState picto="orders" title="Sign in to see orders" body="Your order history lives on your account." actionLabel="Sign in" onAction={promptLogin} />
      </Screen>
    );
  }

  const rows: any[] = orders.data?.pages.flatMap((p: any) => p.items) ?? [];

  return (
    <Screen>
      <View style={{ height: 56, alignItems: 'center', justifyContent: 'center' }}>
        <T variant="heading">Activity</T>
      </View>
      {orders.isLoading ? (
        <LoadingBlock />
      ) : orders.isError ? (
        <ErrorState onRetry={() => orders.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          picto="orders"
          title="No orders yet"
          body="Your orders and rides land here — loud and trackable."
          actionLabel="Find food"
          onAction={() => navigation.navigate('Search')}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(o) => o.id}
          refreshControl={<RefreshControl refreshing={orders.isRefetching} onRefresh={() => orders.refetch()} tintColor={color.brand[500]} />}
          contentContainerStyle={{ padding: space['2xl'], gap: space.md, paddingBottom: space['3xl'] }}
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
          renderItem={({ item: o }) => {
            const st = STATUS_TONE[o.status] ?? { label: o.status, color: color.text.secondary, bg: color.surface.subtle };
            const active = ACTIVE.has(o.status);
            const isRide = o.orderType === 'TAXI';
            return (
              <Card style={{ padding: space.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  {isRide ? (
                    // A ride has no storefront — a car tile is its identity.
                    <View style={{ width: 64, height: 64, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
                      <Pictogram name="taxi" size={32} color={color.brand[600]} />
                    </View>
                  ) : (
                    <Image
                      source={{ uri: vendorImage(o.vendor ?? {}) }}
                      placeholder={{ blurhash: DARK_BLURHASH }}
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
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
                      <Money amount={isRide ? (o.taxiFareTotal ?? o.totalAmount) : (o.totalAmount ?? o.total)} tone="brand" />
                      {isRide && o.placedAt ? (
                        <T variant="caption" tone="muted">
                          {new Date(o.placedAt).toLocaleDateString()}
                        </T>
                      ) : null}
                    </View>
                  </View>
                  <View
                    style={{
                      paddingHorizontal: space.md,
                      paddingVertical: 4,
                      borderRadius: 9999,
                      backgroundColor: st.bg,
                    }}
                  >
                    <T variant="caption" weight="semibold" style={{ color: st.color }}>
                      {st.label}
                    </T>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                  {active ? (
                    <PillButton
                      label={isRide ? 'Track ride' : 'Track order'}
                      size="sm"
                      onPress={() => navigation.navigate(isRide ? 'Taxi' : 'Delivery', isRide ? undefined : { orderId: o.id })}
                      style={{ flex: 1 }}
                    />
                  ) : isRide ? (
                    // No storefront to reorder from — rebook the same trip instead.
                    <PillButton
                      label="Book again"
                      variant="soft"
                      size="sm"
                      onPress={() => navigation.navigate('Taxi')}
                      style={{ flex: 1 }}
                    />
                  ) : (
                    <>
                      <PillButton
                        label="Reorder"
                        size="sm"
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
                        size="sm"
                        onPress={() => navigation.navigate('Delivery', { orderId: o.id })}
                        style={{ flex: 1 }}
                      />
                    </>
                  )}
                </View>
              </Card>
            );
          }}
        />
      )}
    </Screen>
  );
}
