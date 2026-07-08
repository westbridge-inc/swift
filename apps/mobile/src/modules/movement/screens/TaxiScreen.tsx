import { useMemo, useRef, useState } from 'react';
import { View, Linking, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, PressableScale, ConfirmDialog, choiceSurface, choiceSurfaceStyle, elevation } from '../../../components/ui';
import { useActiveRide, useRideEstimate, useRequestRide, useCancelRide } from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';
import { GEORGETOWN } from '../../../hooks/useDeviceLocation';
import { money } from '../../../lib/money';
import { Image } from 'expo-image';
import { mediaUrl } from '../../../lib/images';
import type { RideClass, TierEstimate } from '../../../services/api';
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
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.02, (maxLat - minLat) * 2.2),
    longitudeDelta: Math.max(0.02, (maxLng - minLng) * 2.2),
  };
}

function BackButton({ navigation }: any) {
  return (
    <SafeAreaView edges={['top']} style={{ position: 'absolute', top: 0, left: 0, zIndex: 10 }}>
      <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10} className="m-lg">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-surface-base" style={{ elevation: 4 }}>
          <Feather name="chevron-left" size={22} color={color.text.primary} />
        </View>
      </PressableScale>
    </SafeAreaView>
  );
}

// Same marker language as the courier map: pickup = ink dot in a white ring,
// drop-off = the brand map pin.
function PickupDot() {
  return (
    <View
      style={[
        { width: 16, height: 16, borderRadius: 8, backgroundColor: color.text.primary, borderWidth: 3, borderColor: '#fff' },
        elevation.card,
      ]}
    />
  );
}
function DropPin() {
  return <MaterialCommunityIcons name="map-marker" size={36} color={color.brand[600]} />;
}

const SHEET_STYLE = { backgroundColor: color.surface.subtle, borderTopLeftRadius: 24, borderTopRightRadius: 24 };
const HANDLE_STYLE = { width: 44, backgroundColor: color.border.strong };

