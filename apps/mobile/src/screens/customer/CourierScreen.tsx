import { useState } from 'react';
import { View } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, Badge, PressableScale, Input, ChoiceChip } from '../../components/ui';
import { useCourierEstimate, useCourierOrders, useSendCourier } from '../../hooks';
import { useLocationStore } from '../../stores/locationStore';
import { GEORGETOWN } from '../../hooks/useDeviceLocation';
import { money } from '../../lib/money';
import type { PickedPlace } from './DestinationSearchScreen';

type Size = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
type Speed = 'STANDARD' | 'EXPRESS' | 'RUSH';

const SIZES: { key: Size; label: string }[] = [
  { key: 'SMALL', label: 'Small' },
  { key: 'MEDIUM', label: 'Medium' },
  { key: 'LARGE', label: 'Large' },
  { key: 'EXTRA_LARGE', label: 'XL' },
];
const SPEEDS: { key: Speed; label: string }[] = [
  { key: 'STANDARD', label: 'Standard' },
  { key: 'EXPRESS', label: 'Express' },
  { key: 'RUSH', label: 'Rush' },
];

function prettyStatus(s: string) {
  return (s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
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

export function CourierScreen({ navigation }: any) {
  const { latitude, longitude, address } = useLocationStore();
  const { data: recent } = useCourierOrders<any[]>();
  const send = useSendCourier();

  const [pickupOverride, setPickupOverride] = useState<PickedPlace | undefined>();
  const [dropoff, setDropoff] = useState<PickedPlace | undefined>();
  const [size, setSize] = useState<Size>('MEDIUM');
  const [speed, setSpeed] = useState<Speed>('STANDARD');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [description, setDescription] = useState('');

  const livePickup =
    latitude != null && longitude != null
      ? { lat: latitude, lng: longitude, label: address || 'Current location' }
      : undefined;
  const pickup = pickupOverride ?? livePickup;
  const pickupPoint = pickup ? { lat: pickup.lat, lng: pickup.lng } : undefined;
  const dropoffPoint = dropoff ? { lat: dropoff.lat, lng: dropoff.lng } : undefined;

  const { data: estimate, isFetching: estimating } = useCourierEstimate<any>(pickupPoint, dropoffPoint, size, speed);

  const valid =
    !!pickupPoint && !!dropoffPoint && recipientName.trim().length >= 2 && recipientPhone.trim().length >= 5 && !!estimate;
  const errMsg = (send.error as any)?.response?.data?.error?.message;

  const openSearch = (onSelect: (p: PickedPlace) => void, title: string) =>
    navigation?.navigate?.('DestinationSearch', { onSelect, title });

  const pickupLL = pickup ? { latitude: pickup.lat, longitude: pickup.lng } : undefined;
  const dropoffLL = dropoff ? { latitude: dropoff.lat, longitude: dropoff.lng } : undefined;
  const region =
    pickupLL && dropoffLL
      ? regionFor([pickupLL, dropoffLL])
      : {
          latitude: pickup?.lat ?? GEORGETOWN.latitude,
          longitude: pickup?.lng ?? GEORGETOWN.longitude,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        };

  const onSend = () => {
    if (!pickupPoint || !dropoffPoint || !dropoff || !pickup) return;
    send.mutate(
      {
        pickup: pickupPoint,
        dropoff: dropoffPoint,
        pickupAddress: pickup.label || 'Current location',
        dropoffAddress: dropoff.label || 'Drop-off',
        packageSize: size,
        speed,
        recipientName: recipientName.trim(),
        recipientPhone: recipientPhone.trim(),
        packageDescription: description.trim() || undefined,
        payer: 'SENDER',
      },
      {
        onSuccess: (res: any) => {
          if (res?.orderId) navigation?.navigate?.('OrderTracking', { id: res.orderId });
        },
      },
    );
  };

  return (
    <View style={{ flex: 1 }} className="bg-surface-base">
      <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} region={region} showsUserLocation>
        {pickupLL ? <Marker coordinate={pickupLL} title="From" /> : null}
        {dropoffLL ? <Marker coordinate={dropoffLL} title="To" pinColor={color.brand[500]} /> : null}
        {pickupLL && dropoffLL ? (
          <Polyline coordinates={[pickupLL, dropoffLL]} strokeColor={color.brand[500]} strokeWidth={4} />
        ) : null}
      </MapView>

      <BackButton navigation={navigation} />

      <BottomSheet index={0} snapPoints={['45%', '90%']} enableDynamicSizing={false}>
        <BottomSheetScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
        >
          <Heading size="xl" className="mb-md">
            Send a package
          </Heading>

          {/* From / To */}
          <PressableScale onPress={() => openSearch((p) => setPickupOverride(p), 'Pickup')}>
            <View className="flex-row items-center rounded-xl border border-border-subtle bg-surface-subtle px-lg py-md">
              <MaterialCommunityIcons name="circle-slice-8" size={16} color={color.text.muted} />
              <View className="ml-sm flex-1">
                <Text className="text-xs text-text-muted">From</Text>
                <Text className="text-base font-semibold" numberOfLines={1}>{pickup?.label ?? 'Set pickup'}</Text>
              </View>
            </View>
          </PressableScale>
          <PressableScale onPress={() => openSearch((p) => setDropoff(p), 'Deliver to?')}>
            <View className="mt-sm flex-row items-center rounded-xl border border-border-subtle bg-surface-subtle px-lg py-md">
              <MaterialCommunityIcons name="map-marker" size={18} color={color.brand[500]} />
              <View className="ml-sm flex-1">
                <Text className="text-xs text-text-muted">To</Text>
                <Text className="text-base font-semibold" numberOfLines={1}>{dropoff?.label ?? 'Choose destination'}</Text>
              </View>
              <Feather name="search" size={18} color={color.text.muted} />
            </View>
          </PressableScale>

          {/* Size */}
          <Text className="mb-xs mt-lg text-sm font-semibold text-text-secondary">Package size</Text>
          <View className="flex-row flex-wrap" style={{ gap: 8 }}>
            {SIZES.map((s) => (
              <ChoiceChip key={s.key} label={s.label} active={s.key === size} onPress={() => setSize(s.key)} />
            ))}
          </View>

          {/* Speed */}
          <Text className="mb-xs mt-lg text-sm font-semibold text-text-secondary">Speed</Text>
          <View className="flex-row" style={{ gap: 8 }}>
            {SPEEDS.map((s) => (
              <ChoiceChip key={s.key} label={s.label} active={s.key === speed} onPress={() => setSpeed(s.key)} full />
            ))}
          </View>

          {/* Recipient */}
          <Text className="mb-xs mt-lg text-sm font-semibold text-text-secondary">Recipient</Text>
          <Card className="gap-sm">
            <Input value={recipientName} onChangeText={setRecipientName} placeholder="Recipient name" />
            <Input
              value={recipientPhone}
              onChangeText={setRecipientPhone}
              placeholder="Recipient phone"
              keyboardType="phone-pad"
            />
            <Input value={description} onChangeText={setDescription} placeholder="What's inside? (optional)" />
          </Card>

          {/* Price */}
          {dropoffPoint ? (
            <Card className="mt-md">
              {estimating && !estimate ? (
                <View className="flex-row items-center">
                  <Spinner />
                  <Text className="ml-sm text-text-secondary">Calculating…</Text>
                </View>
              ) : estimate ? (
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-md">
                    <Text className="text-base font-semibold">Delivery fee</Text>
                    <Text className="mt-xs text-xs text-text-muted">
                      {estimate.distanceKm} km · ~{estimate.estimatedMinutes} min · cash
                    </Text>
                  </View>
                  <Text className="text-xl font-semibold text-brand-600">{money(estimate.totalFee)}</Text>
                </View>
              ) : (
                <Text className="text-text-secondary">Couldn&apos;t get a price. Try another destination.</Text>
              )}
            </Card>
          ) : null}

          {errMsg ? <Text className="mt-md text-center text-sm text-error">{errMsg}</Text> : null}

          <Button className="mt-md" loading={send.isPending} disabled={!valid} onPress={onSend}>
            <Text className="font-body font-semibold text-white">
              {estimate ? `Send parcel · ${money(estimate.totalFee)}` : 'Send parcel'}
            </Text>
          </Button>
          {!valid && dropoffPoint ? (
            <Text className="mt-xs text-center text-xs text-text-muted">Add the recipient&apos;s name and phone to continue.</Text>
          ) : null}

          {/* Recent sends */}
          {recent && recent.length > 0 ? (
            <View className="mt-xl">
              <Heading size="lg" className="mb-sm">Recent sends</Heading>
              {recent.slice(0, 5).map((o: any) => (
                <PressableScale key={o.id} onPress={() => navigation?.navigate?.('OrderTracking', { id: o.id })}>
                  <Card className="mb-sm flex-row items-center justify-between">
                    <View className="flex-1 pr-md">
                      <Text className="text-sm font-semibold" numberOfLines={1}>
                        To {o.courierRecipientName ?? o.deliveryAddress ?? 'recipient'}
                      </Text>
                      <Text className="mt-xs text-xs text-text-muted">#{o.orderNumber} · {money(o.totalAmount)}</Text>
                    </View>
                    <Badge
                      label={prettyStatus(o.status)}
                      tone={o.status === 'DELIVERED' || o.status === 'COMPLETED' ? 'success' : 'brand'}
                    />
                  </Card>
                </PressableScale>
              ))}
            </View>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}
