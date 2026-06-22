import { useState } from 'react';
import { View, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { color } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, PressableScale } from '../../components/ui';
import { useAddresses, useActiveRide, useRideEstimate, useRequestRide, useCancelRide } from '../../hooks';
import { useLocationStore } from '../../stores/locationStore';
import { money } from '../../lib/money';

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Finding your driver…',
  DRIVER_ASSIGNED: 'Driver assigned',
  DRIVER_EN_ROUTE: 'Driver on the way',
  DRIVER_ARRIVED: 'Your driver has arrived',
  RIDE_IN_PROGRESS: 'On your trip',
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

function Header({ navigation, title }: any) {
  return (
    <View className="flex-row items-center px-lg py-sm">
      <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10}>
        <Feather name="chevron-left" size={24} color={color.text.primary} />
      </PressableScale>
      <Text className="ml-md text-base font-bold">{title}</Text>
    </View>
  );
}

export function TaxiScreen({ navigation }: any) {
  const { latitude, longitude, address } = useLocationStore();
  const { data: addresses } = useAddresses<any[]>();
  const { data: activeRide, isLoading: loadingActive } = useActiveRide<any>(true);
  const requestRide = useRequestRide();
  const cancelRide = useCancelRide();

  const [dropoffId, setDropoffId] = useState<string | undefined>(undefined);

  const list = addresses ?? [];
  const pickupPoint = latitude != null && longitude != null ? { lat: latitude, lng: longitude } : undefined;
  const dropoff = list.find((a) => a.id === dropoffId);
  const dropoffPoint =
    dropoff && dropoff.latitude != null && dropoff.longitude != null
      ? { lat: dropoff.latitude, lng: dropoff.longitude }
      : undefined;

  const { data: estimate, isFetching: estimating } = useRideEstimate<any>(pickupPoint, dropoffPoint);

  if (loadingActive) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  // ===== Active ride =====
  if (activeRide) {
    const d = activeRide.driver;
    const pickup =
      activeRide.pickupLat != null ? { latitude: Number(activeRide.pickupLat), longitude: Number(activeRide.pickupLng) } : null;
    const drop =
      activeRide.deliveryLat != null
        ? { latitude: Number(activeRide.deliveryLat), longitude: Number(activeRide.deliveryLng) }
        : null;
    const driverLoc = d?.currentLat != null ? { latitude: Number(d.currentLat), longitude: Number(d.currentLng) } : null;
    const pts = [pickup, drop, driverLoc].filter(Boolean) as LatLng[];
    const region = pts.length ? regionFor(pts) : undefined;

    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <Header navigation={navigation} title="Your ride" />
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          {region ? (
            <View className="mx-lg mb-md overflow-hidden rounded-xl border border-border-subtle" style={{ height: 220 }}>
              <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} initialRegion={region} pointerEvents="none">
                {pickup ? <Marker coordinate={pickup} title="Pickup" /> : null}
                {drop ? <Marker coordinate={drop} title="Drop-off" pinColor={color.brand[500]} /> : null}
                {driverLoc ? <Marker coordinate={driverLoc} title="Driver" pinColor={color.text.primary} /> : null}
              </MapView>
            </View>
          ) : null}

          <View className="px-lg">
            <Card>
              <Heading size="lg">{STATUS_LABEL[activeRide.status] ?? 'On the way'}</Heading>
              <Text className="mt-xs text-sm text-text-secondary">
                Fare {money(activeRide.taxiFareTotal ?? activeRide.totalAmount)} · cash
              </Text>
              {activeRide.ridePin ? (
                <View className="mt-sm flex-row items-center">
                  <Text className="text-sm text-text-secondary">PIN </Text>
                  <Text className="text-lg font-semibold text-brand-600">{activeRide.ridePin}</Text>
                  <Text className="ml-sm text-xs text-text-muted">show to your driver</Text>
                </View>
              ) : null}
            </Card>

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
                  <Button
                    variant="outline"
                    className="px-lg"
                    onPress={() => {
                      Linking.openURL(`tel:${d.user.phone}`).catch(() => {});
                    }}
                  >
                    <View className="flex-row items-center">
                      <Feather name="phone" size={15} color={color.brand[500]} />
                      <Text className="ml-sm font-body font-semibold text-brand-500">Call</Text>
                    </View>
                  </Button>
                ) : null}
              </Card>
            ) : (
              <Text className="mt-md px-xs text-sm text-text-secondary">
                Hang tight — we&apos;re matching you with a nearby driver.
              </Text>
            )}

            <Button
              label="Cancel ride"
              variant="outline"
              className="mt-lg"
              loading={cancelRide.isPending}
              onPress={() => cancelRide.mutate({ id: activeRide.id })}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ===== Request a ride =====
  const canRequest = !!pickupPoint && !!dropoffPoint && !!estimate;
  const errMsg = (requestRide.error as any)?.response?.data?.message;

  const onRequest = () => {
    if (!pickupPoint || !dropoffPoint || !dropoff) return;
    requestRide.mutate({
      pickup: pickupPoint,
      dropoff: dropoffPoint,
      pickupAddress: address || 'Current location',
      dropoffAddress: dropoff.addressLine1 || dropoff.label || 'Drop-off',
      passengerCount: 1,
    });
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <Header navigation={navigation} title="Taxi" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 160 }} showsVerticalScrollIndicator={false}>
        <View className="px-lg pt-sm">
          <Heading size="lg" className="mb-sm">
            Pickup
          </Heading>
          <Card>
            <Text className="text-base font-semibold">
              {pickupPoint ? address || 'Current location' : 'Location unavailable'}
            </Text>
            <Text className="mt-xs text-xs text-text-muted">
              {pickupPoint ? 'Using your current location' : 'Enable location to set your pickup'}
            </Text>
          </Card>

          <Heading size="lg" className="mb-sm mt-lg">
            Where to?
          </Heading>
          {list.length === 0 ? (
            <PressableScale onPress={() => navigation?.navigate?.('AddAddress')}>
              <Card className="flex-row items-center">
                <Feather name="plus-circle" size={18} color={color.brand[500]} />
                <Text className="ml-sm font-semibold text-brand-600">Add a destination address</Text>
              </Card>
            </PressableScale>
          ) : (
            list.map((a) => {
              const active = a.id === dropoffId;
              return (
                <PressableScale key={a.id} onPress={() => setDropoffId(a.id)}>
                  <Card className={active ? 'mb-sm border-brand-500' : 'mb-sm'}>
                    <View className="flex-row items-center justify-between">
                      <View className="flex-1 pr-md">
                        <Text className="text-base font-semibold">{a.label || a.addressLine1}</Text>
                        <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                          {a.addressLine1}
                          {a.city ? `, ${a.city}` : ''}
                        </Text>
                      </View>
                      <Feather name={active ? 'check-circle' : 'circle'} size={20} color={active ? color.brand[500] : color.text.muted} />
                    </View>
                  </Card>
                </PressableScale>
              );
            })
          )}

          {dropoffPoint ? (
            <Card className="mt-lg">
              {estimating ? (
                <View className="flex-row items-center">
                  <Spinner />
                  <Text className="ml-sm text-text-secondary">Calculating fare…</Text>
                </View>
              ) : estimate ? (
                <>
                  <View className="flex-row items-center justify-between">
                    <Text className="text-base font-semibold">Fixed fare</Text>
                    <Text className="text-xl font-semibold text-brand-600">{money(estimate.fare)}</Text>
                  </View>
                  <Text className="mt-xs text-sm text-text-secondary">
                    {estimate.distanceKm} km · ~{estimate.durationMin} min · cash
                  </Text>
                  <Text className="mt-xs text-xs text-text-muted">Price locked before you book — no surge.</Text>
                </>
              ) : (
                <Text className="text-text-secondary">Couldn&apos;t get a fare. Try another address.</Text>
              )}
            </Card>
          ) : null}
        </View>
      </ScrollView>

      <View className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-base px-lg pb-2xl pt-md">
        {errMsg ? <Text className="mb-sm text-center text-sm text-error">{errMsg}</Text> : null}
        <Button loading={requestRide.isPending} disabled={!canRequest} onPress={onRequest}>
          <Text className="font-body font-semibold text-white">
            {estimate ? `Request ride · ${money(estimate.fare)}` : 'Request ride'}
          </Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
