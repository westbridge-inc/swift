/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, Linking, Pressable, ScrollView, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { useMutation } from '@tanstack/react-query';
import { useOrder, useTipOrder, useDecideSubstitution } from '../../../hooks/customer';
import { toast } from '../../../components/ui/toast';
import { customerApi, courierApi } from '../../../services/api';
import { connectSocket, getSocket, subscribeToOrder } from '../../../services/socket';
import { money } from '../../../lib/money';
import { CircleChip, ErrorState, IconChip, LoadingBlock, PillButton, PopupCard, T } from '../../../kit';

const { height: SCREEN_H } = Dimensions.get('window');
const GUTTER = space['2xl'];

// Order status → kit stage index (35–38): placed · preparing · oncoming · done.
// The four words are fulfillment-specific — a booked haircut is not "On the
// way / Delivered" (D8-07). Same stage indices, right vocabulary per journey.
const STAGES_BY_FULFILLMENT = {
  DELIVERY: [
    { icon: 'clipboard' as const, label: 'Placed' },
    { icon: 'coffee' as const, label: 'Preparing' },
    { icon: 'navigation' as const, label: 'On the way' },
    { icon: 'check' as const, label: 'Delivered' },
  ],
  PICKUP: [
    { icon: 'clipboard' as const, label: 'Placed' },
    { icon: 'coffee' as const, label: 'Preparing' },
    { icon: 'shopping-bag' as const, label: 'Ready' },
    { icon: 'check' as const, label: 'Picked up' },
  ],
  APPOINTMENT: [
    { icon: 'clipboard' as const, label: 'Booked' },
    { icon: 'check-circle' as const, label: 'Confirmed' },
    { icon: 'clock' as const, label: 'In progress' },
    { icon: 'check' as const, label: 'Completed' },
  ],
} as const;

function stagesFor(fulfillment?: string) {
  return STAGES_BY_FULFILLMENT[fulfillment as keyof typeof STAGES_BY_FULFILLMENT] ?? STAGES_BY_FULFILLMENT.DELIVERY;
}

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

