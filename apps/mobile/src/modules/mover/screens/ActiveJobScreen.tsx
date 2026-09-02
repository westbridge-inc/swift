/** @jsxImportSource react */
import React, { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import * as ImagePicker from 'expo-image-picker';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { CodeInput, DecorativeIcon, EmptyState, Eyebrow, LockIn, PillButton, PopupCard, PopupTitle, Screen, StatusRail, T, type TimelineStep, cardShadow, lockInButtonStyle } from '../../../kit';
import { Stars } from '../../../kit/controls';
import { useMoverKind, useActiveJob, useActiveJobs, useDriverAction, useRiderAction, useRateCustomer, useCourierProof, useCourierCollect, useRideSos } from '../../../hooks';
import { SosCeremony } from '../../safety/SosCeremony';
import { useMoverPreview } from '../../../stores/moverPreview';
import { toast } from '../../../kit/toast';
import { useLocationStore } from '../../../stores/locationStore';
import { grantedLocationFix } from '../../../lib/deviceLocation';
import { haversineKm, streetEtaMin } from '../../../lib/geo';
// One authority for the rider's leg: what they do next, and whether the goods
// are still with the vendor. `showBagIsWaiting` is why the counter signal no
// longer survives past custody — see that file.
import { riderStep, showBagIsWaiting, legStopLabel } from '../../../lib/riderLeg';
import { money } from '../../../lib/money';
import { jobAmount, RoutePair } from '../shared';
import { haptic } from '../../../lib/haptics';
import { dk, withAlpha, DCard } from '../surface';
import { openExternal } from '../../../lib/openExternal';

/** [F-213] Every driver handover PIN is 6 digits (api ride-pin.ts). */
const RIDE_PIN_LENGTH = 6;
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../../../stores/authStore';

/**
 * The active job/ride screen at navigation grade (dashboard plan Phase D):
 * dark map, bold route, a live distance/ETA pill to the CURRENT target, and
 * one huge next-action button. Every rule survives untouched — the PIN gate,
 * the golden cash rule, MMG honesty, the post-trip rating.
 */

type DriverAction = 'en-route' | 'arrived' | 'verify-pin' | 'start' | 'handover';
type FailedOutcome = 'refused' | 'no_show';

// The ONE next step a driver takes, driven by the real backend status:
// DRIVER_ASSIGNED → EN_ROUTE → ARRIVED → [verify PIN] → start → RIDE_IN_PROGRESS → fare outcome.
// [M-29] There is no bare "complete": a cash ride completes when the fare is
// recorded — collected (the step below), or refused / left without paying
// (the unpaid sheet). The server refuses a completion tap without it.
function driverStep(job: any): { label: string; action: DriverAction; pin?: boolean } | null {
  const s = String(job?.status ?? '').toUpperCase();
  if (s === 'DRIVER_ASSIGNED') return { label: "I'm on the way", action: 'en-route' };
  if (s === 'DRIVER_EN_ROUTE') return { label: "I've arrived", action: 'arrived' };
  if (s === 'DRIVER_ARRIVED') return job.ridePinVerified ? { label: 'Start trip', action: 'start' } : { label: 'Verify rider PIN', action: 'verify-pin', pin: true };
  if (s === 'RIDE_IN_PROGRESS') return { label: 'Fare collected — complete trip', action: 'handover' };
  return null;
}

// The ONE next step a rider takes before the door, driven by the backend status:
// RIDER_ASSIGNED → en-route-pickup → arrived-pickup → picked-up →
// en-route-delivery → arrived → (ARRIVED: handover/delivered UI takes over).

const DRIVER_STEPS = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'];
const RIDER_STEPS = ['RIDER_ASSIGNED', 'PICKED_UP', 'DELIVERED'];

/**
 * [WS-2.1 → WS-3.2 item 6 — RESOLVED] The tombstoned 12pt-dot stepper is
 * retired: the kit's `StatusRail` (the horizontal Timeline) draws this now,
 * using the dark-cockpit inks the kit gained for exactly this swap — one
 * component, one state grammar, one screen-reader sentence, both surfaces.
 * The collapse rule survives as index math: rider mid-leg states (en route to
 * the customer / arrived) sit on the "Picked up" node; terminal states on the
 * last; unknown states claim nothing past "Assigned".
 */
function railFor(status: string | undefined, isDriver: boolean): { steps: TimelineStep[]; currentIndex: number } {
  const s = String(status ?? '').toUpperCase();
  const keys = isDriver ? DRIVER_STEPS : RIDER_STEPS;
  let currentIndex = keys.indexOf(s);
  if (currentIndex < 0) {
    if (s === 'COMPLETED' || s === 'DELIVERED') currentIndex = keys.length - 1;
    else if (!isDriver && (s === 'EN_ROUTE_DELIVERY' || s === 'ARRIVED')) currentIndex = 1;
    else currentIndex = 0;
  }
  const steps: TimelineStep[] = isDriver
    ? [
        { key: 'assigned', label: 'Assigned', icon: 'user-check', description: 'The trip is yours.' },
        { key: 'enroute', label: 'En route', icon: 'navigation', description: 'Heading to the pickup.' },
        { key: 'arrived', label: 'Arrived', icon: 'map-pin', description: 'At the pickup point.' },
        { key: 'riding', label: 'Riding', icon: 'compass', description: 'Passenger on board.' },
      ]
    : [
        { key: 'assigned', label: 'Assigned', icon: 'user-check', description: 'The job is yours.' },
        { key: 'picked', label: 'Picked up', icon: 'package', description: 'Order collected from the store.' },
        { key: 'delivered', label: 'Delivered', icon: 'flag', description: 'Handed to the customer.' },
      ];
  return { steps, currentIndex };
}

export function ActiveJobScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { kind } = useMoverKind();
  const active = useActiveJob(kind);
  const stackedJobs = useActiveJobs(kind);
  const driverAct = useDriverAction();
  const riderAct = useRiderAction();
  const courierProof = useCourierProof();
  const courierCollect = useCourierCollect();
  const rate = useRateCustomer();
  const { latitude, longitude, status: locationStatus } = useLocationStore();
  const [pin, setPin] = useState('');
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  const [ratePopup, setRatePopup] = useState<{ orderId: string; name: string; mmg: boolean } | null>(null);
  const [stars, setStars] = useState(5);
  // Driver-raised SOS on an active taxi ride — the backend authorizes the driver
  // participant on /rides/:id/sos (same route the passenger's SOS uses).
  const sos = useRideSos();
  const [sosConfirm, setSosConfirm] = useState(false);
  // G14: pre-pickup handback — a two-step with preset reasons, never one tap.
  const [handbackConfirm, setHandbackConfirm] = useState(false);
  // [M-29] The unpaid sheet — the failed fare outcome (driver) or failed
  // handover (rider): refused, or nobody / left without paying.
  const [unpaidSheet, setUnpaidSheet] = useState(false);
  // [M-28] The sender-pays courier job that ends at pickup: the fee was not
  // paid, so the parcel is never taken.
  const [senderRefusedSheet, setSenderRefusedSheet] = useState(false);
  // Preview (R3): useActiveJob supplies a sample in-progress trip, so this
  // nav-grade screen is fully browsable read-only. Real actions (SOS/dial) are
  // suppressed below; the step mutations already no-op in preview.
  const preview = useMoverPreview((s) => s.preview);
  // [B6] A stacked rider works ONE screen with a stop list — never a tab per
  // order. The detail panel below (PIN sheet, cash line, customer, actions,
  // handback) is the selected stop's own, because every one of them reads
  // `job`. A single leg is `active.data`, exactly as before.
  const legs: any[] = stackedJobs.legs;
  const stacked = legs.length > 1;
  const job: any = stacked ? (legs.find((l) => l.id === selectedLegId) ?? legs[0]) : active.data;

  if (!job && !ratePopup) {
    return (
      <Screen>
        <EmptyState icon="map-pin" title="No active job" body="When you accept a job it'll show up here." />
        <View style={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}>
          <PillButton label="Back" variant="soft" onPress={() => navigation?.goBack?.()} />
        </View>
      </Screen>
    );
  }

  const pickup = job?.pickupLat != null ? { latitude: Number(job.pickupLat), longitude: Number(job.pickupLng) } : null;
  const drop = job?.deliveryLat != null ? { latitude: Number(job.deliveryLat), longitude: Number(job.deliveryLng) } : null;
  const region =
    pickup && drop
      ? {
          latitude: (pickup.latitude + drop.latitude) / 2,
          longitude: (pickup.longitude + drop.longitude) / 2,
          latitudeDelta: Math.max(0.02, Math.abs(pickup.latitude - drop.latitude) * 2.2),
          longitudeDelta: Math.max(0.02, Math.abs(pickup.longitude - drop.longitude) * 2.2),
        }
      : pickup
        ? { ...pickup, latitudeDelta: 0.02, longitudeDelta: 0.02 }
        : undefined;

  const busy = driverAct.isPending || riderAct.isPending || courierProof.isPending || courierCollect.isPending;
  const isDriver = kind === 'DRIVER';
  // Courier deliveries close with a proof-of-delivery photo (D8-02): capture →
  // upload → the handoff transition (which pays the rider). Everything else uses
  // the plain "Mark delivered" action.
  const isCourier = String(job?.orderType ?? '').toUpperCase() === 'COURIER';
  // [M-28] The courier's cash outcome travels WITH the proof photo when the
  // recipient pays: 'paid' captures the fee and delivers in one commit;
  // 'refused' / 'no_show' fail the job with the photo and the rider's location
  // as the claim's evidence. A job already paid (MMG, or the sender's fee
  // collected at pickup) sends the photo alone. The outcome is never defaulted
  // here — the server refuses a bare proof on an unpaid cash job.
  const captureCourierProof = async (outcome?: 'paid' | FailedOutcome) => {
    try {
      const owner = preview ? null : requireAuthSessionSnapshot();
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (owner) requireAuthSessionForPrincipal(owner);
      if (!perm.granted) {
        toast.error('Camera access is needed to capture proof of delivery.');
        return;
      }
      const shot = await ImagePicker.launchCameraAsync({ quality: 0.6 });
      if (owner) requireAuthSessionForPrincipal(owner);
      if (shot.canceled || !shot.assets?.[0]) return;
      courierProof.mutate(
        { orderId: job.id, uri: shot.assets[0].uri, outcome, authSession: owner ?? undefined },
        {
          onSuccess: (res: any) => {
            if (outcome && outcome !== 'paid') {
              const claim = res?.claim?.status;
              toast.show(
                claim === 'AUTO_APPROVED' ? 'Failed delivery recorded — the Swift guarantee covers it.'
                  : claim === 'PENDING_REVIEW' ? 'Failed delivery recorded — your claim is under review.'
                    : 'Failed delivery recorded.',
              );
              navigation?.goBack?.();
              return;
            }
            active.refetch?.();
          },
          onError: (proofError: any) => {
            if (!(proofError instanceof AuthSessionBoundaryError)) {
              toast.error(proofError?.response?.data?.error?.message ?? 'Couldn’t save the proof. Try again.');
            }
          },
        },
      );
    } catch (proofError) {
      if (!(proofError instanceof AuthSessionBoundaryError)) throw proofError;
    }
  };
  const markDelivered = () =>
    isCourier ? captureCourierProof() : riderAct.mutate({ id: job.id, action: 'delivered' });
  const deliverLabel = isCourier ? 'Capture proof & deliver' : 'Mark delivered';
  // MMG direct-pay: the customer already paid the STORE — the rider collects
  // NOTHING at the door; their delivery fee comes from the store in cash.
  const isMmgPaid = job?.paymentMethod === 'MOBILE_MONEY';
  // [M-28] Courier cash: WHO pays decides WHEN the money is recorded, and the
  // server refuses a proof that would imply money it never saw. Sender pays →
  // the fee is collected at pickup, before custody (the collect step below);
  // recipient pays → at the door, with the proof photo. `paymentStatus` is
  // server truth: once the fee is CAPTURED the door is proof-and-deliver only.
  const courierCash = isCourier && job?.paymentMethod === 'CASH';
  const feeCaptured = job?.paymentStatus === 'CAPTURED';
  const senderFeeDue = courierCash && job?.courierPayer === 'SENDER' && !feeCaptured;
  const recipientFeeDue = courierCash && job?.courierPayer !== 'SENDER' && !feeCaptured;
  const jobStatus = String(job?.status ?? '').toUpperCase();
  // The sender is in front of the rider at these two; PICKED_UP still records
  // (the server allows it) so a rider who took the parcel first is not stuck.
  const atSender = jobStatus === 'RIDER_ARRIVED_PICKUP' || jobStatus === 'READY_FOR_PICKUP';
  const canStillCollect = atSender || jobStatus === 'PICKED_UP';
  const courierFee = jobAmount(job);
  const pickedUp = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'].includes(String(job?.status ?? '').toUpperCase());
  // The store owes the rider fee PLUS any prepaid tip on MMG — the settlement
  // ledger records fee + tip, so the door copy must claim the same number
  // [REPORT-006 carryover: fee-only copy under-claimed the rider's pay].
  const feeLabel = `GYD ${(Number(job?.deliveryFee ?? 0) + Number(job?.tipAmount ?? 0)).toLocaleString()}`;
  const cust: any = job?.customer ?? job?.user ?? null;
  const custName = cust ? [cust.firstName, cust.lastName].filter(Boolean).join(' ') : null;
  const inProgress = String(job?.status ?? '').toUpperCase() === 'RIDE_IN_PROGRESS';
  const riderToDrop = !isDriver && pickedUp;
  const navTarget = inProgress || riderToDrop ? drop : pickup;
  const targetLabel = inProgress || riderToDrop ? 'drop-off' : 'pickup';
  const openNav = () => {
    if (!navTarget) return;
    const q = `${navTarget.latitude},${navTarget.longitude}`;
    Linking.openURL(`maps://?daddr=${q}`).catch(() => openExternal(`https://maps.google.com/?daddr=${q}`, "Couldn't open maps on this phone."));
  };
  const step = isDriver && job ? driverStep(job) : null;

  // Live distance/ETA to the CURRENT target (reference nav pill) — straight
  // GPS math via the shared street-pace estimator, never presented as routing.
  const me = grantedLocationFix(latitude, longitude, locationStatus);
  const distKm = navTarget && me ? haversineKm(me, navTarget) : null;
  const etaMin = navTarget && me ? streetEtaMin(me, navTarget) : null;

  const runDriverStep = () => {
    if (!step || !job) return;
    // [M-29] The step's own outcome is 'paid' — "Fare collected"; the failed
    // outcomes come only from the unpaid sheet, each named explicitly.
    const input = step.action === 'handover'
      ? { id: job.id, action: 'handover' as const, outcome: 'paid' as const }
      : { id: job.id, action: step.action, ...(step.pin ? { pin } : {}) };
    driverAct.mutate(
      input,
      {
        onError: () => {
          if (step.pin) haptic.failure();
        },
        onSuccess: () => {
          if (step.pin) haptic.success();
          // Trip done → rate the passenger while it's fresh (DRIVER_TO_CUSTOMER).
          if (step.action === 'handover') {
            setStars(5);
            setRatePopup({ orderId: job.id, name: custName ?? 'your passenger', mmg: job.paymentMethod === 'MOBILE_MONEY' });
          }
        },
      },
    );
  };

  // [M-29] The failed outcome, on either rail: the server captures this GPS
  // as evidence, strikes the customer and opens the guarantee claim in one
  // commit — nothing here is optimistic, and the answer names the claim.
  const recordUnpaid = (outcome: FailedOutcome) => {
    setUnpaidSheet(false);
    if (preview || !job?.id) return;
    const recorded = isDriver ? 'Unpaid fare recorded' : 'Failed delivery recorded';
    const onSuccess = (res: any) => {
      const claim = res?.claim?.status;
      toast.show(
        claim === 'AUTO_APPROVED' ? `${recorded} — the Swift guarantee covers it.`
          : claim === 'PENDING_REVIEW' ? `${recorded} — your claim is under review.`
            : `${recorded}.`,
      );
      navigation?.goBack?.();
    };
    const onError = (e: any) => toast.show(e?.response?.data?.error?.message ?? "Couldn't record the outcome — try again or call support.");
    if (isDriver) driverAct.mutate({ id: job.id, action: 'handover', outcome }, { onSuccess, onError });
    // [M-28] A courier's failed outcome is recorded WITH the proof photo —
    // the camera opens next, and the photo is the claim's evidence.
    else if (isCourier) void captureCourierProof(outcome);
    else riderAct.mutate({ id: job.id, action: 'handover', outcome }, { onSuccess, onError });
  };

  // [M-28] The sender's fee, recorded at pickup. 'paid' captures it (the door's
  // proof then closes the job); 'refused' ends the job here — no custody, a
  // strike on the sender — and the answer names what the server did.
  const collectFromSender = (outcome: 'paid' | 'refused') => {
    setSenderRefusedSheet(false);
    if (preview || !job?.id) return;
    courierCollect.mutate(
      { orderId: job.id, outcome },
      {
        onSuccess: (res: any) => {
          if (outcome === 'paid') {
            haptic.success();
            toast.show(`${courierFee} recorded as collected from the sender.`);
            active.refetch?.();
            return;
          }
          toast.show(res?.status === 'CANCELLED' ? 'Job ended — the sender didn’t pay. Their account takes a strike.' : 'Recorded.');
          navigation?.goBack?.();
        },
        onError: (e: any) => toast.show(e?.response?.data?.error?.message ?? "Couldn't record the sender's payment — try again or call support."),
      },
    );
  };

  const closeRating = () => {
    setRatePopup(null);
    navigation?.goBack?.();
  };

  // The one big action at the bottom (reference "Arrived" button).
  const bigButton = (
    label: string,
    onPress: () => void,
    opts?: { disabled?: boolean; loading?: boolean; soft?: boolean; lockedIn?: boolean },
  ) => (
    <PillButton
      label={label}
      loading={opts?.loading}
      disabled={opts?.disabled}
      variant={opts?.soft ? 'outline' : 'primary'}
      onPress={onPress}
      // After a lock-in the CTA carries the confirmed-success colour, so the
      // eye lands on the one thing left to do [100x pass §1c].
      style={{ minHeight: 56, ...(opts?.lockedIn ? lockInButtonStyle() : {}) }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: dk.bg }}>
      {job ? (
        <MapView
          provider={PROVIDER_DEFAULT}
          style={{ flex: 1 }}
          initialRegion={region}
          showsUserLocation={me !== null}
        >
          {pickup ? <Marker coordinate={pickup} title="Pickup" /> : null}
          {drop ? <Marker coordinate={drop} title="Drop-off" pinColor={color.brand[500]} /> : null}
          {pickup && drop ? (
            <>
              {/* Bold route line: white halo under the accent stroke. Geodesic
                  connector — a heading, not turn-by-turn. */}
              <Polyline coordinates={[pickup, drop]} geodesic strokeColor={withAlpha(color.white, 0.35)} strokeWidth={9} />
              <Polyline coordinates={[pickup, drop]} geodesic strokeColor={color.brand[500]} strokeWidth={5} />
            </>
          ) : null}
        </MapView>
      ) : (
        <View style={{ flex: 1 }} />
      )}

      <View style={{ position: 'absolute', top: insets.top, left: 0, right: 0, zIndex: 10, flexDirection: 'row', alignItems: 'center', padding: space.lg }}>
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={10}>
          {({ pressed }) => (
            <View style={[{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.card, borderWidth: 1, borderColor: dk.line, opacity: pressed ? 0.7 : 1 }, cardShadow]}>
              <Feather name="chevron-left" size={22} color={dk.text} />
            </View>
          )}
        </Pressable>
        {/* Live nav pill (reference): distance · ETA → current target. Tap = real navigation. */}
        {job && distKm != null ? (
          <Pressable onPress={openNav} style={{ flex: 1, alignItems: 'center' }} hitSlop={6}>
            {({ pressed }) => (
              <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 9999, backgroundColor: dk.card, borderWidth: 1, borderColor: dk.line, paddingHorizontal: space.lg, height: 40, opacity: pressed ? 0.8 : 1 }, cardShadow]}>
                <MaterialCommunityIcons name="navigation-variant" size={15} color={dk.accent} />
                <T variant="label" weight="bold" style={{ color: dk.text }}>
                  {distKm < 10 ? distKm.toFixed(1) : Math.round(distKm)} km · ~{etaMin} min
                </T>
                <T variant="label" style={{ color: dk.muted }}>
                  to {targetLabel}
                </T>
              </View>
            )}
          </Pressable>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <View style={{ width: 40 }} />
      </View>

      {job ? (
        <BottomSheet
          index={0}
          snapPoints={['52%', '88%']}
          enableDynamicSizing={false}
          backgroundStyle={{ backgroundColor: dk.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20 }}
          handleIndicatorStyle={{ backgroundColor: dk.faint }}
        >
          <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}>
            {stacked ? (
              <View style={{ marginBottom: space.md }}>
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  {legs.map((leg: any, i: number) => {
                    const selected = leg.id === job?.id;
                    return (
                      <Pressable key={leg.id} onPress={() => { setSelectedLegId(leg.id); setPin(''); }} style={{ flex: 1 }} hitSlop={4}>
                        <View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: selected ? dk.accentBorder : dk.line, backgroundColor: selected ? dk.card : 'transparent', padding: space.md }}>
                          <T variant="caption" weight="bold" style={{ color: selected ? dk.accent : dk.muted, letterSpacing: 1 }}>
                            STOP {i + 1}
                          </T>
                          <T variant="label" weight="semibold" numberOfLines={1} style={{ color: dk.text, marginTop: 2 }}>
                            {legStopLabel(leg)}
                          </T>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                {stackedJobs.run ? (
                  <T variant="label" style={{ color: dk.muted, marginTop: space.sm }}>
                    {stackedJobs.run.drops} drops · {money(stackedJobs.run.cashToCollect)} to collect
                  </T>
                ) : null}
              </View>
            ) : null}
            {/* Route + fare + live progress */}
            <DCard style={{ marginBottom: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T variant="caption" weight="bold" style={{ color: dk.muted, letterSpacing: 1 }}>
                  {job.orderNumber ? `ORDER #${job.orderNumber}` : 'CURRENT JOB'}
                </T>
                <T variant="caption" weight="semibold" style={{ color: dk.muted }}>
                  {String(job.status ?? '').replace(/_/g, ' ').toLowerCase()}
                </T>
              </View>
              <T variant="title" style={{ marginTop: space.sm, color: dk.text }}>
                {jobAmount(job)}{' '}
                <T variant="label" style={{ color: dk.muted }}>
                  {isMmgPaid ? '· MMG — already paid'
                    : senderFeeDue ? '· cash — sender pays at pickup'
                      : recipientFeeDue ? '· cash — recipient pays at the door'
                        : courierCash ? '· cash — fee collected'
                          : '· cash'}
                </T>
              </T>
              {/* Kitchen signal (readyAt rides outside the status lane once a
                  rider is assigned) — tells the rider the bag is on the counter.
                  Gated on the pickup leg inside `showBagIsWaiting`: past custody
                  the bag is in the rider's own hands and this line was a lie. */}
              {!isDriver && showBagIsWaiting(job) ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm }}>
                  <MaterialCommunityIcons name="check-circle" size={15} color={dk.success} />
                  <T variant="label" weight="semibold" style={{ color: dk.success }}>
                    Order is packed and ready for pickup
                  </T>
                </View>
              ) : null}
              <StatusRail onDark {...railFor(job.status, isDriver)} style={{ marginTop: space.md }} />
              <View style={{ marginTop: space.md }}>
                <RoutePair pickup={job.pickupAddress ?? 'Pickup'} dropoff={job.deliveryAddress ?? job.dropoffAddress ?? 'Drop-off'} />
              </View>
            </DCard>

            {/* Passenger / customer */}
            {cust ? (
              <DCard style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.accent }}>
                  <T variant="body" weight="bold" style={{ color: color.white }}>
                    {(cust.firstName ?? 'C').charAt(0).toUpperCase()}
                  </T>
                </View>
                <View style={{ flex: 1, marginLeft: space.md }}>
                  <T variant="caption" style={{ color: dk.muted }}>
                    {isDriver ? 'Passenger' : 'Customer'}
                  </T>
                  <T variant="body" weight="bold" numberOfLines={1} style={{ color: dk.text }}>
                    {custName ?? 'Customer'}
                  </T>
                </View>
                {cust.phone ? (
                  <Pressable onPress={() => void openExternal(`tel:${cust.phone}`, "Couldn't start the call — dial the customer directly.")} hitSlop={6}>
                    {({ pressed }) => (
                      <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.cardSoft, marginRight: space.sm, opacity: pressed ? 0.7 : 1 }}>
                        <Feather name="phone" size={17} color={dk.success} />
                      </View>
                    )}
                  </Pressable>
                ) : null}
                <Pressable onPress={() => navigation.navigate('Conversation', { orderId: job.id, title: custName ?? 'Customer' })} hitSlop={6}>
                  {({ pressed }) => (
                    <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.cardSoft, opacity: pressed ? 0.7 : 1 }}>
                      <Feather name="message-circle" size={17} color={dk.accent} />
                    </View>
                  )}
                </Pressable>
              </DCard>
            ) : null}

            {/* SOS — anyone alone with a stranger on a cash job needs an
                emergency path, not just the passenger and not just the driver.
                This read `{isDriver ? …}` and the comment above it already
                argued the case it then failed to apply: a delivery rider
                carrying cash to a stranger's address at night is the SAME
                risk, on the SAME screen, and had no button. The gate existed
                only because /rides/:id/sos is taxi-scoped — meanwhile the
                general /safety/sos route, which authorises the rider too, had
                sat complete and uncalled the whole time. Drivers keep the ride
                route (a working emergency path is not re-plumbed for
                tidiness); everyone else now reaches the general one. */}
            {/* [Wave 3 vs reference 16] The stack reads action → safety →
                navigation: the step and its button come FIRST, Emergency
                follows, and Navigate closes as the reference's quiet text
                link — the live nav pill at the top already owns wayfinding,
                and a third full button made maroon compete with itself. */}
            {/* The single next step (driver) or handover/deliver (rider) */}
            {isDriver ? (
              step ? (
                <>
                  {step.pin ? (
                    // [Wave 3 vs reference 16] The handover is a CEREMONY with a
                    // name on it: the eyebrow, then "Ask Devon for their code" —
                    // it addresses a person, not a system — then the boxes, then
                    // the one-line why. Same gate, same server truth.
                    <View style={{ marginBottom: space.md }}>
                      <View style={{ alignItems: 'center', marginBottom: space.md }}>
                        <Eyebrow>Handover check</Eyebrow>
                        <T variant="body" weight="bold" center style={{ color: dk.text, marginTop: space.xs }}>
                          Ask {custName ?? 'the passenger'} for their code
                        </T>
                      </View>
                      <CodeInput value={pin} onChange={setPin} length={RIDE_PIN_LENGTH} error={driverAct.isError} autoFocus={false} />
                      <T variant="caption" center style={{ color: dk.muted, marginTop: space.sm }}>
                        Their code proves you picked up the right person.
                      </T>
                    </View>
                  ) : null}
                  {/* THE LOCK-IN [100x pass §1c]. `ridePinVerified` is SERVER
                      truth — the tick can only appear once the code was really
                      accepted, never optimistically while the request is in
                      flight. Failure keeps its own language: CodeInput already
                      shakes ±6dp ×3 on error. */}
                  {step.action === 'start' ? <LockIn label="Code accepted — locked in." style={{ marginBottom: space.md }} /> : null}
                  {bigButton(step.label, runDriverStep, {
                    loading: busy,
                    disabled: busy || (!!step.pin && pin.length < RIDE_PIN_LENGTH),
                    lockedIn: step.action === 'start',
                  })}
                  {/* [M-29] The other outcome at the destination. Never a plain
                      "complete" — the server refuses a cash ride without a
                      recorded fare (PAYMENT_NOT_CAPTURED). */}
                  {step.action === 'handover' ? (
                    <PillButton
                      label="Passenger didn't pay"
                      variant="soft"
                      style={{ marginTop: space.sm }}
                      disabled={busy}
                      onPress={() => setUnpaidSheet(true)}
                    />
                  ) : null}
                </>
              ) : (
                <T variant="label" center style={{ color: dk.muted, paddingVertical: space.md }}>
                  Trip complete.
                </T>
              )
            ) : riderStep(job) ? (
              // Before the door: walk the delivery leg one step at a time
              // (heading to pickup → picked up → heading to customer → arrived).
              // Only once the order is ARRIVED do the handover/delivered controls
              // below take over.
              <>
                {senderFeeDue && canStillCollect ? (
                  // [M-28] Sender pays → the fee is collected HERE, before the
                  // parcel changes hands. The server records it with this
                  // location and refuses the door's proof until it has.
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(dk.accent, 0.14), borderWidth: 1, borderColor: dk.accentBorder, padding: space.md, marginBottom: space.md }}>
                    <Feather name="alert-circle" size={15} color={dk.accent} style={{ marginTop: 1 }} />
                    <T variant="caption" weight="semibold" style={{ flex: 1, color: dk.text }}>
                      {atSender
                        ? `The sender pays: collect ${courierFee} BEFORE taking the parcel.`
                        : `The sender's ${courierFee} wasn't recorded at pickup — record it now, or the drop-off can't close.`}
                    </T>
                  </View>
                ) : null}
                {senderFeeDue && atSender
                  ? bigButton(`Collected ${courierFee} from the sender`, () => collectFromSender('paid'), { loading: courierCollect.isPending, disabled: busy })
                  : bigButton(riderStep(job)!.label, () => riderAct.mutate({ id: job.id, action: riderStep(job)!.action }), {
                    loading: riderAct.isPending,
                    disabled: busy,
                  })}
                {senderFeeDue && atSender ? (
                  <PillButton
                    label="Sender didn't pay"
                    variant="soft"
                    style={{ marginTop: space.sm }}
                    disabled={busy}
                    onPress={() => setSenderRefusedSheet(true)}
                  />
                ) : null}
                {senderFeeDue && !atSender && canStillCollect ? (
                  <PillButton
                    label={`Record ${courierFee} collected from the sender`}
                    variant="soft"
                    style={{ marginTop: space.sm }}
                    disabled={busy}
                    onPress={() => collectFromSender('paid')}
                  />
                ) : null}
                {/* G14: the valve exists ONLY before pickup — after custody the
                    server refuses and support owns it, so no button is shown. */}
                {!pickedUp ? (
                  <PillButton
                    label="Can't complete this delivery"
                    variant="soft"
                    style={{ marginTop: space.sm }}
                    disabled={busy || riderAct.isPending}
                    onPress={() => setHandbackConfirm(true)}
                  />
                ) : null}
              </>
            ) : isCourier ? (
              // [M-28] The courier's door. The proof photo ALWAYS closes the
              // job; whether money is recorded with it depends on who pays and
              // whether it was already captured — never on a default.
              <>
                {recipientFeeDue ? (
                  <>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(dk.accent, 0.14), borderWidth: 1, borderColor: dk.accentBorder, padding: space.md, marginBottom: space.md }}>
                      <Feather name="alert-circle" size={15} color={dk.accent} style={{ marginTop: 1 }} />
                      <T variant="caption" weight="semibold" style={{ flex: 1, color: dk.text }}>
                        Golden rule: collect {courierFee} from the recipient BEFORE handing over the parcel.
                      </T>
                    </View>
                    {bigButton(`Collected ${courierFee} — capture proof & deliver`, () => captureCourierProof('paid'), { loading: courierProof.isPending, disabled: busy })}
                    <PillButton
                      label="Recipient didn't pay"
                      variant="soft"
                      style={{ marginTop: space.sm }}
                      disabled={busy}
                      onPress={() => setUnpaidSheet(true)}
                    />
                  </>
                ) : senderFeeDue ? (
                  // A sender-pays job that reached the door with no fee recorded
                  // cannot close from here — the server refuses the proof, and
                  // the collect step is a pickup step. Honesty over a dead tap.
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(dk.accent, 0.14), borderWidth: 1, borderColor: dk.accentBorder, padding: space.md, marginBottom: space.md }}>
                    <Feather name="alert-circle" size={15} color={dk.accent} style={{ marginTop: 1 }} />
                    <T variant="caption" weight="semibold" style={{ flex: 1, color: dk.text }}>
                      The sender's {courierFee} was never recorded at pickup, so this job can't be closed from here. Call support.
                    </T>
                  </View>
                ) : (
                  <>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(color.success, 0.12), borderWidth: 1, borderColor: withAlpha(color.success, 0.4), padding: space.md, marginBottom: space.md }}>
                      <Feather name="check-circle" size={15} color={dk.success} style={{ marginTop: 1 }} />
                      <T variant="caption" weight="semibold" style={{ flex: 1, color: dk.text }}>
                        {isMmgPaid
                          ? 'Paid via MMG — collect NOTHING at the door.'
                          : courierCash
                            ? `${courierFee} already collected from the sender — collect NOTHING at the door.`
                            : 'Already paid — collect NOTHING at the door.'}
                      </T>
                    </View>
                    {bigButton('Capture proof & deliver', () => captureCourierProof(), { loading: courierProof.isPending, disabled: busy })}
                  </>
                )}
              </>
            ) : isMmgPaid ? (
              <>
                {/* Customer paid the store via MMG — the door is a pure handover;
                    the rider's fee comes from the STORE (tracked in Earnings). */}
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(color.success, 0.12), borderWidth: 1, borderColor: withAlpha(color.success, 0.4), padding: space.md, marginBottom: space.md }}>
                  <Feather name="check-circle" size={15} color={dk.success} style={{ marginTop: 1 }} />
                  <T variant="caption" weight="semibold" style={{ flex: 1, color: dk.text }}>
                    {pickedUp
                      ? `Customer already paid via MMG — collect NOTHING at the door. Your ${feeLabel} pay (fee + tip) comes from the store (see Earnings).`
                      : `Customer already paid via MMG. Collect your ${feeLabel} pay (fee + tip) from the store with the order.`}
                  </T>
                </View>
                {bigButton(deliverLabel, markDelivered, { loading: riderAct.isPending || courierProof.isPending, disabled: busy })}
              </>
            ) : (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(dk.accent, 0.14), borderWidth: 1, borderColor: dk.accentBorder, padding: space.md, marginBottom: space.md }}>
                  <Feather name="alert-circle" size={15} color={dk.accent} style={{ marginTop: 1 }} />
                  <T variant="caption" weight="semibold" style={{ flex: 1, color: dk.text }}>
                    Golden rule: collect the cash BEFORE handing over the order.
                  </T>
                </View>
                {/* CASH: the ONLY completion path is capturing the money, which
                    hands over + completes the delivery server-side. No plain
                    "mark delivered" here — the server refuses a cash order that
                    wasn't paid (PAYMENT_NOT_CAPTURED), so it must not be offered. */}
                {bigButton('Confirm payment & hand over', () => riderAct.mutate({ id: job.id, action: 'handover' }), { loading: riderAct.isPending, disabled: busy })}
                {/* [M-29] The door's other outcome — the rail existed on the
                    server (strike + guarantee claim) with no way to reach it. */}
                <PillButton
                  label="Customer didn't pay"
                  variant="soft"
                  style={{ marginTop: space.sm }}
                  disabled={busy}
                  onPress={() => setUnpaidSheet(true)}
                />
              </>
            )}

            {/* SOS after the action — anyone alone with a stranger on a cash
                job needs an emergency path (driver AND rider; the general
                /safety/sos route authorises both — see the SosCeremony split
                below). */}
            {job?.id ? (
              <PillButton
                label="Emergency — get help now"
                variant="outline"
                icon="alert-triangle"
                style={{ marginTop: space.md, borderColor: color.error }}
                onPress={() => setSosConfirm(true)}
              />
            ) : null}

            {/* Navigate — the reference's plain text link, centred and quiet. */}
            {navTarget ? (
              <Pressable
                onPress={openNav}
                accessibilityRole="link"
                accessibilityLabel={`Navigate to ${targetLabel}`}
                accessibilityHint="Opens turn-by-turn directions"
                style={{ marginTop: space.md, minHeight: space['5xl'], justifyContent: 'center', alignSelf: 'center' }}
              >
                {({ pressed }) => (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, opacity: pressed ? 0.7 : 1 }}>
                    <Feather name="navigation" size={14} color={dk.accent} />
                    <T variant="label" weight="semibold" style={{ color: dk.accent }}>
                      Navigate to {targetLabel}
                    </T>
                  </View>
                )}
              </Pressable>
            ) : null}
          </BottomSheetScrollView>
        </BottomSheet>
      ) : null}

      {/* SOS — deliberate two-step. Two routes, one button: a taxi ride keeps
          /rides/:id/sos (live, proven, IMMEDIATE server-side — never
          re-plumbed for consistency's sake); every other job takes the shared
          LIVE ceremony [REPORT-035] — the popup stays open through the raise,
          failure is loud, and "Page Swift NOW" skips the grace wait. */}
      {!isDriver && job?.id && !preview ? (
        <SosCeremony
          visible={sosConfirm}
          onClose={() => setSosConfirm(false)}
          context={{ orderId: job.id }}
          recordNoun="job"
          getCoords={() => (me ? { lat: me.latitude, lng: me.longitude } : undefined)}
        />
      ) : (
        <PopupCard visible={sosConfirm} onClose={() => setSosConfirm(false)}>
          <DecorativeIcon style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: color.error }}>
            <Feather name="alert-triangle" size={32} color={color.white} />
          </DecorativeIcon>
          <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
            Get emergency help?
          </PopupTitle>
          <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
            This dials 911 — local emergency services — right away. Swift also saves the alert and your live location on this trip’s record. Use only in a real emergency.
          </T>
          <PillButton
            label="Yes — get help now"
            style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
            disabled={sos.isPending}
            onPress={() => {
              setSosConfirm(false);
              if (preview) return; // read-only preview never dials or records
              // 911 is THE action — dial first, never behind anything else. Swift
              // records evidence; it is not an emergency responder and the copy
              // must never imply a staffed safety desk [liability shield].
              // Guyana launch emergency number; move to CountryConfig for other markets.
              void openExternal('tel:911', "Couldn't start the call — dial 911 directly.");
              const coords = me ? { lat: me.latitude, lng: me.longitude } : undefined;
              if (!job?.id) return;
              sos.mutate({ id: job.id, coords });
            }}
          />
          <PillButton label="Close" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setSosConfirm(false)} />
        </PopupCard>
      )}

      {/* [M-29] The unpaid sheet: the failed fare outcome at the destination
          (driver) or the failed handover at the door (rider). The choice names
          what happened; the server records the GPS evidence, the strike and
          the guarantee claim together. */}
      <PopupCard visible={unpaidSheet} onClose={() => setUnpaidSheet(false)}>
        <PopupTitle variant="title" center>{isDriver ? 'The passenger didn’t pay?' : isCourier ? 'The recipient didn’t pay?' : 'The customer didn’t pay?'}</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {isDriver
            ? 'Your location is recorded as evidence, the passenger’s account takes a strike, and the Swift guarantee reviews the fare. Pick what happened:'
            : isCourier
              ? 'Next you’ll photograph the parcel at the door as evidence. Your location is recorded, the sender’s account takes a strike, and the Swift guarantee reviews the fee. Pick what happened:'
              : 'Your location is recorded as evidence, the customer’s account takes a strike, and the Swift guarantee reviews the amount. Pick what happened:'}
        </T>
        <PillButton
          label={isDriver || isCourier ? 'Refused to pay' : 'Refused to pay at the door'}
          variant="outline"
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          disabled={busy}
          onPress={() => recordUnpaid('refused')}
        />
        <PillButton
          label={isDriver ? 'Left without paying' : isCourier ? 'Nobody there' : 'Nobody at the door'}
          variant="outline"
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          disabled={busy}
          onPress={() => recordUnpaid('no_show')}
        />
        <PillButton label="Go back" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => setUnpaidSheet(false)} />
      </PopupCard>

      {/* [M-28] The sender-pays job that ends at pickup: the fee wasn't paid,
          so the parcel is never taken. One confirmation, then the server
          records the location, cancels the job and strikes the sender. */}
      <PopupCard visible={senderRefusedSheet} onClose={() => setSenderRefusedSheet(false)}>
        <PopupTitle variant="title" center>The sender didn’t pay?</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Don’t take the parcel. The job ends here — your location is recorded and the sender’s account takes a strike.
        </T>
        <PillButton
          label="Sender refused to pay"
          variant="outline"
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          disabled={busy}
          onPress={() => collectFromSender('refused')}
        />
        <PillButton label="Go back" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => setSenderRefusedSheet(false)} />
      </PopupCard>

      {/* G14 handback — reason required, honesty first: the customer is told
          "finding you another rider", and after pickup this popup can never
          appear (the button above is gone and the server refuses anyway). */}
      <PopupCard visible={handbackConfirm} onClose={() => setHandbackConfirm(false)}>
        <PopupTitle variant="title" center>Hand this delivery back?</PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          The order goes straight back to dispatch and the nearest rider gets it. Pick what happened:
        </T>
        {(['Vehicle problem', 'Emergency', 'Cannot reach the pickup'] as const).map((why) => (
          <PillButton
            key={why}
            label={why}
            variant="outline"
            style={{ alignSelf: 'stretch', marginTop: space.md }}
            disabled={riderAct.isPending}
            onPress={() => {
              setHandbackConfirm(false);
              if (preview || !job?.id) return;
              riderAct.mutate(
                { id: job.id, action: 'handback', reason: why },
                { onError: (e: any) => toast.show(e?.response?.data?.error?.message ?? "Couldn't hand the delivery back — try again or call support.") },
              );
            }}
          />
        ))}
        <PillButton label="Keep the delivery" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.lg }} onPress={() => setHandbackConfirm(false)} />
      </PopupCard>

      {/* Post-trip passenger rating — DRIVER_TO_CUSTOMER, once per ride */}
      <PopupCard visible={!!ratePopup} onClose={closeRating}>
        <DecorativeIcon style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[500] }}>
          <Feather name="check" size={34} color={color.white} />
        </DecorativeIcon>
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Trip complete
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {ratePopup?.mmg ? 'Paid to your MMG — 100% yours.' : 'Cash collected — 100% yours.'} How was {ratePopup?.name}?
        </T>
        <View style={{ marginTop: space.lg }}>
          <Stars value={stars} size={34} gap={6} onRate={setStars} />
        </View>
        <PillButton
          label={rate.isPending ? 'Sending…' : 'Rate passenger'}
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          disabled={rate.isPending}
          onPress={() => {
            if (!ratePopup) return;
            rate.mutate({ id: ratePopup.orderId, score: stars }, { onSettled: closeRating });
          }}
        />
        <PillButton label="Skip" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={closeRating} />
      </PopupCard>
    </View>
  );
}
