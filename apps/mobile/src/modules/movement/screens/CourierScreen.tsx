/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
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
import { PinGlyph, Card, CircleChip, LabeledInput, Pictogram, PillButton, T, TonePill, cardShadow } from '../../../kit';
import { JourneyRail } from '../../../kit/journey-rail';
import { VERTICAL_TINT } from '../../../kit/vertical-tint';
import type { PickedPlace } from './DestinationSearchScreen';

type Size = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
type Speed = 'STANDARD' | 'EXPRESS' | 'RUSH';

const SEND_TINT = VERTICAL_TINT.send ?? { bg: color.brand[50], ink: color.brand[600] };

// Capacity is phrased in objects people can judge without a tape measure.
// EXTRA_LARGE is the only tier that excludes motorcycles, so the trunk promise
// remains mechanically true in dispatch.
const SIZES: { key: Size; letter: string; label: string; hint: string }[] = [
  { key: 'SMALL', letter: 'S', label: 'Fits one hand', hint: 'Keys or documents' },
  { key: 'MEDIUM', letter: 'M', label: 'A shopping bag', hint: 'Bike-friendly' },
  // [Wave 3 vs reference 12] LARGE was simply never offered — the reference
  // draws four tiers, the API accepts it, and dispatch has priced and proven
  // it (a LARGE parcel is a motorcycle's ceiling; P-19/P-20 pinned exactly
  // that). A sender with a backpack-sized box was forced to over-declare XL
  // and lose every motorbike in town.
  { key: 'LARGE', letter: 'L', label: 'Fits a backpack', hint: 'Motorbike or car' },
  { key: 'EXTRA_LARGE', letter: 'XL', label: 'Needs a trunk', hint: 'Car or larger' },
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

/** Text-first option card with Send's identity tint reserved for selection. */
function OptionCard({
  icon,
  letter,
  label,
  hint,
  active,
  onPress,
}: {
  icon?: React.ComponentProps<typeof Feather>['name'];
  letter?: string;
  label: string;
  hint: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${hint}`}
      accessibilityState={{ selected: active }}
      style={{ flex: 1 }}
    >
      {({ pressed }) => (
        <View
          style={[
            {
              borderRadius: radius.lg,
              borderWidth: active ? space.xs / 2 : StyleSheet.hairlineWidth,
              minHeight: space['5xl'] * 2 + space['2xl'],
              paddingVertical: space.md,
              paddingHorizontal: space.sm,
              borderColor: active ? SEND_TINT.ink : color.border.subtle,
              backgroundColor: active ? SEND_TINT.bg : color.surface.base,
              opacity: pressed ? 0.85 : 1,
              alignItems: 'center',
              justifyContent: 'center',
              flex: 1,
            },
            !active ? cardShadow : null,
          ]}
        >
          <View
            style={{
              width: space['3xl'],
              height: space['3xl'],
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: SEND_TINT.bg,
            }}
          >
            {letter ? (
              <T variant="bodyStrong" style={{ color: SEND_TINT.ink }}>
                {letter}
              </T>
            ) : icon ? (
              <Feather name={icon} size={16} color={SEND_TINT.ink} />
            ) : null}
          </View>
          <View style={{ alignItems: 'center', marginTop: space.sm }}>
            <T
              variant="label"
              weight="semibold"
              center
              style={active ? { color: SEND_TINT.ink } : undefined}
            >
              {label}
            </T>
            <T variant="caption" tone="muted" center style={{ marginTop: space.xs }}>
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

  const { data: estimate, isFetching: estimating, isError: estimateFailed, refetch: refetchEstimate } = useCourierEstimate<any>(pickupPoint, dropoffPoint, size, speed);

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
        <CircleChip icon="chevron-left" label="Back" onPress={() => navigation?.goBack?.()} />
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
          <T variant="title">
            Send a parcel
          </T>
          <T variant="body" tone="muted" style={{ marginTop: space.xs, marginBottom: space.lg }}>
            One connected journey, from pickup to drop-off.
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

          <Card>
            <JourneyRail
              pictogram="send"
              tint={SEND_TINT}
              start={(
                <Pressable
                  onPress={() => openSearch((p) => setPickupOverride(p), 'Pickup')}
                  accessibilityRole="button"
                  accessibilityLabel={pickup?.label ? `Pickup. ${pickup.label}` : 'Set pickup location'}
                  accessibilityHint="Opens location search"
                >
                  <View pointerEvents="none">
                    <LabeledInput
                      value={pickup?.label ?? ''}
                      placeholder="Set pickup location"
                      editable={false}
                      caretHidden
                      showSoftInputOnFocus={false}
                      accessible={false}
                      right={<T variant="micro" tone="muted">FROM</T>}
                    />
                  </View>
                </Pressable>
              )}
              end={(
                <Pressable
                  onPress={() => openSearch((p) => setDropoff(p), 'Deliver to?')}
                  accessibilityRole="button"
                  accessibilityLabel={dropoff?.label ? `Drop-off. ${dropoff.label}` : 'Set drop-off location'}
                  accessibilityHint="Opens location search"
                >
                  <View pointerEvents="none">
                    <LabeledInput
                      value={dropoff?.label ?? ''}
                      placeholder="Set drop-off location"
                      editable={false}
                      caretHidden
                      showSoftInputOnFocus={false}
                      accessible={false}
                      right={<T variant="micro" tone="muted">TO</T>}
                    />
                  </View>
                </Pressable>
              )}
            />
          </Card>

          {/* Parcel capacity */}
          <T variant="heading" style={{ marginTop: space.xl, marginBottom: space.md }}>
            What fits?
          </T>
          {/* [Wave 3 vs reference 12] Four tiers sit as the reference's 2×2 —
              four in one row would crush every label. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {SIZES.map((s) => (
              <View key={s.key} style={{ flexBasis: '47%', flexGrow: 1 }}>
                <OptionCard letter={s.letter} label={s.label} hint={s.hint} active={s.key === size} onPress={() => setSize(s.key)} />
              </View>
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
              ) : estimateFailed && !estimate ? (
                // [WR-028] A failed quote must not blame the recipient fields
                // (the CTA caption) or sit as a blank card.
                <View>
                  <T variant="body" tone="error">
                    We couldn't price this trip.
                  </T>
                  <PillButton label="Retry" size="md" variant="soft" style={{ marginTop: space.sm, alignSelf: 'flex-start' }} onPress={() => refetchEstimate()} />
                </View>
              ) : estimate ? (
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space.md }}>
                    <View>
                      <T variant="micro" tone="muted">
                        Delivery fee
                      </T>
                      {/* [Wave 3 vs reference 12 · law 3] MONEY IS INK, never
                          brand — red stops meaning "act" when it also means
                          "$1,100". The reference sets the fee in ink. */}
                      <T variant="displayXl" style={{ marginTop: space.xs }}>
                        {money(estimate.totalFee)}
                      </T>
                    </View>
                    <T variant="label" weight="semibold" tone="muted">
                      {estimate.distanceKm} km · ~{estimate.estimatedMinutes} min
                    </T>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md }}>
                    <Feather name="dollar-sign" size={12} color={color.text.secondary} />
                    <T variant="caption" weight="semibold" tone="muted" style={{ flex: 1 }}>
                      Cash or MMG, straight to your rider. Swift adds nothing.
                    </T>
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
            // [Wave 3 vs reference 12] The price rides the button — "Send
            // parcel · $1,100" — the same commit-with-the-number the taxi
            // request button already makes.
            label={estimate ? `Send parcel · ${money(estimate.totalFee)}` : 'Send parcel'}
            style={{ marginTop: space.xl }}
            loading={send.isPending}
            disabled={!valid}
            onPress={onSend}
          />
          {!valid && dropoffPoint ? (
            <T variant="caption" tone="muted" center style={{ marginTop: space.sm }}>
              {estimateFailed && !estimate
                ? 'Waiting on the price — retry the quote above.'
                : "Add the recipient's name and phone to continue."}
            </T>
          ) : null}

          {/* Recent sends */}
          {recent && recent.length > 0 ? (
            <View style={{ marginTop: space['2xl'] }}>
              <T variant="heading" style={{ marginBottom: space.md }}>
                Recent sends
              </T>
              {recent.slice(0, 5).map((o: any) => (
                <Pressable
                  key={o.id}
                  onPress={() => navigation?.navigate?.('Delivery', { orderId: o.id })}
                  accessibilityRole="button"
                  accessibilityLabel={`Send to ${o.courierRecipientName ?? o.deliveryAddress ?? 'recipient'}. Order ${o.orderNumber}. ${money(o.totalAmount)}. ${prettyStatus(o.status)}`}
                  accessibilityHint="Opens delivery details"
                >
                  {({ pressed }) => (
                    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md, opacity: pressed ? 0.8 : 1 }}>
                      <View
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={{
                          width: space['5xl'],
                          height: space['5xl'],
                          borderRadius: radius.md,
                          backgroundColor: SEND_TINT.bg,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Pictogram name="send" size={space['2xl']} color={SEND_TINT.ink} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <T variant="label" weight="semibold" numberOfLines={1}>
                          To {o.courierRecipientName ?? o.deliveryAddress ?? 'recipient'}
                        </T>
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm, marginTop: space.xs }}>
                          <T variant="caption" tone="muted">
                            #{o.orderNumber}
                          </T>
                          <T variant="numM">
                            {money(o.totalAmount)}
                          </T>
                        </View>
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