function StageBar({ stage, fulfillment }: { stage: number; fulfillment?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {stagesFor(fulfillment).map((s, i) => {
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

/** Free-cancel countdown while the order is held (hidden from the store). */
function HeldBanner({ holdExpiresAt, vendorName, onExpire }: { holdExpiresAt?: string | null; vendorName?: string; onExpire: () => void }) {
  const [, tick] = useState(0);
  const expiresMs = holdExpiresAt ? new Date(holdExpiresAt).getTime() : 0;
  const remaining = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
  const active = !!holdExpiresAt && remaining > 0;

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (new Date(holdExpiresAt!).getTime() <= Date.now()) onExpire();
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, holdExpiresAt]);

  if (!active) return null;
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        backgroundColor: color.brand[50],
        borderRadius: radius.lg,
        padding: space.md,
        marginBottom: space.md,
      }}
    >
      <Feather name="clock" size={18} color={color.brand[600]} />
      <View style={{ flex: 1 }}>
        <T variant="label" weight="semibold">
          {vendorName ?? 'The store'} gets your order in {mm}:{String(ss).padStart(2, '0')}
        </T>
        <T variant="caption" tone="muted" style={{ marginTop: 1 }}>
          Changed your mind? Cancelling is free until then.
        </T>
      </View>
    </View>
  );
}

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

  // A courier job cancels through its own endpoint so the assigned rider is
  // freed AND told they're back in the dispatch pool (the generic order-cancel
  // frees the rider row but doesn't notify them). Everything else uses the
  // standard customer cancel with its free-window / fee logic.
  const cancelOrder = useMutation({
    mutationFn: () =>
      order.data?.orderType === 'COURIER' ? courierApi.cancel(orderId) : customerApi.cancelOrder(orderId),
    onSuccess: () => order.refetch(),
  });
  const tip = useTipOrder(orderId);
  const decideSub = useDecideSubstitution(orderId);

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
    s.on('order:substitution', onStatus);
    return () => {
      s.off('rider:location', onRider);
      s.off('driver:location', onDriver);
      s.off('order:status_changed', onStatus);
      s.off('order:substitution', onStatus);
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
  // REST last-known position seeds the marker instantly on open/reconnect;
  // the live socket stream overrides it from the first event.
  const courierPos =
    courier ?? (o?.rider?.currentLat != null ? { latitude: Number(o.rider.currentLat), longitude: Number(o.rider.currentLng) } : null);

  const fitMap = () => {
    const pts = [vendorPos, dropPos, courierPos].filter(Boolean) as { latitude: number; longitude: number }[];
    if (pts.length < 2 || !mapRef.current) return;
    mapRef.current.fitToCoordinates(pts, {
      edgePadding: { top: 90, bottom: 60, left: 60, right: 60 },
      animated: true,
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fitMap, [!!vendorPos, !!dropPos, !!courierPos]);

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
          {courierPos ? (
            <Marker coordinate={courierPos} title="Your rider">
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
              coordinates={courierPos ? [vendorPos, courierPos, dropPos] : [vendorPos, dropPos]}
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
          {/* LIFECYCLE_V2 hold — the store hasn't been told yet; cancelling is
              free until the countdown ends. Server clock decides; this is UI. */}
          <HeldBanner holdExpiresAt={o.holdExpiresAt} vendorName={o.vendor?.name} onExpire={() => order.refetch()} />

          {/* Out-of-stock substitutions (§5.3) — the store asked; you decide. */}
          {items
            .filter((it: any) => it.subStatus === 'PENDING')
            .map((it: any) => (
              <View
                key={`sub-${it.id}`}
                style={{ backgroundColor: color.brand[50], borderRadius: radius.lg, padding: space.md, marginBottom: space.md }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <Feather name="repeat" size={16} color={color.brand[600]} />
                  <T variant="label" weight="bold" style={{ flex: 1 }}>
                    {it.name} is out of stock
                  </T>
                </View>
                <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                  {o.vendor?.name ?? 'The store'} suggests {it.substituteName} ({money(Number(it.substitutePrice ?? 0))}
                  {it.quantity > 1 ? ` × ${it.quantity}` : ''}) instead. Rejecting removes the item and lowers your total.
                </T>
                <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                  <PillButton
                    label="Approve swap"
                    size="sm"
                    style={{ flex: 1 }}
                    loading={decideSub.isPending}
                    disabled={decideSub.isPending}
                    onPress={() => decideSub.mutate({ lineId: it.id, approve: true })}
                  />
                  <PillButton
                    label="No thanks"
                    variant="soft"
                    size="sm"
                    style={{ flex: 1 }}
                    disabled={decideSub.isPending}
                    onPress={() => decideSub.mutate({ lineId: it.id, approve: false })}
                  />
                </View>
              </View>
            ))}

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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: rider ? space.xl : 0 }}>
                <T variant="heading">Your Delivery Time</T>
                {o.isExpress ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 9999, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: '#FDF1DC' }}>
                    <Feather name="zap" size={11} color={color.warning} />
                    <T variant="caption" weight="bold" style={{ color: '#8A5A00' }}>
                      Express
                    </T>
                  </View>
                ) : null}
              </View>
              <T variant="label" tone="muted" style={{ marginTop: 2 }}>
                {eta ? `Estimated by ${eta}` : 'The store will confirm your order shortly'}
              </T>
              {o.deliveryAddress ? (
                <T variant="caption" tone="faint" style={{ marginTop: 2 }} numberOfLines={1}>
                  To: {o.deliveryAddress}
                </T>
              ) : null}

              <View style={{ marginTop: space.xl }}>
                <StageBar stage={stage} fulfillment={o.fulfillment} />
              </View>
            </>
          )}

          {/* Takeaway handover gate — the counter asks for THIS code. It only
              lived on the checkout confirmation before; now the order screen
              keeps it until the store marks the order collected. */}
          {o.fulfillment === 'PICKUP' && o.pickupCode && !cancelled && stage < 3 ? (
            <View
              style={{
                alignItems: 'center',
                borderRadius: radius.lg,
                backgroundColor: color.brand[50],
                paddingVertical: space.lg,
                marginTop: space.xl,
              }}
            >
              <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
                PICKUP CODE — SHOW AT THE COUNTER
              </T>
              <T variant="display" weight="bold" tone="brand" style={{ marginTop: 4, letterSpacing: 6 }}>
                {o.pickupCode}
              </T>
            </View>
          ) : null}

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

          {/* Post-delivery tip — 100% to the rider. Shown once, after delivery,
              only if they haven't tipped yet. */}
          {stage === 3 && !cancelled && o.rider && Number(o.tipAmount ?? 0) === 0 ? (
            <View style={{ borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.lg, marginTop: space.xl }}>
              <T variant="body" weight="bold">
                Add a tip for {o.rider?.firstName ?? 'your rider'}?
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                100% goes to them — Swift takes nothing.
              </T>
              <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
                {[200, 500, 1000].map((amt) => (
                  <PillButton
                    key={amt}
                    label={money(amt)}
                    variant="soft"
                    size="md"
                    style={{ flex: 1 }}
                    disabled={tip.isPending}
                    onPress={() => tip.mutate(amt, { onSuccess: () => toast.success('Thanks!', `${money(amt)} tip sent to ${o.rider?.firstName ?? 'your rider'}.`) })}
                  />
                ))}
              </View>
            </View>
          ) : stage === 3 && !cancelled && Number(o.tipAmount ?? 0) > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.xl }}>
              <Feather name="heart" size={14} color={color.success} />
              <T variant="caption" tone="muted">
                You tipped {money(o.tipAmount)} — thank you.
              </T>
            </View>
          ) : null}

          {stage === 3 && !cancelled && !o.hasBeenRated ? (
            <PillButton
              label="Rate this order"
              icon="star"
              onPress={() => navigation.navigate('Feedback', { orderId })}
              style={{ marginTop: space.md }}
            />
          ) : null}

          {/* Something wrong with this order? Open a tracked support ticket
              pre-tied to it, instead of an email into the void. */}
          <PillButton
            label="Report a problem"
            variant="soft"
            icon="life-buoy"
            onPress={() => navigation.navigate('GetHelp', { orderId, category: 'ORDER_ISSUE' })}
            style={{ marginTop: space.md }}
          />

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
          {o.orderType === 'COURIER'
            ? 'This cancels the pickup and puts the rider back in the dispatch pool. It can’t be undone.'
            : o.freeCancellationWindow
              ? 'You’re inside the free-cancellation window — no charge.'
              : Number(o.cancellationFee) > 0
                ? `The store may have started preparing it. Cancelling now costs ${money(o.cancellationFee)}.`
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
