/** @jsxImportSource react */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, View, useColorScheme, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, MarkerAnimated, PROVIDER_DEFAULT } from 'react-native-maps';
import Reanimated from 'react-native-reanimated';
import { rideMapProps } from '../../../kit/map-style';
import { useInterpolatedDriver } from '../map/useInterpolatedDriver';
import { STALE_AFTER_MS, type DriverPing } from '../map/interpolation';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { color, elevation, motion, radius, space } from '@swift/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useActiveRide, useRideEstimate, useRequestRide, useCancelRide, useRideSos, useRideAvailability, useWatchAvailability, useRideSupply, useQueueStatus, useJoinQueue, useLeaveQueue } from '../../../hooks';
import { connectSocket, getSocket, subscribeToOrder } from '../../../services/socket';
import { RidePostTripSheet } from '../RidePostTripSheet';
import { useLocationStore } from '../../../stores/locationStore';
import { useDeviceLocation } from '../../../hooks/useDeviceLocation';
import { grantedLocationFix, pickupLocationContext } from '../../../lib/deviceLocation';
import { LocationPrimerCard } from '../../../components/LocationPrimerCard';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';
import { haptic } from '../../../lib/haptics';
import { toast } from '../../../kit/toast';
import { safetyApi, type RideClass, type TierEstimate } from '../../../services/api';
import { CalmRadar, Card, CircleChip, Eyebrow, IconChip, LoadingBlock, Money, PillButton, Pictogram, type PictogramName, PinGlyph, PopupCard, PopupTitle, Stars, T, VehicleRender, cardShadow } from '../../../kit';
import { VERTICAL_TINT } from '../../../kit/vertical-tint';
import type { PickedPlace } from './DestinationSearchScreen';
import { openExternal } from '../../../lib/openExternal';
import { orderStatusLabel } from '../../../lib/orderStatus';

/**
 * The ride's status, in words — from `lib/orderStatus.ts`, the one authority.
 *
 * This screen used to carry its own five-entry copy, and it had already drifted:
 * a passenger read "Your driver has arrived" here and "Your driver is outside"
 * on Home, "On your trip" here and "On your way" there, "Finding your driver…"
 * here and "Finding you a driver" there — three of five words different for the
 * same ride, on two screens one tap apart. Neither was wrong; they just were
 * not the same, which is what a second vocabulary always becomes.
 *
 * The fallback matters as much as the words. The old one was 'Ride in
 * progress', which asserts the ride is UNDERWAY — a confident claim about a
 * status this app does not recognise, and false for every state before pickup.
 * The authority's fallback says "In progress" and nothing more.
 */
const rideStatusLabel = (status: string | null | undefined) => orderStatusLabel(status, 'TAXI');

const TAXI_TINT = VERTICAL_TINT.taxi ?? { bg: color.brand[50], ink: color.brand[600] };
const RIDE_PIN_LENGTH = 6;

const TIER_META: Record<RideClass, { label: string; icon: PictogramName; blurb: string }> = {
  ECONOMY: { label: 'Car', icon: 'sedan', blurb: 'Everyday rides' },
  COMFORT: { label: 'Estate', icon: 'estate', blurb: 'Extra legroom and boot space' },
  XL: { label: 'Van', icon: 'van', blurb: 'Room for people and bags' },
  GROUP: { label: 'Minibus', icon: 'bus', blurb: 'Groups, tours and airport runs' },
};

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

type LatLng = { latitude: number; longitude: number };

