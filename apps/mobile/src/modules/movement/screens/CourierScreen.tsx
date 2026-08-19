/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useCourierEstimate, useCourierOrders, useSendCourier } from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';
import { useDeviceLocation } from '../../../hooks/useDeviceLocation';
import { pickupLocationContext } from '../../../lib/deviceLocation';
import { LocationPrimerCard } from '../../../components/LocationPrimerCard';
import { money } from '../../../lib/money';
import { PinGlyph, Card, CircleChip, IconChip, LabeledInput, PillButton, T, TonePill, cardShadow } from '../../../kit';
import { RouteCard } from './TaxiScreen';
import type { PickedPlace } from './DestinationSearchScreen';

type Size = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
type Speed = 'STANDARD' | 'EXPRESS' | 'RUSH';

// Size reads as text-first (S/M/L/XL letter + hint carry it — the F8 size
// language); speeds keep one glyph each. Courier-specific icon inventions
// were cut rather than drawn off-hand (set discipline, logged in the journal).
const SIZES: { key: Size; letter: string; label: string; hint: string }[] = [
  { key: 'SMALL', letter: 'S', label: 'Small', hint: 'Documents, keys' },
  { key: 'MEDIUM', letter: 'M', label: 'Medium', hint: 'Fits a shoebox' },
  { key: 'LARGE', letter: 'L', label: 'Large', hint: 'Fits a backpack' },
  { key: 'EXTRA_LARGE', letter: 'XL', label: 'Extra large', hint: 'Bulky or heavy' },
];
const SPEEDS: { key: Speed; label: string; icon: React.ComponentProps<typeof Feather>['name']; hint: string }[] = [
  { key: 'STANDARD', label: 'Standard', icon: 'clock', hint: 'Lowest price' },
  { key: 'EXPRESS', label: 'Express', icon: 'fast-forward', hint: 'Faster' },
  { key: 'RUSH', label: 'Rush', icon: 'zap', hint: 'Fastest' },
];

function prettyStatus(s: string) {
  return (s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
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

/** Kit selectable option card: icon chip + label + hint; brand tint when active.
 *  `wide` = half-width row card (2×2 grid); default = equal column (3-across). */
function OptionCard({
  icon,
  letter,
  label,
  hint,
  active,
  onPress,
  wide,
}: {
  icon?: React.ComponentProps<typeof Feather>['name'];
  letter?: string;
  label: string;
  hint: string;
  active: boolean;
  onPress: () => void;
  wide?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={wide ? { flexBasis: '47%', flexGrow: 1 } : { flex: 1 }}>
      {({ pressed }) => (
        <View
          style={[
            {
              borderRadius: radius.lg,
              borderWidth: 1,
              paddingVertical: space.md,
              paddingHorizontal: space.md,
              borderColor: active ? color.brand[500] : color.border.subtle,
              backgroundColor: active ? color.brand[50] : color.surface.base,
              opacity: pressed ? 0.85 : 1,
            },
            wide ? { flexDirection: 'row', alignItems: 'center', gap: space.md } : { alignItems: 'center' },
            !active ? cardShadow : null,
          ]}
        >
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? color.brand[500] : color.brand[50],
            }}
          >
            {letter ? (
              <T variant="bodyStrong" style={{ color: active ? color.white : color.brand[600] }}>
                {letter}
              </T>
            ) : icon ? (
              <Feather name={icon} size={17} color={active ? color.white : color.brand[600]} />
            ) : null}
          </View>
          <View style={wide ? { flex: 1 } : { alignItems: 'center', marginTop: 6 }}>
            <T variant="label" weight="semibold" tone={active ? 'deep' : 'ink'} numberOfLines={1}>
              {label}
            </T>
            <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 1 }}>
              {hint}
            </T>
          </View>
        </View>
      )}
    </Pressable>
  );
}

