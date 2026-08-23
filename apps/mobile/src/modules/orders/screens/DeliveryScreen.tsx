/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, Linking, Pressable, ScrollView, View } from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { Image } from 'expo-image';
import Svg, { Circle } from 'react-native-svg';
import { openExternal } from '../../../lib/openExternal';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, motion, radius, space } from '@swift/ui';
import { useMutation } from '@tanstack/react-query';
import { useOrder, useDecideSubstitution } from '../../../hooks/customer';
import { customerApi, courierApi } from '../../../services/api';
import { connectSocket, getSocket, subscribeToOrder } from '../../../services/socket';
import { money } from '../../../lib/money';
import { haptic } from '../../../lib/haptics';
import { openMmgPaymentAction, safeMmgPaymentActionUrl } from '../../../lib/payLink';
import { toast } from '../../../components/ui/toast';
import { holdRingActive, holdRingCaption } from './hold-ring';
import { CircleChip, DecorativeIcon, ErrorState, IconChip, InfoRow, LoadingBlock, PillButton, PopupCard, PopupTitle, T } from '../../../kit';

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

/** Opacity-only pulse for the CURRENT stage step (design-100×: gentle, once
 *  per cycle, nothing else moves). */
function PulseIcon({ active, children }: { active: boolean; children: React.ReactNode }) {
  const o = useSharedValue(1);
  useEffect(() => {
    if (active) {
      o.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: motion.duration.gentle * 2 }),
          withTiming(1, { duration: motion.duration.gentle * 2 }),
        ),
        -1,
      );
    } else {
      o.value = withTiming(1, { duration: motion.duration.fast });
    }
  }, [active, o]);
  const style = { opacity: o };
  return <Animated.View style={style}>{children}</Animated.View>;
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
              <PulseIcon active={current}>
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
              </PulseIcon>
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

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const RING_R = 45;
const RING_C = 2 * Math.PI * RING_R;

/** THE HOLD RING (design-100× Part 5 moment 1): Swift's free-cancel window as
 *  a 96dp draining ring — brand stroke on a brand track, mm:ss in displayXl
 *  tabular at its center, server-timestamped, one linear sweep per second.
 *  At 0:30 the ring, digits and copy shift to warning and the warn haptic
 *  fires once. The ticking is information, not decoration. No fake movement:
 *  when the window ends the order refetches and the timeline takes over. */
