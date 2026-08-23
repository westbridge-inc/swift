/** @jsxImportSource react */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Linking, Pressable, Share, View, useColorScheme, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, MarkerAnimated, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import Reanimated from 'react-native-reanimated';
import { rideMapProps } from '../../../kit/map-style';
import { useInterpolatedDriver } from '../map/useInterpolatedDriver';
import type { DriverPing } from '../map/interpolation';
import BottomSheet, { BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useActiveRide, useRideEstimate, useRequestRide, useCancelRide, useRideSos, useRideAvailability, useWatchAvailability, useRideSupply, useQueueStatus, useJoinQueue, useLeaveQueue } from '../../../hooks';
import { connectSocket, getSocket, subscribeToOrder } from '../../../services/socket';
import { RidePostTripSheet } from '../RidePostTripSheet';
import { useLocationStore } from '../../../stores/locationStore';
import { useDeviceLocation } from '../../../hooks/useDeviceLocation';
import { grantedLocationFix, GEORGETOWN, pickupLocationContext } from '../../../lib/deviceLocation';
import { LocationPrimerCard } from '../../../components/LocationPrimerCard';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';
import { streetEtaMin } from '../../../lib/geo';
import { haptic } from '../../../lib/haptics';
import { safetyApi, type RideClass, type TierEstimate } from '../../../services/api';
import { Card, CircleChip, IconChip, LoadingBlock, Money, PillButton, Pictogram, type PictogramName, PinGlyph, PopupCard, PopupTitle, Stars, T, VehicleRender, type VehicleBodyType, cardShadow } from '../../../kit';
import type { PickedPlace } from './DestinationSearchScreen';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Finding your driver…',
  DRIVER_ASSIGNED: 'Driver assigned',
  DRIVER_EN_ROUTE: 'Driver on the way',
  DRIVER_ARRIVED: 'Your driver has arrived',
  RIDE_IN_PROGRESS: 'On your trip',
};

const TIER_META: Record<RideClass, { label: string; icon: PictogramName; blurb: string; body: VehicleBodyType }> = {
  ECONOMY: { label: 'Economy', icon: 'sedan', blurb: 'Affordable, everyday rides', body: 'SEDAN' },
  COMFORT: { label: 'Comfort', icon: 'estate', blurb: 'Newer cars, extra legroom', body: 'WAGON' },
  XL: { label: 'XL', icon: 'van', blurb: 'Seats up to 6', body: 'SUV' },
  GROUP: { label: 'Bus', icon: 'bus', blurb: 'Minibus — groups, tours & airport runs', body: 'MINIBUS' },
};

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

type LatLng = { latitude: number; longitude: number };

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
      <CircleChip icon="chevron-left" onPress={() => navigation?.goBack?.()} />
    </View>
  );
}

