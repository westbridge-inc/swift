/** @jsxImportSource react */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Linking, Pressable, Share, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Image } from 'expo-image';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useActiveRide, useRideEstimate, useRequestRide, useCancelRide, useRideSos, useRideAvailability, useWatchAvailability } from '../../../hooks';
import { connectSocket, getSocket, subscribeToOrder } from '../../../services/socket';
import { RidePostTripSheet } from '../RidePostTripSheet';
import { useLocationStore } from '../../../stores/locationStore';
import { GEORGETOWN } from '../../../hooks/useDeviceLocation';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';
import { streetEtaMin } from '../../../lib/geo';
import { type RideClass, type TierEstimate } from '../../../services/api';
import { Card, CircleChip, IconChip, LoadingBlock, PillButton, PopupCard, Stars, T, cardShadow } from '../../../kit';
import type { PickedPlace } from './DestinationSearchScreen';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Finding your driver…',
  DRIVER_ASSIGNED: 'Driver assigned',
  DRIVER_EN_ROUTE: 'Driver on the way',
  DRIVER_ARRIVED: 'Your driver has arrived',
  RIDE_IN_PROGRESS: 'On your trip',
};

const TIER_META: Record<RideClass, { label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; blurb: string }> = {
  ECONOMY: { label: 'Economy', icon: 'car', blurb: 'Affordable, everyday rides' },
  COMFORT: { label: 'Comfort', icon: 'car-estate', blurb: 'Newer cars, extra legroom' },
  XL: { label: 'XL', icon: 'car-3-plus', blurb: 'Seats up to 6' },
  GROUP: { label: 'Bus', icon: 'bus', blurb: 'Minibus — groups, tours & airport runs' },
};

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
  return <MaterialCommunityIcons name="map-marker" size={36} color={color.brand[600]} />;
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
              <MaterialCommunityIcons name="map-marker" size={18} color={color.brand[500]} />
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
          <MaterialCommunityIcons name="car" size={30} color={color.white} />
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
  const insets = useSafeAreaInsets();
  const { latitude, longitude, address } = useLocationStore();
  const { data: activeRide, isLoading: loadingActive } = useActiveRide<any>(true);
  const requestRide = useRequestRide();
  const cancelRide = useCancelRide();
  const qc = useQueryClient();

  // Post-trip closure: the ride that just completed, held so we can show the
  // rate + tip sheet after `useActiveRide` drops it (a completed ride is no
  // longer "active").
  const [completedRide, setCompletedRide] = useState<any>(null);
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

  const livePickup =
    latitude != null && longitude != null
      ? { lat: latitude, lng: longitude, label: address || 'Current location' }
      : undefined;
  const pickup = pickupOverride ?? livePickup;

  const pickupPoint = pickup ? { lat: pickup.lat, lng: pickup.lng } : undefined;
  const dropoffPoint = dropoff ? { lat: dropoff.lat, lng: dropoff.lng } : undefined;

  const { data: estimate, isFetching: estimating } = useRideEstimate(pickupPoint, dropoffPoint);

  // Availability spec §2.1 (hooks live ABOVE the early returns — the active-ride
  // and loading branches must never change the hook order).
  const supply = useRideAvailability(pickupPoint);
  const watch = useWatchAvailability();

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
    return <ActiveRide navigation={navigation} ride={activeRide} cancelRide={cancelRide} insets={insets} />;
  }

  // ===== Request flow (idle → route chosen) =====
  const mapCenter = {
    latitude: pickup?.lat ?? GEORGETOWN.latitude,
    longitude: pickup?.lng ?? GEORGETOWN.longitude,
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

  const onRequest = () => {
    if (!pickupPoint || !dropoffPoint || !dropoff || !pickup) return;
    requestRide.mutate({
      pickup: pickupPoint,
      dropoff: dropoffPoint,
      pickupAddress: pickup.label || 'Current location',
      dropoffAddress: dropoff.label || 'Drop-off',
      passengerCount: 1,
      rideClass: selectedClass,
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        region={routeRegion}
        showsUserLocation
        mapPadding={{ top: 0, left: 0, right: 0, bottom: Math.round(winH * 0.38) }}
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
          <RouteCard
            pickupLabel={pickup?.label}
            dropoffLabel={dropoff?.label}
            onPickup={() => openSearch((p) => setPickupOverride(p), 'Pickup')}
            onDropoff={() => openSearch((p) => setDropoff(p), 'Where to?')}
          />

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

          {supplyNone ? (
            // §2.1: an empty field gets honesty, not a spinner. Watch swaps in;
            // "Try anyway" stays — drivers come online mid-search.
            <>
              <PillButton
                label={watch.isSuccess ? "We'll ping you — watching for drivers" : 'Notify me when a driver is available'}
                style={{ marginTop: space.lg }}
                loading={watch.isPending}
                disabled={watch.isSuccess || !pickupPoint}
                onPress={() => pickupPoint && watch.mutate(pickupPoint)}
              />
              <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
                No drivers are available near you right now — we&apos;re sorry.{' '}
                {watch.isSuccess ? "We'll ping you the moment one comes online." : ''}
              </T>
              <T
                variant="caption"
                tone="muted"
                center
                style={{ marginTop: space.sm, textDecorationLine: 'underline' }}
                onPress={() => canRequest && !requestRide.isPending && onRequest()}
              >
                Try anyway — some drivers come online mid-search
              </T>
            </>
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
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? color.brand[500] : color.brand[50],
            }}
          >
            <MaterialCommunityIcons name={meta.icon} size={22} color={selected ? color.white : color.brand[600]} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="body" weight="semibold" tone={selected ? 'deep' : 'ink'}>
              {meta.label} <T variant="label" tone="muted">· {tier.capacity} seats</T>
            </T>
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              {meta.blurb} · ~{durationMin} min
            </T>
          </View>
          <T variant="body" weight="bold" tone={selected ? 'brand' : 'ink'}>
            {money(tier.fare)}
          </T>
        </View>
      )}
    </Pressable>
  );
}

