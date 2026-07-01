import { useState } from 'react';
import { View, ScrollView, Linking, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Spinner, PressableScale, EmptyState } from '../../../components/ui';
import { useOrder, useRateOrder } from '../../../hooks';
import { money } from '../../../lib/money';

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

function StarRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <View className="mt-xs flex-row" style={{ gap: 8 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <PressableScale key={n} onPress={() => onChange(n)} hitSlop={6}>
          <MaterialCommunityIcons
            name={n <= value ? 'star' : 'star-outline'}
            size={34}
            color={n <= value ? color.brand[500] : color.text.muted}
          />
        </PressableScale>
      ))}
    </View>
  );
}

function RatingCard({ orderId, vendorName, hasRider, riderName }: { orderId: string; vendorName: string; hasRider: boolean; riderName: string }) {
  const rate = useRateOrder(orderId);
  const [vendorScore, setVendorScore] = useState(0);
  const [riderScore, setRiderScore] = useState(0);
  const [comment, setComment] = useState('');
  const canSubmit = vendorScore > 0 || riderScore > 0;

  const submit = () => {
    const body: { vendorScore?: number; vendorComment?: string; riderScore?: number } = {};
    if (vendorScore > 0) {
      body.vendorScore = vendorScore;
      if (comment.trim()) body.vendorComment = comment.trim();
    }
    if (riderScore > 0) body.riderScore = riderScore;
    rate.mutate(body);
  };

  return (
    <Card>
      <Heading size="lg">Rate your order</Heading>
      <Text className="mt-sm text-sm font-semibold text-text-primary">How was {vendorName}?</Text>
      <StarRow value={vendorScore} onChange={setVendorScore} />
      {hasRider ? (
        <>
          <Text className="mt-md text-sm font-semibold text-text-primary">How was {riderName}?</Text>
          <StarRow value={riderScore} onChange={setRiderScore} />
        </>
      ) : null}
      <TextInput
        value={comment}
        onChangeText={setComment}
        placeholder="Add a comment (optional)"
        placeholderTextColor={color.text.muted}
        multiline
        className="mt-md rounded-2xl border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary"
        style={{ minHeight: 56 }}
      />
      {rate.isError ? <Text className="mt-sm text-center text-sm text-error">Couldn&apos;t submit. Please try again.</Text> : null}
      <View className="mt-md">
        <Button loading={rate.isPending} disabled={!canSubmit} onPress={submit}>
          <Text className="font-body font-semibold text-white">Submit rating</Text>
        </Button>
      </View>
    </Card>
  );
}

export function OrderTrackingScreen({ navigation, route }: any) {
  const id: string = route?.params?.id ?? '';
  // Poll while the order is live so status/rider update without manual refresh.
  const { data: order, isLoading, isError, refetch } = useOrder<any>(id, 15000);

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (isError || !order) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon="alert-circle-outline"
            title="Couldn’t load this order"
            body="Something went wrong on our end."
            actionLabel="Retry"
            onAction={() => refetch()}
          />
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
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

          {/* Takeaway: the collection code to show at the counter. */}
          {order.fulfillment === 'PICKUP' && order.pickupCode && !cancelled && step < 4 ? (
            <Card className="mt-md items-center bg-surface-subtle">
              <Text className="text-xs font-semibold uppercase text-text-muted">Pickup code</Text>
              <Text className="mt-xs text-3xl font-bold tracking-widest text-brand-600">{order.pickupCode}</Text>
              <Text className="mt-xs text-center text-xs text-text-secondary">
                Show this at {order.vendor?.name ?? 'the store'} to collect your order.
              </Text>
            </Card>
          ) : null}
        </View>

        {/* Rate the order once it's delivered/completed */}
        {step >= 4 && !cancelled ? (
          <View className="px-lg pt-md">
            {order.hasBeenRated ? (
              <Card className="flex-row items-center">
                <MaterialCommunityIcons name="star" size={18} color={color.brand[500]} />
                <Text className="ml-sm text-sm font-semibold text-text-primary">Thanks for rating this order</Text>
              </Card>
            ) : (
              <RatingCard
                orderId={order.id ?? id}
                vendorName={order.vendor?.name ?? 'the vendor'}
                hasRider={!!order.rider}
                riderName={order.rider?.firstName ?? 'your rider'}
              />
            )}
          </View>
        ) : null}

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
                <PressableScale
                  onPress={() => navigation.navigate('Chat', { orderId: order.id ?? id, title: order.rider.firstName ?? 'Your rider' })}
                  className="h-10 w-10 items-center justify-center rounded-full bg-brand-50"
                >
                  <Feather name="message-circle" size={18} color={color.brand[500]} />
                </PressableScale>
                {order.rider.phone ? (
                  <PressableScale
                    onPress={() => {
                      Linking.openURL(`tel:${order.rider.phone}`).catch(() => {});
                    }}
                    className="h-10 w-10 items-center justify-center rounded-full bg-brand-50"
                  >
                    <Feather name="phone" size={18} color={color.brand[500]} />
                  </PressableScale>
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
                <Text className="text-base font-extrabold text-brand-600">{money(order.totalAmount)}</Text>
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