function validLatLng(latitudeRaw: unknown, longitudeRaw: unknown): LatLng | null {
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

function regionFor(pts: LatLng[]) {
  const lats = pts.map((p) => p.latitude);
  const lngs = pts.map((p) => p.longitude);
  return {
    latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
    longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    latitudeDelta: Math.max(0.02, (Math.max(...lats) - Math.min(...lats)) * 2.2),
    longitudeDelta: Math.max(0.02, (Math.max(...lngs) - Math.min(...lngs)) * 2.2),
  };
}

function FloatingBack({ navigation, insets }: any) {
  return (
    <View style={{ position: 'absolute', top: insets.top + space.sm, left: space['2xl'] }}>
      <CircleChip icon="chevron-left" label="Go back" onPress={() => navigation?.goBack?.()} />
    </View>
  );
}

// Marker language shared with courier: pickup = ink dot in a white ring,
// drop-off = brand location pin.
function PickupDot() {
  return (
    <View
      style={[
        { width: space.lg, height: space.lg, borderRadius: radius.full, backgroundColor: color.text.primary, borderWidth: space.xs / 2, borderColor: color.white },
        cardShadow,
      ]}
    />
  );
}
function DropPin() {
  return <PinGlyph size={34} color={color.brand[600]} />;
}

/** Route card: pickup dot → destination pin, two pressable rows. */
export function RouteCard({
  pickupLabel,
  dropoffLabel,
  onPickup,
  onDropoff,
  pickupTitle = 'Pickup',
  dropoffTitle = 'Where to?',
}: {
  pickupLabel?: string;
  dropoffLabel?: string;
  onPickup: () => void;
  onDropoff: () => void;
  pickupTitle?: string;
  dropoffTitle?: string;
}) {
  return (
    <Card>
      <Pressable
        onPress={onPickup}
        accessibilityRole="button"
        accessibilityLabel={`${pickupTitle}. ${pickupLabel ?? 'Set pickup location'}`}
        accessibilityHint="Opens location search"
        style={{ minHeight: space['5xl'], justifyContent: 'center' }}
      >
        {({ pressed }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
            <View style={{ width: space['2xl'], alignItems: 'center' }}>
              {/* [Wave 3 vs reference 11] The pickup glyph is the FILLED ink
                  square — the same ink language as the map's PickupDot — not
                  an outlined ring that reads as an unfilled state. */}
              <View style={{ width: space.md + space.xs, height: space.md + space.xs, borderRadius: radius.sm, backgroundColor: color.text.primary, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: space.xs + 1, height: space.xs + 1, backgroundColor: color.white }} />
              </View>
            </View>
            <View style={{ flex: 1, marginLeft: space.sm }}>
              <T variant="caption" tone="muted">
                {pickupTitle}
              </T>
              <T variant="body" weight="semibold" numberOfLines={1}>
                {pickupLabel ?? 'Set pickup location'}
              </T>
            </View>
          </View>
        )}
      </Pressable>
      <View style={{ marginLeft: space.md, height: space.lg, width: space.xs / 2, backgroundColor: color.border.subtle, marginVertical: space.xs }} />
      <Pressable
        onPress={onDropoff}
        accessibilityRole="button"
        accessibilityLabel={`${dropoffTitle}. ${dropoffLabel ?? 'Choose your destination'}`}
        accessibilityHint="Opens destination search"
        style={{ minHeight: space['5xl'], justifyContent: 'center' }}
      >
        {({ pressed }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
            <View style={{ width: space['2xl'], alignItems: 'center' }}>
              <PinGlyph size={18} color={color.brand[500]} />
            </View>
            <View style={{ flex: 1, marginLeft: space.sm }}>
              <T variant="caption" tone="muted">
                {dropoffTitle}
              </T>
              <T variant="body" weight="semibold" numberOfLines={1}>
                {dropoffLabel ?? 'Choose your destination'}
              </T>
            </View>
            <Feather name="search" size={18} color={color.text.muted} />
          </View>
        )}
      </Pressable>
    </Card>
  );
}

const SHEET_STYLE = { backgroundColor: color.surface.subtle, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl };
const HANDLE_STYLE = { width: space['4xl'], backgroundColor: color.border.strong };

// The driving marker [rides 6.3]: reanimated shared values sweep the car
// between pings on the UI thread — a GC mid-trip never stutters it.
const DrivingMarker = Reanimated.createAnimatedComponent(MarkerAnimated);

/** "Finding your driver" — two calm rings leave the real pickup pin. The
 *  server-owned PENDING state is the only claim: there are no fake cars,
 *  elapsed-time theatre or unsupported wait-time promises. The ring machinery
 *  is the kit's CalmRadar [Wave 3 part 2]; this keeps only the taxi facts. */
function SearchingCard() {
  return (
    <CalmRadar
      ink={TAXI_TINT.ink}
      center={
        <View style={{ width: space['4xl'], height: space['4xl'], borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: TAXI_TINT.bg }}>
          <PinGlyph size={22} color={TAXI_TINT.ink} />
        </View>
      }
      title="Finding your driver"
      caption="We’ll update this trip when a driver accepts."
    />
  );
}

export function TaxiScreen({ navigation }: any) {
  const { height: winH } = useWindowDimensions();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const { latitude, longitude, address, status: locationStatus } = useLocationStore();
  const { resolve: requestLocation } = useDeviceLocation({ refreshOnMount: false });
  const locationContext = pickupLocationContext(latitude, longitude, locationStatus);
  const { data: activeRide, isLoading: loadingActive } = useActiveRide<any>(true);
  const requestRide = useRequestRide();
  const cancelRide = useCancelRide();
  const qc = useQueryClient();

  // Post-trip closure: the ride that just completed, held so we can show the
  // rate + tip sheet after `useActiveRide` drops it (a completed ride is no
  // longer "active").
  const [completedRide, setCompletedRide] = useState<any>(null);
  const [rematching, setRematching] = useState(false);
  const activeRef = useRef<any>(null);
  activeRef.current = activeRide;

  // Make the ride feel LIVE: the order room already emits status changes (the
  // rider previously only saw them on the 8s poll). Listen so the status flips
  // instantly, and capture the ride on completion to close the loop.
  useEffect(() => {
    const id = activeRide?.id;
    if (!id) return;
    connectSocket();
    subscribeToOrder(id);
    const s = getSocket();
    const onStatus = (p: any) => {
      if (p?.orderId !== id) return;
      if (p?.status === 'DELIVERED' || p?.status === 'COMPLETED') {
        if (activeRef.current) setCompletedRide(activeRef.current);
      }
      // T18 continuity [rides spec 5.6/S-55]: a driver cancel keeps the SAME
      // trip and re-dispatches — the screen says so instead of pretending the
      // search just started. Clears the moment a new driver lands.
      if (p?.status === 'PENDING' && p?.reason === 'driver_cancelled') setRematching(true);
      else if (p?.status && p.status !== 'PENDING') setRematching(false);
      // The haptic map [rides spec Part 10]: match + arrival are the two
      // notification-success moments; code-verified trip start is the commit.
      if (navigation?.isFocused?.() !== false) {
        if (p?.status === 'DRIVER_ASSIGNED' || p?.status === 'DRIVER_ARRIVED') haptic.success();
        else if (p?.status === 'RIDE_IN_PROGRESS') haptic.commit();
        else if (p?.status === 'DELIVERED' || p?.status === 'COMPLETED') haptic.success();
      }
      qc.invalidateQueries({ queryKey: ['rides', 'active'] });
    };
    s.on('order:status_changed', onStatus);
    return () => {
      s.off('order:status_changed', onStatus);
    };
  }, [activeRide?.id, navigation, qc]);

  // Pickup defaults to live location; a manual override wins when set.
  const [pickupOverride, setPickupOverride] = useState<PickedPlace | undefined>();
  const [dropoff, setDropoff] = useState<PickedPlace | undefined>();
  const [selectedClass, setSelectedClass] = useState<RideClass>('ECONOMY');

  const livePickup = locationContext.devicePickup
    ? {
        lat: locationContext.devicePickup.latitude,
        lng: locationContext.devicePickup.longitude,
        label: address || locationContext.devicePickup.label,
      }
    : undefined;
  const pickup = pickupOverride ?? livePickup;

  const pickupCoordinate = pickup ? validLatLng(pickup.lat, pickup.lng) : null;
  const dropoffCoordinate = dropoff ? validLatLng(dropoff.lat, dropoff.lng) : null;
  const pickupPoint = pickupCoordinate ? { lat: pickupCoordinate.latitude, lng: pickupCoordinate.longitude } : undefined;
  const dropoffPoint = dropoffCoordinate ? { lat: dropoffCoordinate.latitude, lng: dropoffCoordinate.longitude } : undefined;

  const { data: estimate, isFetching: estimating } = useRideEstimate(pickupPoint, dropoffPoint);

  // Availability spec §2.1 (hooks live ABOVE the early returns — the active-ride
  // and loading branches must never change the hook order).
  const availability = useRideAvailability(pickupPoint);
  const watch = useWatchAvailability();
  // 5.5: honest counts for the chip + the queue that auto-requests. A queue
  // match creates a REAL ride server-side, so the active-ride poll flips the
  // screen; the push covers the backgrounded case.
  const supplyCounts = useRideSupply(pickupPoint);
  const queue = useQueueStatus();
  const joinQueue = useJoinQueue();
  const leaveQueue = useLeaveQueue();

  const openSearch = (onSelect: (p: PickedPlace) => void, title: string) =>
    navigation?.navigate?.('DestinationSearch', { onSelect, title });

  if (loadingActive) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
        <LoadingBlock />
      </View>
    );
  }

  if (activeRide) {
    return (
      <ActiveRide
        key={`${activeRide.id}:${activeRide.driver?.id ?? activeRide.driverId ?? 'searching'}`}
        navigation={navigation}
        ride={activeRide}
        cancelRide={cancelRide}
        insets={insets}
        rematching={rematching}
      />
    );
  }

  // ===== Request flow (idle → route chosen) =====
  const queued = !!queue.data;
  const pickupLL = pickupCoordinate ?? undefined;
  const dropoffLL = dropoffCoordinate ?? undefined;
  const mapCenter = {
    latitude: pickupLL?.latitude ?? locationContext.center.latitude,
    longitude: pickupLL?.longitude ?? locationContext.center.longitude,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
  };
  const routeRegion = !queued && pickupLL && dropoffLL ? regionFor([pickupLL, dropoffLL]) : mapCenter;

  const selectedTier = estimate?.tiers.find((t) => t.rideClass === selectedClass);
  const canRequest = !!pickupPoint && !!dropoffPoint && !!selectedTier;
  const requestVariables = requestRide.variables;
  const errorMatchesCurrentTrip = !!requestVariables
    && requestVariables.pickup.lat === pickupPoint?.lat
    && requestVariables.pickup.lng === pickupPoint?.lng
    && requestVariables.dropoff.lat === dropoffPoint?.lat
    && requestVariables.dropoff.lng === dropoffPoint?.lng
    && requestVariables.rideClass === selectedClass;
  const errBody = errorMatchesCurrentTrip ? (requestRide.error as any)?.response?.data : undefined;
  const errMsg = errBody?.error?.message ?? errBody?.message;
  // L2-before-first-ride (§5): the gate must open a door, never dead-end.
  const needsL2 = (errBody?.error?.code ?? errBody?.code) === 'ID_VERIFICATION_REQUIRED';

  // One coherent /supply snapshot owns visible counts, level and ETA. The
  // older /availability read contributes only its rollout gate.
  const counts = supplyCounts.data;
  const gated = availability.data?.gate === true;
  const supplyNone = (gated && counts?.level === 'NONE')
    || (errBody?.error?.code ?? errBody?.code) === 'NO_DRIVERS_NEARBY';
  const supplyLow = gated && !supplyNone && counts?.level === 'LOW';
  const watchMatchesPickup = watch.isSuccess
    && watch.variables?.lat === pickupPoint?.lat
    && watch.variables?.lng === pickupPoint?.lng;

  const tripPayload = () =>
    pickupPoint && dropoffPoint && pickup && dropoff
      ? {
          pickup: pickupPoint,
          dropoff: dropoffPoint,
          pickupAddress: pickup.label || 'Current location',
          dropoffAddress: dropoff.label || 'Drop-off',
          passengerCount: 1,
          rideClass: selectedClass,
        }
      : null;

  const onRequest = () => {
    const payload = tripPayload();
    if (payload) requestRide.mutate(payload);
  };

  // The supply chip [5.1/S-02..04]: one line answering "can I get a ride"
  // before any destination is typed. Real numbers only — never a guess.
  const nearestPickupEta = !counts || supplyNone || counts.level === 'NONE' || counts.online === 0 || counts.busy >= counts.online
    ? null
    : typeof counts.nearestEtaMinutes === 'number' && counts.nearestEtaMinutes > 0
      ? Math.round(counts.nearestEtaMinutes)
      : null;
  // The estimate contract has ONE server route duration, not a per-class
  // pickup ETA. Keep it global and call it a trip estimate; duplicating it on
  // every tier would falsely imply class-specific supply.
  const routeDurationMin = supplyNone || counts?.online === 0 || !estimate || estimate.durationMin <= 0
    ? null
    : estimate.durationMin;
  const supplyChip = !counts
    ? null
    : supplyNone || counts.level === 'NONE'
      ? counts.online === 0
        ? { label: 'No drivers online right now', tone: 'muted' as const }
        : counts.busy >= counts.online
          ? { label: `${counts.online} driver${counts.online === 1 ? '' : 's'} online — all on trips`, tone: 'muted' as const }
          : { label: 'No eligible driver near this pickup', tone: 'muted' as const }
      : counts.busy >= counts.online
        ? { label: `${counts.online} driver${counts.online === 1 ? '' : 's'} online — all on trips`, tone: 'muted' as const }
        : { label: `${counts.online - counts.busy} driver${counts.online - counts.busy === 1 ? '' : 's'} nearby`, tone: 'ink' as const };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        region={routeRegion}
        showsUserLocation={locationContext.showUserLocation}
        mapPadding={{ top: 0, left: 0, right: 0, bottom: Math.round(winH * 0.38) }}
        {...rideMapProps(scheme)}
      >
        {!queued && pickupLL ? (
          <Marker coordinate={pickupLL} title="Pickup" anchor={{ x: 0.5, y: 0.5 }}>
            <PickupDot />
          </Marker>
        ) : null}
        {!queued && dropoffLL ? (
          <Marker coordinate={dropoffLL} title="Drop-off" anchor={{ x: 0.5, y: 1 }}>
            <DropPin />
          </Marker>
        ) : null}
      </MapView>

      <FloatingBack navigation={navigation} insets={insets} />

      <BottomSheet
        index={0}
        snapPoints={['42%', '85%']}
        enableDynamicSizing={false}
        backgroundStyle={SHEET_STYLE}
        handleIndicatorStyle={HANDLE_STYLE}
      >
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}>
          {!pickupOverride && locationContext.showPrimer ? (
            <LocationPrimerCard
              status={locationStatus}
              onRequest={() => {
                void requestLocation();
              }}
              style={{ marginBottom: space.lg }}
            />
          ) : null}
          {queued ? (
            <Card>
              <T variant="title">Your queued trip is saved</T>
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                Its route and vehicle stay as they were when you joined. Leave the queue to choose a different trip.
              </T>
            </Card>
          ) : (
            <RouteCard
              pickupLabel={pickup?.label}
              dropoffLabel={dropoff?.label}
              onPickup={() => openSearch((p) => setPickupOverride(p), 'Pickup')}
              onDropoff={() => openSearch((p) => setDropoff(p), 'Where to?')}
            />
          )}

          {supplyChip && !queued ? (
            <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: space.md }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.xs,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                  borderRadius: radius.full,
                  backgroundColor: color.surface.sunken,
                }}
              >
                <View style={{ width: space.sm, height: space.sm, borderRadius: radius.full, backgroundColor: supplyChip.tone === 'ink' ? TAXI_TINT.ink : color.text.muted }} />
                <T variant="label" tone={supplyChip.tone === 'ink' ? 'ink' : 'muted'}>{supplyChip.label}</T>
              </View>
            </View>
          ) : null}

          {/* Tiers */}
          {queued ? null : dropoffPoint ? (
            <View style={{ marginTop: space.xl }}>
              {/* [Wave 3 vs reference 11] ONE heading, the Eyebrow — the
                  reference goes straight from "CHOOSE YOUR RIDE" to the tiers;
                  the extra "Pick your vehicle" title said the same thing twice.
                  The honest nearest-driver ETA keeps its place on the row. */}
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md, marginBottom: space.md }}>
                <Eyebrow accessibilityRole="header">Choose your ride</Eyebrow>
                {nearestPickupEta != null ? (
                  <T variant="caption" style={{ color: TAXI_TINT.ink }}>
                    Nearest driver · ~{nearestPickupEta} min
                  </T>
                ) : null}
              </View>
              {estimating && !estimate ? (
                <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Feather name="loader" size={16} color={color.text.muted} />
                  <T variant="body" tone="muted">
                    Calculating fares…
                  </T>
                </Card>
              ) : estimate ? (
                <>
                  {estimate.tiers.map((tier) => (
                    <TierRow
                      key={tier.rideClass}
                      tier={tier}
                      selected={tier.rideClass === selectedClass}
                      tripDurationMin={routeDurationMin}
                      onPress={() => setSelectedClass(tier.rideClass)}
                    />
                  ))}
                  <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
                    Fare estimate · cash to the driver{routeDurationMin != null ? ` · ~${routeDurationMin} min trip` : ''}.
                  </T>
                </>
              ) : (
                <Card>
                  <T variant="body" tone="muted">
                    Couldn&apos;t get a fare. Try another destination.
                  </T>
                </Card>
              )}
            </View>
          ) : (
            <T variant="label" tone="muted" style={{ marginTop: space.xl, paddingHorizontal: space.xs }}>
              Set your destination to see ride options and fixed fares.
            </T>
          )}

          {errMsg ? (
            <T variant="label" tone="error" center accessibilityLiveRegion="assertive" style={{ marginTop: space.lg }}>
              {errMsg}
            </T>
          ) : null}
          {needsL2 ? (
            <PillButton
              label="Verify your ID — takes a minute"
              variant="outline"
              style={{ marginTop: space.md }}
              onPress={() => navigation?.navigate?.('IdentityVerification')}
            />
          ) : null}

          {queue.data ? (
            // 5.5B — you're in line. A supply gap is a service, not an
            // apology: position is live, the stored trip stays intact, and
            // leaving is one tap. Brand accent —
            // queueing is service, never danger [3.1].
            <Card style={{ marginTop: space.lg, backgroundColor: color.brand[50], borderWidth: StyleSheet.hairlineWidth, borderColor: color.brand[500] }}>
              <T variant="title" tone="deep">You’re in line</T>
              <T variant="body" weight="semibold" style={{ marginTop: space.xs }}>
                {ordinal(queue.data.position)} in line
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                Your saved trip stays here until it matches, expires, or you leave. You can close this screen.
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                {queue.data.suppliersOnline} driver{queue.data.suppliersOnline === 1 ? '' : 's'} online — {queue.data.suppliersBusy} on trips right now
              </T>
              <PillButton
                label="Leave the queue"
                variant="outline"
                style={{ marginTop: space.md }}
                loading={leaveQueue.isPending}
                onPress={() => leaveQueue.mutate()}
              />
            </Card>
          ) : supplyNone ? (
            // 5.5A — the flagship fix: real counts, a queue, no apology.
            <Card style={{ marginTop: space.lg }}>
              <T variant="title">
                {(counts?.online ?? 0) === 0
                  ? 'No drivers online right now'
                  : (counts?.busy ?? 0) >= (counts?.online ?? 0)
                    ? 'All drivers are busy'
                    : 'No eligible driver available for this request'}
              </T>
              {counts ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  {counts.online} driver{counts.online === 1 ? '' : 's'} online near this pickup — {counts.busy} on trips right now
                </T>
              ) : null}
              <PillButton
                label="Join the queue"
                style={{ marginTop: space.md }}
                loading={joinQueue.isPending}
                disabled={!tripPayload()}
                onPress={() => {
                  const payload = tripPayload();
                  if (payload) {
                    if (!pickupOverride && pickup) setPickupOverride(pickup);
                    joinQueue.mutate(payload);
                  }
                }}
              />
              {!tripPayload() ? (
                <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
                  Set your destination first — we hold your whole trip in line.
                </T>
              ) : null}
              <PillButton
                label={watchMatchesPickup ? "We'll ping you — watching for drivers" : 'Notify me instead'}
                variant="outline"
                style={{ marginTop: space.sm }}
                loading={watch.isPending}
                disabled={watchMatchesPickup || !pickupPoint}
                onPress={() => pickupPoint && watch.mutate(pickupPoint)}
              />
            </Card>
          ) : (
            <>
              <PillButton
                label={selectedTier ? `Request ${TIER_META[selectedClass].label} · ${money(selectedTier.fare)}` : 'Request ride'}
                style={{ marginTop: space.lg }}
                loading={requestRide.isPending}
                disabled={!canRequest}
                onPress={onRequest}
              />
              {supplyLow ? (
                <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
                  Few drivers nearby — may take a little longer
                </T>
              ) : null}
              {!canRequest && dropoffPoint ? (
                <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
                  Pick a ride option to continue.
                </T>
              ) : null}
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheet>

      {/* Ride just ended → rate the driver + optional cash tip, then dismiss. */}
      <RidePostTripSheet ride={completedRide} onDone={() => setCompletedRide(null)} />
    </View>
  );
}

