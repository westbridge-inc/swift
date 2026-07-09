import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, Linking, Pressable, ScrollView, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { useMutation } from '@tanstack/react-query';
import { useOrder } from '../../../hooks/customer';
import { customerApi } from '../../../services/api';
import { connectSocket, getSocket, subscribeToOrder } from '../../../services/socket';
import { money } from '../../../lib/money';
import { CircleChip, ErrorState, IconChip, LoadingBlock, PillButton, PopupCard, T } from '../../../kit';

const { height: SCREEN_H } = Dimensions.get('window');
const GUTTER = space['2xl'];

// Order status → kit stage index (35–38): placed · preparing · oncoming · done.
const STAGES = [
  { icon: 'clipboard' as const, label: 'Placed' },
  { icon: 'coffee' as const, label: 'Preparing' },
  { icon: 'navigation' as const, label: 'On the way' },
  { icon: 'check' as const, label: 'Delivered' },
];

function stageFor(status?: string): number {
  switch (status) {
    case 'PENDING':
    case 'ACCEPTED':
      return 0;
    case 'PREPARING':
    case 'READY':
      return 1;
    case 'RIDER_ASSIGNED':
    case 'PICKED_UP':
      return 2;
    case 'DELIVERED':
    case 'COMPLETED':
      return 3;
    default:
      return 0;
  }
}

function StageBar({ stage }: { stage: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {STAGES.map((s, i) => {
        const done = i < stage;
        const current = i === stage;
        const tint = done || current ? color.brand[500] : color.text.muted;
        return (
          <React.Fragment key={s.label}>
            {i > 0 ? (
              <View
                style={{
                  flex: 1,
                  height: 2,
                  marginHorizontal: 6,
                  borderRadius: 1,
                  backgroundColor: done || current ? color.brand[300] : color.border.subtle,
                }}
              />
            ) : null}
            <View style={{ alignItems: 'center', gap: 4 }}>
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: done || current ? color.brand[50] : color.surface.subtle,
                  borderWidth: current ? 1.5 : 0,
                  borderColor: color.brand[500],
                }}
              >
                <Feather name={s.icon} size={15} color={tint} />
              </View>
              <T variant="caption" tone={done || current ? 'deep' : 'faint'}>
                {s.label}
              </T>
            </View>
          </React.Fragment>
        );
      })}
    </View>
  );
}

