/** @jsxImportSource react */
import React, { useEffect } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { Image } from 'expo-image';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useOrders, useReorder } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { DARK_BLURHASH, vendorImage } from '../../../lib/images';
import { money } from '../../../lib/money';
import { Card, EmptyState, ErrorState, LoadingBlock, PillButton, Screen, T } from '../../../kit';

// No kit frame for order history — composed from the kit's Recent Order card
// pattern (thumb · name · meta · trailing action).
const STATUS_TONE: Record<string, { label: string; color: string; bg: string }> = {
  PENDING: { label: 'Pending', color: '#B45309', bg: '#FEF3C7' },
  ACCEPTED: { label: 'Accepted', color: '#B45309', bg: '#FEF3C7' },
  PREPARING: { label: 'Preparing', color: '#B45309', bg: '#FEF3C7' },
  READY: { label: 'Ready', color: '#B45309', bg: '#FEF3C7' },
  RIDER_ASSIGNED: { label: 'On the way', color: '#1D4ED8', bg: '#DBEAFE' },
  PICKED_UP: { label: 'On the way', color: '#1D4ED8', bg: '#DBEAFE' },
  DELIVERED: { label: 'Delivered', color: '#15803D', bg: '#DCFCE7' },
  COMPLETED: { label: 'Completed', color: '#15803D', bg: '#DCFCE7' },
  CANCELLED: { label: 'Cancelled', color: '#B91C1C', bg: '#FEE2E2' },
  REFUNDED: { label: 'Refunded', color: '#B91C1C', bg: '#FEE2E2' },
  // Taxi lifecycle — rides are orders too and land in the same history.
  DRIVER_ASSIGNED: { label: 'Driver assigned', color: '#1D4ED8', bg: '#DBEAFE' },
  DRIVER_EN_ROUTE: { label: 'Driver on the way', color: '#1D4ED8', bg: '#DBEAFE' },
  DRIVER_ARRIVED: { label: 'Driver arrived', color: '#1D4ED8', bg: '#DBEAFE' },
  RIDE_IN_PROGRESS: { label: 'On trip', color: '#1D4ED8', bg: '#DBEAFE' },
  FAILED: { label: 'Failed', color: '#B91C1C', bg: '#FEE2E2' },
};

const ACTIVE = new Set([
  'PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'RIDER_ASSIGNED', 'PICKED_UP',
  'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS',
]);

export function OrdersHistoryScreen() {
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin } = useAuthStore();
  const orders = useOrders<any>();
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
        <EmptyState icon="clipboard" title="Sign in to see orders" body="Your order history lives on your account." actionLabel="Sign In" onAction={promptLogin} />
      </Screen>
    );
  }

  const rows: any[] = Array.isArray(orders.data) ? orders.data : (orders.data?.orders ?? []);

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
          icon="clipboard"
          title="No orders yet"
          body="Once you place an order it shows up here."
          actionLabel="Find Foods"
          onAction={() => navigation.navigate('Search')}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(o) => o.id}
          refreshControl={<RefreshControl refreshing={orders.isRefetching} onRefresh={() => orders.refetch()} tintColor={color.brand[500]} />}
          contentContainerStyle={{ padding: space['2xl'], gap: space.md, paddingBottom: space['3xl'] }}
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
                      <MaterialCommunityIcons name="car" size={30} color={color.brand[600]} />
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
                    <T variant="label" weight="bold" tone="brand">
                      {money(isRide ? (o.taxiFareTotal ?? o.totalAmount) : (o.totalAmount ?? o.total))}
                      {isRide && o.placedAt ? (
                        <T variant="caption" tone="muted">
                          {'  '}{new Date(o.placedAt).toLocaleDateString()}
                        </T>
                      ) : null}
                    </T>
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
                      label={isRide ? 'Track ride' : 'Track'}
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