/** Kit selection card: soft brand tint + brand border when selected. */
function TierRow({
  tier,
  selected,
  tripDurationMin,
  onPress,
}: {
  tier: TierEstimate;
  selected: boolean;
  tripDurationMin: number | null;
  onPress: () => void;
}) {
  const meta = TIER_META[tier.rideClass];
  const accessibilityLabel = [
    meta.label,
    `${tier.capacity} seats`,
    tripDurationMin != null ? `about ${tripDurationMin} minute trip` : null,
    money(tier.fare),
  ].filter(Boolean).join(', ');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
    >
      {({ pressed }) => (
        <View
          style={[
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              minHeight: space['5xl'] * 2,
              marginBottom: space.md,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              borderRadius: radius.lg,
              borderWidth: selected ? space.xs / 2 : StyleSheet.hairlineWidth,
              borderColor: selected ? TAXI_TINT.ink : color.border.subtle,
              backgroundColor: selected ? TAXI_TINT.bg : color.surface.base,
              opacity: pressed ? 0.85 : 1,
            },
            !selected ? elevation.card : null,
          ]}
        >
          {/* Request classes use the kit's ONE side-view pictogram family.
              VehicleRender is reserved for an actual assigned vehicle. */}
          <View style={{ width: space['5xl'], height: space['5xl'], borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: TAXI_TINT.bg }}>
            <Pictogram name={meta.icon} size={32} color={TAXI_TINT.ink} />
          </View>
          <View style={{ flex: 1 }}>
            {/* [Wave 3 vs reference 11] The name stands alone in bold; seats
                join the sub-line ("4 seats · Extra legroom…"), exactly how the
                reference sets every tier's second line. */}
            <T variant="body" weight="semibold" style={selected ? { color: TAXI_TINT.ink } : undefined}>
              {meta.label}
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
              {tier.capacity} seats · {meta.blurb}
            </T>
          </View>
          <Money amount={tier.fare} style={selected ? { color: TAXI_TINT.ink } : undefined} />
        </View>
      )}
    </Pressable>
  );
}

