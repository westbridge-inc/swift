import { useEffect, useState } from 'react';
import { View, ScrollView, Linking, TextInput } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Spinner, PressableScale, EmptyState, elevation } from '../../../components/ui';
import { useOrder, useRateOrder } from '../../../hooks';
import { getSocket, subscribeToOrder } from '../../../services/socket';
import { money } from '../../../lib/money';
import { Image } from 'expo-image';
import { mediaUrl } from '../../../lib/images';

// Kit "Delivery" screens (35–39): live map on top, white sheet below with the
// staged title, a segmented progress bar, the courier pill row and the order
// summary. Stage titles follow the order's real status; the courier marker is
// fed by the socket room (rider:location / driver:location) with the 15s
// order poll as fallback.

const STEPS = [
  { key: 'placed', label: 'Order placed', sub: (o: any) => `Waiting for ${o.vendor?.name ?? 'the store'} to confirm` },
  { key: 'preparing', label: 'Preparing your order', sub: (o: any) => `${o.vendor?.name ?? 'The store'} is getting it ready` },
  { key: 'ready', label: 'Ready for pickup', sub: () => 'Waiting for your rider to collect it' },
  { key: 'otw', label: 'On the way', sub: (o: any) => `${o.rider?.firstName ?? 'Your rider'} is heading to you` },
  { key: 'delivered', label: 'Delivered', sub: () => 'Enjoy! Rate your order below' },
];

const STATUS_STEP: Record<string, number> = {
  PENDING: 0,
  ACCEPTED: 0,
  PREPARING: 1,
  READY: 2,
  RIDER_ASSIGNED: 2,
  PICKED_UP: 3,
  EN_ROUTE_DELIVERY: 3,
  ARRIVED: 3,
  DELIVERED: 4,
  COMPLETED: 4,
};

function PickupDot() {
  return (
    <View
      style={[
        { width: 16, height: 16, borderRadius: 8, backgroundColor: color.text.primary, borderWidth: 3, borderColor: '#fff' },
        elevation.card,
      ]}
    />
  );
}
function DropPin() {
  return <MaterialCommunityIcons name="map-marker" size={36} color={color.brand[500]} />;
}
function CourierMarker() {
  return (
    <View
      className="items-center justify-center"
      style={[{ width: 36, height: 36, borderRadius: 18, backgroundColor: color.text.primary }, elevation.raised]}
    >
      <MaterialCommunityIcons name="bike-fast" size={18} color="#fff" />
    </View>
  );
}

/** Kit segmented progress — one soft pill per stage, filled to the current. */
function StageBar({ step }: { step: number }) {
  return (
    <View className="mt-md flex-row" style={{ gap: 8 }}>
      {STEPS.map((s, i) => (
        <View
          key={s.key}
          className="flex-1"
          style={{ height: 6, borderRadius: 3, backgroundColor: i <= step ? color.brand[500] : color.border.subtle }}
        />
      ))}
    </View>
  );
}

function StarRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <View className="mt-xs flex-row" style={{ gap: 8 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <PressableScale key={n} onPress={() => onChange(n)} hitSlop={6}>
          <MaterialCommunityIcons
            name={n <= value ? 'star' : 'star-outline'}
            size={34}
            color={n <= value ? color.warning : color.text.muted}
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
        className="mt-md border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary"
        style={{ minHeight: 56, borderRadius: 8 }}
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

/** Kit driver pill — avatar + name/vehicle on a soft full-round row, with the
 *  chat + call action circles on the right. */
function CourierPill({ rider, onChat, onCall }: { rider: any; onChat: () => void; onCall?: () => void }) {
  return (
    <View className="flex-row items-center bg-surface-subtle p-sm" style={{ borderRadius: 100 }}>
      {rider.avatar ? (
        <Image source={{ uri: mediaUrl(rider.avatar) ?? undefined }} style={{ width: 44, height: 44, borderRadius: 22 }} contentFit="cover" />
      ) : (
        <View className="h-11 w-11 items-center justify-center rounded-full bg-surface-base">
          <Feather name="user" size={18} color={color.text.muted} />
        </View>
      )}
      <View className="ml-md flex-1">
        <Text className="font-semibold text-text-primary" style={{ fontSize: 14 }}>{rider.firstName ?? 'Your rider'}</Text>
        <Text className="text-text-secondary" style={{ fontSize: 12 }} numberOfLines={1}>
          {[rider.vehicleColor, rider.vehicleMake, rider.vehicleModel].filter(Boolean).join(' ') || rider.vehicleType || 'Rider'}
          {rider.licensePlate ? ` · ${rider.licensePlate}` : ''}
        </Text>
      </View>
      <PressableScale
        onPress={onChat}
        className="items-center justify-center"
        style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.brand[500] }}
      >
        <Feather name="message-circle" size={18} color="#fff" />
      </PressableScale>
      {onCall ? (
        <PressableScale
          onPress={onCall}
          className="ml-sm items-center justify-center"
          style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color.brand[500] }}
        >
          <Feather name="phone" size={18} color="#fff" />
        </PressableScale>
      ) : null}
    </View>
  );
}

