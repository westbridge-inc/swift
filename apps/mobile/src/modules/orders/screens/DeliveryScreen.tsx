/** @jsxImportSource react */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, Share, StyleSheet, View, useWindowDimensions } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { Image } from 'expo-image';
import { openExternal } from '../../../lib/openExternal';
// The emergency path for the person WAITING. The earner side got one; the
// customer watching a stranger walk up their path did not.
import { SosCeremony } from '../../safety/SosCeremony';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { Feather } from '@expo/vector-icons';
import { useIsFocused, useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, elevation, motion, radius, space } from '@swift/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOrder, useDecideSubstitution } from '../../../hooks/customer';
import { customerApi, courierApi, WEB_URL } from '../../../services/api';
import { connectSocket, getSocket, subscribeToOrder } from '../../../services/socket';
import { money } from '../../../lib/money';
import { promiseLine, promiseNote } from '../../../lib/promise';
import { haptic } from '../../../lib/haptics';
import { openMmgPaymentAction, safeMmgPaymentActionUrl } from '../../../lib/payLink';
import { toast } from '../../../kit/toast';
import { CircleChip, DecorativeIcon, ErrorState, Eyebrow, HoldRing, IconChip, InfoRow, LoadingBlock, PillButton, PopupCard, PopupTitle, T, Timeline, holdRingCaption, holdRingWindow, type TimelineStep as KitTimelineStep } from '../../../kit';
import { afterDismiss } from '../../../kit/after-dismiss';
import { VERTICAL_TINT } from '../../../kit/vertical-tint';
import { STALE_AFTER_MS } from '../../movement/map/interpolation';
import { customerKeys } from '../../../hooks/customer';

const GUTTER = space['2xl'];
const ORDER_TINT = VERTICAL_TINT.orders ?? { bg: color.brand[50], ink: color.brand[600] };
const SEND_TINT = VERTICAL_TINT.send ?? ORDER_TINT;
const SERVICES_TINT = VERTICAL_TINT.services ?? ORDER_TINT;
const LIVE_TRACKING_STATUSES = new Set([
  'RIDER_ASSIGNED',
  'RIDER_EN_ROUTE_PICKUP',
  'RIDER_ARRIVED_PICKUP',
  'PICKED_UP',
  'EN_ROUTE_DELIVERY',
  'ARRIVED',
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'RIDE_IN_PROGRESS',
]);
const LIVE_ETA_STATUSES = new Set([
  'RIDER_ASSIGNED',
  'RIDER_EN_ROUTE_PICKUP',
  'DRIVER_ASSIGNED',
  'DRIVER_EN_ROUTE',
]);

type MapCoordinate = { latitude: number; longitude: number };

function validMapCoordinate(latitudeRaw: unknown, longitudeRaw: unknown): MapCoordinate | null {
  if (latitudeRaw == null || longitudeRaw == null) return null;
  const latitude = Number(latitudeRaw);
  const longitude = Number(longitudeRaw);
  if (
    !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90
    || Math.abs(longitude) > 180
  ) return null;
  return { latitude, longitude };
}

function isTerminalOrderSnapshot(order: any): boolean {
  const status = String(order?.status ?? '').toUpperCase();
  return ['CANCELLED', 'REFUNDED', 'FAILED', 'DELIVERED', 'COMPLETED'].includes(status)
    || (order?.fulfillment === 'PICKUP' && status === 'PICKED_UP');
}

type ServerTimelineEntry = { status?: string; timestamp?: string | null; note?: string | null };
// [WS-2.1] The step shape is the kit's now — one definition, imported. A local
// copy here is how the screen and the primitive drift apart on what a step is.
type TimelineStep = KitTimelineStep;

// `formatServerTime` lived here and is gone with the inline timeline: the kit
// primitive formats its own clock, and two functions turning a server timestamp
// into "4:05 pm" is the same duplication one notch smaller.