export function CourierScreen({ navigation }: any) {
  const { height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { latitude, longitude, address, status: locationStatus } = useLocationStore();
  const { resolve: requestLocation } = useDeviceLocation({ refreshOnMount: false });
  const locationContext = pickupLocationContext(latitude, longitude, locationStatus);
  const { data: recent } = useCourierOrders<any[]>();
  const send = useSendCourier();

  const [pickupOverride, setPickupOverride] = useState<PickedPlace | undefined>();
  const [dropoff, setDropoff] = useState<PickedPlace | undefined>();
  const [size, setSize] = useState<Size>('MEDIUM');
  const [speed, setSpeed] = useState<Speed>('STANDARD');
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [description, setDescription] = useState('');

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
          latitude: pickup?.lat ?? locationContext.center.latitude,
          longitude: pickup?.lng ?? locationContext.center.longitude,
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
          if (res?.orderId) navigation?.navigate?.('Delivery', { orderId: res.orderId });
        },
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        region={region}
        showsUserLocation={locationContext.showUserLocation}
        // The sheet covers the lower half — keep pins framed in the visible top.
        mapPadding={{ top: 0, right: 0, bottom: Math.round(winH * 0.46), left: 0 }}
      >
        {pickupLL ? (
          <Marker coordinate={pickupLL} anchor={{ x: 0.5, y: 0.5 }} title="From">
            <View
              style={[
                { width: 16, height: 16, borderRadius: 8, backgroundColor: color.text.primary, borderWidth: 3, borderColor: color.white },
                cardShadow,
              ]}
            />
          </Marker>
        ) : null}
        {dropoffLL ? (
          <Marker coordinate={dropoffLL} title="To">
            <PinGlyph size={34} color={color.brand[600]} />
          </Marker>
        ) : null}
        {pickupLL && dropoffLL ? (
          <Polyline coordinates={[pickupLL, dropoffLL]} strokeColor={color.brand[500]} strokeWidth={4} />
        ) : null}
      </MapView>

      <View style={{ position: 'absolute', top: insets.top + space.sm, left: space['2xl'] }}>
        <CircleChip icon="chevron-left" onPress={() => navigation?.goBack?.()} />
      </View>

      <BottomSheet
        index={0}
        snapPoints={['52%', '92%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: color.surface.subtle, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }}
        handleIndicatorStyle={{ backgroundColor: color.border.strong, width: 44 }}
      >
        <BottomSheetScrollView
          contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}
          keyboardShouldPersistTaps="handled"
        >
          <T variant="title" style={{ marginBottom: space.lg }}>
            Send a package
          </T>

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
            pickupTitle="From"
            dropoffTitle="To"
            pickupLabel={pickup?.label}
            dropoffLabel={dropoff?.label}
            onPickup={() => openSearch((p) => setPickupOverride(p), 'Pickup')}
            onDropoff={() => openSearch((p) => setDropoff(p), 'Deliver to?')}
          />

          {/* Package size — 2×2 so "Documents, keys" never truncates */}
          <T variant="heading" style={{ marginTop: space.xl, marginBottom: space.md }}>
            Package size
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: space.md, rowGap: space.md }}>
            {SIZES.map((s) => (
              <OptionCard key={s.key} wide letter={s.letter} label={s.label} hint={s.hint} active={s.key === size} onPress={() => setSize(s.key)} />
            ))}
          </View>

          {/* Speed */}
          <T variant="heading" style={{ marginTop: space.xl, marginBottom: space.md }}>
            How fast?
          </T>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            {SPEEDS.map((s) => (
              <OptionCard key={s.key} icon={s.icon} label={s.label} hint={s.hint} active={s.key === speed} onPress={() => setSpeed(s.key)} />
            ))}
          </View>

          {/* Recipient */}
          <T variant="heading" style={{ marginTop: space.xl, marginBottom: space.md }}>
            Recipient
          </T>
          <View style={{ gap: space.md }}>
            <LabeledInput icon="user" placeholder="Recipient name" value={recipientName} onChangeText={setRecipientName} />
            <LabeledInput icon="phone" placeholder="Recipient phone" keyboardType="phone-pad" value={recipientPhone} onChangeText={setRecipientPhone} />
            <LabeledInput icon="box" placeholder="What's inside? (optional)" value={description} onChangeText={setDescription} />
          </View>

          {/* Price */}
          {dropoffPoint ? (
            <Card style={{ marginTop: space.xl }}>
              {estimating && !estimate ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                  <Feather name="loader" size={16} color={color.text.muted} />
                  <T variant="body" tone="muted">
                    Calculating fare…
                  </T>
                </View>
              ) : estimate ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View>
                    <T variant="micro" tone="muted">
                      Delivery fee
                    </T>
                    <T variant="displayXl" tone="brand" style={{ marginTop: 2 }}>
                      {money(estimate.totalFee)}
                    </T>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <T variant="label" weight="semibold" tone="muted">
                      {estimate.distanceKm} km · ~{estimate.estimatedMinutes} min
                    </T>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                      <Feather name="dollar-sign" size={13} color={color.success} />
                      <T variant="caption" weight="semibold" tone="muted">
                        No fees · pay cash
                      </T>
                    </View>
                  </View>
                </View>
              ) : (
                <T variant="body" tone="muted">
                  Couldn&apos;t get a price. Try another destination.
                </T>
              )}
            </Card>
          ) : null}

          {errMsg ? (
            <T variant="label" tone="error" center style={{ marginTop: space.lg }}>
              {errMsg}
            </T>
          ) : null}

          <PillButton
            label={estimate ? `Send parcel · ${money(estimate.totalFee)}` : 'Send parcel'}
            style={{ marginTop: space.xl }}
            loading={send.isPending}
            disabled={!valid}
            onPress={onSend}
          />
          {!valid && dropoffPoint ? (
            <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
              Add the recipient&apos;s name and phone to continue.
            </T>
          ) : null}

          {/* Recent sends */}
          {recent && recent.length > 0 ? (
            <View style={{ marginTop: space['2xl'] }}>
              <T variant="heading" style={{ marginBottom: space.md }}>
                Recent sends
              </T>
              {recent.slice(0, 5).map((o: any) => (
                <Pressable key={o.id} onPress={() => navigation?.navigate?.('Delivery', { orderId: o.id })}>
                  {({ pressed }) => (
                    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md, opacity: pressed ? 0.8 : 1 }}>
                      <IconChip icon="package" />
                      <View style={{ flex: 1 }}>
                        <T variant="label" weight="semibold" numberOfLines={1}>
                          To {o.courierRecipientName ?? o.deliveryAddress ?? 'recipient'}
                        </T>
                        <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                          #{o.orderNumber} · {money(o.totalAmount)}
                        </T>
                      </View>
                      <TonePill
                        label={prettyStatus(o.status)}
                        tone={o.status === 'DELIVERED' || o.status === 'COMPLETED' ? 'success' : 'brand'}
                      />
                    </Card>
                  )}
                </Pressable>
              ))}
            </View>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}
