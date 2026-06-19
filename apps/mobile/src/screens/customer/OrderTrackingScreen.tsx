import { View, ScrollView, Pressable, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Spinner, Button } from '../../components/ui';
import { useOrder } from '../../hooks';
import { money } from '../../lib/money';

const STEPS = [
  { key: 'placed', label: 'Order placed' },
  { key: 'preparing', label: 'Preparing your order' },
  { key: 'ready', label: 'Ready for pickup' },
  { key: 'otw', label: 'On the way' },
  { key: 'delivered', label: 'Delivered' },
];

const STATUS_STEP: Record<string, number> = {
  PENDING: 0,
  ACCEPTED: 0,
  PREPARING: 1,
  READY: 2,
  PICKED_UP: 3,
  EN_ROUTE_DELIVERY: 3,
  ARRIVED: 3,
  DELIVERED: 4,
  COMPLETED: 4,
};

export function OrderTrackingScreen({ navigation, route }: any) {
  const id: string = route?.params?.id ?? '';
  // Poll while the order is live so status/rider update without manual refresh.
  const { data: order, isLoading, isError, refetch } = useOrder<any>(id, 15000);

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !order) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center px-2xl">
          <Feather name="alert-triangle" size={32} color={color.text.muted} />
          <Text className="mt-sm text-center text-text-secondary">Couldn&apos;t load this order.</Text>
          <Button label="Retry" className="mt-md" onPress={() => refetch()} />
        </View>
      </SafeAreaView>
    );
  }

  const cancelled = ['CANCELLED', 'REFUNDED'].includes(order.status);
  const step = STATUS_STEP[order.status] ?? 0;

  const pickup =
    order.vendor?.latitude != null && order.vendor?.longitude != null
      ? { latitude: Number(order.vendor.latitude), longitude: Number(order.vendor.longitude) }
      : null;
  const dropoff =
    order.deliveryLat != null && order.deliveryLng != null
      ? { latitude: Number(order.deliveryLat), longitude: Number(order.deliveryLng) }
      : null;
  const showMap = !!(pickup && dropoff && !cancelled);
  const region =
    pickup && dropoff
      ? {
          latitude: (pickup.latitude + dropoff.latitude) / 2,
          longitude: (pickup.longitude + dropoff.longitude) / 2,
          latitudeDelta: Math.max(0.02, Math.abs(pickup.latitude - dropoff.latitude) * 2.2),
          longitudeDelta: Math.max(0.02, Math.abs(pickup.longitude - dropoff.longitude) * 2.2),
        }
      : undefined;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </Pressable>
        <Text className="ml-md text-base font-bold">Order{order.orderNumber ? ` #${order.orderNumber}` : ''}</Text>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        {showMap && region ? (
          <View className="mx-lg mb-md overflow-hidden rounded-2xl border border-border-subtle" style={{ height: 200 }}>
            <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} initialRegion={region} pointerEvents="none">
              <Marker coordinate={pickup!} title={order.vendor?.name ?? 'Pickup'} />
              <Marker coordinate={dropoff!} title="Delivery" pinColor={color.brand[500]} />
            </MapView>
          </View>
        ) : null}

        {/* Status banner */}
        <View className="px-lg">
          {cancelled ? (
            <Card className="bg-brand-50">
              <Heading size="lg" className="text-brand-700">Order cancelled</Heading>
              <Text className="mt-xs text-sm text-text-secondary">This order was cancelled.</Text>
            </Card>
          ) : (
            <Card>
              <Heading size="lg">{STEPS[step]?.label ?? 'In progress'}</Heading>
              <Text className="mt-xs text-sm text-text-secondary">
                {order.vendor?.name ?? ''}{order.estimatedPrepTime ? ` · ~${order.estimatedPrepTime} min` : ''}
              </Text>
            </Card>
          )}
        </View>

        {/* Timeline */}
        {!cancelled ? (
          <View className="px-lg pt-md">
            {STEPS.map((s, i) => {
              const done = i <= step;
              return (
                <View key={s.key} className="flex-row items-center py-sm">
                  <View
                    className={
                      done
                        ? 'h-6 w-6 items-center justify-center rounded-full bg-brand-500'
                        : 'h-6 w-6 items-center justify-center rounded-full border border-border-strong bg-surface-base'
                    }
                  >
                    {done ? (
                      <Feather name="check" size={14} color="#fff" />
                    ) : (
                      <Text className="text-xs text-text-muted">{i + 1}</Text>
                    )}
                  </View>
                  <Text className={done ? 'ml-md text-base font-semibold text-text-primary' : 'ml-md text-base text-text-muted'}>
                    {s.label}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* Rider */}
        {order.rider ? (
          <View className="px-lg pt-md">
            <Card className="flex-row items-center justify-between">
              <View className="flex-1 pr-md">
                <Text className="text-xs text-text-secondary">Your rider</Text>
                <Text className="text-base font-semibold">{order.rider.firstName ?? 'Assigned'}</Text>
              </View>
              <View className="flex-row items-center" style={{ gap: 8 }}>
                <Pressable
                  onPress={() => navigation.navigate('Chat', { orderId: order.id ?? id, title: order.rider.firstName ?? 'Your rider' })}
                  className="h-10 w-10 items-center justify-center rounded-full bg-brand-50"
                >
                  <Feather name="message-circle" size={18} color={color.brand[500]} />
                </Pressable>
                {order.rider.phone ? (
                  <Pressable
                    onPress={() => {
                      Linking.openURL(`tel:${order.rider.phone}`).catch(() => {});
                    }}
                    className="h-10 w-10 items-center justify-center rounded-full bg-brand-50"
                  >
                    <Feather name="phone" size={18} color={color.brand[500]} />
                  </Pressable>
                ) : null}
              </View>
            </Card>
          </View>
        ) : null}

        {/* Summary */}
        <View className="px-lg pt-md">
          <Heading size="lg" className="mb-sm">Order summary</Heading>
          <Card>
            {(order.items ?? []).map((it: any) => (
              <View key={it.id} className="flex-row items-center justify-between py-1">
                <Text className="flex-1 pr-md text-sm" numberOfLines={1}>{it.quantity}× {it.name}</Text>
                <Text className="text-sm">{money(it.lineTotal)}</Text>
              </View>
            ))}
            <View className="mt-sm border-t border-border-subtle pt-sm">
              <View className="flex-row items-center justify-between py-1">
                <Text className="text-base font-semibold">Total</Text>
                <Text className="text-base font-semibold">{money(order.totalAmount)}</Text>
              </View>
            </View>
            <View className="mt-sm flex-row items-center">
              <MaterialCommunityIcons name="cash" size={16} color={color.success} />
              <Text className="ml-sm text-xs text-text-muted">Pay {money(order.totalAmount)} in cash on delivery.</Text>
            </View>
          </Card>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
