/** @jsxImportSource react */
import React, { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import * as ImagePicker from 'expo-image-picker';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { EmptyState, LabeledInput, PillButton, PopupCard, Screen, T, cardShadow } from '../../../kit';
import { Stars } from '../../../kit/controls';
import { useMoverKind, useActiveJob, useDriverAction, useRiderAction, useRateCustomer, useCourierProof, useRideSos } from '../../../hooks';
import { useMoverPreview } from '../../../stores/moverPreview';
import { toast } from '../../../components/ui/toast';
import { useLocationStore } from '../../../stores/locationStore';
import { haversineKm, streetEtaMin } from '../../../lib/geo';
import { jobAmount, RoutePair } from '../shared';
import { dk, withAlpha, DCard } from '../dark';

/**
 * The active job/ride screen at navigation grade (dashboard plan Phase D):
 * dark map, bold route, a live distance/ETA pill to the CURRENT target, and
 * one huge next-action button. Every rule survives untouched — the PIN gate,
 * the golden cash rule, MMG honesty, the post-trip rating.
 */

type DriverAction = 'en-route' | 'arrived' | 'verify-pin' | 'start' | 'complete';

// The ONE next step a driver takes, driven by the real backend status:
// DRIVER_ASSIGNED → EN_ROUTE → ARRIVED → [verify PIN] → start → RIDE_IN_PROGRESS → complete.
function driverStep(job: any): { label: string; action: DriverAction; pin?: boolean } | null {
  const s = String(job?.status ?? '').toUpperCase();
  if (s === 'DRIVER_ASSIGNED') return { label: "I'm on the way", action: 'en-route' };
  if (s === 'DRIVER_EN_ROUTE') return { label: "I've arrived", action: 'arrived' };
  if (s === 'DRIVER_ARRIVED') return job.ridePinVerified ? { label: 'Start trip', action: 'start' } : { label: 'Verify rider PIN', action: 'verify-pin', pin: true };
  if (s === 'RIDE_IN_PROGRESS') return { label: 'Complete trip', action: 'complete' };
  return null;
}

// The ONE next step a rider takes before the door, driven by the backend status:
// RIDER_ASSIGNED → en-route-pickup → arrived-pickup → picked-up →
// en-route-delivery → arrived → (ARRIVED: handover/delivered UI takes over).
type RiderStep = { label: string; action: 'en-route-pickup' | 'arrived-pickup' | 'picked-up' | 'en-route-delivery' | 'arrived' };
function riderStep(job: any): RiderStep | null {
  const s = String(job?.status ?? '').toUpperCase();
  if (s === 'RIDER_ASSIGNED') return { label: "I'm on the way to pick up", action: 'en-route-pickup' };
  if (s === 'RIDER_EN_ROUTE_PICKUP') return { label: "I've arrived at pickup", action: 'arrived-pickup' };
  if (s === 'RIDER_ARRIVED_PICKUP' || s === 'READY_FOR_PICKUP') return { label: 'Picked up the order', action: 'picked-up' };
  if (s === 'PICKED_UP') return { label: "I'm on the way to the customer", action: 'en-route-delivery' };
  if (s === 'EN_ROUTE_DELIVERY') return { label: "I've arrived at the customer", action: 'arrived' };
  return null; // ARRIVED → the handover/delivered controls below take over
}

const DRIVER_STEPS = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'];
const RIDER_STEPS = ['RIDER_ASSIGNED', 'PICKED_UP', 'DELIVERED'];
const DRIVER_STEP_LABELS = ['Assigned', 'En route', 'Arrived', 'Riding'];
const RIDER_STEP_LABELS = ['Assigned', 'Picked up', 'Delivered'];

/** Where this job stands — the same statuses the state machine enforces. */
function StatusStepper({ status, isDriver }: { status?: string; isDriver: boolean }) {
  const steps = isDriver ? DRIVER_STEPS : RIDER_STEPS;
  const labels = isDriver ? DRIVER_STEP_LABELS : RIDER_STEP_LABELS;
  const s = String(status ?? '').toUpperCase();
  let idx = steps.indexOf(s);
  if (idx < 0) {
    if (s === 'COMPLETED' || s === 'DELIVERED') idx = steps.length - 1;
    // Rider mid-leg states aren't in the 3-dot stepper: past pickup (en route to
    // customer / arrived) sits on the "Picked up" dot; pre-pickup on "Assigned".
    else if (!isDriver && (s === 'EN_ROUTE_DELIVERY' || s === 'ARRIVED')) idx = 1;
    else idx = 0;
  }
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.md }}>
      {steps.map((_, i) => (
        <React.Fragment key={i}>
          <View style={{ alignItems: 'center' }}>
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: i <= idx ? dk.accent : dk.cardSoft,
              }}
            />
            <T variant="caption" weight={i === idx ? 'semibold' : 'regular'} style={{ marginTop: 3, color: i <= idx ? dk.text : dk.faint }}>
              {labels[i]}
            </T>
          </View>
          {i < steps.length - 1 ? (
            <View style={{ flex: 1, height: 2, marginHorizontal: 4, marginBottom: 16, borderRadius: 1, backgroundColor: i < idx ? dk.accent : dk.cardSoft }} />
          ) : null}
        </React.Fragment>
      ))}
    </View>
  );
}