function humanStatus(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

function timelineIndex(order: any, holdActive: boolean, releasePending: boolean): number | null {
  if (holdActive) return 1;
  if (releasePending) return 1;
  const status = String(order.status ?? '').toUpperCase();
  const pickup = order.fulfillment === 'PICKUP';
  const courier = order.orderType === 'COURIER';
  if (['DELIVERED', 'COMPLETED'].includes(status) || (pickup && status === 'PICKED_UP')) return 4;
  if (pickup && status === 'READY_FOR_PICKUP') return 3;
  if (['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RIDE_IN_PROGRESS'].includes(status)) return 3;
  if (courier && status === 'RIDER_ASSIGNED') return 2;
  if (courier && ['RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(status)) return 3;
  if (status === 'DRIVER_ASSIGNED') return 2;
  if (['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(status)) return 3;
  if (['ACCEPTED', 'PREPARING'].includes(status) || (!courier && status === 'READY_FOR_PICKUP')) return 2;
  if (['PENDING', 'READY_FOR_PICKUP'].includes(status)) return 1;
  return null;
}

function TrackingTimeline({ order, holdActive, releasePending }: { order: any; holdActive: boolean; releasePending: boolean }) {
  const currentIndex = timelineIndex(order, holdActive, releasePending);
  const pickup = order.fulfillment === 'PICKUP';
  const appointment = order.fulfillment === 'APPOINTMENT';
  const courier = order.orderType === 'COURIER';
  const status = String(order.status ?? '').toUpperCase();
  const vendorName = order.vendor?.name ?? 'the store';
  const entries = (order.timeline ?? []) as ServerTimelineEntry[];
  const eventTime = (statuses: string[]) => entries.find((entry) => entry.status && statuses.includes(entry.status))?.timestamp;
  const sentLabel = holdActive
    ? 'Held before sending'
    : releasePending
      ? courier ? 'Sending to nearby riders' : appointment ? 'Sending to the provider' : 'Sending to the store'
      : courier ? 'Sent to nearby riders' : appointment ? 'Sent to the provider' : 'Sent to the store';
  const acceptedRecorded = !!(order.acceptedAt || eventTime(['ACCEPTED']));
  const preparationStarted = !!(order.preparingAt || eventTime(['PREPARING']));
  const preparationFinished = !!(order.readyAt || eventTime(['READY_FOR_PICKUP']))
    || ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED'].includes(status);
  let transitLabel = 'On the way';
  let transitDescription = order.rider
    ? `${order.rider.firstName ?? 'Your rider'} is handling this delivery.`
    : 'Live rider tracking appears after assignment and a GPS fix.';
  if (pickup) {
    transitLabel = 'Ready';
    transitDescription = 'Show the pickup code at the counter.';
  } else if (appointment) {
    transitLabel = 'In progress';
    transitDescription = 'The booked work is underway.';
  } else if (courier && ['RIDER_ASSIGNED', 'DRIVER_ASSIGNED'].includes(status)) {
    transitLabel = 'Heading to pickup';
    transitDescription = 'This step begins when the assigned rider sets off.';
  } else if (['RIDER_ASSIGNED', 'DRIVER_ASSIGNED'].includes(status)) {
    transitLabel = 'Rider assigned';
    transitDescription = 'The rider is assigned. The next server update will show when they set off.';
  } else if (['RIDER_EN_ROUTE_PICKUP', 'DRIVER_EN_ROUTE'].includes(status)) {
    transitLabel = 'Rider heading to pickup';
    transitDescription = 'The rider is heading to the pickup.';
  } else if (['RIDER_ARRIVED_PICKUP', 'DRIVER_ARRIVED'].includes(status)) {
    transitLabel = 'Rider at pickup';
    transitDescription = 'The rider reached the pickup.';
  } else if (status === 'PICKED_UP') {
    transitLabel = 'Picked up';
    transitDescription = 'The rider has the order. Waiting for the server to confirm the delivery leg.';
  } else if (status === 'ARRIVED') {
    transitLabel = 'Rider arrived';
    transitDescription = 'The rider reached the delivery address.';
  }
  const steps: TimelineStep[] = [
    {
      key: 'placed',
      label: courier ? 'Requested' : appointment ? 'Booked' : 'Placed',
      description: 'The server received your request.',
      upcomingDescription: 'The server will record the request here.',
      icon: 'clipboard',
      timestamp: order.placedAt,
    },
    {
      key: 'sent',
      label: sentLabel,
      description: holdActive
        ? courier
          ? 'The rider search starts only when the ring closes.'
          : `Until the ring closes, ${appointment ? 'the provider' : vendorName} hasn’t been told.`
        : releasePending
          ? 'The timer ended. Waiting for the server to confirm release.'
          : courier
            ? 'The request is visible to eligible riders.'
            : `${appointment ? 'The provider' : vendorName} can see the request now.`,
      doneDescription: courier
        ? 'The server released the request to eligible riders.'
        : `${appointment ? 'The provider' : vendorName} received the request.`,
      upcomingDescription: courier
        ? 'The server will release the request to eligible riders.'
        : `${appointment ? 'The provider' : vendorName} will receive the request after the hold.`,
      icon: 'send',
    },
    {
      key: 'preparing',
      label: courier
        ? 'Rider assigned'
        : appointment
          ? 'Confirmed'
          : status === 'READY_FOR_PICKUP'
            ? 'Ready for pickup'
            : preparationStarted
              ? 'Preparing'
              : acceptedRecorded || status === 'ACCEPTED' ? 'Accepted' : 'Preparing',
      description: courier
        ? 'The assigned rider appears here when the server confirms them.'
        : appointment
          ? 'The provider has confirmed the booking.'
          : status === 'READY_FOR_PICKUP'
            ? pickup
              ? 'The order is ready for collection.'
              : 'The order is ready and waiting for a rider.'
            : preparationStarted
              ? `${vendorName} is working on your order.`
              : `${vendorName} accepted the order; preparation is next.`,
      doneDescription: courier
        ? 'The server assigned a rider.'
        : appointment
          ? 'The provider confirmed the booking.'
          : `${vendorName} finished this step.`,
      upcomingDescription: courier
        ? 'The assigned rider will appear after the server confirms them.'
        : appointment
          ? 'The provider will confirm the booking here.'
          : `${vendorName} will accept and prepare the order here.`,
      icon: courier ? 'user-check' : appointment ? 'check-circle' : 'coffee',
      timestamp: courier
        ? eventTime(['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP'])
        : order.preparingAt ?? order.acceptedAt,
    },
    {
      key: 'transit',
      label: transitLabel,
      description: transitDescription,
      doneDescription: pickup
        ? 'The order was ready for collection.'
        : appointment
          ? 'The booked work finished.'
          : 'The delivery completed its travel step.',
      upcomingDescription: pickup
        ? 'The store will mark the order ready for collection.'
        : appointment
          ? 'The booked work will appear here when it begins.'
          : 'Live rider tracking will appear after assignment and a GPS fix.',
      icon: pickup ? 'shopping-bag' : appointment ? 'clock' : 'navigation',
      timestamp: pickup ? order.readyAt : order.pickedUpAt ?? eventTime(['EN_ROUTE_DELIVERY']),
    },
    {
      key: 'complete',
      label: pickup ? 'Picked up' : appointment ? 'Completed' : 'Delivered',
      description: pickup ? 'The store confirms collection.' : appointment ? 'The booking is complete.' : 'The delivery is complete.',
      doneDescription: pickup ? 'The store confirmed collection.' : appointment ? 'The server marked the booking complete.' : 'The server marked the delivery complete.',
      upcomingDescription: pickup ? 'The store will confirm collection here.' : appointment ? 'The server will mark the booking complete here.' : 'The server will mark the delivery complete here.',
      icon: 'check',
      timestamp: pickup ? order.pickedUpAt : order.deliveredAt,
    },
  ];

  return (
    <View style={{ marginTop: space['2xl'] }}>
      {/* [Wave 3 vs reference 09] The section eyebrow is the Eyebrow — the
          uppercase tracked micro label the reference draws, from the kit. */}
      <Eyebrow accessibilityRole="header">Where it stands</Eyebrow>
      {currentIndex == null ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.soft.info }}>
          <Feather name="info" size={18} color={color.info} />
          <T variant="label" tone="info" style={{ flex: 1 }}>
            Current server status: {humanStatus(String(order.status ?? 'unknown'))}.
          </T>
        </View>
      ) : null}
      {/* [WS-2.1] The kit Timeline, not a copy of it. This screen is where the
          primitive was generalized FROM, and leaving the original here would
          have left two implementations of "where is this in its journey" — the
          exact drift the kit exists to end, committed while extracting it.

          THE DOMAIN RULE SURVIVES, and it is why `state` is a per-step
          override rather than something the primitive infers: rider dispatch
          runs alongside kitchen preparation, so a rider status must not tick
          off Preparing unless a server prep fact did. The primitive is told;
          it never guesses. */}
      <View style={{ marginTop: space.lg }}>
        <Timeline
          currentIndex={currentIndex}
          steps={steps.map((step, index) => {
            let done = currentIndex == null ? index === 0 : index < currentIndex;
            let current = currentIndex === index;
            if (step.key === 'preparing' && !courier && !appointment && currentIndex != null && currentIndex >= 2) {
              if (currentIndex === 2) {
                done = false;
                current = true;
              } else {
                done = preparationFinished;
                current = !done && (preparationStarted || acceptedRecorded);
              }
            }
            return { ...step, state: done ? ('done' as const) : current ? ('current' as const) : ('upcoming' as const) };
          })}
        />
      </View>
    </View>
  );
}

// Kit Delivery (35–39): honest map state on top, sheet w/ rider card, vertical
// timeline and order lines. Live courier via socket (rider:location uses
// {lat,lng}; driver:location uses {latitude,longitude} — different keys!) with
// a 15s poll as fallback; order:status_changed refetches.

// (The HoldRing itself now lives in the kit [Wave 3 part 2] — the moment is
// platform-wide, not this screen's. Its honesty matrix rides kit/hold-window.)

export function DeliveryScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const orderId: string = route.params?.orderId;

  // The customer's emergency path. The server has authorised this caller all
  // along — safety.routes.ts puts { customerId } FIRST in the participant OR —
  // there was simply never a button. These sit with the other top-level hooks
  // because this component early-returns for loading and error states, and a
  // hook after an early return breaks React's ordering (caught by
  // react-hooks/rules-of-hooks, which is why that rule is an error here).
  const [sosConfirm, setSosConfirm] = useState(false);
  const myLocation = useLocationStore();

  const order = useOrder<any>(orderId, 15000);
  const [courier, setCourier] = useState<{ latitude: number; longitude: number } | null>(null);
  const [lastCourierFixAt, setLastCourierFixAt] = useState<number | null>(null);
  const [trackingDisconnected, setTrackingDisconnected] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());
  // Server-computed ETA for the courier's ACTIVE leg, refreshed with the
  // location stream [SWIFT-UG-RT-01]. Null until the first event lands.
  const [liveEtaMin, setLiveEtaMin] = useState<number | null>(null);
  // [B3] Whether the live ETA is to THIS delivery directly, or the chain
  // through another delivery the rider is finishing first. The server labels
  // it; the screen must say so, or "arriving in 6 min" is a lie for the
  // second customer of a stacked rider.
  const [liveEtaBasis, setLiveEtaBasis] = useState<'direct' | 'after_current'>('direct');
  const [arrived, setArrived] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelChecking, setCancelChecking] = useState(false);
  const [cancelPreviewFresh, setCancelPreviewFresh] = useState(false);
  const [cancelPreviewFee, setCancelPreviewFee] = useState<number | null>(null);
  const [cancelPreviewOrderId, setCancelPreviewOrderId] = useState<string | null>(null);
  const prevStatus = useRef<string | null>(null);
  const prevStatusRef = useRef<string | undefined>(undefined);
  const activeOrderIdRef = useRef(orderId);
  activeOrderIdRef.current = orderId;
  const mapRef = useRef<MapView>(null);
  const lastCourierServerFixAt = useRef<number | null>(null);

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
  const qc = useQueryClient();
  const cancelOrder = useMutation<any, any, { targetOrderId: string; orderType: string }>({
    mutationFn: ({ targetOrderId, orderType }: { targetOrderId: string; orderType: string }) =>
      orderType === 'COURIER' ? courierApi.cancel(targetOrderId) : customerApi.cancelOrder(targetOrderId),
    onSuccess: (res: any, target) => {
      // Home's live-order card is fed by a DIFFERENT query than this screen,
      // and Home does not refetch on focus. Refetching only `order` here left
      // that card counting down the free-cancel window of an order that no
      // longer existed — the founder watched it happen. Invalidate the feed
      // prefix, not one coordinate variant, and do it before the early return:
      // the feed is wrong regardless of which order this screen is showing.
      void qc.invalidateQueries({ queryKey: customerKeys.homeAll });
      if (target.targetOrderId !== activeOrderIdRef.current) return;
      // customerApi.cancelOrder is unwrapped at the seam; the courier endpoint
      // still returns the raw envelope — accept both shapes, never lose the
      // message OR the numeric fee the server actually charged.
      const payload = res?.data?.data ?? res?.data ?? res ?? {};
      if (typeof payload.message === 'string') setCancelMessage(payload.message);
      setCancelFee(typeof payload.cancellationFee === 'number' ? payload.cancellationFee : null);
      setConfirmCancel(false);
      order.refetch();
    },
    onError: (error: any, target) => {
      if (target.targetOrderId !== activeOrderIdRef.current) return;
      const serverMessage = error?.response?.data?.error?.message;
      if (typeof serverMessage === 'string') {
        toast.error('Cancellation didn’t go through', serverMessage);
      } else {
        setConfirmCancel(false);
        toast.show(
          'Checking cancellation status',
          'We couldn’t confirm the outcome. The latest server status is being refreshed before you try again.',
        );
      }
      // The outcome is unknown (a timeout can mean the cancel DID land), so
      // the feed is treated as suspect too.
      void qc.invalidateQueries({ queryKey: customerKeys.homeAll });
      void order.refetch();
    },
  });
  const decideSub = useDecideSubstitution(orderId);

  const o = order.data;
  const orderStatus = String(o?.status ?? '').toUpperCase();
  const liveTrackingAllowed = LIVE_TRACKING_STATUSES.has(orderStatus)
    && !(o?.fulfillment === 'PICKUP' && orderStatus === 'PICKED_UP');
  const liveTrackingAllowedRef = useRef(liveTrackingAllowed);
  liveTrackingAllowedRef.current = liveTrackingAllowed;

  const openCancelConfirmation = async () => {
    const targetOrderId = orderId;
    setCancelPreviewFresh(false);
    setCancelPreviewFee(null);
    setCancelPreviewOrderId(null);
    setCancelChecking(true);
    try {
      const refreshed = await order.refetch();
      if (activeOrderIdRef.current !== targetOrderId) return;
      const latest = refreshed.data;
      if (refreshed.isError || !latest) {
        toast.error('Couldn’t confirm cancellation', 'Check your connection and try again. Your order is unchanged.');
        return;
      }
      if (latest.canCancel !== true || isTerminalOrderSnapshot(latest)) {
        toast.show('This order can no longer be cancelled', 'The latest server status is shown on the timeline.');
        return;
      }
      if (latest.orderType !== 'COURIER') {
        const previewFee = latest.cancellationFee;
        if (typeof previewFee !== 'number' || !Number.isFinite(previewFee)) {
          toast.error('Couldn’t confirm cancellation cost', 'Try again before cancelling. Your order is unchanged.');
          return;
        }
        setCancelPreviewFee(previewFee);
      }
      setCancelPreviewFresh(true);
      setCancelPreviewOrderId(targetOrderId);
      setConfirmCancel(true);
    } finally {
      if (activeOrderIdRef.current === targetOrderId) setCancelChecking(false);
    }
  };

  const commitCancellation = async () => {
    const targetOrderId = orderId;
    if (cancelPreviewOrderId !== targetOrderId) {
      setConfirmCancel(false);
      return;
    }
    setCancelChecking(true);
    try {
      const refreshed = await order.refetch();
      if (activeOrderIdRef.current !== targetOrderId) return;
      const latest = refreshed.data;
      if (refreshed.isError || !latest) {
        toast.error('Couldn’t recheck cancellation', 'Nothing was cancelled. Check your connection and try again.');
        return;
      }
      if (latest.canCancel !== true || isTerminalOrderSnapshot(latest)) {
        setConfirmCancel(false);
        toast.show('This order can no longer be cancelled', 'The latest server status is shown on the timeline.');
        return;
      }
      if (latest.orderType !== 'COURIER') {
        const latestFee = latest.cancellationFee;
        if (typeof latestFee !== 'number' || !Number.isFinite(latestFee)) {
          toast.error('Couldn’t recheck cancellation cost', 'Nothing was cancelled. Try again.');
          return;
        }
        if (cancelPreviewFee !== latestFee) {
          setCancelPreviewFee(latestFee);
          setCancelPreviewFresh(true);
          toast.show('Cancellation cost updated', 'Review the new server preview, then confirm again.');
          return;
        }
      }
      cancelOrder.mutate({ targetOrderId, orderType: latest.orderType });
    } finally {
      if (activeOrderIdRef.current === targetOrderId) setCancelChecking(false);
    }
  };

  // Socket: join the order room, follow courier + status.
  useEffect(() => {
    if (!orderId || !isFocused) return;
    setCourier(null);
    setLastCourierFixAt(null);
    setLiveEtaMin(null);
    setTrackingDisconnected(false);
    lastCourierServerFixAt.current = null;
    connectSocket();
    subscribeToOrder(orderId);
    const s = getSocket();
    const acceptFix = (latitudeRaw: unknown, longitudeRaw: unknown, timestampRaw: unknown, etaRaw: unknown) => {
      if (!liveTrackingAllowedRef.current) return;
      const coordinate = validMapCoordinate(latitudeRaw, longitudeRaw);
      const fixedAt = typeof timestampRaw === 'string' ? Date.parse(timestampRaw) : Number.NaN;
      if (
        !coordinate
        || !Number.isFinite(fixedAt)
        || (lastCourierServerFixAt.current != null && fixedAt < lastCourierServerFixAt.current)
      ) return;
      lastCourierServerFixAt.current = fixedAt;
      setCourier(coordinate);
      // Freshness is time since THIS device received a timestamped server fix;
      // comparing two different wall clocks would make skew look like staleness.
      setLastCourierFixAt(Date.now());
      if (etaRaw == null) {
        setLiveEtaMin(null);
      } else {
        const etaMinutes = Number(etaRaw);
        setLiveEtaMin(Number.isFinite(etaMinutes) && etaMinutes >= 0 ? etaMinutes : null);
      }
    };
    const onRider = (p: any) => {
      acceptFix(p?.lat, p?.lng, p?.ts, p?.etaMinutes);
      setLiveEtaBasis(p?.etaBasis === 'after_current' ? 'after_current' : 'direct');
    };
    const onDriver = (p: any) => {
      if (p?.orderId !== orderId) return;
      acceptFix(p?.latitude, p?.longitude, p?.timestamp, p?.etaMinutes);
    };
    const onStatus = (payload: any) => {
      if (payload?.orderId !== orderId) return;
      void order.refetch();
    };
    const onConnect = () => {
      setTrackingDisconnected(false);
      subscribeToOrder(orderId);
      void order.refetch();
    };
    const onDisconnect = () => {
      setTrackingDisconnected(true);
      setLiveEtaMin(null);
    };
    const onConnectError = () => {
      setTrackingDisconnected(true);
      setLiveEtaMin(null);
    };
    s.on('rider:location', onRider);
    s.on('driver:location', onDriver);
    s.on('order:status_changed', onStatus);
    s.on('order:prep_update', onStatus);
    s.on('order:substitution', onStatus);
    s.on('order:promise_revised', onStatus);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onConnectError);
    return () => {
      s.off('rider:location', onRider);
      s.off('driver:location', onDriver);
      s.off('order:status_changed', onStatus);
      s.off('order:prep_update', onStatus);
      s.off('order:substitution', onStatus);
      s.off('order:promise_revised', onStatus);
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('connect_error', onConnectError);
      s.emit('order:unsubscribe', { orderId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, orderId]);

  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (isFocused) setNowTs(Date.now());
  }, [isFocused]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNowTs(Date.now());
    });
    return () => subscription.remove();
  }, []);

  // The live-ETA cache does not identify which journey leg produced a value.
  // Clear every transition, and only render the pre-custody legs above; an old
  // pickup ETA must never reappear as a delivery ETA after the rider departs.
  useEffect(() => {
    setLiveEtaMin(null);
  }, [orderStatus]);

  useEffect(() => {
    if (!liveTrackingAllowed) {
      setCourier(null);
      setLastCourierFixAt(null);
      setLiveEtaMin(null);
    }
  }, [liveTrackingAllowed]);

  // React Navigation can reuse this screen with a different order id. Clear
  // every order-local ceremony and preview so order A can never act on order B.
  useEffect(() => {
    setCourier(null);
    setLastCourierFixAt(null);
    setLiveEtaMin(null);
    setTrackingDisconnected(false);
    setArrived(false);
    setConfirmCancel(false);
    setCancelChecking(false);
    setCancelPreviewFresh(false);
    setCancelPreviewFee(null);
    setCancelPreviewOrderId(null);
    setCancelMessage(null);
    setCancelFee(null);
    lastCourierServerFixAt.current = null;
    prevStatus.current = null;
    prevStatusRef.current = undefined;
  }, [orderId]);

  // Arrival popup once, on the transition into DELIVERED.
  useEffect(() => {
    if (!isFocused) return;
    const status = o?.status;
    if (!status) return;
    if (prevStatus.current && prevStatus.current !== 'DELIVERED' && status === 'DELIVERED') {
      haptic.success();
      setArrived(true);
    }
    prevStatus.current = status;
  }, [isFocused, o?.status]);

  // The order's immutable pickup snapshot owns this marker. A vendor profile
  // edit must never move an already-placed order, and courier requests have no vendor.
  const pickupPos = validMapCoordinate(o?.pickupLat, o?.pickupLng);
  const dropPos = o?.fulfillment === 'PICKUP'
    ? null
    : validMapCoordinate(o?.deliveryLat, o?.deliveryLng);
  // The REST rider coordinate has no freshness timestamp. It is deliberately
  // ignored; only a timestamped socket fix earns a tracking marker.
  const courierPos = liveTrackingAllowed ? courier : null;

  const fitMap = () => {
    const pts = [pickupPos, dropPos, courierPos].filter(Boolean) as { latitude: number; longitude: number }[];
    if (!pts.length || !mapRef.current) return;
    if (pts.length === 1) {
      mapRef.current.animateToRegion({ ...pts[0]!, latitudeDelta: 0.04, longitudeDelta: 0.04 }, motion.duration.gentle);
    } else {
      mapRef.current.fitToCoordinates(pts, {
        edgePadding: {
          top: space['5xl'] * 2,
          bottom: space['5xl'] + space.md,
          left: space['5xl'] + space.md,
          right: space['5xl'] + space.md,
        },
        animated: true,
      });
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fitMap, [!!pickupPos, !!dropPos, !!courierPos]);

  // The READY moment gets the success haptic exactly once per transition —
  // the ceremony card [pickup spec 2.2] does the visual half.
  useEffect(() => {
    if (!isFocused) return;
    const status = o?.status as string | undefined;
    if (status === 'READY_FOR_PICKUP' && prevStatusRef.current && prevStatusRef.current !== 'READY_FOR_PICKUP' && o?.fulfillment === 'PICKUP') {
      haptic.success();
    }
    prevStatusRef.current = status;
  }, [isFocused, o?.status, o?.fulfillment]);

  if (order.isLoading) return <LoadingBlock style={{ backgroundColor: color.surface.subtle }} />;
  if (order.isError || !o) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top }}>
        <ErrorState onRetry={() => order.refetch()} />
      </View>
    );
  }

  const cancelled = o.status === 'CANCELLED' || o.status === 'REFUNDED';
  const failed = o.status === 'FAILED';
  const complete = ['DELIVERED', 'COMPLETED'].includes(o.status)
    || (o.fulfillment === 'PICKUP' && o.status === 'PICKED_UP');
  const terminal = cancelled || failed || complete;
  const verticalTint = o.orderType === 'COURIER'
    ? SEND_TINT
    : o.fulfillment === 'APPOINTMENT' ? SERVICES_TINT : ORDER_TINT;
  // [REPORT-008 F-01] PENDING on MMG is only "the store hasn't confirmed yet"
  // — the customer may have ALREADY paid through the external link, so the
  // cancel surfaces must never promise "no charge"; they say what is true and
  // point at the party who holds the money.
  const mmgCancellationAmbiguous = o.paymentMethod === 'MOBILE_MONEY' && o.paymentStatus === 'PENDING';
  const rider = o.rider;
  const items: any[] = o.items ?? [];
  const mmgPaymentAction = safeMmgPaymentActionUrl(o.paymentAction) ? o.paymentAction : null;
  const mmgCaptured = o.paymentMethod === 'MOBILE_MONEY' && o.paymentStatus === 'CAPTURED';
  const ringHidden = terminal || mmgCaptured || !o.canCancel;
  // Hold lifecycle and cancel eligibility are separate server facts. A paid or
  // otherwise non-cancellable order may still be held from the recipient; do
  // not mark it sent merely because the cancellation ceremony is hidden.
  const currentHoldWindow = holdRingWindow(o.holdExpiresAt, o.placedAt, nowTs, terminal);
  const holdActive = currentHoldWindow != null;
  const hasHoldTimestamp = typeof o.holdExpiresAt === 'string' && o.holdExpiresAt.length > 0;
  const holdExpiresMs = hasHoldTimestamp ? Date.parse(o.holdExpiresAt) : Number.NaN;
  const holdTimingUnavailable = !terminal
    && hasHoldTimestamp
    && (!Number.isFinite(holdExpiresMs) || (holdExpiresMs > nowTs && !currentHoldWindow));
  // The local arc may hit zero before the release worker clears the server
  // timestamp. "Sending" is truthful; "Sent" waits for the next server read.
  const releasePending = !terminal
    && hasHoldTimestamp
    && Number.isFinite(holdExpiresMs)
    && holdExpiresMs <= nowTs;
  const trackable = liveTrackingAllowed;
  const expectsRider = o.orderType === 'COURIER'
    || (o.fulfillment !== 'PICKUP' && o.fulfillment !== 'APPOINTMENT');
  const fixStale = !!courierPos && !!lastCourierFixAt && nowTs - lastCourierFixAt > STALE_AFTER_MS;
  const mapAnchor = courierPos ?? pickupPos ?? dropPos;
  const initialRegion = mapAnchor ? { ...mapAnchor, latitudeDelta: 0.05, longitudeDelta: 0.05 } : null;
  const mapNotice = holdTimingUnavailable
    ? 'Checking the cancellation window with the server.'
    : holdActive || releasePending
    ? o.orderType === 'COURIER'
      ? 'Live tracking starts after the request is released to riders.'
      : o.fulfillment === 'PICKUP'
        ? 'This is a pickup order. The map shows the store; there is no rider to track.'
        : o.fulfillment === 'APPOINTMENT'
          ? 'This booking does not use rider tracking.'
          : 'Live tracking starts after the order is sent to the store and a rider is assigned.'
    : trackingDisconnected && trackable
      ? courierPos
        ? 'Reconnecting to the rider’s live location. Showing the last received position.'
        : 'Reconnecting to the rider’s live location. Waiting for the first GPS update.'
      : fixStale
        ? 'Rider location is paused. Showing the last received position.'
        : rider && !courierPos && trackable
          ? 'Waiting for the rider’s first live location update.'
          : expectsRider && !rider && !terminal
            ? 'A rider hasn’t been assigned yet.'
            : !expectsRider && !terminal
              ? o.fulfillment === 'PICKUP'
                ? 'Pickup order — use the store address and directions below.'
                : 'Appointment booking — follow the provider details below.'
            : null;
  const freshLiveEta = LIVE_ETA_STATUSES.has(orderStatus) && !trackingDisconnected && !fixStale
    ? liveEtaMin
    : null;
  const serverEstimateMinutes = typeof o.estimatedDeliveryTime === 'number' && o.estimatedDeliveryTime > 0
    ? Math.round(o.estimatedDeliveryTime)
    : null;
  const serverPrepMinutes = typeof o.estimatedPrepTime === 'number' && o.estimatedPrepTime > 0
    ? Math.round(o.estimatedPrepTime)
    : null;
  const arrivalReached = ['RIDER_ARRIVED_PICKUP', 'DRIVER_ARRIVED', 'ARRIVED'].includes(orderStatus);
  const releaseName = o.vendor?.name ?? (o.fulfillment === 'APPOINTMENT' ? 'the provider' : 'the store');
  const holdReleaseLead = o.orderType === 'COURIER'
    ? 'This request is released to nearby riders'
    : o.fulfillment === 'APPOINTMENT'
      ? `This booking goes to ${releaseName}`
      : `Your order goes to ${releaseName}`;
  const holdCancellationCaption = o.orderType === 'COURIER'
    ? 'Changed your mind? Cancel before a rider accepts. Swift does not collect or hold courier payment.'
    : o.fulfillment === 'APPOINTMENT'
      ? 'Changed your mind? Cancel before the provider starts — the app shows any cost before you confirm.'
      : holdRingCaption(mmgCancellationAmbiguous);
  const pendingSummary = o.orderType === 'COURIER'
    ? 'Waiting for an eligible rider to accept'
    : o.fulfillment === 'APPOINTMENT'
      ? 'The provider will confirm your booking shortly'
      : 'The store will confirm your order shortly';
  const referenceNoun = o.orderType === 'COURIER' ? 'request' : o.fulfillment === 'APPOINTMENT' ? 'booking' : 'order';
  const journeyHeading = o.orderType === 'COURIER'
    ? 'Courier status'
    : o.fulfillment === 'APPOINTMENT'
      ? 'Booking status'
      : o.fulfillment === 'PICKUP' ? 'Pickup' : 'Delivery time';
  const directPayee = o.orderType === 'COURIER'
    ? 'rider'
    : o.fulfillment === 'APPOINTMENT' ? 'provider' : 'seller or rider';
  const mmgPayee = mmgPaymentAction?.recipientName
    ?? (o.orderType === 'COURIER' ? 'the named payee' : o.fulfillment === 'APPOINTMENT' ? 'the provider' : 'the store');
  let etaCopy = pendingSummary;
  if (cancelled) etaCopy = 'Cancelled';
  else if (failed) etaCopy = 'Couldn’t complete this order';
  else if (complete) etaCopy = 'Completed';
  else if (arrivalReached) {
    etaCopy = orderStatus === 'RIDER_ARRIVED_PICKUP' ? 'Rider reached the pickup' : 'Your rider has arrived';
  } else if (o.fulfillment === 'APPOINTMENT' && orderStatus === 'ACCEPTED') {
    etaCopy = 'The provider confirmed your booking';
  } else if (freshLiveEta != null) {
    etaCopy = freshLiveEta <= 0
      ? 'Rider is arriving now'
      : liveEtaBasis === 'after_current'
        ? `Rider arriving in ~${Math.round(freshLiveEta)} min, after another delivery`
        : `Rider arriving in ~${Math.round(freshLiveEta)} min`;
  }
  else if (o.fulfillment === 'PICKUP' && orderStatus === 'READY_FOR_PICKUP') {
    etaCopy = 'Ready for pickup';
  } else if (o.fulfillment === 'PICKUP' && serverPrepMinutes != null) {
    etaCopy = `Estimated ready time · ~${serverPrepMinutes} min`;
  } else if (serverEstimateMinutes != null) etaCopy = `Server estimate · ~${serverEstimateMinutes} min total`;

  // [ALG-12] The promise the customer was given at checkout — a RANGE on
  // five-minute marks from the server, recomputed against this screen's
  // ticking clock so a passed window is never shown as still coming
  // (R-12.2.4). The live line above is labelled live; this is the commitment
  // (L7). Delivery orders only, and only while the order is still coming.
  const promise = o.fulfillment === 'DELIVERY' && !cancelled && !failed && !complete ? promiseLine(o.promise, nowTs) : null;
  const promiseUpdate = promiseNote(o.promise);

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      {/* Compact during the hold; larger only when there is something real to
          track. No route geometry is drawn because the API does not send one. */}
      <View style={{ height: screenHeight * (holdActive || releasePending || holdTimingUnavailable ? 0.24 : 0.4) }}>
        {initialRegion ? (
          <MapView key={orderId} ref={mapRef} style={{ flex: 1 }} initialRegion={initialRegion}>
            {pickupPos ? (
              <Marker coordinate={pickupPos} title={o.vendor?.name ?? 'Pickup'}>
                <View
                  style={{
                    width: space['4xl'],
                    height: space['4xl'],
                    borderRadius: radius.full,
                    backgroundColor: verticalTint.ink,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: space.xs / 2,
                    borderColor: color.white,
                  }}
                >
                  <Feather name="shopping-bag" size={16} color={color.white} />
                </View>
              </Marker>
            ) : null}
            {dropPos ? (
              <Marker coordinate={dropPos} title="Delivery address">
                {/* [Wave 3 vs reference 09] The destination is the INK pin —
                    a black-filled marker against the maroon store marker, so
                    the two ends of the journey read as different things. */}
                <View
                  style={{
                    width: space['4xl'],
                    height: space['4xl'],
                    borderRadius: radius.full,
                    backgroundColor: color.text.primary,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: space.xs / 2,
                    borderColor: color.white,
                  }}
                >
                  <Feather name="map-pin" size={16} color={color.white} />
                </View>
              </Marker>
            ) : null}
            {courierPos ? (
              <Marker coordinate={courierPos} title={fixStale || trackingDisconnected ? 'Rider — last received location' : 'Your rider'}>
                <View
                  style={{
                    width: space['4xl'],
                    height: space['4xl'],
                    borderRadius: radius.full,
                    backgroundColor: color.surface.base,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: space.xs / 2,
                    borderColor: color.brand[500],
                    opacity: fixStale || trackingDisconnected ? 0.45 : 1,
                    ...elevation.card,
                  }}
                >
                  <Feather name="navigation" size={16} color={color.brand[500]} />
                </View>
              </Marker>
            ) : null}
          </MapView>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space['3xl'], backgroundColor: color.surface.sunken }}>
            <IconChip icon="map-pin" size={48} />
            <T variant="heading" center style={{ marginTop: space.md }}>Map details unavailable</T>
            <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
              This order has no coordinates to show. Use the saved address below.
            </T>
          </View>
        )}

        {mapNotice ? (
          <View
            accessible
            accessibilityLiveRegion="polite"
            accessibilityLabel={mapNotice}
            style={{ position: 'absolute', left: GUTTER, right: GUTTER, bottom: space.xl, flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.lg, backgroundColor: color.soft.info, ...elevation.card }}
          >
            <Feather name={trackingDisconnected ? 'wifi-off' : 'map-pin'} size={16} color={color.info} />
            <T variant="caption" tone="info" style={{ flex: 1 }}>{mapNotice}</T>
          </View>
        ) : null}

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
          <CircleChip icon="chevron-left" label="Go back" onPress={() => navigation.goBack()} />
          {(holdActive || holdTimingUnavailable) ? (
            // [Wave 3 vs reference 09] "Order #4193 — held" floats ON the map,
            // pinned to the journey it describes — not a caption in the sheet.
            <View
              accessible
              accessibilityLabel={`${referenceNoun[0]!.toUpperCase()}${referenceNoun.slice(1)} number ${o.orderNumber}, held`}
              style={{ alignSelf: 'center', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.full, backgroundColor: color.surface.base, ...elevation.card }}
            >
              <T variant="label" weight="semibold" numberOfLines={1}>
                {referenceNoun[0]!.toUpperCase()}{referenceNoun.slice(1)} #{o.orderNumber} — held
              </T>
            </View>
          ) : null}
          {courierPos && !holdActive && !releasePending && !holdTimingUnavailable ? (
            <CircleChip
              icon="crosshair"
              label={fixStale || trackingDisconnected ? 'Recenter last rider location' : 'Recenter live tracking'}
              onPress={fitMap}
            />
          ) : <View />}
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
          ...elevation.raised,
        }}
      >
        <ScrollView contentContainerStyle={{ padding: GUTTER, paddingBottom: insets.bottom + space['2xl'] }}>
          {/* The "#NNNN · held" caption moved onto the map as the reference's
              floating chip — one statement of the state, where it belongs. */}
          <HoldRing
            key={`${o.id}:${o.holdExpiresAt ?? 'none'}:${isFocused ? 'focused' : 'hidden'}`}
            holdExpiresAt={o.holdExpiresAt}
            placedAt={o.placedAt}
            releaseLead={holdReleaseLead}
            cancellationCaption={holdCancellationCaption}
            onExpire={() => {
              setNowTs(Date.now());
              void order.refetch();
            }}
            hidden={ringHidden || !isFocused}
          />
          {holdTimingUnavailable ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: color.soft.info }}>
              <Feather name="refresh-cw" size={18} color={color.info} />
              <T variant="label" tone="info" style={{ flex: 1 }}>
                Checking the hold timing with the server. No progress ring is shown without both server timestamps.
              </T>
            </View>
          ) : null}
          {releasePending ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: color.soft.info }}>
              <Feather name="send" size={18} color={color.info} />
              <T variant="label" tone="info" style={{ flex: 1 }}>
                Timer closed. Checking with the server before marking this order sent.
              </T>
            </View>
          ) : null}
          {(holdActive || holdTimingUnavailable || releasePending) && o.canCancel && !terminal ? (
            <PillButton
              label={`Cancel ${referenceNoun}`}
              icon="x-circle"
              // [Wave 3 vs reference 09] An OUTLINE, deliberately not maroon —
              // the reference reserves the brand fill for the actions Swift
              // wants taken; cancelling is offered honestly, never sold.
              variant="outline"
              loading={cancelChecking || cancelOrder.isPending}
              onPress={() => { void openCancelConfirmation(); }}
              style={{ marginTop: space.md }}
            />
          ) : null}

          {!cancelled && !failed ? (
            <TrackingTimeline order={o} holdActive={holdActive || holdTimingUnavailable} releasePending={releasePending} />
          ) : null}

          {/* Out-of-stock substitutions (§5.3) — the store asked; you decide. */}
          {!terminal ? items
            .filter((it: any) => it.subStatus === 'PENDING')
            .map((it: any) => (
              <View
                key={`sub-${it.id}`}
                style={{ backgroundColor: color.brand[50], borderRadius: radius.lg, padding: space.md, marginTop: space.xl, marginBottom: space.md }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                  <Feather name="repeat" size={16} color={color.brand[600]} />
                  <T variant="label" weight="bold" style={{ flex: 1 }}>
                    {it.name} is out of stock
                  </T>
                </View>
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  {o.vendor?.name ?? 'The store'} suggests {it.substituteName} ({money(Number(it.substitutePrice ?? 0))}
                  {it.quantity > 1 ? ` × ${it.quantity}` : ''}) instead. Rejecting removes the item and lowers your total.
                </T>
                <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                  <PillButton
                    label="Approve swap"
                    size="md"
                    style={{ flex: 1 }}
                    loading={decideSub.isPending}
                    disabled={decideSub.isPending}
                    onPress={() => decideSub.mutate({ lineId: it.id, approve: true })}
                  />
                  <PillButton
                    label="No thanks"
                    variant="soft"
                    size="md"
                    style={{ flex: 1 }}
                    disabled={decideSub.isPending}
                    onPress={() => decideSub.mutate({ lineId: it.id, approve: false })}
                  />
                </View>
              </View>
            )) : null}

          {/* Rider card */}
          {rider ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                backgroundColor: verticalTint.bg,
                borderRadius: radius.lg,
                padding: space.md,
                marginTop: space.xl,
              }}
            >
              {rider.avatar ? (
                <Image source={{ uri: rider.avatar }} style={{ width: space['5xl'], height: space['5xl'], borderRadius: radius.full }} accessible={false} />
              ) : (
                <View
                  style={{
                    width: space['5xl'],
                    height: space['5xl'],
                    borderRadius: radius.full,
                    backgroundColor: verticalTint.bg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Feather name="user" size={20} color={verticalTint.ink} />
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
                accessibilityRole="button"
                accessibilityLabel={`Message ${rider.firstName ?? 'your rider'}`}
                accessibilityHint="Opens the order conversation"
                style={{
                  width: space['5xl'],
                  height: space['5xl'],
                  borderRadius: radius.full,
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
                  accessibilityRole="button"
                  accessibilityLabel={`Call ${rider.firstName ?? 'your rider'}`}
                  accessibilityHint="Opens the phone dialer"
                  style={{
                    width: space['5xl'],
                    height: space['5xl'],
                    borderRadius: radius.full,
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

          {/* EMERGENCY. Above this sits a button to phone the stranger walking
              up your path, and further down one to file a support ticket.
              Neither is a way to get help. POST /safety/sos has authorised the
              customer since the safety engine was built — safety.routes.ts
              lists { customerId } first in the participant OR — and no client
              ever called it. Only while the order is in flight: an emergency
              button on a delivered receipt is noise. */}
          {!terminal && o?.id && rider ? (
            <PillButton
              label="Emergency — get help now"
              variant="outline"
              icon="alert-triangle"
              style={{ marginTop: space.md, borderColor: color.error }}
              onPress={() => setSosConfirm(true)}
            />
          ) : null}

          {/* [B9] The recipient's half of Send. GET /courier/track/:token has
              been public since launch and NOTHING generated the link — the
              sender had no way to hand tracking to the person waiting for the
              parcel. Web twin: /track/[token]. Sender-scoped token, in-flight
              only (the token never expires, so a settled parcel stops
              advertising it). */}
          {!terminal && o?.orderType === 'COURIER' && o?.courierTrackingToken ? (
            <PillButton
              label="Share tracking with the recipient"
              variant="soft"
              icon="share-2"
              style={{ marginTop: space.md }}
              onPress={() => {
                const who = o?.courierRecipientName ? `${o.courierRecipientName}, track` : 'Track';
                void Share.share({
                  message: `${who} your Swift parcel live: ${WEB_URL}/track/${o.courierTrackingToken}`,
                }).catch(() => toast.show("Couldn't open the share sheet."));
              }}
            />
          ) : null}

          {cancelled || failed ? (
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
              <Feather name={failed ? 'alert-triangle' : 'x-circle'} size={18} color={color.error} />
              <View style={{ flex: 1 }}>
                <T variant="body" weight="semibold" tone="error">
                  {/* Server's authoritative result first — it knows the real
                      final cost/refund outcome the client clock cannot. */}
                  {failed
                    ? 'This order could not continue. Report a problem for help with what happens next.'
                    : cancelMessage
                      ?? (mmgCancellationAmbiguous
                        ? 'This order was cancelled. If you already sent the MMG payment, the store refunds you directly.'
                        : 'This order was cancelled.')}
                </T>
                {/* [REPORT-012 F-012-03] The fee the server ACTUALLY charged —
                    rendered from the committed result, never a preview. */}
                {!failed && cancelFee != null ? (
                  <T variant="caption" tone="error" style={{ marginTop: space.xs }}>
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
                <T variant="heading">{journeyHeading}</T>
                {o.isExpress ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, borderRadius: radius.full, paddingHorizontal: space.sm, paddingVertical: space.xs, backgroundColor: color.brand[50] }}>
                    <Feather name="zap" size={11} color={color.brand[600]} />
                    <T variant="caption" weight="bold" tone="deep">
                      Express
                    </T>
                  </View>
                ) : null}
              </View>
              <T variant="label" tone="muted" style={{ marginTop: space.xs }}>
                {etaCopy}
              </T>
              {promise ? (
                <T variant="label" style={{ marginTop: space.xs }} testID="promise-range">
                  {promise.label}
                </T>
              ) : null}
              {promise && promiseUpdate ? (
                <T variant="caption" tone="faint" style={{ marginTop: 2 }}>
                  {promiseUpdate}
                </T>
              ) : null}
              {o.fulfillment === 'PICKUP' && o.pickupAddress ? (
                <T variant="caption" tone="faint" style={{ marginTop: space.xs }} numberOfLines={1}>
                  From: {o.pickupAddress}
                </T>
              ) : o.deliveryAddress ? (
                <T variant="caption" tone="faint" style={{ marginTop: space.xs }} numberOfLines={1}>
                  To: {o.deliveryAddress}
                </T>
              ) : null}
            </>
          )}

          {/* Takeaway handover gate — the counter asks for THIS code. Quiet
              while the kitchen works; at READY it becomes the signature
              moment [pickup spec 2.2]: "It's ready." + the code + the way
              there. The push never carries the code — this screen does. */}
          {o.fulfillment === 'PICKUP' && o.pickupCode && !cancelled && !failed && !complete ? (
            o.status === 'READY_FOR_PICKUP' ? (
              <View
                style={{
                  alignItems: 'center',
                  borderRadius: radius.lg,
                  backgroundColor: color.brand[50],
                  borderWidth: StyleSheet.hairlineWidth,
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
                <T variant="displayXl" tone="brand" style={{ marginTop: space.xs, letterSpacing: space.sm }}>
                  {o.pickupCode}
                </T>
                {o.pickupAddress ? (
                  <Pressable
                    onPress={() => {
                      const q = o.pickupLat != null && o.pickupLng != null ? `${o.pickupLat},${o.pickupLng}` : encodeURIComponent(o.pickupAddress);
                      void openExternal(`https://maps.apple.com/?daddr=${q}`, "Couldn't open maps on this phone.");
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Directions to ${o.vendor?.name ?? 'the store'}`}
                    accessibilityHint="Opens turn-by-turn directions"
                    style={{ minHeight: space['5xl'], justifyContent: 'center' }}
                  >
                    {({ pressed }) => (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md, opacity: pressed ? 0.7 : 1 }}>
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
                <T variant="displayXl" tone="brand" style={{ marginTop: space.xs, letterSpacing: space.sm }}>
                  {o.pickupCode}
                </T>
              </View>
            )
          ) : null}

          {/* Order lines */}
          <T variant="heading" accessibilityRole="header" style={{ marginTop: space['2xl'], color: verticalTint.ink }}>
            Your {referenceNoun} · #{o.orderNumber}
          </T>
          <View style={{ marginTop: space.sm }}>
            {items.map((it: any, i: number) => (
              <InfoRow
                key={it.id ?? i}
                label={`${it.quantity} ${it.item?.name ?? it.name}`}
                value={money(it.totalPrice ?? it.lineTotal ?? Number(it.unitPrice ?? 0) * (it.quantity ?? 1))}
              />
            ))}
            {Number(o.deliveryFee ?? 0) > 0 ? <InfoRow label="Delivery" value={money(o.deliveryFee)} /> : null}
            {Number(o.tipAmount ?? 0) > 0 ? <InfoRow label="Tip" value={money(o.tipAmount)} /> : null}
            {Number(o.discount ?? 0) > 0 ? <InfoRow label="Discount" value={`−${money(o.discount)}`} /> : null}
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color.border.subtle, marginVertical: space.sm }} />
            <InfoRow label="Total" value={money(o.totalAmount ?? o.total)} strong />
          </View>
          {o.paymentMethod === 'CASH' ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.surface.sunken }}>
              <Feather name="dollar-sign" size={18} color={color.text.secondary} />
              <T variant="label" tone="muted" style={{ flex: 1 }}>
                {terminal
                  ? `Cash is handled directly with the ${directPayee}. Swift has not held ${money(o.totalAmount ?? o.total)}.`
                  : o.orderType === 'COURIER'
                  ? 'Cash is paid directly to the rider by the named payer. Swift does not hold this money.'
                  : `Cash — have ${money(o.totalAmount ?? o.total)} ready for the ${directPayee}. Swift does not hold this money.`}
              </T>
            </View>
          ) : o.paymentMethod === 'MOBILE_MONEY' ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.surface.sunken }}>
              <Feather name="smartphone" size={18} color={color.text.secondary} />
              <T variant="label" tone="muted" style={{ flex: 1 }}>
                MMG goes directly to {mmgPayee}. Swift does not hold order money.
              </T>
            </View>
          ) : null}

          {mmgPaymentAction && o.paymentStatus === 'PENDING' && !cancelled && !failed ? (
            <View style={{ borderRadius: radius.lg, backgroundColor: color.brand[50], padding: space.lg, marginTop: space.xl }}>
              <T variant="body" weight="bold" tone="deep">
                Payment is still awaiting confirmation
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
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
          {complete && !cancelled && Number(o.tipAmount ?? 0) > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xl }}>
              <Feather name="heart" size={14} color={color.success} />
              <T variant="caption" tone="muted">
                You tipped {money(o.tipAmount)} — thank you.
              </T>
            </View>
          ) : null}

          {complete && !cancelled && !o.hasBeenRated ? (
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

          {o.canCancel && !terminal && !holdActive && !holdTimingUnavailable && !releasePending ? (
            <PillButton
              label={`Cancel ${referenceNoun}`}
              variant="soft"
              loading={cancelChecking || cancelOrder.isPending}
              onPress={() => { void openCancelConfirmation(); }}
              style={{ marginTop: space.md }}
            />
          ) : null}
        </ScrollView>
      </View>

      {/* Cancel confirm */}
      <PopupCard
        visible={confirmCancel && cancelPreviewOrderId === orderId}
        onClose={() => { if (!cancelChecking && !cancelOrder.isPending) setConfirmCancel(false); }}
      >
        <IconChip icon="x-circle" size={56} />
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Cancel this {referenceNoun}?
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          {o.orderType === 'COURIER'
            ? rider
              ? 'This cancels the pickup and puts the assigned rider back in the dispatch pool. It can’t be undone.'
              : 'This stops the rider search and cancels the pickup request. It can’t be undone.'
            : mmgCancellationAmbiguous
              ? 'Cancelling stops fulfilment. If you already sent the MMG payment, the store refunds you directly.'
              : 'Cancelling stops fulfilment. The server preview is shown below; the final outcome is confirmed when cancellation completes.'}
        </T>
        {cancelPreviewFresh && o.orderType === 'COURIER' ? (
          <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.lg, padding: space.md, borderRadius: radius.md, backgroundColor: color.soft.info }}>
            <DecorativeIcon>
              <Feather name="info" size={18} color={color.info} />
            </DecorativeIcon>
            <T variant="label" tone="info" style={{ flex: 1 }}>
              Fresh server check: cancellation is still available. This courier flow does not quote an in-app cancellation fee, and Swift does not collect courier payment.
            </T>
          </View>
        ) : cancelPreviewFresh && cancelPreviewFee != null ? (
          <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.lg, padding: space.md, borderRadius: radius.md, backgroundColor: cancelPreviewFee > 0 ? color.soft.warning : color.soft.info }}>
            <DecorativeIcon>
              <Feather name={cancelPreviewFee > 0 ? 'alert-triangle' : 'info'} size={18} color={cancelPreviewFee > 0 ? color.warning : color.info} />
            </DecorativeIcon>
            <T variant="label" tone={cancelPreviewFee > 0 ? 'warning' : 'info'} style={{ flex: 1 }}>
              {cancelPreviewFee > 0
                ? `Server preview: ${money(cancelPreviewFee)} would be recorded if you cancel now. Swift does not collect it.`
                : 'Server preview: no cancellation fee.'}
            </T>
          </View>
        ) : null}
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton
            label="Yes, cancel it"
            variant="outline"
            icon="x-circle"
            size="md"
            loading={cancelChecking || cancelOrder.isPending}
            onPress={() => { void commitCancellation(); }}
          />
          <PillButton
            label={`Keep my ${referenceNoun}`}
            variant="soft"
            size="md"
            disabled={cancelChecking || cancelOrder.isPending}
            onPress={() => setConfirmCancel(false)}
          />
        </View>
      </PopupCard>

      {/* Hooray popup (kit 39) */}
      <PopupCard visible={arrived} onClose={() => setArrived(false)}>
        <DecorativeIcon
          style={{
            width: space['5xl'] + space.lg,
            height: space['5xl'] + space.lg,
            borderRadius: radius.full,
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
              afterDismiss(() => navigation.navigate('Feedback', { orderId }));
            }}
          />
          <PillButton label="Later" variant="soft" size="md" onPress={() => setArrived(false)} />
        </View>
      </PopupCard>

      {/* Two-step, and 911 is the FIRST action — Swift records evidence, it is
          not an emergency responder, and the copy must never imply a staffed
          safety desk [liability shield]. The shared LIVE ceremony
          [REPORT-035]: the popup stays open through the raise, failure is
          loud, and "Page Swift NOW" skips the grace wait. */}
      {o?.id ? (
        <SosCeremony
          visible={sosConfirm}
          onClose={() => setSosConfirm(false)}
          context={{ orderId: o.id }}
          recordNoun="order"
          getCoords={() => {
            // MY coordinates, never the rider's live position. Ops responds to
            // where the person who pressed the button is standing.
            const coords = grantedLocationFix(myLocation.latitude, myLocation.longitude, myLocation.status);
            return coords ? { lat: coords.latitude, lng: coords.longitude } : undefined;
          }}
        />
      ) : null}
    </View>
  );
}