export function TaxiScreen({ navigation }: any) {
  const { height: winH } = useWindowDimensions();
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
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (activeRide) {
    return <ActiveRide navigation={navigation} ride={activeRide} cancelRide={cancelRide} />;
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
    <View style={{ flex: 1 }} className="bg-surface-base">
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

      <BackButton navigation={navigation} />

      <BottomSheet
        index={0}
        snapPoints={['42%', '85%']}
        enableDynamicSizing={false}
        backgroundStyle={SHEET_STYLE}
        handleIndicatorStyle={HANDLE_STYLE}
      >
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
          {/* Route — pickup → destination, connected */}
          <View className="rounded-3xl bg-surface-base p-lg" style={elevation.card}>
            <PressableScale onPress={() => openSearch((p) => setPickupOverride(p), 'Pickup')}>
              <View className="flex-row items-center">
                <View style={{ width: 22, alignItems: 'center' }}>
                  <View style={{ width: 11, height: 11, borderRadius: 6, borderWidth: 2.5, borderColor: color.text.muted }} />
                </View>
                <View className="ml-sm flex-1">
                  <Text className="text-xs text-text-muted">Pickup</Text>
                  <Text className="text-base font-semibold text-text-primary" numberOfLines={1}>{pickup?.label ?? 'Set pickup location'}</Text>
                </View>
              </View>
            </PressableScale>
            <View style={{ marginLeft: 10, height: 16, width: 2, backgroundColor: color.border.subtle, marginVertical: 3 }} />
            <PressableScale onPress={() => openSearch((p) => setDropoff(p), 'Where to?')}>
              <View className="flex-row items-center">
                <View style={{ width: 22, alignItems: 'center' }}>
                  <MaterialCommunityIcons name="map-marker" size={18} color={color.brand[500]} />
                </View>
                <View className="ml-sm flex-1">
                  <Text className="text-xs text-text-muted">Where to?</Text>
                  <Text className="text-base font-semibold text-text-primary" numberOfLines={1}>{dropoff?.label ?? 'Choose your destination'}</Text>
                </View>
                <Feather name="search" size={18} color={color.text.muted} />
              </View>
            </PressableScale>
          </View>

          {/* Tiers */}
          {dropoffPoint ? (
            <View className="mt-lg">
              <Heading size="lg" className="mb-sm">
                Choose a ride
              </Heading>
              {estimating && !estimate ? (
                <Card className="flex-row items-center">
                  <Spinner />
                  <Text className="ml-sm text-text-secondary">Calculating fares…</Text>
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
                  <Text className="mt-sm text-center text-xs text-text-muted">
                    Fixed fare, locked before you book — no surge, pay cash.
                  </Text>
                </>
              ) : (
                <Card>
                  <Text className="text-text-secondary">Couldn&apos;t get a fare. Try another destination.</Text>
                </Card>
              )}
            </View>
          ) : (
            <Text className="mt-lg px-xs text-sm text-text-secondary">
              Set your destination to see ride options and fixed fares.
            </Text>
          )}

          {errMsg ? <Text className="mt-md text-center text-sm text-error">{errMsg}</Text> : null}
          {needsL2 ? (
            <Button
              label="Verify your ID — takes a minute"
              variant="outline"
              className="mt-sm"
              onPress={() => navigation?.navigate?.('IdentityVerification')}
            />
          ) : null}

          <Button className="mt-md" loading={requestRide.isPending} disabled={!canRequest} onPress={onRequest}>
            <Text className="font-body font-semibold text-white">
              {selectedTier
                ? `Request ${TIER_META[selectedClass].label} · ${money(selectedTier.fare)}`
                : 'Request ride'}
            </Text>
          </Button>
          {!canRequest && dropoffPoint ? (
            <Text className="mt-xs text-center text-xs text-text-muted">Pick a ride option to continue.</Text>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

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
    <PressableScale onPress={onPress}>
      <View className={`mb-sm flex-row items-center rounded-2xl border px-lg py-md ${choiceSurface(selected)}`} style={choiceSurfaceStyle(selected)}>
        <MaterialCommunityIcons name={meta.icon} size={26} color={selected ? '#fff' : color.text.primary} />
        <View className="ml-md flex-1">
          <Text className={`text-base font-bold ${selected ? 'text-white' : 'text-text-primary'}`}>
            {meta.label}
            <Text className={selected ? 'text-white' : 'text-text-muted'}> · {tier.capacity} seats</Text>
          </Text>
          <Text className={`text-xs ${selected ? 'text-white/90' : 'text-text-secondary'}`}>
            {meta.blurb} · ~{durationMin} min
          </Text>
        </View>
        <Text className={`text-lg font-bold ${selected ? 'text-white' : 'text-text-primary'}`}>
          {money(tier.fare)}
        </Text>
      </View>
    </PressableScale>
  );
}

function ActiveRide({ navigation, ride, cancelRide }: any) {
  const { height: winH } = useWindowDimensions();
  const sheetRef = useRef<BottomSheet>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const d = ride.driver;
  const pickup = ride.pickupLat != null ? { latitude: Number(ride.pickupLat), longitude: Number(ride.pickupLng) } : null;
  const drop =
    ride.deliveryLat != null ? { latitude: Number(ride.deliveryLat), longitude: Number(ride.deliveryLng) } : null;
  const driverLoc = d?.currentLat != null ? { latitude: Number(d.currentLat), longitude: Number(d.currentLng) } : null;
  const pts = [pickup, drop, driverLoc].filter(Boolean) as LatLng[];
  const region = useMemo(() => (pts.length ? regionFor(pts) : GEORGETOWN_REGION), [ride]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1 }} className="bg-surface-base">
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
              className="h-9 w-9 items-center justify-center rounded-full"
              style={[{ backgroundColor: color.text.primary }, elevation.card]}
            >
              <MaterialCommunityIcons name="car" size={18} color="#fff" />
            </View>
          </Marker>
        ) : null}
      </MapView>

      <BackButton navigation={navigation} />

      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={['38%', '70%']}
        enableDynamicSizing={false}
        backgroundStyle={SHEET_STYLE}
        handleIndicatorStyle={HANDLE_STYLE}
      >
        <BottomSheetView style={{ paddingHorizontal: 16, paddingBottom: 24 }}>
          <Heading size="lg">{STATUS_LABEL[ride.status] ?? 'On the way'}</Heading>
          <Text className="mt-xs text-sm text-text-secondary">
            {ride.rideClass ? `${TIER_META[ride.rideClass as RideClass]?.label ?? ride.rideClass} · ` : ''}
            Fare {money(ride.taxiFareTotal ?? ride.totalAmount)} · cash
          </Text>
          {ride.ridePin ? (
            <View className="mt-sm flex-row items-center">
              <Text className="text-sm text-text-secondary">PIN </Text>
              <Text className="text-lg font-semibold" style={{ color: color.brand[600] }}>{ride.ridePin}</Text>
              <Text className="ml-sm text-xs text-text-muted">show to your driver</Text>
            </View>
          ) : null}

          {d ? (
            <Card className="mt-md">
              <View className="flex-row items-center justify-between">
                <View className="flex-row flex-1 items-center pr-md">
                  {/* Trust visibility (master plan §5): see WHO is coming */}
                  {d.user?.avatar ? (
                    <Image
                      source={{ uri: mediaUrl(d.user.avatar) ?? undefined }}
                      style={{ width: 48, height: 48, borderRadius: 24 }}
                      contentFit="cover"
                    />
                  ) : (
                    <View className="h-12 w-12 items-center justify-center rounded-full bg-surface-subtle">
                      <Feather name="user" size={20} color={color.text.muted} />
                    </View>
                  )}
                  <View className="ml-md flex-1">
                    <Text className="text-base font-semibold">{d.user?.firstName ?? 'Your driver'}</Text>
                    <Text className="mt-xs text-sm text-text-secondary">
                      {[d.vehicleColor, d.vehicleMake, d.vehicleModel].filter(Boolean).join(' ')}
                    </Text>
                    {d.averageRating ? (
                      <Text className="mt-xs text-xs text-text-muted">{Number(d.averageRating).toFixed(1)} ★</Text>
                    ) : null}
                  </View>
                </View>
                {d.user?.phone ? (
                  <Button variant="outline" className="px-lg" onPress={() => Linking.openURL(`tel:${d.user.phone}`).catch(() => {})}>
                    <View className="flex-row items-center">
                      <Feather name="phone" size={15} color={color.brand[500]} />
                      <Text className="ml-sm font-body font-semibold" style={{ color: color.brand[500] }}>Call</Text>
                    </View>
                  </Button>
                ) : null}
              </View>
              {/* …and WHAT is coming: the car photo + plate, big enough to match at the kerb */}
              <View className="mt-sm flex-row items-center">
                {d.vehiclePhotoUrl ? (
                  <Image
                    source={{ uri: mediaUrl(d.vehiclePhotoUrl) ?? undefined }}
                    style={{ width: 88, height: 56, borderRadius: 10 }}
                    contentFit="cover"
                  />
                ) : null}
                {d.licensePlate ? (
                  <View className={d.vehiclePhotoUrl ? 'ml-md rounded-lg border border-border-subtle px-md py-xs' : 'rounded-lg border border-border-subtle px-md py-xs'}>
                    <Text className="text-base font-bold tracking-widest text-text-primary">{d.licensePlate}</Text>
                  </View>
                ) : null}
              </View>
            </Card>
          ) : (
            <Text className="mt-md text-sm text-text-secondary">Hang tight — we&apos;re matching you with a nearby driver.</Text>
          )}

          <Button
            label="Cancel ride"
            variant="neutral"
            className="mt-lg"
            loading={cancelRide.isPending}
            onPress={() => setConfirmCancel(true)}
          />
        </BottomSheetView>
      </BottomSheet>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this ride?"
        body={d ? 'Your driver is already on the way.' : 'We’ll stop looking for a driver.'}
        confirmLabel="Cancel ride"
        cancelLabel="Keep ride"
        destructive
        loading={cancelRide.isPending}
        onConfirm={() => {
          setConfirmCancel(false);
          cancelRide.mutate({ id: ride.id });
        }}
        onClose={() => setConfirmCancel(false)}
      />
    </View>
  );
}

const GEORGETOWN_REGION = {
  latitude: GEORGETOWN.latitude,
  longitude: GEORGETOWN.longitude,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};