function StartCodeCeremony({
  code,
  driverName,
  arrived,
  onWrongDriver,
}: {
  code: unknown;
  driverName?: string;
  arrived: boolean;
  onWrongDriver: () => void;
}) {
  const value = typeof code === 'string' ? code : '';
  const digits = /^\d+$/.test(value) && value.length === RIDE_PIN_LENGTH ? value.split('') : [];

  return (
    <View style={{ marginTop: space.lg, paddingTop: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border.subtle }}>
      <T variant="micro" tone="faint" center>Say this code to start the ride</T>
      {digits.length === RIDE_PIN_LENGTH ? (
        <View
          accessible
          accessibilityLabel={`Start code. ${digits.join(', ')}`}
          style={{ flexDirection: 'row', gap: space.xs, marginTop: space.md }}
        >
          {digits.map((digit, index) => (
            <View
              key={`${digit}-${index}`}
              style={{
                flex: 1,
                minHeight: space['5xl'],
                paddingVertical: space.xs,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.md,
                backgroundColor: color.brand[50],
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: color.brand[200],
              }}
            >
              <T variant="displayXl" tone="brand" maxFontSizeMultiplier={2} accessible={false}>
                {digit}
              </T>
            </View>
          ))}
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.soft.danger }}>
          <Feather name="alert-triangle" size={18} color={color.error} />
          <T variant="label" tone="error" style={{ flex: 1 }}>
            The six-digit start code isn’t available. Don’t begin the ride until it appears.
          </T>
        </View>
      )}
      <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
        It proves this is your ride — {driverName ?? 'the driver'} types it to start.
      </T>
      {arrived ? (
        <Pressable
          onPress={onWrongDriver}
          accessibilityRole="button"
          accessibilityLabel="This isn’t my driver"
          accessibilityHint="Reports that the car at the kerb does not match your ride"
          hitSlop={space.md}
          style={{ marginTop: space.sm, minHeight: space['5xl'], justifyContent: 'center' }}
        >
          <T variant="caption" center style={{ color: color.error, textDecorationLine: 'underline' }}>
            This isn’t my driver
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

function AssignedRideCard({
  ride,
  driver,
  status,
  legEta,
  showStartCode,
  onWrongDriver,
}: {
  ride: any;
  driver: any;
  status: string;
  legEta: number | null;
  showStartCode: boolean;
  onWrongDriver: () => void;
}) {
  const vehicle = [driver.vehicleColor, driver.vehicleMake, driver.vehicleModel].filter(Boolean).join(' ');
  const statusLabel = rideStatusLabel(status);
  const fare = ride.taxiFareTotal ?? ride.totalAmount;

  return (
    <Card>
      <T variant="micro" tone="faint">
        {statusLabel}{legEta != null ? legEta <= 0 ? ' · arriving now' : ` · ~${Math.round(legEta)} min` : ''}
      </T>

      {/* Plate-first safety culture: this is the first visual fact in the
          assigned card, ahead of face, vehicle detail and start code. */}
      {driver.licensePlate ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xs }}>
          <View style={{ flex: 1 }}>
            <T variant="displayXl" style={{ letterSpacing: space.xs }}>
              {driver.licensePlate}
            </T>
            <T variant="label" weight="semibold" style={{ color: TAXI_TINT.ink, marginTop: space.xs }}>
              Check the plate first
            </T>
          </View>
          <VehicleRender bodyType={driver.bodyType} colorHex={driver.colorHex} view="hero" size={96} />
        </View>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.soft.danger }}>
          <Feather name="alert-triangle" size={18} color={color.error} />
          <T variant="label" tone="error" style={{ flex: 1 }}>
            Plate details aren’t available. Don’t get in until the vehicle is confirmed.
          </T>
        </View>
      )}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg }}>
        {driver.user?.avatar ? (
          <Image
            source={{ uri: mediaUrl(driver.user.avatar) ?? undefined }}
            style={{ width: space['5xl'], height: space['5xl'], borderRadius: radius.full }}
            contentFit="cover"
            accessible={false}
          />
        ) : (
          <IconChip icon="user" size={48} />
        )}
        <View style={{ flex: 1 }}>
          <T variant="body" weight="semibold">{driver.user?.firstName ?? 'Your driver'}</T>
          <T variant="caption" tone="muted" numberOfLines={2} style={{ marginTop: space.xs }}>
            {vehicle || 'Vehicle details unavailable'}
          </T>
          {driver.displayRating != null ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs }}>
              <Stars value={Number(driver.displayRating)} size={11} />
              <T variant="caption" tone="muted">{Number(driver.displayRating).toFixed(1)}</T>
            </View>
          ) : <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>New on Swift</T>}
        </View>
        {driver.user?.phone ? (
          <PillButton
            label="Call"
            variant="soft"
            size="md"
            icon="phone"
            onPress={() => void openExternal(`tel:${driver.user.phone}`, "Couldn't start the call — dial your driver directly.")}
          />
        ) : null}
      </View>

      {showStartCode ? (
        <StartCodeCeremony
          code={ride.ridePin}
          driverName={driver.user?.firstName}
          arrived={status === 'DRIVER_ARRIVED'}
          onWrongDriver={onWrongDriver}
        />
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md, marginTop: space.lg, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border.subtle }}>
        <View style={{ flex: 1 }}>
          <T variant="micro" tone="faint">Fare · cash</T>
          <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
            Pay the driver directly.
          </T>
        </View>
        <Money amount={fare} size="l" />
      </View>
    </Card>
  );
}