// Marker language shared with courier: pickup = ink dot in a white ring,
// drop-off = brand location pin.
function PickupDot() {
  return (
    <View
      style={[
        { width: 16, height: 16, borderRadius: 8, backgroundColor: color.text.primary, borderWidth: 3, borderColor: color.white },
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
      <Pressable onPress={onPickup}>
        {({ pressed }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
            <View style={{ width: 24, alignItems: 'center' }}>
              <View style={{ width: 11, height: 11, borderRadius: 6, borderWidth: 2.5, borderColor: color.text.muted }} />
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
      <View style={{ marginLeft: 11, height: 16, width: 2, backgroundColor: color.border.subtle, marginVertical: 4 }} />
      <Pressable onPress={onDropoff}>
        {({ pressed }) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', opacity: pressed ? 0.7 : 1 }}>
            <View style={{ width: 24, alignItems: 'center' }}>
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
const HANDLE_STYLE = { width: 44, backgroundColor: color.border.strong };

// The driving marker [rides 6.3]: reanimated shared values sweep the car
// between pings on the UI thread — a GC mid-trip never stutters it.
const DrivingMarker = Reanimated.createAnimatedComponent(MarkerAnimated);

/** "Finding your driver" — a live search deserves motion, not a static line:
 *  a breathing ring around a car mark + how long we've been looking. */
function SearchingCard({ startedAt }: { startedAt?: string }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const [, forceTick] = useState(0);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    // Elapsed-time ticker (1s) — reassurance that the search is alive.
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      loop.stop();
      clearInterval(t);
    };
  }, [pulse]);

  const ringStyle = (delay: number) => ({
    position: 'absolute' as const,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: color.brand[500],
    opacity: pulse.interpolate({ inputRange: [0, delay, 1], outputRange: [0.25, 0.18, 0] }),
    transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.1] }) }],
  });

  const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)) : null;
  const mm = elapsed != null ? Math.floor(elapsed / 60) : 0;
  const ss = elapsed != null ? elapsed % 60 : 0;

  return (
    <View style={{ alignItems: 'center', paddingVertical: space.lg }}>
      <View style={{ width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={ringStyle(0.5)} />
        <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[500] }}>
          <Pictogram name="taxi" size={32} color={color.white} />
        </View>
      </View>
      <T variant="body" weight="semibold" style={{ marginTop: space.lg }}>
        Contacting drivers near you…
      </T>
      <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
        {elapsed != null ? `Searching for ${mm}:${String(ss).padStart(2, '0')} · ` : ''}usually under a couple of minutes
      </T>
    </View>
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
      if (p?.orderId && p.orderId !== id) return;
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
      if (p?.status === 'DRIVER_ASSIGNED' || p?.status === 'DRIVER_ARRIVED') haptic.success();
      else if (p?.status === 'RIDE_IN_PROGRESS') haptic.commit();
      else if (p?.status === 'DELIVERED' || p?.status === 'COMPLETED') haptic.success();
      qc.invalidateQueries({ queryKey: ['rides', 'active'] });
    };
    s.on('order:status_changed', onStatus);
    return () => {
      s.off('order:status_changed', onStatus);
    };
  }, [activeRide?.id, qc]);

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

  const pickupPoint = pickup ? { lat: pickup.lat, lng: pickup.lng } : undefined;
  const dropoffPoint = dropoff ? { lat: dropoff.lat, lng: dropoff.lng } : undefined;

  const { data: estimate, isFetching: estimating } = useRideEstimate(pickupPoint, dropoffPoint);

  // Availability spec §2.1 (hooks live ABOVE the early returns — the active-ride
  // and loading branches must never change the hook order).
  const supply = useRideAvailability(pickupPoint);
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
    return <ActiveRide navigation={navigation} ride={activeRide} cancelRide={cancelRide} insets={insets} rematching={rematching} />;
  }

  // ===== Request flow (idle → route chosen) =====
  const mapCenter = {
    latitude: pickup?.lat ?? locationContext.center.latitude,
    longitude: pickup?.lng ?? locationContext.center.longitude,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
  };
  const pickupLL = pickup ? { latitude: pickup.lat, longitude: pickup.lng } : undefined;
  const dropoffLL = dropoff ? { latitude: dropoff.lat, longitude: dropoff.lng } : undefined;
  const routeRegion = pickupLL && dropoffLL ? regionFor([pickupLL, dropoffLL]) : mapCenter;

  const selectedTier = estimate?.tiers.find((t) => t.rideClass === selectedClass);
  const canRequest = !!pickupPoint && !!dropoffPoint && !!selectedTier;
  const errBody = (requestRide.error as any)?.response?.data;
  const errMsg = errBody?.error?.message ?? errBody?.message;
  // L2-before-first-ride (§5): the gate must open a door, never dead-end.
  const needsL2 = (errBody?.error?.code ?? errBody?.code) === 'ID_VERIFICATION_REQUIRED';

  // Availability spec §2.1: NONE → the request button becomes "Notify me";
  // LOW → a soft note. The UI only reshapes when the server's gate
  // (DISPATCH_AVAILABILITY) is on — flag off keeps today's screen
  // byte-identical. A 409 is the server speaking regardless.
  const gated = supply.data?.gate === true;
  const supplyNone = (gated && supply.data?.level === 'NONE')
    || (errBody?.error?.code ?? errBody?.code) === 'NO_DRIVERS_NEARBY';
  const supplyLow = gated && !supplyNone && supply.data?.level === 'LOW';

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
  const counts = supplyCounts.data;
  const supplyChip = !counts
    ? null
    : counts.online === 0
      ? { label: 'No drivers online right now', tone: 'muted' as const }
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
        {pickupLL ? (
          <Marker coordinate={pickupLL} title="Pickup" anchor={{ x: 0.5, y: 0.5 }}>
            <PickupDot />
          </Marker>
        ) : null}
        {dropoffLL ? (
          <Marker coordinate={dropoffLL} title="Drop-off" anchor={{ x: 0.5, y: 1 }}>
            <DropPin />
          </Marker>
        ) : null}
        {pickupLL && dropoffLL ? (
          <Polyline coordinates={[pickupLL, dropoffLL]} strokeColor={color.brand[500]} strokeWidth={4} />
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
          <RouteCard
            pickupLabel={pickup?.label}
            dropoffLabel={dropoff?.label}
            onPickup={() => openSearch((p) => setPickupOverride(p), 'Pickup')}
            onDropoff={() => openSearch((p) => setDropoff(p), 'Where to?')}
          />

          {supplyChip ? (
            <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: space.md }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.xs,
                  paddingHorizontal: space.md,
                  paddingVertical: 6,
                  borderRadius: radius.full,
                  backgroundColor: color.surface.sunken,
                }}
              >
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: supplyChip.tone === 'ink' ? color.success : color.text.muted }} />
                <T variant="label" tone={supplyChip.tone === 'ink' ? 'ink' : 'muted'}>{supplyChip.label}</T>
              </View>
            </View>
          ) : null}

          {/* Tiers */}
          {dropoffPoint ? (
            <View style={{ marginTop: space.xl }}>
              <T variant="heading" style={{ marginBottom: space.md }}>
                Choose a ride
              </T>
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
                      durationMin={estimate.durationMin}
                      onPress={() => setSelectedClass(tier.rideClass)}
                    />
                  ))}
                  <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
                    Fixed fare, locked before you book — no surge, pay cash.
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
            <T variant="label" tone="error" center style={{ marginTop: space.lg }}>
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
            // apology: position is live, the request fires automatically the
            // moment a driver frees, and leaving is one tap. Brand accent —
            // queueing is service, never danger [3.1].
            <Card style={{ marginTop: space.lg, backgroundColor: color.brand[50], borderWidth: 1, borderColor: color.brand[500] }}>
              <T variant="title" tone="deep">You’re in line</T>
              <T variant="body" weight="semibold" style={{ marginTop: space.xs }}>
                {ordinal(queue.data.position)} in line
              </T>
              <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                We’ll request automatically the moment a driver frees up. You can close the app — we’ll notify you.
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
              <T variant="title">{(counts?.online ?? 0) > 0 ? 'All drivers are busy' : 'No drivers online right now'}</T>
              {counts ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.xs }}>
                  {counts.online} driver{counts.online === 1 ? '' : 's'} online in Georgetown — {counts.busy} on trips right now
                </T>
              ) : null}
              <PillButton
                label="Join the queue"
                style={{ marginTop: space.md }}
                loading={joinQueue.isPending}
                disabled={!tripPayload()}
                onPress={() => {
                  const payload = tripPayload();
                  if (payload) joinQueue.mutate(payload);
                }}
              />
              {!tripPayload() ? (
                <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
                  Set your destination first — we hold your whole trip in line.
                </T>
              ) : null}
              <PillButton
                label={watch.isSuccess ? "We'll ping you — watching for drivers" : 'Notify me instead'}
                variant="outline"
                style={{ marginTop: space.sm }}
                loading={watch.isPending}
                disabled={watch.isSuccess || !pickupPoint}
                onPress={() => pickupPoint && watch.mutate(pickupPoint)}
              />
              {(counts?.online ?? 0) > 0 ? (
                // Try-anyway exists ONLY when someone is actually online —
                // a search against an empty set is theater [0.8].
                <T
                  variant="caption"
                  tone="muted"
                  center
                  style={{ marginTop: space.md, textDecorationLine: 'underline' }}
                  onPress={() => canRequest && !requestRide.isPending && onRequest()}
                >
                  Try now anyway — drivers sometimes come online mid-search
                </T>
              ) : null}
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
  durationMin,
  onPress,
}: {
  tier: TierEstimate;
  selected: boolean;
  durationMin: number;
  onPress: () => void;
}) {
  const meta = TIER_META[tier.rideClass];
  return (
    <Pressable onPress={onPress}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            marginBottom: space.md,
            paddingHorizontal: space.lg,
            paddingVertical: space.md,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: selected ? color.brand[500] : color.border.subtle,
            backgroundColor: selected ? color.brand[50] : color.surface.base,
            opacity: pressed ? 0.85 : 1,
          }}
        >
          {/* The class reads visually before a word is read [5.3]: the same
              construction system that renders the assigned car (6B.5). */}
          <VehicleRender bodyType={meta.body} view="hero" size={82} />
          <View style={{ flex: 1 }}>
            <T variant="body" weight="semibold" tone={selected ? 'deep' : 'ink'}>
              {meta.label} <T variant="label" tone="muted">· {tier.capacity} seats</T>
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {/* [F-268] "~0 min" with zero drivers online was a dishonest
                  number on a money row. No estimate ⇒ say nothing; the
                  "No drivers online" banner already carries the truth. */}
              {meta.blurb}{durationMin > 0 ? ` · ~${durationMin} min` : ''}
            </T>
          </View>
          <Money amount={tier.fare} tone={selected ? 'brand' : 'ink'} />
        </View>
      )}
    </Pressable>
  );
}

