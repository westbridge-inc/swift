import { useState } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, Badge } from '../../components/ui';
import { useAddresses, useCourierEstimate, useCourierOrders, useSendCourier } from '../../hooks';
import { useLocationStore } from '../../stores/locationStore';
import { money } from '../../lib/money';

const SIZES = [
  { key: 'SMALL', label: 'Small' },
  { key: 'MEDIUM', label: 'Medium' },
  { key: 'LARGE', label: 'Large' },
  { key: 'EXTRA_LARGE', label: 'XL' },
];
const SPEEDS = [
  { key: 'STANDARD', label: 'Standard' },
  { key: 'EXPRESS', label: 'Express' },
  { key: 'RUSH', label: 'Rush' },
];

const FIELD = 'mb-sm rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary';

function prettyStatus(s: string) {
  return (s || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function CourierScreen({ navigation }: any) {
  const { latitude, longitude, address } = useLocationStore();
  const { data: addresses } = useAddresses<any[]>();
  const { data: recent } = useCourierOrders<any[]>();
  const send = useSendCourier();

  const [dropoffId, setDropoffId] = useState<string | undefined>(undefined);
  const [size, setSize] = useState<'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE'>('MEDIUM');
  const [speed, setSpeed] = useState<'STANDARD' | 'EXPRESS' | 'RUSH'>('STANDARD');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [description, setDescription] = useState('');

  const list = addresses ?? [];
  const pickupPoint = latitude != null && longitude != null ? { lat: latitude, lng: longitude } : undefined;
  const dropoff = list.find((a) => a.id === dropoffId);
  const dropoffPoint =
    dropoff && dropoff.latitude != null && dropoff.longitude != null
      ? { lat: dropoff.latitude, lng: dropoff.longitude }
      : undefined;

  const { data: estimate, isFetching: estimating } = useCourierEstimate<any>(pickupPoint, dropoffPoint, size, speed);

  const valid =
    !!pickupPoint &&
    !!dropoffPoint &&
    recipientName.trim().length >= 2 &&
    recipientPhone.trim().length >= 5 &&
    !!estimate;
  const errMsg = (send.error as any)?.response?.data?.message;

  const onSend = () => {
    if (!pickupPoint || !dropoffPoint || !dropoff) return;
    send.mutate(
      {
        pickup: pickupPoint,
        dropoff: dropoffPoint,
        pickupAddress: address || 'Current location',
        dropoffAddress: dropoff.addressLine1 || dropoff.label || 'Drop-off',
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
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="px-lg pb-sm pt-md">
        <Heading size="2xl">Send a package</Heading>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 170 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View className="px-lg">
          <Text className="mb-xs text-sm font-semibold text-text-secondary">From</Text>
          <Card>
            <Text className="text-base font-semibold">
              {pickupPoint ? address || 'Current location' : 'Location unavailable'}
            </Text>
          </Card>

          <Text className="mb-xs mt-lg text-sm font-semibold text-text-secondary">To</Text>
          {list.length === 0 ? (
            <Pressable onPress={() => navigation?.navigate?.('AddAddress')}>
              <Card className="flex-row items-center">
                <Feather name="plus-circle" size={18} color={color.brand[500]} />
                <Text className="ml-sm font-semibold text-brand-600">Add a destination address</Text>
              </Card>
            </Pressable>
          ) : (
            list.map((a) => {
              const active = a.id === dropoffId;
              return (
                <Pressable key={a.id} onPress={() => setDropoffId(a.id)}>
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
                </Pressable>
              );
            })
          )}

          <Text className="mb-xs mt-lg text-sm font-semibold text-text-secondary">Package size</Text>
          <View className="flex-row flex-wrap" style={{ gap: 8 }}>
            {SIZES.map((s) => {
              const active = s.key === size;
              return (
                <Pressable
                  key={s.key}
                  onPress={() => setSize(s.key as any)}
                  className={
                    active
                      ? 'rounded-lg border border-brand-500 bg-brand-50 px-lg py-sm'
                      : 'rounded-lg border border-border-subtle px-lg py-sm'
                  }
                >
                  <Text className={active ? 'font-semibold text-brand-600' : 'text-text-secondary'}>{s.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text className="mb-xs mt-lg text-sm font-semibold text-text-secondary">Speed</Text>
          <View className="flex-row" style={{ gap: 8 }}>
            {SPEEDS.map((s) => {
              const active = s.key === speed;
              return (
                <Pressable
                  key={s.key}
                  onPress={() => setSpeed(s.key as any)}
                  className={
                    active
                      ? 'flex-1 items-center rounded-lg border border-brand-500 bg-brand-50 py-sm'
                      : 'flex-1 items-center rounded-lg border border-border-subtle py-sm'
                  }
                >
                  <Text className={active ? 'font-semibold text-brand-600' : 'text-text-secondary'}>{s.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text className="mb-xs mt-lg text-sm font-semibold text-text-secondary">Recipient</Text>
          <TextInput
            value={recipientName}
            onChangeText={setRecipientName}
            placeholder="Recipient name"
            placeholderTextColor={color.text.muted}
            className={FIELD}
          />
          <TextInput
            value={recipientPhone}
            onChangeText={setRecipientPhone}
            placeholder="Recipient phone"
            placeholderTextColor={color.text.muted}
            keyboardType="phone-pad"
            className={FIELD}
          />
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What's inside? (optional)"
            placeholderTextColor={color.text.muted}
            className={FIELD}
          />

          {dropoffPoint ? (
            <Card className="mt-md">
              {estimating ? (
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
                <Text className="text-text-secondary">Couldn&apos;t get a price. Try another address.</Text>
              )}
            </Card>
          ) : null}

          {recent && recent.length > 0 ? (
            <View className="mt-xl">
              <Heading size="lg" className="mb-sm">
                Recent sends
              </Heading>
              {recent.slice(0, 5).map((o: any) => (
                <Pressable key={o.id} onPress={() => navigation?.navigate?.('OrderTracking', { id: o.id })}>
                  <Card className="mb-sm flex-row items-center justify-between">
                    <View className="flex-1 pr-md">
                      <Text className="text-sm font-semibold" numberOfLines={1}>
                        To {o.courierRecipientName ?? o.deliveryAddress ?? 'recipient'}
                      </Text>
                      <Text className="mt-xs text-xs text-text-muted">
                        #{o.orderNumber} · {money(o.totalAmount)}
                      </Text>
                    </View>
                    <Badge
                      label={prettyStatus(o.status)}
                      tone={o.status === 'DELIVERED' || o.status === 'COMPLETED' ? 'success' : 'brand'}
                    />
                  </Card>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>

      <View className="absolute inset-x-0 bottom-0 border-t border-border-subtle bg-surface-base px-lg pb-2xl pt-md">
        {errMsg ? <Text className="mb-sm text-center text-sm text-error">{errMsg}</Text> : null}
        <Button disabled={!valid || send.isPending} onPress={onSend}>
          <Text className="font-body font-semibold text-white">
            {send.isPending ? 'Sending…' : estimate ? `Send parcel · ${money(estimate.totalFee)}` : 'Send parcel'}
          </Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