export function ActiveJobScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { kind } = useMoverKind();
  const active = useActiveJob(kind);
  const driverAct = useDriverAction();
  const riderAct = useRiderAction();
  const courierProof = useCourierProof();
  const rate = useRateCustomer();
  const { latitude, longitude } = useLocationStore();
  const [pin, setPin] = useState('');
  const [ratePopup, setRatePopup] = useState<{ orderId: string; name: string; mmg: boolean } | null>(null);
  const [stars, setStars] = useState(5);
  // Driver-raised SOS on an active taxi ride — the backend authorizes the driver
  // participant on /rides/:id/sos (same route the passenger's SOS uses).
  const sos = useRideSos();
  const [sosConfirm, setSosConfirm] = useState(false);
  // Preview (R3): useActiveJob supplies a sample in-progress trip, so this
  // nav-grade screen is fully browsable read-only. Real actions (SOS/dial) are
  // suppressed below; the step mutations already no-op in preview.
  const preview = useMoverPreview((s) => s.preview);
  const job: any = active.data;

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

  const busy = driverAct.isPending || riderAct.isPending || courierProof.isPending;
  const isDriver = kind === 'DRIVER';
  // Courier deliveries close with a proof-of-delivery photo (D8-02): capture →
  // upload → the handoff transition (which pays the rider). Everything else uses
  // the plain "Mark delivered" action.
  const isCourier = String(job?.orderType ?? '').toUpperCase() === 'COURIER';
  const captureCourierProof = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      toast.error('Camera access is needed to capture proof of delivery.');
      return;
    }
    const shot = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (shot.canceled || !shot.assets?.[0]) return;
    courierProof.mutate(
      { orderId: job.id, uri: shot.assets[0].uri },
      {
        onSuccess: () => active.refetch?.(),
        onError: () => toast.error('Couldn’t save the proof. Try again.'),
      },
    );
  };
  const markDelivered = () =>
    isCourier ? captureCourierProof() : riderAct.mutate({ id: job.id, action: 'delivered' });
  const deliverLabel = isCourier ? 'Capture proof & deliver' : 'Mark delivered';
  // MMG direct-pay: the customer already paid the STORE — the rider collects
  // NOTHING at the door; their delivery fee comes from the store in cash.
  const isMmgPaid = job?.paymentMethod === 'MOBILE_MONEY';
  const pickedUp = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'].includes(String(job?.status ?? '').toUpperCase());
  const feeLabel = `GYD ${Number(job?.deliveryFee ?? 0).toLocaleString()}`;
  const cust: any = job?.customer ?? job?.user ?? null;
  const custName = cust ? [cust.firstName, cust.lastName].filter(Boolean).join(' ') : null;
  const inProgress = String(job?.status ?? '').toUpperCase() === 'RIDE_IN_PROGRESS';
  const riderToDrop = !isDriver && pickedUp;
  const navTarget = inProgress || riderToDrop ? drop : pickup;
  const targetLabel = inProgress || riderToDrop ? 'drop-off' : 'pickup';
  const openNav = () => {
    if (!navTarget) return;
    const q = `${navTarget.latitude},${navTarget.longitude}`;
    Linking.openURL(`maps://?daddr=${q}`).catch(() => Linking.openURL(`https://maps.google.com/?daddr=${q}`));
  };
  const step = isDriver && job ? driverStep(job) : null;

  // Live distance/ETA to the CURRENT target (reference nav pill) — straight
  // GPS math via the shared street-pace estimator, never presented as routing.
  const me = latitude != null && longitude != null ? { latitude, longitude } : null;
  const distKm = navTarget && me ? haversineKm(me, navTarget) : null;
  const etaMin = navTarget && me ? streetEtaMin(me, navTarget) : null;

  const runDriverStep = () => {
    if (!step || !job) return;
    driverAct.mutate(
      { id: job.id, action: step.action, ...(step.pin ? { pin } : {}) },
      {
        onSuccess: () => {
          // Trip done → rate the passenger while it's fresh (DRIVER_TO_CUSTOMER).
          if (step.action === 'complete') {
            setStars(5);
            setRatePopup({ orderId: job.id, name: custName ?? 'your passenger', mmg: job.paymentMethod === 'MOBILE_MONEY' });
          }
        },
      },
    );
  };

  const closeRating = () => {
    setRatePopup(null);
    navigation?.goBack?.();
  };

  // The one big action at the bottom (reference "Arrived" button).
  const bigButton = (label: string, onPress: () => void, opts?: { disabled?: boolean; loading?: boolean; soft?: boolean }) => (
    <PillButton
      label={label}
      loading={opts?.loading}
      disabled={opts?.disabled}
      variant={opts?.soft ? 'outline' : 'primary'}
      onPress={onPress}
      style={{ minHeight: 56 }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: dk.bg }}>
      {job ? (
        <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} initialRegion={region} showsUserLocation>
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
                  {isMmgPaid ? '· MMG — already paid' : '· cash'}
                </T>
              </T>
              {/* Kitchen signal (readyAt rides outside the status lane once a
                  rider is assigned) — tells the rider the bag is on the counter. */}
              {!isDriver && (job.readyAt || String(job.status).toUpperCase() === 'READY_FOR_PICKUP') ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm }}>
                  <MaterialCommunityIcons name="check-circle" size={15} color={dk.success} />
                  <T variant="label" weight="semibold" style={{ color: dk.success }}>
                    Order is packed and ready for pickup
                  </T>
                </View>
              ) : null}
              <StatusStepper status={job.status} isDriver={isDriver} />
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
                  <Pressable onPress={() => Linking.openURL(`tel:${cust.phone}`)} hitSlop={6}>
                    {({ pressed }) => (
                      <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.cardSoft, marginRight: space.sm, opacity: pressed ? 0.7 : 1 }}>
                        <Feather name="phone" size={17} color={dk.success} />
                      </View>
                    )}
                  </Pressable>
                ) : null}
                <Pressable onPress={() => navigation.navigate('Chat', { orderId: job.id, title: custName ?? 'Customer' })} hitSlop={6}>
                  {({ pressed }) => (
                    <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.cardSoft, opacity: pressed ? 0.7 : 1 }}>
                      <Feather name="message-circle" size={17} color={dk.accent} />
                    </View>
                  )}
                </Pressable>
              </DCard>
            ) : null}

            {/* SOS — a driver alone with a stranger on a cash trip needs an
                emergency path too, not just the passenger. Taxi rides only (the
                /rides/:id/sos route authorizes the driver participant). */}
            {isDriver ? (
              <PillButton
                label="Emergency — get help now"
                variant="outline"
                icon="alert-triangle"
                style={{ marginBottom: space.md, borderColor: color.error }}
                onPress={() => setSosConfirm(true)}
              />
            ) : null}

            {/* Navigate */}
            {navTarget ? (
              <PillButton label={`Navigate to ${targetLabel}`} variant="outline" style={{ marginBottom: space.md }} onPress={openNav} />
            ) : null}

            {/* The single next step (driver) or handover/deliver (rider) */}
            {isDriver ? (
              step ? (
                <>
                  {step.pin ? (
                    <View style={{ marginBottom: space.md }}>
                      <LabeledInput value={pin} onChangeText={setPin} placeholder="Enter rider's PIN" keyboardType="number-pad" maxLength={6} />
                      <T variant="caption" style={{ color: dk.muted, marginTop: space.sm }}>
                        The passenger has this PIN in their app — verifying it proves you picked up the right person.
                      </T>
                    </View>
                  ) : null}
                  {bigButton(step.label, runDriverStep, { loading: busy, disabled: busy || (!!step.pin && pin.length < 4) })}
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
              bigButton(riderStep(job)!.label, () => riderAct.mutate({ id: job.id, action: riderStep(job)!.action }), {
                loading: riderAct.isPending,
                disabled: busy,
              })
            ) : isMmgPaid ? (
              <>
                {/* Customer paid the store via MMG — the door is a pure handover;
                    the rider's fee comes from the STORE (tracked in Earnings). */}
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(color.success, 0.12), borderWidth: 1, borderColor: withAlpha(color.success, 0.4), padding: space.md, marginBottom: space.md }}>
                  <Feather name="check-circle" size={15} color={dk.success} style={{ marginTop: 1 }} />
                  <T variant="caption" weight="semibold" style={{ flex: 1, color: dk.text }}>
                    {pickedUp
                      ? `Customer already paid via MMG — collect NOTHING at the door. Your ${feeLabel} fee comes from the store (see Earnings).`
                      : `Customer already paid via MMG. Collect your ${feeLabel} delivery fee from the store with the order.`}
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
              </>
            )}
          </BottomSheetScrollView>
        </BottomSheet>
      ) : null}

      {/* SOS confirm — deliberate two-step, then records the incident + pages
          ops AND dials local emergency (the same flow the passenger has). */}
      <PopupCard visible={sosConfirm} onClose={() => setSosConfirm(false)}>
        <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: color.error }}>
          <Feather name="alert-triangle" size={32} color={color.white} />
        </View>
        <T variant="title" center style={{ marginTop: space.lg }}>
          Get emergency help?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          This alerts Swift safety with your live location, then dials local emergency services. Use only in a real emergency.
        </T>
        <PillButton
          label="Yes — get help now"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          disabled={sos.isPending}
          onPress={() => {
            setSosConfirm(false);
            if (preview) return; // read-only preview never dials or records
            const coords = latitude != null && longitude != null ? { lat: latitude, lng: longitude } : undefined;
            if (job?.id) sos.mutate({ id: job.id, coords });
            // Guyana launch emergency number; move to CountryConfig for other markets.
            Linking.openURL('tel:911').catch(() => {});
          }}
        />
        <PillButton label="Close" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setSosConfirm(false)} />
      </PopupCard>

      {/* Post-trip passenger rating — DRIVER_TO_CUSTOMER, once per ride */}
      <PopupCard visible={!!ratePopup} onClose={closeRating}>
        <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[500] }}>
          <Feather name="check" size={34} color={color.white} />
        </View>
        <T variant="title" center style={{ marginTop: space.lg }}>
          Trip complete
        </T>
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