// Kit Delivery (35–39): live map + route on top, sheet w/ rider card, delivery
// time, stage bar, order lines. Live courier via socket (rider:location uses
// {lat,lng}; driver:location uses {latitude,longitude} — different keys!) with
// a 15s poll as fallback; order:status_changed refetches.
export function DeliveryScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const orderId: string = route.params?.orderId;

  const order = useOrder<any>(orderId, 15000);
  const [courier, setCourier] = useState<{ latitude: number; longitude: number } | null>(null);
  const [arrived, setArrived] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const prevStatus = useRef<string | null>(null);
  const mapRef = useRef<MapView>(null);

  const cancelOrder = useMutation({
    mutationFn: () => customerApi.cancelOrder(orderId),
    onSuccess: () => order.refetch(),
  });

  const o = order.data;

  // Socket: join the order room, follow courier + status.
  useEffect(() => {
    if (!orderId) return;
    connectSocket();
    subscribeToOrder(orderId);
    const s = getSocket();
    const onRider = (p: any) => {
      if (p?.lat != null && p?.lng != null) setCourier({ latitude: p.lat, longitude: p.lng });
    };
    const onDriver = (p: any) => {
      if (p?.latitude != null && p?.longitude != null) setCourier({ latitude: p.latitude, longitude: p.longitude });
    };
    const onStatus = () => order.refetch();
    s.on('rider:location', onRider);
    s.on('driver:location', onDriver);
    s.on('order:status_changed', onStatus);
    return () => {
      s.off('rider:location', onRider);
      s.off('driver:location', onDriver);
      s.off('order:status_changed', onStatus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // Arrival popup once, on the transition into DELIVERED.
  useEffect(() => {
    const status = o?.status;
    if (!status) return;
    if (prevStatus.current && prevStatus.current !== 'DELIVERED' && status === 'DELIVERED') setArrived(true);
    prevStatus.current = status;
  }, [o?.status]);

  const vendorPos = o?.vendor?.latitude != null ? { latitude: o.vendor.latitude, longitude: o.vendor.longitude } : null;
  const dropPos = o?.deliveryLat != null ? { latitude: o.deliveryLat, longitude: o.deliveryLng } : null;

  const fitMap = () => {
    const pts = [vendorPos, dropPos, courier].filter(Boolean) as { latitude: number; longitude: number }[];
    if (pts.length < 2 || !mapRef.current) return;
    mapRef.current.fitToCoordinates(pts, {
      edgePadding: { top: 90, bottom: 60, left: 60, right: 60 },
      animated: true,
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fitMap, [!!vendorPos, !!dropPos, !!courier]);

  if (order.isLoading) return <LoadingBlock style={{ backgroundColor: color.surface.subtle }} />;
  if (order.isError || !o) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        <ErrorState onRetry={() => order.refetch()} />
      </View>
    );
  }

  const stage = stageFor(o.status);
  const cancelled = o.status === 'CANCELLED' || o.status === 'REFUNDED';
  const rider = o.rider;
  const items: any[] = o.items ?? [];
  const eta = o.estimatedDeliveryTime
    ? new Date(o.estimatedDeliveryTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;

  const initialRegion = vendorPos
    ? { ...vendorPos, latitudeDelta: 0.05, longitudeDelta: 0.05 }
    : { latitude: 6.8013, longitude: -58.1551, latitudeDelta: 0.08, longitudeDelta: 0.08 }; // Georgetown

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      {/* Live map */}
      <View style={{ height: SCREEN_H * 0.48 }}>
        <MapView ref={mapRef} style={{ flex: 1 }} initialRegion={initialRegion}>
          {vendorPos ? (
            <Marker coordinate={vendorPos} title={o.vendor?.name}>
              <View style={{ alignItems: 'center' }}>
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: color.brand[500],
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 2,
                    borderColor: color.white,
                  }}
                >
                  <Feather name="shopping-bag" size={16} color={color.white} />
                </View>
              </View>
            </Marker>
          ) : null}
          {dropPos ? (
            <Marker coordinate={dropPos} title="Delivery address">
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: color.text.primary,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 2,
                  borderColor: color.white,
                }}
              >
                <Feather name="map-pin" size={16} color={color.white} />
              </View>
            </Marker>
          ) : null}
          {courier ? (
            <Marker coordinate={courier} title="Your rider">
              <View
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  backgroundColor: color.white,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 2,
                  borderColor: color.brand[500],
                }}
              >
                <Feather name="navigation" size={16} color={color.brand[500]} />
              </View>
            </Marker>
          ) : null}
          {vendorPos && dropPos ? (
            <Polyline
              coordinates={courier ? [vendorPos, courier, dropPos] : [vendorPos, dropPos]}
              strokeColor={color.brand[500]}
              strokeWidth={4}
              lineDashPattern={[1, 6]}
            />
          ) : null}
        </MapView>

        {/* Floating chips */}
        <View
          style={{
            position: 'absolute',
            top: insets.top + space.sm,
            left: GUTTER,
            right: GUTTER,
            flexDirection: 'row',
            justifyContent: 'space-between',
          }}
        >
          <CircleChip icon="chevron-left" onPress={() => navigation.goBack()} />
          <CircleChip icon="crosshair" onPress={fitMap} />
        </View>
      </View>

      {/* Sheet */}
      <View
        style={{
          flex: 1,
          marginTop: -radius.xl,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          backgroundColor: color.surface.base,
          paddingTop: space.md,
        }}
      >
        <View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: color.border.subtle, alignSelf: 'center' }} />
        <ScrollView contentContainerStyle={{ padding: GUTTER, paddingBottom: insets.bottom + space['2xl'] }}>
          {/* Rider card */}
          {rider ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                backgroundColor: color.surface.subtle,
                borderRadius: radius.lg,
                padding: space.md,
              }}
            >
              {rider.avatar ? (
                <Image source={{ uri: rider.avatar }} style={{ width: 48, height: 48, borderRadius: 24 }} />
              ) : (
                <View
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    backgroundColor: color.brand[50],
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Feather name="user" size={20} color={color.brand[600]} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <T variant="body" weight="semibold">
                  {rider.firstName} {rider.lastName ?? ''}
                </T>
                <T variant="caption" tone="muted" numberOfLines={1}>
                  {rider.licensePlate
                    ? `${rider.vehicleColor ?? ''} ${rider.vehicleMake ?? ''} · ${rider.licensePlate}`.trim()
                    : `Order #${o.orderNumber}`}
                </T>
              </View>
              <Pressable
                onPress={() => navigation.navigate('Conversation', { orderId, title: rider.firstName })}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: color.brand[500],
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Feather name="message-circle" size={18} color={color.white} />
              </Pressable>
              {rider.phone ? (
                <Pressable
                  onPress={() => Linking.openURL(`tel:${rider.phone}`)}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: color.brand[500],
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Feather name="phone" size={18} color={color.white} />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {cancelled ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                marginTop: rider ? space.xl : 0,
                padding: space.lg,
                borderRadius: radius.md,
                backgroundColor: '#FBEAEA',
              }}
            >
              <Feather name="x-circle" size={18} color={color.error} />
              <T variant="body" weight="semibold" tone="error">
                This order was cancelled.
              </T>
            </View>
          ) : (
            <>
              <T variant="heading" style={{ marginTop: rider ? space.xl : 0 }}>
                Your Delivery Time
              </T>
              <T variant="label" tone="muted" style={{ marginTop: 2 }}>
                {eta ? `Estimated by ${eta}` : 'The store will confirm your order shortly'}
              </T>
              {o.deliveryAddress ? (
                <T variant="caption" tone="faint" style={{ marginTop: 2 }} numberOfLines={1}>
                  To: {o.deliveryAddress}
                </T>
              ) : null}

              <View style={{ marginTop: space.xl }}>
                <StageBar stage={stage} />
              </View>
            </>
          )}

          {/* Order lines */}
          <T variant="heading" style={{ marginTop: space['2xl'] }}>
            Order
          </T>
          <View style={{ marginTop: space.sm }}>
            {items.map((it: any, i: number) => (
              <View key={it.id ?? i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6 }}>
                <T variant="body" tone="muted" style={{ flex: 1 }} numberOfLines={1}>
                  {it.quantity} {it.item?.name ?? it.name}
                </T>
                <T variant="body" weight="semibold">
                  {money(it.totalPrice ?? it.lineTotal ?? Number(it.unitPrice ?? 0) * (it.quantity ?? 1))}
                </T>
              </View>
            ))}
            <View style={{ height: 1, backgroundColor: color.border.subtle, marginVertical: space.sm }} />
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T variant="body" weight="semibold" style={{ flex: 1 }}>
                Total
              </T>
              <T variant="body" weight="bold" tone="brand">
                {money(o.totalAmount ?? o.total)}
              </T>
            </View>
          </View>

          {stage === 3 && !cancelled && !o.hasBeenRated ? (
            <PillButton
              label="Rate this order"
              icon="star"
              onPress={() => navigation.navigate('Feedback', { orderId })}
              style={{ marginTop: space.xl }}
            />
          ) : null}

          {o.canCancel ? (
            <PillButton
              label={o.freeCancellationWindow ? 'Cancel order (free)' : 'Cancel order'}
              variant="soft"
              loading={cancelOrder.isPending}
              onPress={() => setConfirmCancel(true)}
              style={{ marginTop: space.md }}
            />
          ) : null}
        </ScrollView>
      </View>

      {/* Cancel confirm */}
      <PopupCard visible={confirmCancel} onClose={() => setConfirmCancel(false)}>
        <IconChip icon="x-circle" size={56} tone="error" />
        <T variant="heading" center style={{ marginTop: space.md }}>
          Cancel this order?
        </T>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          {o.freeCancellationWindow
            ? 'You’re inside the free-cancellation window.'
            : 'The store may have already started preparing it.'}
        </T>
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton
            label="Yes, cancel it"
            size="md"
            onPress={() => {
              setConfirmCancel(false);
              cancelOrder.mutate();
            }}
          />
          <PillButton label="Keep my order" variant="soft" size="md" onPress={() => setConfirmCancel(false)} />
        </View>
      </PopupCard>

      {/* Hooray popup (kit 39) */}
      <PopupCard visible={arrived} onClose={() => setArrived(false)}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: color.brand[500],
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name="check" size={30} color={color.white} />
        </View>
        <T variant="heading" center style={{ marginTop: space.md }}>
          Hooray! Your order has arrived
        </T>
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton
            label="Rate this order"
            size="md"
            onPress={() => {
              setArrived(false);
              navigation.navigate('Feedback', { orderId });
            }}
          />
          <PillButton label="Later" variant="soft" size="md" onPress={() => setArrived(false)} />
        </View>
      </PopupCard>
    </View>
  );
}