function ActiveRide({ navigation, ride, cancelRide, insets, rematching }: any) {
  const { height: winH } = useWindowDimensions();
  const scheme = useColorScheme();
  const sheetRef = useRef<BottomSheet>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelRideError, setCancelRideError] = useState<string | null>(null);
  const [driverPing, setDriverPing] = useState<DriverPing | null>(null);
  const [guardianPrompt, setGuardianPrompt] = useState(false);
  const [guardianBusy, setGuardianBusy] = useState(false);
  const [confirmNotMyDriver, setConfirmNotMyDriver] = useState(false);
  const [notMyDriverBusy, setNotMyDriverBusy] = useState(false);
  /** [F-027-04] Non-null when the release did NOT go through. The sheet stays
   *  open on it, because the person is standing next to the wrong car. */
  const [notMyDriverError, setNotMyDriverError] = useState<string | null>(null);
  const [liveDriver, setLiveDriver] = useState<LatLng | null>(null);
  // Server-computed active-leg ETA riding the same stream [SWIFT-UG-RT-01].
  const [liveEtaMin, setLiveEtaMin] = useState<number | null>(null);
  // Live-tracking honesty: the car marker is only truthful while the GPS feed is
  // fresh. Track the heading (to rotate it) and WHEN the last fix landed, so a
  // dead feed (tunnel, dead battery, app killed) degrades instead of lying.
  const [lastFixAt, setLastFixAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [connLost, setConnLost] = useState(false);
  // Terminal dispatch outcome: the cascade tried every driver and found none.
  // Without this the rider sits on the "Contacting drivers…" spinner forever.
  const [exhausted, setExhausted] = useState(false);
  const [sosConfirm, setSosConfirm] = useState(false);
  const sos = useRideSos();
  const riderLoc = useLocationStore();
  const queryClient = useQueryClient();
  const mapRef = useRef<MapView>(null);
  const centeredFirstFix = useRef(false);
  const lastServerFixAt = useRef<number | null>(null);
  const d = ride.driver;
  // Live driver position: taxi rides are orders, so the order room streams
  // `driver:location` straight from the driver's GPS uploads. The undated REST
  // snapshot is intentionally ignored; only timestamped socket fixes render.
  useEffect(() => {
    if (!ride?.id) return;
    setLiveDriver(null);
    setDriverPing(null);
    setLastFixAt(null);
    setLiveEtaMin(null);
    setConnLost(false);
    lastServerFixAt.current = null;
    connectSocket();
    subscribeToOrder(ride.id);
    const s = getSocket();
    const onDriver = (p: any) => {
      if (p?.orderId !== ride.id || p?.driverId !== d?.id) return;
      const latitude = Number(p?.latitude);
      const longitude = Number(p?.longitude);
      const fixAt = typeof p?.timestamp === 'string' ? Date.parse(p.timestamp) : Number.NaN;
      if (
        !Number.isFinite(latitude)
        || !Number.isFinite(longitude)
        || Math.abs(latitude) > 90
        || Math.abs(longitude) > 180
        || !Number.isFinite(fixAt)
        || (lastServerFixAt.current != null && fixAt < lastServerFixAt.current)
      ) return;
      lastServerFixAt.current = fixAt;
      const receivedAt = Date.now();
      setLiveDriver({ latitude, longitude });
      setLastFixAt(receivedAt);
      // Feed the 6.3 sweep — the marker drives between these on the UI thread.
      setDriverPing({
        latitude,
        longitude,
        heading: typeof p?.heading === 'number' ? p.heading : null,
        receivedAt,
      });
      const etaMinutes = p?.etaMinutes;
      setLiveEtaMin(
        typeof etaMinutes === 'number' && Number.isFinite(etaMinutes) && etaMinutes >= 0
          ? etaMinutes
          : null,
      );
    };
    // socket.io auto-reconnects the transport, but the ORDER ROOM is per-
    // connection (joined only via order:subscribe), so after any blip a
    // "connected" socket silently stops receiving driver:location until we
    // re-subscribe. Re-join on every (re)connect and surface a banner while down.
    const onConnect = () => { setConnLost(false); subscribeToOrder(ride.id); };
    const onDisconnect = () => { setConnLost(true); setLiveEtaMin(null); };
    const onError = () => { setConnLost(true); setLiveEtaMin(null); };
    // Terminal exhaustion signal (backend emits it to the order room when the
    // cascade gives up) — flip the searching spinner to an honest dead state.
    const onExhausted = (p: any) => {
      if (p?.orderId === ride.id) setExhausted(true);
    };
    // Trip Guardian check-in [safety spec §5 / rides 12.2]: the ONE safety
    // engine prompts through the order room; the phone only renders and
    // responds — zero safety logic client-side.
    const onGuardianCheckin = (p: any) => {
      if (p?.orderId !== ride.id) return;
      setGuardianPrompt(true);
      if (navigation?.isFocused?.() !== false) haptic.warn();
    };
    s.on('driver:location', onDriver);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onError);
    s.on('dispatch:exhausted', onExhausted);
    s.on('guardian:checkin', onGuardianCheckin);
    return () => {
      s.off('driver:location', onDriver);
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('connect_error', onError);
      s.off('dispatch:exhausted', onExhausted);
      s.off('guardian:checkin', onGuardianCheckin);
      s.emit('order:unsubscribe', { orderId: ride.id });
    };
  }, [d?.id, navigation, ride?.id]);

  // THE CHECK-IN CARD MUST SURVIVE A CLOSED APP.
  //
  // Above, the card is raised by a live socket event. That is a nudge for a
  // phone already watching — and a passenger whose app was backgrounded or
  // killed when it fired, which is the exact case the push exists for, missed
  // it with nothing to raise it again. They were left holding a notification
  // asking "Everything OK on your trip?" and no way in the app to answer.
  // On a HARD check-in the silence has a server deadline, and the ladder
  // escalates when it passes: someone who tried to answer would be recorded as
  // someone who never did.
  //
  // So on arrival we ASK. The server decides — an already-answered or
  // escalated check-in returns null and no card appears, which a "show the
  // prompt" flag riding on the notification could not have got right.
  // Failure is silent: the socket path still works, and a safety card that
  // throws an error banner at someone mid-trip helps nobody.
  useEffect(() => {
    if (!ride?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await safetyApi.guardianOutstandingCheckin();
        const pending = res?.data?.data ?? null;
        if (cancelled || !pending) return;
        // Same-ride guard as the socket handler: a check-in belongs to one trip.
        if (pending.orderId !== ride.id) return;
        setGuardianPrompt(true);
        if (navigation?.isFocused?.() !== false) haptic.warn();
      } catch {
        // Offline or a failed read — the live event remains the other path in.
      }
    })();
    return () => { cancelled = true; };
  }, [navigation, ride?.id]);

  // A driver was found (or the search moved on) — clear any prior dead state so
  // the auto-re-dispatch that lands a driver flips the UI back to live tracking.
  useEffect(() => {
    if (d || String(ride.status ?? '').toUpperCase() !== 'PENDING') setExhausted(false);
  }, [d, ride.status]);

  // Ticking clock so the "is the fix stale?" check re-evaluates without a new
  // event — a DEAD feed sends nothing, so only a timer can notice the silence.
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 3000);
    return () => clearInterval(t);
  }, []);

  const pickup = validLatLng(ride.pickupLat, ride.pickupLng);
  const drop = validLatLng(ride.deliveryLat, ride.deliveryLng);
  const interp = useInterpolatedDriver(driverPing);

  // REST exposes an undated profile coordinate, so it can never be presented
  // as live. Only timestamped socket fixes earn a marker on this screen.
  const driverLoc = liveDriver;
  const fixStale = liveDriver != null && lastFixAt != null && nowTs - lastFixAt > STALE_AFTER_MS;
  const pts = [pickup, drop, driverLoc].filter(Boolean) as LatLng[];
  const hasMapContext = pts.length > 0;
  const region = useMemo(
    () => (pts.length ? regionFor(pts) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pickup?.latitude, pickup?.longitude, drop?.latitude, drop?.longitude, driverLoc?.latitude, driverLoc?.longitude],
  );

  const recenter = () => {
    const target = driverLoc ?? pickup ?? drop;
    if (target) mapRef.current?.animateToRegion({ ...target, latitudeDelta: 0.012, longitudeDelta: 0.012 }, motion.duration.gentle);
  };

  // Fit the first honest socket fix once. Later pings never override a pan;
  // the explicit re-center control is the only follow action after this.
  useEffect(() => {
    if (!driverLoc || centeredFirstFix.current || !mapRef.current) return;
    centeredFirstFix.current = true;
    const coordinates = [pickup, drop, driverLoc].filter(Boolean) as LatLng[];
    if (coordinates.length === 1) {
      mapRef.current.animateToRegion({ ...driverLoc, latitudeDelta: 0.02, longitudeDelta: 0.02 }, motion.duration.gentle);
      return;
    }
    mapRef.current.fitToCoordinates(coordinates, {
      edgePadding: {
        top: space['5xl'] * 2,
        bottom: space['5xl'] * 2,
        left: space['4xl'],
        right: space['4xl'],
      },
      animated: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverLoc?.latitude, driverLoc?.longitude]);

  const status = String(ride.status ?? '').toUpperCase();
  const arrived = status === 'DRIVER_ARRIVED';
  // Reset the streamed ETA when the leg changes so a pickup-leg number never
  // lingers into the dropoff leg. No client fallback fills that gap.
  useEffect(() => {
    setLiveEtaMin(null);
  }, [status]);
  // Active-leg ETA is a server socket fact. There is deliberately no
  // straight-line/device fallback.
  const legEta = !connLost && !fixStale && [
    'DRIVER_ASSIGNED',
    'DRIVER_EN_ROUTE',
  ].includes(status) ? liveEtaMin : null;
  const mapNotice = !d
    ? null
    : connLost
      ? driverLoc
        ? 'Reconnecting to the driver’s live location. Showing the last received position.'
        : 'Reconnecting to the driver’s live location. Waiting for the first GPS update.'
      : fixStale || interp.stale
        ? 'Driver location is paused. Showing the last received position.'
          : !driverLoc
          ? 'Waiting for the driver’s live location'
          : null;
  const freshDriverLoc = driverLoc && !connLost && !fixStale && !interp.stale ? driverLoc : null;
  const pinVerified = ride.ridePinVerified === true || ride.ridePinVerifiedAt != null;
  const showStartCode = !!d
    && ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'].includes(status)
    && !pinVerified;
  const canCancelRide = !pinVerified
    && ['PENDING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'].includes(status);

  useEffect(() => {
    if (!canCancelRide) {
      setConfirmCancel(false);
      setCancelRideError(null);
    }
  }, [canCancelRide]);

  const shareTrip = () => {
    const vehicle = [d?.vehicleColor, d?.vehicleMake, d?.vehicleModel].filter(Boolean).join(' ');
    const message = [
      status === 'RIDE_IN_PROGRESS' ? 'I’m on a Swift taxi ride.' : 'My Swift taxi ride.',
      d?.user?.firstName ? `Driver: ${d.user.firstName}${d?.displayRating != null ? ` (★${Number(d.displayRating).toFixed(1)})` : ' (New on Swift)'}` : null,
      vehicle ? `Vehicle: ${vehicle}` : null,
      d?.licensePlate ? `Plate: ${d.licensePlate}` : null,
      ride.pickupAddress ? `From: ${ride.pickupAddress}` : null,
      ride.deliveryAddress ? `To: ${ride.deliveryAddress}` : null,
      freshDriverLoc ? `Driver’s latest received position: https://maps.google.com/?q=${freshDriverLoc.latitude.toFixed(5)},${freshDriverLoc.longitude.toFixed(5)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    Share.share({ message }).catch(() => {});
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      {hasMapContext ? (
        <MapView
          ref={mapRef}
          provider={PROVIDER_DEFAULT}
          style={{ flex: 1 }}
          initialRegion={region!}
          mapPadding={{ top: 0, left: 0, right: 0, bottom: Math.round(winH * 0.46) }}
          {...rideMapProps(scheme)}
        >
        {pickup ? (
          <Marker coordinate={pickup} title="Pickup" anchor={{ x: 0.5, y: 0.5 }}>
            <PickupDot />
          </Marker>
        ) : null}
        {drop ? (
          <Marker coordinate={drop} title="Drop-off" anchor={{ x: 0.5, y: 1 }}>
            <DropPin />
          </Marker>
        ) : null}
        {interp.hasFix && driverLoc ? (
          // The 6.3 driving marker: position + bearing sweep between pings on
          // the UI thread (no teleporting); flat = rotates in the map plane.
          // The glyph IS the tinted top-view render (6B.5) — the car on the
          // map matches the card and the curb. Stale = frozen + dimmed; a
          // silent feed must never look like a live, moving car (0.8).
          <DrivingMarker
            animatedProps={interp.animatedProps as never}
            coordinate={driverLoc ?? { latitude: 0, longitude: 0 }}
            title="Driver"
            anchor={{ x: 0.5, y: 0.5 }}
            flat
          >
            <View style={{ opacity: interp.stale || fixStale || connLost ? 0.45 : 1 }}>
              <VehicleRender bodyType={d?.bodyType} colorHex={d?.colorHex} view="top" size={20} />
            </View>
          </DrivingMarker>
        ) : driverLoc ? (
          <Marker coordinate={driverLoc} title="Driver" anchor={{ x: 0.5, y: 0.5 }} flat>
            <View style={{ opacity: fixStale || connLost ? 0.45 : 1 }}>
              <VehicleRender bodyType={d?.bodyType} colorHex={d?.colorHex} view="top" size={20} />
            </View>
          </Marker>
        ) : null}
        </MapView>
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space['3xl'], backgroundColor: color.surface.sunken }}>
          <IconChip icon="map-pin" size={48} />
          <T variant="heading" center style={{ marginTop: space.md }}>Route map unavailable</T>
          <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
            Pickup and destination coordinates aren’t available for this ride.
          </T>
        </View>
      )}

      {/* An absent or stale fix is visible copy, never an undated marker. */}
      {mapNotice ? (
        <View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={mapNotice}
          style={{ position: 'absolute', top: insets.top + space.md, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: '78%', backgroundColor: color.soft.info, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.full, ...elevation.card }}
        >
          <Feather name={connLost ? 'wifi-off' : 'map-pin'} size={13} color={color.info} />
          <T variant="caption" tone="info" style={{ flexShrink: 1 }}>{mapNotice}</T>
        </View>
      ) : null}

      {/* Recenter on the driver — the map no longer auto-follows, so give the
          rider a one-tap way back to the car. */}
      {driverLoc ? (
        <Pressable
          onPress={recenter}
          accessibilityRole="button"
          accessibilityLabel={freshDriverLoc ? 'Recenter on driver' : 'Recenter on last driver location'}
          accessibilityHint={freshDriverLoc
            ? 'Moves the map to the driver’s latest live location'
            : 'Moves the map to the last location received from the driver'}
          style={{ position: 'absolute', right: space.lg, bottom: Math.round(winH * 0.48), width: space['5xl'], height: space['5xl'], borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base, ...elevation.card }}
          hitSlop={space.sm}
        >
          <Feather name="crosshair" size={21} color={color.text.primary} />
        </Pressable>
      ) : null}

      <FloatingBack navigation={navigation} insets={insets} />

      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={['54%', '90%']}
        enableDynamicSizing={false}
        backgroundStyle={SHEET_STYLE}
        handleIndicatorStyle={HANDLE_STYLE}
      >
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: insets.bottom + space['2xl'] }}>
          {d ? (
            <>
              {arrived ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, borderRadius: radius.lg, backgroundColor: color.brand[500], padding: space.lg, marginBottom: space.md }}>
                  <Pictogram name="taxi" size={30} color={color.white} />
                  <View style={{ flex: 1 }}>
                    <T variant="body" weight="bold" tone="onBrand">Your driver is here</T>
                    <T variant="caption" tone="onBrand" style={{ opacity: 0.9, marginTop: space.xs }}>
                      Meet them at the pickup point{d.licensePlate ? ` · look for ${d.licensePlate}` : ''}
                    </T>
                  </View>
                </View>
              ) : null}
              <AssignedRideCard
                ride={ride}
                driver={d}
                status={status}
                legEta={legEta}
                showStartCode={showStartCode}
                onWrongDriver={() => setConfirmNotMyDriver(true)}
              />
            </>
          ) : (
            <>
              <T variant="title">
                {rematching ? 'Finding you another driver' : rideStatusLabel(ride.status)}
              </T>
              <T variant="label" tone="muted" style={{ marginTop: space.xs }}>
                {ride.rideClass ? `${TIER_META[ride.rideClass as RideClass]?.label ?? ride.rideClass} · ` : ''}
                Fare {money(ride.taxiFareTotal ?? ride.totalAmount)} · cash to the driver
                {ride.taxiDuration ? ` · ~${Math.round(Number(ride.taxiDuration))} min trip` : ''}
              </T>
            </>
          )}

          {d ? null : exhausted ? (
            /* Terminal dead state — honest, not an endless spinner. */
            <View style={{ alignItems: 'center', paddingVertical: space.lg }}>
              <IconChip icon="alert-circle" size={52} tone="error" />
              <T variant="body" weight="semibold" center style={{ marginTop: space.md }}>
                No driver available right now
              </T>
              <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
                No driver accepted this request. You can keep waiting or cancel.
              </T>
            </View>
          ) : (
            <>
              {rematching ? (
                // T18/S-55: SAME trip, zero re-entry — say so while the radar
                // returns. The next assignment clears this automatically.
                <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
                  Your trip is unchanged — we&apos;re asking the nearest available driver now.
                </T>
              ) : null}
              <SearchingCard />
            </>
          )}

          {/* SOS — an active ride's most important control. Only while a driver
              is engaged (assigned → in progress); records the incident + pages
              ops AND dials local emergency services. */}
          {d ? (
            <PillButton
              label="Emergency — get help now"
              variant="outline"
              icon="alert-triangle"
              style={{ marginTop: space.xl, borderColor: color.error, alignSelf: 'stretch' }}
              onPress={() => setSosConfirm(true)}
            />
          ) : null}

          {/* Safety row: let someone you trust follow the trip */}
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.xl }}>
            <PillButton
              label="Share trip"
              variant="soft"
              icon="share-2"
              style={{ flex: 1 }}
              onPress={shareTrip}
            />
            {canCancelRide ? (
              <PillButton
                label="Cancel ride"
                variant="outline"
                style={{ flex: 1 }}
                loading={cancelRide.isPending}
                onPress={() => {
                  setCancelRideError(null);
                  setConfirmCancel(true);
                }}
              />
            ) : null}
          </View>
        </BottomSheetScrollView>
      </BottomSheet>

      {/* Kit confirm popup (kit 30-style) */}
      <PopupCard visible={confirmCancel} onClose={() => { if (!cancelRide.isPending) setConfirmCancel(false); }}>
        <IconChip icon="x-circle" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Cancel this ride?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {d
            ? arrived
              ? 'Your driver has arrived. Cancelling now may record a late-cancellation fee. Swift does not collect ride money.'
              : status === 'DRIVER_EN_ROUTE'
                ? 'Your driver is already on the way. Cancelling now may record a late-cancellation fee. Swift does not collect ride money.'
                : 'Your driver accepted the ride. Cancelling now may record a late-cancellation fee. Swift does not collect ride money.'
            : 'We’ll stop looking for a driver.'}
        </T>
        {cancelRideError ? (
          <T variant="body" tone="error" center accessibilityLiveRegion="assertive" style={{ marginTop: space.lg }}>
            {cancelRideError}
          </T>
        ) : null}
        <PillButton
          label={cancelRideError ? 'Try cancelling again' : 'Cancel ride'}
          variant="outline"
          icon="x-circle"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={cancelRide.isPending}
          onPress={() => {
            setCancelRideError(null);
            cancelRide.mutate(
              { id: ride.id },
              {
                onSuccess: (result: any) => {
                  const message = typeof result?.message === 'string' ? result.message : 'Ride cancelled.';
                  const fee = typeof result?.cancellationFee === 'number' && Number.isFinite(result.cancellationFee)
                    ? result.cancellationFee
                    : null;
                  toast.show(
                    message,
                    fee == null
                      ? 'The server confirmed the cancellation.'
                      : fee > 0
                        ? `The server recorded ${money(fee)}. Swift does not collect ride money.`
                        : 'The server confirmed no cancellation fee.',
                  );
                  setConfirmCancel(false);
                },
                onError: (error: any) => {
                  const serverMessage = error?.response?.data?.error?.message
                    ?? error?.response?.data?.message;
                  if (typeof serverMessage === 'string') {
                    setCancelRideError(serverMessage);
                  } else {
                    setConfirmCancel(false);
                    toast.show(
                      'Checking ride status',
                      'We couldn’t confirm the cancellation outcome. The active-ride poll is checking the server before you try again.',
                    );
                    void queryClient.invalidateQueries({ queryKey: ['rides', 'active'] });
                  }
                },
              },
            );
          }}
        />
        <PillButton
          label="Keep ride"
          variant="soft"
          disabled={cancelRide.isPending}
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          onPress={() => setConfirmCancel(false)}
        />
      </PopupCard>

      {/* SOS confirm — a deliberate two-step so it isn't triggered by accident,
          then records the incident + pages ops AND dials local emergency. */}
      <PopupCard visible={sosConfirm} onClose={() => setSosConfirm(false)}>
        <IconChip icon="alert-triangle" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Get emergency help?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          This dials 911 — local emergency services — right away. Swift also saves the alert and any available location on this trip’s record. Use only in a real emergency.
        </T>
        <PillButton
          label="Yes — get help now"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={sos.isPending}
          onPress={() => {
            setSosConfirm(false);
            // 911 is THE action — dial first, never behind anything else. Swift
            // records evidence; it is not an emergency responder and the copy
            // must never imply a staffed safety desk [liability shield].
            // Guyana launch emergency number; move to CountryConfig for other markets.
            void openExternal('tel:911', "Couldn't start the call — dial 911 directly.");
            // [F-028-08] Only a GRANTED fix may speak for the passenger.
            // The old existence check preferred persisted coordinates over
            // the LIVE driver position, so after a permission refusal an SOS
            // could page ops with wherever the phone last was — on the one
            // payload where a wrong location sends help to the wrong place.
            // Stale-but-granted beats nothing; live driver beats stale rider;
            // an honest "unknown" beats both when that is the truth.
            const riderFix = grantedLocationFix(riderLoc.latitude, riderLoc.longitude, riderLoc.status);
            const coords = riderFix
              ? { lat: riderFix.latitude, lng: riderFix.longitude }
              : freshDriverLoc
                ? { lat: freshDriverLoc.latitude, lng: freshDriverLoc.longitude }
                : undefined;
            sos.mutate(
              { id: ride.id, coords },
              {
                onError: () => {
                  toast.error(
                    'Swift could not save the SOS alert',
                    'The emergency call was still started. Tell the 911 operator where you are.',
                  );
                },
              },
            );
          }}
        />
        <PillButton label="Close" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setSosConfirm(false)} />
      </PopupCard>

      {/* "This isn't my driver" [safety spec / rides 5.7]: wrong person or
          car at the kerb — don't get in. The server releases the ride,
          re-dispatches the SAME trip, and locks the driver for review. */}
      <PopupCard visible={confirmNotMyDriver} onClose={() => setConfirmNotMyDriver(false)}>
        <IconChip icon="alert-triangle" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Not the person or car shown?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Don’t get in. We’ll cancel this pickup, alert Swift safety, and find you another driver — your trip stays exactly as it is.
        </T>
        {/* [F-027-04] The failure has to be visible. This used to swallow every
            error and close the sheet, so an offline phone, an expired session
            or a 5xx all looked exactly like success: the suspect driver stayed
            assigned while the customer — standing at the kerb next to the
            wrong car — was told we had cancelled and were finding another.
            "The poll reconciles either way" is only true when the server
            already committed and the response was lost. */}
        {notMyDriverError ? (
          <T variant="body" tone="error" center style={{ marginTop: space.lg }} accessibilityLiveRegion="assertive">
            {notMyDriverError}
          </T>
        ) : null}
        <PillButton
          label={notMyDriverError ? 'Try again' : 'Confirm — this isn’t my driver'}
          variant="destructive"
          style={{ alignSelf: 'stretch', marginTop: notMyDriverError ? space.lg : space['2xl'] }}
          loading={notMyDriverBusy}
          onPress={async () => {
            setNotMyDriverBusy(true);
            setNotMyDriverError(null);
            try {
              await safetyApi.notMyDriver(ride.id);
              haptic.warn();
              setNotMyDriverBusy(false);
              setConfirmNotMyDriver(false);
            } catch {
              // Stay open, stay explicit, and keep the instruction on screen.
              setNotMyDriverBusy(false);
              // Names a control that actually exists: "Emergency — get help
              // now" sits on the trip screen behind this sheet.
              setNotMyDriverError('We could NOT reach Swift — this driver has not been cancelled. Do not get in. Try again, or close this and use Emergency.');
            }
          }}
        />
        <PillButton label="Close" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmNotMyDriver(false)} />
      </PopupCard>

      {/* Trip Guardian check-in [safety spec §5]: the engine noticed something
          worth asking about (long stop, deviation) — one honest question,
          two honest answers. NEED_HELP escalates server-side. */}
      <PopupCard visible={guardianPrompt} onClose={() => setGuardianPrompt(false)}>
        <IconChip icon="shield" size={56} />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Everything okay?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Swift’s Trip Guardian checks in when a trip pauses or changes route. Your driver can’t see your answer.
        </T>
        <PillButton
          label="I’m okay"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={guardianBusy}
          onPress={async () => {
            setGuardianBusy(true);
            try {
              await safetyApi.guardianCheckin('OK');
            } catch {
              // [WR-006] The answer never reached the server — say so. The
              // sweep re-prompts an unanswered check-in, so this stays true.
              toast.show("Couldn't send that — Trip Guardian will check in again.");
            }
            setGuardianBusy(false);
            setGuardianPrompt(false);
          }}
        />
        <PillButton
          label="I need help"
          variant="destructive"
          style={{ alignSelf: 'stretch', marginTop: space.md }}
          loading={guardianBusy}
          onPress={async () => {
            setGuardianBusy(true);
            let sent = true;
            try {
              await safetyApi.guardianCheckin('NEED_HELP');
              haptic.warn();
            } catch {
              sent = false;
            }
            setGuardianBusy(false);
            setGuardianPrompt(false);
            if (!sent) {
              // [WR-006] The distress answer did NOT reach the server. The
              // sweep still escalates the unanswered check-in at its deadline,
              // but never pretend it was sent — say so and lead with SOS.
              toast.show("Your answer didn't send — if you need help, use SOS now.");
            }
            setSosConfirm(true); // the full emergency path is one tap away
          }}
        />
      </PopupCard>
    </View>
  );
}
