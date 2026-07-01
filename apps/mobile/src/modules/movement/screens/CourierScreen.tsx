import { useState } from 'react';
import { View } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Button, Spinner, Badge, PressableScale, Input, elevation } from '../../../components/ui';
import { useCourierEstimate, useCourierOrders, useSendCourier } from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';
import { GEORGETOWN } from '../../../hooks/useDeviceLocation';
import { money } from '../../../lib/money';
import type { PickedPlace } from './DestinationSearchScreen';

type Size = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
type Speed = 'STANDARD' | 'EXPRESS' | 'RUSH';

const SIZES: { key: Size; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; hint: string }[] = [
  { key: 'SMALL', label: 'Small', icon: 'email-outline', hint: 'Documents' },
  { key: 'MEDIUM', label: 'Medium', icon: 'package-variant', hint: 'Shoebox' },
  { key: 'LARGE', label: 'Large', icon: 'package-variant-closed', hint: 'Backpack' },
  { key: 'EXTRA_LARGE', label: 'XL', icon: 'dolly', hint: 'Bulky' },
];
const SPEEDS: { key: Speed; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap; hint: string }[] = [
  { key: 'STANDARD', label: 'Standard', icon: 'clock-outline', hint: 'Lowest price' },
  { key: 'EXPRESS', label: 'Express', icon: 'clock-fast', hint: 'Faster' },
  { key: 'RUSH', label: 'Rush', icon: 'lightning-bolt', hint: 'Fastest' },
];

