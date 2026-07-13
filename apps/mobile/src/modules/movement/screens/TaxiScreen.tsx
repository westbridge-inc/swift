/** @jsxImportSource react */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Pressable, Share, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Image } from 'expo-image';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useActiveRide, useRideEstimate, useRequestRide, useCancelRide } from '../../../hooks';
import { connectSocket, getSocket, subscribeToOrder } from '../../../services/socket';
import { useLocationStore } from '../../../stores/locationStore';
import { GEORGETOWN } from '../../../hooks/useDeviceLocation';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';
import { rideApi, type RideClass, type TierEstimate } from '../../../services/api';
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
        { width: 16, height: 16, borderRadius: 8, backgroundColor: color.text.primary, borderWidth: 3, borderColor: '#fff' },
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

export function TaxiScreen({ navigation }: any) {
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { latitude, longitude, address } = useLocationStore();
  const { data: activeRide, isLoading: loadingActive } = useActiveRide<any>(true);
  const requestRide = useRequestRide();
  const cancelRide = useCancelRide();

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

          <PillButton
            label={selectedTier ? `Request ${TIER_META[selectedClass].label} · ${money(selectedTier.fare)}` : 'Request ride'}
            style={{ marginTop: space.lg }}
            loading={requestRide.isPending}
            disabled={!canRequest}
            onPress={onRequest}
          />
          {!canRequest && dropoffPoint ? (
            <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
              Pick a ride option to continue.
            </T>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>
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
  const d = ride.driver;

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
      }
    };
    s.on('driver:location', onDriver);
    return () => {
      s.off('driver:location', onDriver);
    };
  }, [ride?.id]);

  const pickup = ride.pickupLat != null ? { latitude: Number(ride.pickupLat), longitude: Number(ride.pickupLng) } : null;
  const drop =
    ride.deliveryLat != null ? { latitude: Number(ride.deliveryLat), longitude: Number(ride.deliveryLng) } : null;
  const driverLoc =
    liveDriver ?? (d?.currentLat != null ? { latitude: Number(d.currentLat), longitude: Number(d.currentLng) } : null);
  const pts = [pickup, drop, driverLoc].filter(Boolean) as LatLng[];
  const region = useMemo(() => (pts.length ? regionFor(pts) : GEORGETOWN_REGION), [ride]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Emergency: dial the local number AND alert Swift with live coords so ops
  // have an evidence trail and can respond (ride-hailing safety).
  const raiseSos = () => {
    Alert.alert(
      'Emergency',
      'Call emergency services now and alert Swift with your live location?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Call 911',
          style: 'destructive',
          onPress: () => {
            const coords = driverLoc ? { lat: driverLoc.latitude, lng: driverLoc.longitude } : undefined;
            void rideApi.sos(ride.id, coords).catch(() => {});
            Linking.openURL('tel:911').catch(() => {});
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <MapView
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
          <Marker coordinate={driverLoc} title="Driver" anchor={{ x: 0.5, y: 0.5 }}>
            <View
              style={[
                { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.text.primary },
                cardShadow,
              ]}
            >
              <MaterialCommunityIcons name="car" size={18} color="#fff" />
            </View>
          </Marker>
        ) : null}
      </MapView>

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
          <T variant="title">{STATUS_LABEL[ride.status] ?? 'On the way'}</T>
          <T variant="label" tone="muted" style={{ marginTop: 4 }}>
            {ride.rideClass ? `${TIER_META[ride.rideClass as RideClass]?.label ?? ride.rideClass} · ` : ''}
            Fare {money(ride.taxiFareTotal ?? ride.totalAmount)} · cash
            {ride.taxiDuration ? ` · ~${Math.round(Number(ride.taxiDuration))} min` : ''}
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
          ) : (
            <T variant="label" tone="muted" style={{ marginTop: space.lg }}>
              Hang tight — we&apos;re matching you with a nearby driver.
            </T>
          )}

          {/* Emergency — always one tap away on an active ride */}
          <Pressable onPress={raiseSos} style={{ marginTop: space.xl }}>
            {({ pressed }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  borderRadius: radius.lg,
                  borderWidth: 1.5,
                  borderColor: color.error,
                  backgroundColor: pressed ? '#FDECEC' : 'transparent',
                  paddingVertical: space.md,
                }}
              >
                <MaterialCommunityIcons name="shield-alert" size={18} color={color.error} />
                <T variant="body" weight="bold" style={{ color: color.error }}>
                  Emergency — SOS
                </T>
              </View>
            )}
          </Pressable>

          {/* Safety row: let someone you trust follow the trip */}
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
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
          {d ? 'Your driver is already on the way.' : 'We’ll stop looking for a driver.'}
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
    </View>
  );
}

const GEORGETOWN_REGION = {
  latitude: GEORGETOWN.latitude,
  longitude: GEORGETOWN.longitude,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};