function ActiveRide({ navigation, ride, cancelRide, insets, rematching }: any) {
  const { height: winH } = useWindowDimensions();
  const scheme = useColorScheme();
  const sheetRef = useRef<BottomSheet>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
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
  const [driverHeading, setDriverHeading] = useState<number | null>(null);
  const [lastFixAt, setLastFixAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [connLost, setConnLost] = useState(false);
  // Terminal dispatch outcome: the cascade tried every driver and found none.
  // Without this the rider sits on the "Contacting drivers…" spinner forever.
  const [exhausted, setExhausted] = useState(false);
  const [sosConfirm, setSosConfirm] = useState(false);
  const sos = useRideSos();
  const riderLoc = useLocationStore();
  const mapRef = useRef<MapView>(null);
  const d = ride.driver;
  // The server streams a fix at least every ~10s; past this we treat the marker
  // as stale rather than a live position.
  const FIX_STALE_MS = 12_000;

  // Live driver position: taxi rides are orders, so the order room streams
  // `driver:location` straight from the driver's GPS uploads. The REST
  // snapshot (driver.currentLat) seeds the marker until the first event.
  useEffect(() => {
    if (!ride?.id) return;
    connectSocket();
    subscribeToOrder(ride.id);
    const s = getSocket();
    const onDriver = (p: any) => {
      if (p?.latitude != null && p?.longitude != null) {
        setLiveDriver({ latitude: Number(p.latitude), longitude: Number(p.longitude) });
        setLastFixAt(Date.now());
        if (typeof p?.heading === 'number') setDriverHeading(p.heading);
        // Feed the 6.3 sweep — the marker drives between these on the UI thread.
        setDriverPing({
          latitude: Number(p.latitude),
          longitude: Number(p.longitude),
          heading: typeof p?.heading === 'number' ? p.heading : null,
          receivedAt: Date.now(),
        });
      }
      if (typeof p?.etaMinutes === 'number') setLiveEtaMin(p.etaMinutes);
    };
    // socket.io auto-reconnects the transport, but the ORDER ROOM is per-
    // connection (joined only via order:subscribe), so after any blip a
    // "connected" socket silently stops receiving driver:location until we
    // re-subscribe. Re-join on every (re)connect and surface a banner while down.
    const onConnect = () => { setConnLost(false); subscribeToOrder(ride.id); };
    const onDisconnect = () => setConnLost(true);
    const onError = () => setConnLost(true);
    // Terminal exhaustion signal (backend emits it to the order room when the
    // cascade gives up) — flip the searching spinner to an honest dead state.
    const onExhausted = () => setExhausted(true);
    // Trip Guardian check-in [safety spec §5 / rides 12.2]: the ONE safety
    // engine prompts through the order room; the phone only renders and
    // responds — zero safety logic client-side.
    const onGuardianCheckin = () => { setGuardianPrompt(true); haptic.warn(); };
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
    };
  }, [ride?.id]);

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

  const pickup = ride.pickupLat != null ? { latitude: Number(ride.pickupLat), longitude: Number(ride.pickupLng) } : null;
  const drop =
    ride.deliveryLat != null ? { latitude: Number(ride.deliveryLat), longitude: Number(ride.deliveryLng) } : null;
  // Seed the sweep from the payload's last-known position, so the car exists
  // before the first live ping — the stale clock marks it honestly if no
  // stream follows (the seed is the server's memory, not a live fix).
  const d0 = ride?.driver;
  useEffect(() => {
    if (!driverPing && d0?.currentLat != null && d0?.currentLng != null) {
      setDriverPing({ latitude: Number(d0.currentLat), longitude: Number(d0.currentLng), heading: null, receivedAt: Date.now() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d0?.currentLat, d0?.currentLng]);
  const interp = useInterpolatedDriver(driverPing);

  const driverLoc =
    liveDriver ?? (d?.currentLat != null ? { latitude: Number(d.currentLat), longitude: Number(d.currentLng) } : null);
  // The live feed is only trustworthy while fresh. Once we've had a live fix and
  // it ages out, the car is frozen at its last point — degrade the marker + ETA
  // instead of confidently showing a stationary car with a shrinking ETA.
  const fixStale = liveDriver != null && lastFixAt != null && nowTs - lastFixAt > FIX_STALE_MS;
  const pts = [pickup, drop, driverLoc].filter(Boolean) as LatLng[];
  const region = useMemo(() => (pts.length ? regionFor(pts) : GEORGETOWN_REGION), [ride]); // eslint-disable-line react-hooks/exhaustive-deps

  const recenter = () => {
    const target = driverLoc ?? pickup ?? drop;
    if (target) mapRef.current?.animateToRegion({ ...target, latitudeDelta: 0.012, longitudeDelta: 0.012 }, 350);
  };

  const status = String(ride.status ?? '').toUpperCase();
  const arrived = status === 'DRIVER_ARRIVED';
  // Reset the streamed ETA when the leg changes so a pickup-leg number never
  // lingers into the dropoff leg (the fallback fills the gap until the next
  // server refresh).
  useEffect(() => {
    setLiveEtaMin(null);
  }, [status]);
  // Live leg ETA [SWIFT-UG-RT-01]: the server refreshes etaMinutes on the
  // driver:location stream (road-routed when OSRM is live) — pickup leg
  // before the ride starts, dropoff leg during it. The straight-line
  // estimate stays as the fallback until the first event lands.
  const legEtaRaw =
    status === 'DRIVER_ASSIGNED' || status === 'DRIVER_EN_ROUTE'
      ? (liveEtaMin ?? (driverLoc && pickup ? streetEtaMin(driverLoc, pickup) : null))
      : status === 'RIDE_IN_PROGRESS'
        ? (liveEtaMin ?? (driverLoc && drop ? streetEtaMin(driverLoc, drop) : null))
        : null;
  // A stale fix would recompute a fake shrinking ETA off the frozen coordinate —
  // suppress it so the UI shows "Updating…" rather than a confident lie.
  const legEta = fixStale ? null : legEtaRaw;

  const shareTrip = () => {
    const vehicle = [d?.vehicleColor, d?.vehicleMake, d?.vehicleModel].filter(Boolean).join(' ');
    const message = [
      'I’m on a Swift taxi ride.',
      d?.user?.firstName ? `Driver: ${d.user.firstName}${d?.averageRating ? ` (★${Number(d.averageRating).toFixed(1)})` : ''}` : null,
      vehicle ? `Vehicle: ${vehicle}` : null,
      d?.licensePlate ? `Plate: ${d.licensePlate}` : null,
      ride.pickupAddress ? `From: ${ride.pickupAddress}` : null,
      ride.deliveryAddress ? `To: ${ride.deliveryAddress}` : null,
      driverLoc ? `Live position: https://maps.google.com/?q=${driverLoc.latitude.toFixed(5)},${driverLoc.longitude.toFixed(5)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    Share.share({ message }).catch(() => {});
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        region={region}
        mapPadding={{ top: 0, left: 0, right: 0, bottom: Math.round(winH * 0.34) }}
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
        {interp.hasFix ? (
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
            <View style={{ opacity: interp.stale || fixStale ? 0.45 : 1 }}>
              <VehicleRender bodyType={d?.bodyType} colorHex={d?.colorHex} view="top" size={20} />
            </View>
          </DrivingMarker>
        ) : driverLoc ? (
          <Marker coordinate={driverLoc} title="Driver" anchor={{ x: 0.5, y: 0.5 }} flat rotation={driverHeading ?? 0}>
            <View
              style={[
                { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.text.primary, opacity: fixStale ? 0.4 : 1 },
                cardShadow,
              ]}
            >
              <Feather name="navigation" size={17} color={color.white} />
            </View>
          </Marker>
        ) : null}
      </MapView>

      {/* Live-feed honesty banner: reconnecting (socket down) or updating (fix
          aged out). Silence must never look like a live, moving car. */}
      {(connLost || fixStale || interp.stale) ? (
        <View style={{ position: 'absolute', top: insets.top + space.md, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: color.text.primary, paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.full, ...cardShadow }}>
          <Feather name={connLost ? 'wifi-off' : 'loader'} size={13} color={color.white} />
          <T variant="caption" style={{ color: color.white }}>
            {connLost
              ? 'Reconnecting…'
              : interp.stale && interp.staleAgeS > 0
                ? `Location last updated ${interp.staleAgeS}s ago`
                : 'Updating driver location…'}
          </T>
        </View>
      ) : null}

      {/* Recenter on the driver — the map no longer auto-follows, so give the
          rider a one-tap way back to the car. */}
      {driverLoc ? (
        <Pressable
          onPress={recenter}
          style={{ position: 'absolute', right: space.lg, bottom: Math.round(winH * 0.36), width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base, ...cardShadow }}
          hitSlop={8}
        >
          <Feather name="crosshair" size={21} color={color.text.primary} />
        </Pressable>
      ) : null}

      <FloatingBack navigation={navigation} insets={insets} />

      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={['38%', '70%']}
        enableDynamicSizing={false}
        backgroundStyle={SHEET_STYLE}
        handleIndicatorStyle={HANDLE_STYLE}
      >
        <BottomSheetView style={{ paddingHorizontal: space['2xl'], paddingBottom: space['2xl'] }}>
          {arrived ? (
            /* The kerb moment — loud on purpose so it isn't missed in-pocket. */
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, borderRadius: radius.lg, backgroundColor: color.brand[500], padding: space.lg, marginBottom: space.sm }}>
              <Pictogram name="taxi" size={30} color={color.white} />
              <View style={{ flex: 1 }}>
                <T variant="body" weight="bold" tone="onBrand">
                  Your driver is here
                </T>
                <T variant="caption" tone="onBrand" style={{ opacity: 0.9, marginTop: 2 }}>
                  Meet them at the pickup point{d?.licensePlate ? ` · look for ${d.licensePlate}` : ''}
                </T>
              </View>
            </View>
          ) : (
            <T variant="title">
              {ride.status === 'PENDING' && rematching
                ? 'Your driver had to cancel — finding you another'
                : STATUS_LABEL[ride.status] ?? 'On the way'}
              {fixStale ? ' · locating…' : legEta != null ? ` · ~${legEta} min` : ''}
            </T>
          )}
          <T variant="label" tone="muted" style={{ marginTop: 4 }}>
            {ride.rideClass ? `${TIER_META[ride.rideClass as RideClass]?.label ?? ride.rideClass} · ` : ''}
            Fare {money(ride.taxiFareTotal ?? ride.totalAmount)} · cash
            {ride.taxiDuration ? ` · ~${Math.round(Number(ride.taxiDuration))} min trip` : ''}
          </T>
          {ride.ridePin && ride.status === 'DRIVER_ARRIVED' ? (
            // THE SIGNATURE MOMENT [rides spec 5.7]: the code handshake as a
            // trust ceremony. The find-your-car pairing (tinted render + the
            // plate) sits above the code; the instruction names the driver;
            // the safety nudge closes it. Everything else stays quiet.
            <View
              style={{
                alignItems: 'center',
                backgroundColor: color.brand[50],
                borderRadius: radius.lg,
                paddingVertical: space.lg,
                paddingHorizontal: space.lg,
                marginTop: space.md,
                borderWidth: 1,
                borderColor: color.brand[500],
              }}
            >
              {d ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.sm }}>
                  <VehicleRender bodyType={d.bodyType} colorHex={d.colorHex} view="hero" size={96} />
                  {d.licensePlate ? (
                    <View style={{ paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.md, borderWidth: 1.5, borderColor: color.text.primary, backgroundColor: color.surface.base }}>
                      <T variant="numM" style={{ letterSpacing: 2 }}>{d.licensePlate}</T>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <T variant="micro" tone="muted">Your start code</T>
              <T variant="displayXl" tone="brand" style={{ letterSpacing: 6, marginTop: 2 }}>
                {ride.ridePin}
              </T>
              <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
                Give this code to {d?.user?.firstName ?? 'your driver'} to start your ride
              </T>
              <T variant="label" weight="semibold" center style={{ marginTop: space.sm }}>
                Check the plate before you get in
              </T>
              {/* [F-243/F-244] The wrong-car escape hatch. As a bare <T
                  onPress> a screen reader announced it as static text and the
                  tap area was the ~18pt line box — the least reachable control
                  in the app, on the one screen where reaching it matters. */}
              <Pressable
                onPress={() => setConfirmNotMyDriver(true)}
                accessibilityRole="button"
                accessibilityLabel="This isn’t my driver"
                accessibilityHint="Reports that the car at the kerb does not match your ride"
                hitSlop={12}
                style={{ marginTop: space.sm, minHeight: 44, justifyContent: 'center' }}
              >
                <T variant="caption" center style={{ color: color.error, textDecorationLine: 'underline' }}>
                  This isn’t my driver
                </T>
              </Pressable>
            </View>
          ) : ride.ridePin ? (
            <View
              style={{
                alignItems: 'center',
                backgroundColor: color.brand[50],
                borderRadius: radius.lg,
                paddingVertical: space.md,
                marginTop: space.md,
              }}
            >
              <T variant="micro" tone="muted">
                Start code — show to your driver
              </T>
              <T variant="displayXl" tone="brand" style={{ letterSpacing: 6, marginTop: 2 }}>
                {ride.ridePin}
              </T>
            </View>
          ) : null}

          {d ? (
            <Card style={{ marginTop: space.lg }}>
              {/* THE PLATE-FIRST HANDSHAKE (design-100×): the plate is what you
                  match at the kerb — it leads, in numL, before any face. */}
              {d.licensePlate ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md }}>
                  <View
                    style={{
                      paddingHorizontal: space.lg,
                      paddingVertical: space.sm,
                      borderRadius: radius.md,
                      borderWidth: 1.5,
                      borderColor: color.text.primary,
                    }}
                  >
                    <T variant="numL" style={{ letterSpacing: 3 }}>
                      {d.licensePlate}
                    </T>
                  </View>
                  <View style={{ flex: 1 }}>
                    <T variant="caption" tone="muted">
                      Match this plate before you get in.
                    </T>
                  </View>
                  {/* Shape + tint before reading [6B.5]: the SAME render as the
                      fare card and the map — a white Allion LOOKS like a white
                      sedan from across the street. Real photo when we have it,
                      the tinted body-type render otherwise. */}
                  {d.vehiclePhotoUrl ? (
                    <Image
                      source={{ uri: mediaUrl(d.vehiclePhotoUrl) ?? undefined }}
                      style={{ width: 72, height: 46, borderRadius: radius.md }}
                      contentFit="cover"
                    />
                  ) : (
                    <VehicleRender bodyType={d.bodyType} colorHex={d.colorHex} view="hero" size={78} />
                  )}
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                {d.user?.avatar ? (
                  <Image
                    source={{ uri: mediaUrl(d.user.avatar) ?? undefined }}
                    style={{ width: 44, height: 44, borderRadius: 22 }}
                    contentFit="cover"
                  />
                ) : (
                  <IconChip icon="user" size={44} />
                )}
                <View style={{ flex: 1 }}>
                  <T variant="body" weight="semibold">
                    {d.user?.firstName ?? 'Your driver'}
                  </T>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <T variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
                      {[d.vehicleColor, d.vehicleMake, d.vehicleModel].filter(Boolean).join(' ')}
                    </T>
                    {d.displayRating != null || d.averageRating ? (
                      <>
                        <Stars value={Number(d.displayRating ?? d.averageRating)} size={11} />
                        <T variant="caption" tone="muted">
                          {Number(d.displayRating ?? d.averageRating).toFixed(1)}
                        </T>
                      </>
                    ) : null}
                  </View>
                </View>
                {d.user?.phone ? (
                  <PillButton
                    label="Call"
                    variant="soft"
                    size="sm"
                    icon="phone"
                    onPress={() => Linking.openURL(`tel:${d.user.phone}`).catch(() => {})}
                  />
                ) : null}
              </View>
            </Card>
          ) : exhausted ? (
            /* Terminal dead state — honest, not an endless spinner. The backend
               keeps re-sweeping every minute, so "still trying" is true; the
               rider can also bail without waiting. */
            <View style={{ alignItems: 'center', paddingVertical: space.lg }}>
              <IconChip icon="alert-circle" size={52} tone="error" />
              <T variant="body" weight="semibold" center style={{ marginTop: space.md }}>
                No driver available right now
              </T>
              <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
                We&apos;re still trying every minute as drivers come online. You can keep waiting or cancel.
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
              <SearchingCard startedAt={ride.placedAt ?? ride.createdAt} />
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
            <PillButton
              label="Cancel ride"
              variant="outline"
              style={{ flex: 1 }}
              loading={cancelRide.isPending}
              onPress={() => setConfirmCancel(true)}
            />
          </View>
        </BottomSheetView>
      </BottomSheet>

      {/* Kit confirm popup (kit 30-style) */}
      <PopupCard visible={confirmCancel} onClose={() => setConfirmCancel(false)}>
        <IconChip icon="x-circle" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Cancel this ride?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {d
            ? 'Your driver is already on the way. Cancelling now may charge a late-cancellation fee and lower your reliability rating.'
            : 'We’ll stop looking for a driver.'}
        </T>
        <PillButton
          label="Cancel ride"
          variant="destructive"
          icon="x-circle"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={cancelRide.isPending}
          onPress={() => {
            setConfirmCancel(false);
            cancelRide.mutate({ id: ride.id });
          }}
        />
        <PillButton label="Keep ride" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setConfirmCancel(false)} />
      </PopupCard>

      {/* SOS confirm — a deliberate two-step so it isn't triggered by accident,
          then records the incident + pages ops AND dials local emergency. */}
      <PopupCard visible={sosConfirm} onClose={() => setSosConfirm(false)}>
        <IconChip icon="alert-triangle" size={56} tone="error" />
        <PopupTitle variant="title" center style={{ marginTop: space.lg }}>
          Get emergency help?
        </PopupTitle>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          This dials 911 — local emergency services — right away. Swift also saves the alert and your live location on this trip’s record. Use only in a real emergency.
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
            Linking.openURL('tel:911').catch(() => {});
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
              : driverLoc
                ? { lat: driverLoc.latitude, lng: driverLoc.longitude }
                : undefined;
            sos.mutate({ id: ride.id, coords });
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
            try { await safetyApi.guardianCheckin('OK'); } catch { /* sweep re-prompts if unanswered */ }
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
            try { await safetyApi.guardianCheckin('NEED_HELP'); haptic.warn(); } catch { /* escalation also rides the sweep */ }
            setGuardianBusy(false);
            setGuardianPrompt(false);
            setSosConfirm(true); // the full emergency path is one tap away
          }}
        />
      </PopupCard>
    </View>
  );
}

const GEORGETOWN_REGION = {
  latitude: GEORGETOWN.latitude,
  longitude: GEORGETOWN.longitude,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};
