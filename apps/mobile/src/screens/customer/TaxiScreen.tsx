import { useMemo, useRef, useState } from 'react';
import { View, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetView, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, PressableScale } from '../../components/ui';
import { useActiveRide, useRideEstimate, useRequestRide, useCancelRide } from '../../hooks';
import { useLocationStore } from '../../stores/locationStore';
import { GEORGETOWN } from '../../hooks/useDeviceLocation';
import { money } from '../../lib/money';
import type { RideClass, TierEstimate } from '../../services/api';
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

export function TaxiScreen({ navigation }: any) {
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
  const errMsg = (requestRide.error as any)?.response?.data?.error?.message;

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
      <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} region={routeRegion} showsUserLocation>
        {pickupLL ? <Marker coordinate={pickupLL} title="Pickup" /> : null}
        {dropoffLL ? <Marker coordinate={dropoffLL} title="Drop-off" pinColor={color.brand[500]} /> : null}
        {pickupLL && dropoffLL ? (
          <Polyline coordinates={[pickupLL, dropoffLL]} strokeColor={color.brand[500]} strokeWidth={4} />
        ) : null}
      </MapView>

      <BackButton navigation={navigation} />

      <BottomSheet index={0} snapPoints={['42%', '85%']} enableDynamicSizing={false}>
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
          {/* Pickup + destination rows */}
          <PressableScale onPress={() => openSearch((p) => setPickupOverride(p), 'Pickup')}>
            <View className="flex-row items-center rounded-xl border border-border-subtle bg-surface-subtle px-lg py-md">
              <MaterialCommunityIcons name="circle-slice-8" size={16} color={color.text.muted} />
              <View className="ml-sm flex-1">
                <Text className="text-xs text-text-muted">Pickup</Text>
                <Text className="text-base font-semibold" numberOfLines={1}>
                  {pickup?.label ?? 'Set pickup location'}
                </Text>
              </View>
            </View>
          </PressableScale>

          <PressableScale onPress={() => openSearch((p) => setDropoff(p), 'Where to?')}>
            <View className="mt-sm flex-row items-center rounded-xl border border-border-subtle bg-surface-subtle px-lg py-md">
              <MaterialCommunityIcons name="map-marker" size={18} color={color.brand[500]} />
              <View className="ml-sm flex-1">
                <Text className="text-xs text-text-muted">Where to?</Text>
                <Text className="text-base font-semibold" numberOfLines={1}>
                  {dropoff?.label ?? 'Choose your destination'}
                </Text>
              </View>
              <Feather name="search" size={18} color={color.text.muted} />
            </View>
          </PressableScale>

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
                    Price locked before you book — no surge.
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
      <View
        className={`mb-sm flex-row items-center rounded-xl border px-lg py-md ${
          selected ? 'border-brand-500 bg-brand-500' : 'border-border-subtle bg-surface-base'
        }`}
      >
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
  const sheetRef = useRef<BottomSheet>(null);
  const d = ride.driver;
  const pickup = ride.pickupLat != null ? { latitude: Number(ride.pickupLat), longitude: Number(ride.pickupLng) } : null;
  const drop =
    ride.deliveryLat != null ? { latitude: Number(ride.deliveryLat), longitude: Number(ride.deliveryLng) } : null;
  const driverLoc = d?.currentLat != null ? { latitude: Number(d.currentLat), longitude: Number(d.currentLng) } : null;
  const pts = [pickup, drop, driverLoc].filter(Boolean) as LatLng[];
  const region = useMemo(() => (pts.length ? regionFor(pts) : GEORGETOWN_REGION), [ride]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1 }} className="bg-surface-base">
      <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} region={region}>
        {pickup ? <Marker coordinate={pickup} title="Pickup" /> : null}
        {drop ? <Marker coordinate={drop} title="Drop-off" pinColor={color.brand[500]} /> : null}
        {driverLoc ? (
          <Marker coordinate={driverLoc} title="Driver" pinColor={color.text.primary}>
            <View className="h-9 w-9 items-center justify-center rounded-full bg-text-primary" style={{ elevation: 4 }}>
              <MaterialCommunityIcons name="car" size={18} color="#fff" />
            </View>
          </Marker>
        ) : null}
      </MapView>

      <BackButton navigation={navigation} />

      <BottomSheet ref={sheetRef} index={0} snapPoints={['38%', '70%']} enableDynamicSizing={false}>
        <BottomSheetView style={{ paddingHorizontal: 16, paddingBottom: 24 }}>
          <Heading size="lg">{STATUS_LABEL[ride.status] ?? 'On the way'}</Heading>
          <Text className="mt-xs text-sm text-text-secondary">
            {ride.rideClass ? `${TIER_META[ride.rideClass as RideClass]?.label ?? ride.rideClass} · ` : ''}
            Fare {money(ride.taxiFareTotal ?? ride.totalAmount)} · cash
          </Text>
          {ride.ridePin ? (
            <View className="mt-sm flex-row items-center">
              <Text className="text-sm text-text-secondary">PIN </Text>
              <Text className="text-lg font-semibold text-brand-600">{ride.ridePin}</Text>
              <Text className="ml-sm text-xs text-text-muted">show to your driver</Text>
            </View>
          ) : null}

          {d ? (
            <Card className="mt-md flex-row items-center justify-between">
              <View className="flex-1 pr-md">
                <Text className="text-base font-semibold">{d.user?.firstName ?? 'Your driver'}</Text>
                <Text className="mt-xs text-sm text-text-secondary">
                  {[d.vehicleColor, d.vehicleMake, d.vehicleModel].filter(Boolean).join(' ')}
                  {d.licensePlate ? ` · ${d.licensePlate}` : ''}
                </Text>
                {d.averageRating ? (
                  <Text className="mt-xs text-xs text-text-muted">{Number(d.averageRating).toFixed(1)} ★</Text>
                ) : null}
              </View>
              {d.user?.phone ? (
                <Button variant="outline" className="px-lg" onPress={() => Linking.openURL(`tel:${d.user.phone}`).catch(() => {})}>
                  <View className="flex-row items-center">
                    <Feather name="phone" size={15} color={color.brand[500]} />
                    <Text className="ml-sm font-body font-semibold text-brand-500">Call</Text>
                  </View>
                </Button>
              ) : null}
            </Card>
          ) : (
            <Text className="mt-md text-sm text-text-secondary">Hang tight — we&apos;re matching you with a nearby driver.</Text>
          )}

          <Button
            label="Cancel ride"
            variant="outline"
            className="mt-lg"
            loading={cancelRide.isPending}
            onPress={() => cancelRide.mutate({ id: ride.id })}
          />
        </BottomSheetView>
      </BottomSheet>
    </View>
  );
}

const GEORGETOWN_REGION = {
  latitude: GEORGETOWN.latitude,
  longitude: GEORGETOWN.longitude,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};