export function HoldRing({
  holdExpiresAt,
  createdAt,
  vendorName,
  onExpire,
  mmgAmbiguous,
  hidden,
}: {
  holdExpiresAt?: string | null;
  createdAt?: string | null;
  vendorName?: string;
  onExpire: () => void;
  /** [REPORT-009 F-01 / REPORT-010 F-04] MOBILE_MONEY + PENDING: the pay link
   *  opened at checkout, so "cancelling is free" may be FALSE. REQUIRED (no
   *  default) so deleting the call-site wiring is a compile error, not a
   *  silently restored defect. */
  mmgAmbiguous: boolean;
  /** A cancelled order keeps its future holdExpiresAt — never show a live
   *  "you can still cancel" ring over the cancelled banner. REQUIRED. */
  hidden: boolean;
}) {
  const [, tick] = useState(0);
  const warned = useRef(false);
  const expiresMs = holdExpiresAt ? new Date(holdExpiresAt).getTime() : 0;
  const totalMs = Math.max(1000, expiresMs - (createdAt ? new Date(createdAt).getTime() : expiresMs - 300_000));
  const remainingMs = Math.max(0, expiresMs - Date.now());
  const remaining = Math.floor(remainingMs / 1000);
  const active = holdRingActive(holdExpiresAt, Date.now(), hidden);
  const warn = active && remaining <= 30;

  const progress = useSharedValue(Math.min(1, remainingMs / totalMs));

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      const rem = new Date(holdExpiresAt!).getTime() - Date.now();
      progress.value = withTiming(Math.max(0, Math.min(1, rem / totalMs)), {
        duration: 1000,
        easing: Easing.linear,
      });
      if (rem <= 0) onExpire();
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, holdExpiresAt]);

  useEffect(() => {
    if (warn && !warned.current) {
      warned.current = true;
      haptic.warn();
    }
  }, [warn]);

  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: RING_C * (1 - progress.value),
  }));

  if (!active) return null;
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  const hue = warn ? color.warning : color.brand[500];

  return (
    <View style={{ alignItems: 'center', paddingVertical: space.md, marginBottom: space.md }}>
      <View style={{ width: 96, height: 96, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={96} height={96} viewBox="0 0 96 96" style={{ position: 'absolute' }}>
          <Circle cx={48} cy={48} r={RING_R} stroke={color.brand[100]} strokeWidth={6} fill="none" />
          <AnimatedCircle
            cx={48}
            cy={48}
            r={RING_R}
            stroke={hue}
            strokeWidth={6}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${RING_C}`}
            animatedProps={ringProps}
            transform="rotate(-90 48 48)"
          />
        </Svg>
        <T variant="displayXl" style={{ color: hue }}>
          {mm}:{String(ss).padStart(2, '0')}
        </T>
      </View>
      <T variant="bodyStrong" center style={{ marginTop: space.md }}>
        Your order goes to {vendorName ?? 'the store'} when the ring closes.
      </T>
      <T variant="caption" tone={warn ? 'warning' : 'muted'} center style={{ marginTop: 2 }}>
        {holdRingCaption(mmgAmbiguous)}
      </T>
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
  // Server-computed ETA for the courier's ACTIVE leg, refreshed with the
  // location stream [SWIFT-UG-RT-01]. Null until the first event lands.
  const [liveEtaMin, setLiveEtaMin] = useState<number | null>(null);
  const [arrived, setArrived] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const prevStatus = useRef<string | null>(null);
  const mapRef = useRef<MapView>(null);

  // A courier job cancels through its own endpoint so the assigned rider is
  // freed AND told they're back in the dispatch pool (the generic order-cancel
  // frees the rider row but doesn't notify them). Everything else uses the
  // standard customer cancel with its free-window / fee logic.
  // [REPORT-011 F-02] The SERVER owns the clock: the cancel result carries the
  // authoritative message (and any late-cancel fee it actually charged). Keep
  // it and show it, instead of discarding it and rendering a stale generic
  // banner — a client-clock/preview "free" promise must never be the last word.
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [cancelFee, setCancelFee] = useState<number | null>(null);
  const cancelOrder = useMutation({
    mutationFn: () =>
      order.data?.orderType === 'COURIER' ? courierApi.cancel(orderId) : customerApi.cancelOrder(orderId),
    onSuccess: (res: any) => {
      // customerApi.cancelOrder is unwrapped at the seam; the courier endpoint
      // still returns the raw envelope — accept both shapes, never lose the
      // message OR the numeric fee the server actually charged.
      const payload = res?.data?.data ?? res?.data ?? res ?? {};
      if (typeof payload.message === 'string') setCancelMessage(payload.message);
      setCancelFee(typeof payload.cancellationFee === 'number' ? payload.cancellationFee : null);
      order.refetch();
    },
  });
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
      if (typeof p?.etaMinutes === 'number') setLiveEtaMin(p.etaMinutes);
    };
    const onDriver = (p: any) => {
      if (p?.latitude != null && p?.longitude != null) setCourier({ latitude: p.latitude, longitude: p.longitude });
      if (typeof p?.etaMinutes === 'number') setLiveEtaMin(p.etaMinutes);
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
    if (prevStatus.current && prevStatus.current !== 'DELIVERED' && status === 'DELIVERED') {
      haptic.success();
      setArrived(true);
    }
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

  // The READY moment gets the success haptic exactly once per transition —
  // the ceremony card [pickup spec 2.2] does the visual half.
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const status = o?.status as string | undefined;
    if (status === 'READY_FOR_PICKUP' && prevStatusRef.current && prevStatusRef.current !== 'READY_FOR_PICKUP' && o?.fulfillment === 'PICKUP') {
      haptic.success();
    }
    prevStatusRef.current = status;
  }, [o?.status, o?.fulfillment]);

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
  // [REPORT-008 F-01] PENDING on MMG is only "the store hasn't confirmed yet"
  // — the customer may have ALREADY paid through the external link, so the
  // cancel surfaces must never promise "no charge"; they say what is true and
  // point at the party who holds the money.
  const mmgCancellationAmbiguous = o.paymentMethod === 'MOBILE_MONEY' && o.paymentStatus === 'PENDING';
  const rider = o.rider;
  const items: any[] = o.items ?? [];
  const mmgPaymentAction = safeMmgPaymentActionUrl(o.paymentAction) ? o.paymentAction : null;
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
          <HoldRing holdExpiresAt={o.holdExpiresAt} createdAt={o.createdAt} vendorName={o.vendor?.name} onExpire={() => order.refetch()} mmgAmbiguous={mmgCancellationAmbiguous} hidden={cancelled} />

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
                  {rider.displayRating != null ? `  ·  ${Number(rider.displayRating).toFixed(1)}★` : ''}
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
                  onPress={() => void openExternal(`tel:${rider.phone}`, "Couldn't start the call — dial your rider directly.")}
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
                backgroundColor: color.soft.danger,
              }}
            >
              <Feather name="x-circle" size={18} color={color.error} />
              <View style={{ flex: 1 }}>
                <T variant="body" weight="semibold" tone="error">
                  {/* Server's authoritative result first — it knows the real
                      final cost/refund outcome the client clock cannot. */}
                  {cancelMessage
                    ?? (mmgCancellationAmbiguous
                      ? 'This order was cancelled. If you already sent the MMG payment, the store refunds you directly.'
                      : 'This order was cancelled.')}
                </T>
                {/* [REPORT-012 F-012-03] The fee the server ACTUALLY charged —
                    rendered from the committed result, never a preview. */}
                {cancelFee != null ? (
                  <T variant="caption" tone="error" style={{ marginTop: 2 }}>
                    {/* [REPORT-013 F-013-03] The fee is a recorded deterrence
                        marker on a cash platform — Swift never collects it;
                        saying "charged" would be a false financial fact. */}
                    {cancelFee > 0
                      ? `Late-cancellation fee recorded: ${money(cancelFee)} (not collected by Swift).`
                      : 'No cancellation fee.'}
                  </T>
                ) : null}
              </View>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: rider ? space.xl : 0 }}>
                <T variant="heading">{o.fulfillment === 'PICKUP' ? 'Pickup' : 'Delivery time'}</T>
                {o.isExpress ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: 3, backgroundColor: color.brand[50] }}>
                    <Feather name="zap" size={11} color={color.brand[600]} />
                    <T variant="caption" weight="bold" tone="deep">
                      Express
                    </T>
                  </View>
                ) : null}
              </View>
              <T variant="label" tone="muted" style={{ marginTop: 2 }}>
                {liveEtaMin != null
                  ? `Arriving in ~${liveEtaMin} min`
                  : eta
                    ? `Estimated by ${eta}`
                    : 'The store will confirm your order shortly'}
              </T>
              {o.fulfillment === 'PICKUP' && o.pickupAddress ? (
                <T variant="caption" tone="faint" style={{ marginTop: 2 }} numberOfLines={1}>
                  From: {o.pickupAddress}
                </T>
              ) : o.deliveryAddress ? (
                <T variant="caption" tone="faint" style={{ marginTop: 2 }} numberOfLines={1}>
                  To: {o.deliveryAddress}
                </T>
              ) : null}

              <View style={{ marginTop: space.xl }}>
                <StageBar stage={stage} fulfillment={o.fulfillment} />
              </View>
            </>
          )}

          {/* Takeaway handover gate — the counter asks for THIS code. Quiet
              while the kitchen works; at READY it becomes the signature
              moment [pickup spec 2.2]: "It's ready." + the code + the way
              there. The push never carries the code — this screen does. */}
          {o.fulfillment === 'PICKUP' && o.pickupCode && !cancelled && stage < 3 ? (
            o.status === 'READY_FOR_PICKUP' ? (
              <View
                style={{
                  alignItems: 'center',
                  borderRadius: radius.lg,
                  backgroundColor: color.brand[50],
                  borderWidth: 1,
                  borderColor: color.brand[500],
                  paddingVertical: space.xl,
                  paddingHorizontal: space.lg,
                  marginTop: space.xl,
                }}
              >
                <T variant="title" tone="deep">It’s ready.</T>
                <T variant="micro" tone="muted" style={{ marginTop: space.md }}>
                  Show this code at the counter
                </T>
                <T variant="displayXl" tone="brand" style={{ marginTop: 4, letterSpacing: 6 }}>
                  {o.pickupCode}
                </T>
                {o.pickupAddress ? (
                  <Pressable
                    onPress={() => {
                      const q = o.pickupLat != null && o.pickupLng != null ? `${o.pickupLat},${o.pickupLng}` : encodeURIComponent(o.pickupAddress);
                      void openExternal(`https://maps.apple.com/?daddr=${q}`, "Couldn't open maps on this phone.");
                    }}
                  >
                    {({ pressed }) => (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.md, opacity: pressed ? 0.7 : 1 }}>
                        <Feather name="navigation" size={14} color={color.brand[600]} />
                        <T variant="label" weight="semibold" tone="deep">
                          Directions to {o.vendor?.name ?? 'the store'}
                        </T>
                      </View>
                    )}
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <View
                style={{
                  alignItems: 'center',
                  borderRadius: radius.lg,
                  backgroundColor: color.brand[50],
                  paddingVertical: space.lg,
                  marginTop: space.xl,
                }}
              >
                <T variant="micro" tone="muted">
                  Pickup code — show at the counter
                </T>
                <T variant="displayXl" tone="brand" style={{ marginTop: 4, letterSpacing: 6 }}>
                  {o.pickupCode}
                </T>
              </View>
            )
          ) : null}

          {/* Order lines */}
          <T variant="heading" style={{ marginTop: space['2xl'] }}>
            Order
          </T>
          <View style={{ marginTop: space.sm }}>
            {items.map((it: any, i: number) => (
              <InfoRow
                key={it.id ?? i}
                label={`${it.quantity} ${it.item?.name ?? it.name}`}
                value={money(it.totalPrice ?? it.lineTotal ?? Number(it.unitPrice ?? 0) * (it.quantity ?? 1))}
              />
            ))}
            <View style={{ height: 1, backgroundColor: color.border.subtle, marginVertical: space.sm }} />
            <InfoRow label="Total" value={money(o.totalAmount ?? o.total)} strong />
          </View>

          {mmgPaymentAction && o.paymentStatus === 'PENDING' && !cancelled ? (
            <View style={{ borderRadius: radius.lg, backgroundColor: color.brand[50], padding: space.lg, marginTop: space.xl }}>
              <T variant="body" weight="bold" tone="deep">
                Payment is still awaiting confirmation
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                Pay {mmgPaymentAction.recipientName} directly in MMG. Swift never holds this money.
              </T>
              <PillButton
                label="Pay business with MMG"
                icon="external-link"
                onPress={async () => {
                  // [WR-008] A launch that does nothing must say so.
                  if (!(await openMmgPaymentAction(mmgPaymentAction))) {
                    toast.show(`Couldn't open MMG — open the MMG app and pay ${mmgPaymentAction.recipientName} directly.`);
                  }
                }}
                style={{ marginTop: space.md }}
              />
            </View>
          ) : null}

          {/* [SPS-F-0023] The post-delivery tip prompt is GONE, not disabled:
              the API fails closed (TIP_COLLECTION_UNAVAILABLE — no rail
              collects money after the job), and a button that always errors is
              a dead control (INV-12). Tips chosen at checkout still work and
              still show the thanks line below. */}
          {stage === 3 && !cancelled && Number(o.tipAmount ?? 0) > 0 ? (
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
              label="Cancel order"
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
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Cancel this order?
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          {o.orderType === 'COURIER'
            ? 'This cancels the pickup and puts the rider back in the dispatch pool. It can’t be undone.'
            : mmgCancellationAmbiguous
              ? 'Cancelling stops fulfilment. If you already sent the MMG payment, the store refunds you directly.'
              // [REPORT-012 F-012-03] No cached/device-clock promise survives
              // here: a 15s-old "free window" snapshot can cross expiry
              // between poll and tap. State the RULE; the committed server
              // result (message + exact fee) is rendered after the cancel.
              : 'If the store hasn’t started your order, cancelling is usually free; a late cancel can carry a small fee. The exact outcome is confirmed the moment you cancel.'}
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
        <DecorativeIcon
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
        </DecorativeIcon>
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Your order has arrived
        </PopupTitle>
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