function prettyStatus(s: string) {
  return (s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function BackButton({ navigation }: any) {
  return (
    <SafeAreaView edges={['top']} style={{ position: 'absolute', top: 0, left: 0, zIndex: 10 }}>
      <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10} className="m-lg">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-surface-base" style={elevation.raised}>
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

/** Selectable tile used for size + speed — icon in a tinted chip, label, hint. */
function OptionTile({
  icon,
  label,
  hint,
  active,
  onPress,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  hint: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale onPress={onPress} style={{ flex: 1 }}>
      <View
        className={
          active
            ? 'items-center rounded-2xl border-2 border-brand-500 bg-brand-50 px-1 py-md'
            : 'items-center rounded-2xl border border-border-subtle bg-surface-base px-1 py-md'
        }
        style={active ? undefined : elevation.card}
      >
        <View
          className="mb-1 h-9 w-9 items-center justify-center rounded-full"
          style={{ backgroundColor: active ? color.brand[500] : color.surface.subtle }}
        >
          <MaterialCommunityIcons name={icon} size={18} color={active ? '#fff' : color.text.secondary} />
        </View>
        <Text className={active ? 'text-xs font-bold text-brand-700' : 'text-xs font-bold text-text-primary'} numberOfLines={1}>
          {label}
        </Text>
        <Text className="text-[10px] text-text-muted" numberOfLines={1}>{hint}</Text>
      </View>
    </PressableScale>
  );
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
    <View style={{ flex: 1 }} className="bg-surface-subtle">
      <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} region={region} showsUserLocation>
        {pickupLL ? <Marker coordinate={pickupLL} title="From" /> : null}
        {dropoffLL ? <Marker coordinate={dropoffLL} title="To" pinColor={color.brand[500]} /> : null}
        {pickupLL && dropoffLL ? (
          <Polyline coordinates={[pickupLL, dropoffLL]} strokeColor={color.brand[500]} strokeWidth={4} />
        ) : null}
      </MapView>

      <BackButton navigation={navigation} />

      <BottomSheet index={0} snapPoints={['50%', '92%']} enableDynamicSizing={false} backgroundStyle={{ backgroundColor: color.surface.subtle }}>
        <BottomSheetScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
        >
          <Heading size="xl" className="mb-md">Send a package</Heading>

          {/* Route — From → To, connected */}
          <View className="rounded-3xl bg-surface-base p-lg" style={elevation.card}>
            <PressableScale onPress={() => openSearch((p) => setPickupOverride(p), 'Pickup')}>
              <View className="flex-row items-center">
                <View style={{ width: 22, alignItems: 'center' }}>
                  <View style={{ width: 11, height: 11, borderRadius: 6, borderWidth: 2.5, borderColor: color.text.muted }} />
                </View>
                <View className="ml-sm flex-1">
                  <Text className="text-xs text-text-muted">From</Text>
                  <Text className="text-base font-semibold text-text-primary" numberOfLines={1}>{pickup?.label ?? 'Set pickup'}</Text>
                </View>
              </View>
            </PressableScale>
            <View style={{ marginLeft: 10, height: 16, width: 2, backgroundColor: color.border.subtle, marginVertical: 3 }} />
            <PressableScale onPress={() => openSearch((p) => setDropoff(p), 'Deliver to?')}>
              <View className="flex-row items-center">
                <View style={{ width: 22, alignItems: 'center' }}>
                  <MaterialCommunityIcons name="map-marker" size={18} color={color.brand[500]} />
                </View>
                <View className="ml-sm flex-1">
                  <Text className="text-xs text-text-muted">To</Text>
                  <Text className="text-base font-semibold text-text-primary" numberOfLines={1}>{dropoff?.label ?? 'Choose destination'}</Text>
                </View>
                <Feather name="search" size={18} color={color.text.muted} />
              </View>
            </PressableScale>
          </View>

          {/* Package size */}
          <Text className="mb-sm mt-lg text-sm font-bold text-text-primary">Package size</Text>
          <View className="flex-row" style={{ gap: 8 }}>
            {SIZES.map((s) => (
              <OptionTile key={s.key} icon={s.icon} label={s.label} hint={s.hint} active={s.key === size} onPress={() => setSize(s.key)} />
            ))}
          </View>

          {/* Speed */}
          <Text className="mb-sm mt-lg text-sm font-bold text-text-primary">How fast?</Text>
          <View className="flex-row" style={{ gap: 8 }}>
            {SPEEDS.map((s) => (
              <OptionTile key={s.key} icon={s.icon} label={s.label} hint={s.hint} active={s.key === speed} onPress={() => setSpeed(s.key)} />
            ))}
          </View>

          {/* Recipient */}
          <Text className="mb-sm mt-lg text-sm font-bold text-text-primary">Recipient</Text>
          <View style={{ gap: 8 }}>
            <Input value={recipientName} onChangeText={setRecipientName} placeholder="Recipient name" left={<MaterialCommunityIcons name="account-outline" size={18} color={color.text.muted} />} />
            <Input value={recipientPhone} onChangeText={setRecipientPhone} placeholder="Recipient phone" keyboardType="phone-pad" left={<MaterialCommunityIcons name="phone-outline" size={18} color={color.text.muted} />} />
            <Input value={description} onChangeText={setDescription} placeholder="What's inside? (optional)" left={<MaterialCommunityIcons name="cube-outline" size={18} color={color.text.muted} />} />
          </View>

          {/* Price */}
          {dropoffPoint ? (
            <View className="mt-lg rounded-3xl bg-surface-base p-lg" style={elevation.card}>
              {estimating && !estimate ? (
                <View className="flex-row items-center">
                  <Spinner />
                  <Text className="ml-sm text-text-secondary">Calculating fare…</Text>
                </View>
              ) : estimate ? (
                <View className="flex-row items-center justify-between">
                  <View>
                    <Text className="text-xs font-semibold uppercase tracking-wider text-text-muted">Delivery fee</Text>
                    <Text className="mt-0.5 font-display text-3xl font-extrabold text-brand-600">{money(estimate.totalFee)}</Text>
                  </View>
                  <View className="items-end">
                    <Text className="text-sm font-semibold text-text-secondary">{estimate.distanceKm} km · ~{estimate.estimatedMinutes} min</Text>
                    <View className="mt-1 flex-row items-center">
                      <MaterialCommunityIcons name="cash" size={13} color={color.success} />
                      <Text className="ml-1 text-xs font-semibold text-text-muted">No fees · pay cash</Text>
                    </View>
                  </View>
                </View>
              ) : (
                <Text className="text-text-secondary">Couldn&apos;t get a price. Try another destination.</Text>
              )}
            </View>
          ) : null}

          {errMsg ? <Text className="mt-md text-center text-sm text-error">{errMsg}</Text> : null}

          <Button className="mt-lg" loading={send.isPending} disabled={!valid} onPress={onSend}>
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
              <Text className="mb-sm text-sm font-bold text-text-primary">Recent sends</Text>
              {recent.slice(0, 5).map((o: any) => (
                <PressableScale key={o.id} onPress={() => navigation?.navigate?.('OrderTracking', { id: o.id })}>
                  <View className="mb-sm flex-row items-center rounded-2xl bg-surface-base p-md" style={elevation.card}>
                    <View className="h-9 w-9 items-center justify-center rounded-full bg-brand-50">
                      <MaterialCommunityIcons name="package-variant-closed" size={16} color={color.brand[500]} />
                    </View>
                    <View className="ml-sm flex-1">
                      <Text className="text-sm font-semibold" numberOfLines={1}>To {o.courierRecipientName ?? o.deliveryAddress ?? 'recipient'}</Text>
                      <Text className="mt-xs text-xs text-text-muted">#{o.orderNumber} · {money(o.totalAmount)}</Text>
                    </View>
                    <Badge label={prettyStatus(o.status)} tone={o.status === 'DELIVERED' || o.status === 'COMPLETED' ? 'success' : 'brand'} />
                  </View>
                </PressableScale>
              ))}
            </View>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}