function ActiveRide({ navigation, ride, cancelRide, insets }: any) {
  const { height: winH } = useWindowDimensions();
  const sheetRef = useRef<BottomSheet>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
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
    s.on('driver:location', onDriver);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onError);
    s.on('dispatch:exhausted', onExhausted);
    return () => {
      s.off('driver:location', onDriver);
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.off('connect_error', onError);
      s.off('dispatch:exhausted', onExhausted);
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
        {driverLoc ? (
          // rotation faces the car to its heading (flat = rotate in the map
          // plane); a stale fix dims it so a frozen car reads as "not live".
          <Marker
            coordinate={driverLoc}
            title="Driver"
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            rotation={driverHeading ?? 0}
          >
            <View
              style={[
                { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.text.primary, opacity: fixStale ? 0.4 : 1 },
                cardShadow,
              ]}
            >
              <MaterialCommunityIcons name="navigation" size={18} color={color.white} />
            </View>
          </Marker>
        ) : null}
      </MapView>

      {/* Live-feed honesty banner: reconnecting (socket down) or updating (fix
          aged out). Silence must never look like a live, moving car. */}
      {(connLost || fixStale) ? (
        <View style={{ position: 'absolute', top: insets.top + space.md, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: color.text.primary, paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.full, ...cardShadow }}>
          <MaterialCommunityIcons name={connLost ? 'wifi-off' : 'crosshairs-question'} size={13} color={color.white} />
          <T variant="caption" style={{ color: color.white }}>{connLost ? 'Reconnecting…' : 'Updating driver location…'}</T>
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
          <MaterialCommunityIcons name="crosshairs-gps" size={22} color={color.text.primary} />
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
              <MaterialCommunityIcons name="car-side" size={28} color={color.white} />
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
              {STATUS_LABEL[ride.status] ?? 'On the way'}
              {fixStale ? ' · locating…' : legEta != null ? ` · ~${legEta} min` : ''}
            </T>
          )}
          <T variant="label" tone="muted" style={{ marginTop: 4 }}>
            {ride.rideClass ? `${TIER_META[ride.rideClass as RideClass]?.label ?? ride.rideClass} · ` : ''}
            Fare {money(ride.taxiFareTotal ?? ride.totalAmount)} · cash
            {ride.taxiDuration ? ` · ~${Math.round(Number(ride.taxiDuration))} min trip` : ''}
          </T>
          {ride.ridePin ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm }}>
              <T variant="label" tone="muted">
                PIN
              </T>
              <T variant="heading" tone="brand">
                {ride.ridePin}
              </T>
              <T variant="caption" tone="faint">
                show to your driver
              </T>
            </View>
          ) : null}

          {d ? (
            <Card style={{ marginTop: space.lg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                {/* Trust visibility (master plan §5): see WHO is coming */}
                {d.user?.avatar ? (
                  <Image
                    source={{ uri: mediaUrl(d.user.avatar) ?? undefined }}
                    style={{ width: 48, height: 48, borderRadius: 24 }}
                    contentFit="cover"
                  />
                ) : (
                  <IconChip icon="user" size={48} />
                )}
                <View style={{ flex: 1 }}>
                  <T variant="body" weight="semibold">
                    {d.user?.firstName ?? 'Your driver'}
                  </T>
                  <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                    {[d.vehicleColor, d.vehicleMake, d.vehicleModel].filter(Boolean).join(' ')}
                  </T>
                  {d.averageRating ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                      <Stars value={Number(d.averageRating)} size={11} />
                      <T variant="caption" tone="muted">
                        {Number(d.averageRating).toFixed(1)}
                      </T>
                    </View>
                  ) : null}
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
              {/* …and WHAT is coming: the car photo + plate, big enough to match at the kerb */}
              {d.vehiclePhotoUrl || d.licensePlate ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
                  {d.vehiclePhotoUrl ? (
                    <Image
                      source={{ uri: mediaUrl(d.vehiclePhotoUrl) ?? undefined }}
                      style={{ width: 88, height: 56, borderRadius: radius.md }}
                      contentFit="cover"
                    />
                  ) : null}
                  {d.licensePlate ? (
                    <View
                      style={{
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                        borderRadius: radius.md,
                        borderWidth: 1,
                        borderColor: color.border.strong,
                      }}
                    >
                      <T variant="body" weight="bold" style={{ letterSpacing: 2 }}>
                        {d.licensePlate}
                      </T>
                    </View>
                  ) : null}
                </View>
              ) : null}
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
            <SearchingCard startedAt={ride.placedAt ?? ride.createdAt} />
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
        <T variant="title" center style={{ marginTop: space.lg }}>
          Cancel this ride?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          {d
            ? 'Your driver is already on the way. Cancelling now may charge a late-cancellation fee and lower your reliability rating.'
            : 'We’ll stop looking for a driver.'}
        </T>
        <PillButton
          label="Cancel ride"
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
        <T variant="title" center style={{ marginTop: space.lg }}>
          Get emergency help?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          This alerts Swift safety with your live location, then dials local emergency services. Use only in a real emergency.
        </T>
        <PillButton
          label="Yes — get help now"
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          loading={sos.isPending}
          onPress={() => {
            setSosConfirm(false);
            const coords =
              riderLoc.latitude != null && riderLoc.longitude != null
                ? { lat: riderLoc.latitude, lng: riderLoc.longitude }
                : driverLoc
                  ? { lat: driverLoc.latitude, lng: driverLoc.longitude }
                  : undefined;
            sos.mutate({ id: ride.id, coords });
            // Guyana launch emergency number; move to CountryConfig for other markets.
            Linking.openURL('tel:911').catch(() => {});
          }}
        />
        <PillButton label="Close" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={() => setSosConfirm(false)} />
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