export function OrderTrackingScreen({ navigation, route }: any) {
  const id: string = route?.params?.id ?? '';
  const insets = useSafeAreaInsets();
  // Poll while the order is live so status/rider update even without socket.
  const { data: order, isLoading, isError, refetch } = useOrder<any>(id, 15000);
  const [courierLoc, setCourierLoc] = useState<{ latitude: number; longitude: number } | null>(null);

  // Live pipeline: join the order room (server authorizes), stream courier GPS
  // and refresh on status pushes. REST stays the source of truth for status.
  useEffect(() => {
    if (!id) return;
    const s = getSocket();
    subscribeToOrder(id);
    const onRider = (p: any) => {
      if (p?.lat != null) setCourierLoc({ latitude: Number(p.lat), longitude: Number(p.lng) });
    };
    const onDriver = (p: any) => {
      if (p?.latitude != null) setCourierLoc({ latitude: Number(p.latitude), longitude: Number(p.longitude) });
    };
    const onStatus = (p: any) => {
      if (p?.orderId === id) refetch();
    };
    s.on('rider:location', onRider);
    s.on('driver:location', onDriver);
    s.on('order:status_changed', onStatus);
    return () => {
      s.off('rider:location', onRider);
      s.off('driver:location', onDriver);
      s.off('order:status_changed', onStatus);
      s.emit('order:unsubscribe', { orderId: id });
    };
  }, [id, refetch]);

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
  const stage = STEPS[Math.min(step, STEPS.length - 1)]!;

  const pickup =
    order.vendor?.latitude != null && order.vendor?.longitude != null
      ? { latitude: Number(order.vendor.latitude), longitude: Number(order.vendor.longitude) }
      : null;
  const dropoff =
    order.deliveryLat != null && order.deliveryLng != null
      ? { latitude: Number(order.deliveryLat), longitude: Number(order.deliveryLng) }
      : null;
  const showMap = !!(pickup && dropoff && !cancelled && step < 4);
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
    <View style={{ flex: 1 }} className="bg-surface-subtle">
      {/* Map — kit: the top of the screen IS the map while the order is live */}
      {showMap && region ? (
        <View style={{ height: 300 + insets.top }}>
          <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} initialRegion={region}>
            <Marker coordinate={pickup!} title={order.vendor?.name ?? 'Pickup'} anchor={{ x: 0.5, y: 0.5 }}>
              <PickupDot />
            </Marker>
            <Marker coordinate={dropoff!} title="Delivery" anchor={{ x: 0.5, y: 1 }}>
              <DropPin />
            </Marker>
            {courierLoc ? (
              <Marker coordinate={courierLoc} title={order.rider?.firstName ?? 'Courier'} anchor={{ x: 0.5, y: 0.5 }}>
                <CourierMarker />
              </Marker>
            ) : null}
            <Polyline coordinates={[pickup!, dropoff!]} strokeColor={color.brand[500]} strokeWidth={4} />
          </MapView>
        </View>
      ) : (
        <View style={{ height: insets.top }} />
      )}

      {/* Back — floating over the map */}
      <PressableScale
        onPress={() => navigation?.goBack?.()}
        hitSlop={10}
        style={[
          { position: 'absolute', top: insets.top + 8, left: 16, zIndex: 10, width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base },
          elevation.raised,
        ]}
      >
        <Feather name="chevron-left" size={24} color={color.text.primary} />
      </PressableScale>

      {/* Sheet — tucks over the map, kit r16 seam */}
      <ScrollView
        style={showMap ? { marginTop: -16 } : undefined}
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
      >
        <View
          style={{
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            backgroundColor: color.surface.base,
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 20,
          }}
        >
          {cancelled ? (
            <>
              <Heading size="xl">Order cancelled</Heading>
              <Text className="mt-xs text-sm text-text-secondary">
                {order.orderNumber ? `#${order.orderNumber} — ` : ''}this order was cancelled.
              </Text>
            </>
          ) : (
            <>
              <Heading size="xl">{stage.label}</Heading>
              <Text className="mt-xs text-sm text-text-secondary">{stage.sub(order)}</Text>
              <StageBar step={step} />
            </>
          )}

          {order.rider && !cancelled ? (
            <View className="mt-lg">
              <CourierPill
                rider={order.rider}
                onChat={() => navigation.navigate('Chat', { orderId: order.id ?? id, title: order.rider.firstName ?? 'Your rider' })}
                onCall={order.rider.phone ? () => Linking.openURL(`tel:${order.rider.phone}`).catch(() => {}) : undefined}
              />
              {order.rider.vehiclePhotoUrl ? (
                <Image
                  source={{ uri: mediaUrl(order.rider.vehiclePhotoUrl) ?? undefined }}
                  style={{ width: 88, height: 56, borderRadius: 8, marginTop: 8, marginLeft: 8 }}
                  contentFit="cover"
                />
              ) : null}
            </View>
          ) : null}
        </View>

        {/* Takeaway: the collection code to show at the counter. */}
        {order.fulfillment === 'PICKUP' && order.pickupCode && !cancelled && step < 4 ? (
          <View className="px-lg pt-md">
            <Card className="items-center bg-surface-subtle">
              <Text className="text-xs font-semibold uppercase text-text-muted">Pickup code</Text>
              <Text className="mt-xs text-3xl font-bold tracking-widest" style={{ color: color.brand[600] }}>{order.pickupCode}</Text>
              <Text className="mt-xs text-center text-xs text-text-secondary">
                Show this at {order.vendor?.name ?? 'the store'} to collect your order.
              </Text>
            </Card>
          </View>
        ) : null}

        {/* Rate the order once it's delivered/completed */}
        {step >= 4 && !cancelled ? (
          <View className="px-lg pt-md">
            {order.hasBeenRated ? (
              <Card className="flex-row items-center">
                <MaterialCommunityIcons name="star" size={18} color={color.warning} />
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

        {/* Summary */}
        <View className="px-lg pt-md">
          <Card>
            <View className="flex-row items-center justify-between">
              <Text className="font-semibold text-text-primary" style={{ fontSize: 16 }}>Order summary</Text>
              {order.orderNumber ? (
                <Text className="text-text-muted" style={{ fontSize: 12 }}>#{order.orderNumber}</Text>
              ) : null}
            </View>
            <View className="mt-sm">
              {(order.items ?? []).map((it: any) => (
                <View key={it.id} className="flex-row items-center justify-between py-1">
                  <Text className="flex-1 pr-md text-sm" numberOfLines={1}>{it.quantity}× {it.name}</Text>
                  <Text className="text-sm">{money(it.lineTotal)}</Text>
                </View>
              ))}
            </View>
            <View className="mt-sm border-t border-border-subtle pt-sm">
              <View className="flex-row items-center justify-between py-1">
                <Text className="text-base font-semibold">Total</Text>
                <Text className="text-base font-bold" style={{ color: color.brand[500] }}>{money(order.totalAmount)}</Text>
              </View>
            </View>
            <View className="mt-sm flex-row items-center">
              <MaterialCommunityIcons name="cash" size={16} color={color.success} />
              <Text className="ml-sm text-xs text-text-muted">Pay {money(order.totalAmount)} in cash on delivery.</Text>
            </View>
          </Card>
        </View>
      </ScrollView>
    </View>
  );
}
