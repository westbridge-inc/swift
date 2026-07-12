/** @jsxImportSource react */
import React, { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Card, EmptyState, LabeledInput, PillButton, PopupCard, Screen, T, cardShadow } from '../../../kit';
import { Stars } from '../../../kit/controls';
import { useMoverKind, useActiveJob, useDriverAction, useRiderAction, useRateCustomer } from '../../../hooks';
import { jobAmount, RoutePair } from '../shared';

type DriverAction = 'en-route' | 'arrived' | 'verify-pin' | 'start' | 'complete';

// The ONE next step a driver takes, driven by the real backend status:
// DRIVER_ASSIGNED → EN_ROUTE → ARRIVED → [verify PIN] → start → RIDE_IN_PROGRESS → complete.
function driverStep(job: any): { label: string; action: DriverAction; pin?: boolean } | null {
  const s = String(job?.status ?? '').toUpperCase();
  if (s === 'DRIVER_ASSIGNED') return { label: "I'm on the way", action: 'en-route' };
  if (s === 'DRIVER_EN_ROUTE') return { label: "I've arrived", action: 'arrived' };
  if (s === 'DRIVER_ARRIVED') return job.ridePinVerified ? { label: 'Start trip', action: 'start' } : { label: 'Verify rider PIN', action: 'verify-pin', pin: true };
  if (s === 'RIDE_IN_PROGRESS') return { label: 'Complete trip', action: 'complete' };
  return null;
}

const DRIVER_STEPS = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'];
const RIDER_STEPS = ['RIDER_ASSIGNED', 'PICKED_UP', 'DELIVERED'];
const DRIVER_STEP_LABELS = ['Assigned', 'En route', 'Arrived', 'Riding'];
const RIDER_STEP_LABELS = ['Assigned', 'Picked up', 'Delivered'];

/** Where this job stands — the same statuses the state machine enforces. */
function StatusStepper({ status, isDriver }: { status?: string; isDriver: boolean }) {
  const steps = isDriver ? DRIVER_STEPS : RIDER_STEPS;
  const labels = isDriver ? DRIVER_STEP_LABELS : RIDER_STEP_LABELS;
  const s = String(status ?? '').toUpperCase();
  let idx = steps.indexOf(s);
  if (idx < 0) idx = s === 'COMPLETED' || s === 'DELIVERED' ? steps.length - 1 : 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.md }}>
      {steps.map((_, i) => (
        <React.Fragment key={i}>
          <View style={{ alignItems: 'center' }}>
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: i <= idx ? color.brand[500] : color.border.subtle,
              }}
            />
            <T variant="caption" tone={i <= idx ? 'deep' : 'faint'} weight={i === idx ? 'semibold' : 'regular'} style={{ marginTop: 3 }}>
              {labels[i]}
            </T>
          </View>
          {i < steps.length - 1 ? (
            <View style={{ flex: 1, height: 2, marginHorizontal: 4, marginBottom: 16, borderRadius: 1, backgroundColor: i < idx ? color.brand[500] : color.border.subtle }} />
          ) : null}
        </React.Fragment>
      ))}
    </View>
  );
}

export function ActiveJobScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { kind } = useMoverKind();
  const active = useActiveJob(kind);
  const driverAct = useDriverAction();
  const riderAct = useRiderAction();
  const rate = useRateCustomer();
  const [pin, setPin] = useState('');
  const [ratePopup, setRatePopup] = useState<{ orderId: string; name: string } | null>(null);
  const [stars, setStars] = useState(5);
  const job: any = active.data;

  if (!job && !ratePopup) {
    return (
      <Screen>
        <EmptyState icon="map-pin" title="No active job" body="When you accept a job it'll show up here." />
        <View style={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}>
          <PillButton label="Back" variant="soft" onPress={() => navigation?.goBack?.()} />
        </View>
      </Screen>
    );
  }

  const pickup = job?.pickupLat != null ? { latitude: Number(job.pickupLat), longitude: Number(job.pickupLng) } : null;
  const drop = job?.deliveryLat != null ? { latitude: Number(job.deliveryLat), longitude: Number(job.deliveryLng) } : null;
  const region =
    pickup && drop
      ? {
          latitude: (pickup.latitude + drop.latitude) / 2,
          longitude: (pickup.longitude + drop.longitude) / 2,
          latitudeDelta: Math.max(0.02, Math.abs(pickup.latitude - drop.latitude) * 2.2),
          longitudeDelta: Math.max(0.02, Math.abs(pickup.longitude - drop.longitude) * 2.2),
        }
      : pickup
        ? { ...pickup, latitudeDelta: 0.02, longitudeDelta: 0.02 }
        : undefined;

  const busy = driverAct.isPending || riderAct.isPending;
  const isDriver = kind === 'DRIVER';
  const cust: any = job?.customer ?? job?.user ?? null;
  const custName = cust ? [cust.firstName, cust.lastName].filter(Boolean).join(' ') : null;
  const inProgress = String(job?.status ?? '').toUpperCase() === 'RIDE_IN_PROGRESS';
  const navTarget = inProgress ? drop : pickup;
  const openNav = () => {
    if (!navTarget) return;
    const q = `${navTarget.latitude},${navTarget.longitude}`;
    Linking.openURL(`maps://?daddr=${q}`).catch(() => Linking.openURL(`https://maps.google.com/?daddr=${q}`));
  };
  const step = isDriver && job ? driverStep(job) : null;

  const runDriverStep = () => {
    if (!step || !job) return;
    driverAct.mutate(
      { id: job.id, action: step.action, ...(step.pin ? { pin } : {}) },
      {
        onSuccess: () => {
          // Trip done → rate the passenger while it's fresh (DRIVER_TO_CUSTOMER).
          if (step.action === 'complete') {
            setStars(5);
            setRatePopup({ orderId: job.id, name: custName ?? 'your passenger' });
          }
        },
      },
    );
  };

  const closeRating = () => {
    setRatePopup(null);
    navigation?.goBack?.();
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.base }}>
      {job ? (
        <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} initialRegion={region} showsUserLocation>
          {pickup ? <Marker coordinate={pickup} title="Pickup" /> : null}
          {drop ? <Marker coordinate={drop} title="Drop-off" pinColor={color.brand[500]} /> : null}
          {pickup && drop ? <Polyline coordinates={[pickup, drop]} strokeColor={color.brand[500]} strokeWidth={4} /> : null}
        </MapView>
      ) : (
        <View style={{ flex: 1 }} />
      )}

      <View style={{ position: 'absolute', top: insets.top, left: 0, zIndex: 10, padding: space.lg }}>
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={10}>
          {({ pressed }) => (
            <View style={[{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base, opacity: pressed ? 0.7 : 1 }, cardShadow]}>
              <Feather name="chevron-left" size={22} color={color.text.primary} />
            </View>
          )}
        </Pressable>
      </View>

      {job ? (
        <BottomSheet index={0} snapPoints={['52%', '88%']} enableDynamicSizing={false} backgroundStyle={{ backgroundColor: color.surface.subtle }}>
          <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }}>
            {/* Route + fare + live progress */}
            <Card style={{ marginBottom: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
                  {job.orderNumber ? `ORDER #${job.orderNumber}` : 'CURRENT JOB'}
                </T>
                <T variant="caption" weight="semibold" tone="muted">
                  {String(job.status ?? '').replace(/_/g, ' ').toLowerCase()}
                </T>
              </View>
              <T variant="title" style={{ marginTop: space.sm }}>
                {jobAmount(job)} <T variant="label" tone="muted">· cash</T>
              </T>
              {/* Kitchen signal (readyAt rides outside the status lane once a
                  rider is assigned) — tells the rider the bag is on the counter. */}
              {!isDriver && (job.readyAt || String(job.status).toUpperCase() === 'READY_FOR_PICKUP') ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm }}>
                  <MaterialCommunityIcons name="check-circle" size={15} color={color.success} />
                  <T variant="label" weight="semibold" style={{ color: color.success }}>
                    Order is packed and ready for pickup
                  </T>
                </View>
              ) : null}
              <StatusStepper status={job.status} isDriver={isDriver} />
              <View style={{ marginTop: space.md }}>
                <RoutePair pickup={job.pickupAddress ?? 'Pickup'} dropoff={job.deliveryAddress ?? job.dropoffAddress ?? 'Drop-off'} />
              </View>
            </Card>

            {/* Passenger / customer */}
            {cust ? (
              <Card style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.md }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[500] }}>
                  <T variant="body" weight="bold" tone="onBrand">
                    {(cust.firstName ?? 'C').charAt(0).toUpperCase()}
                  </T>
                </View>
                <View style={{ flex: 1, marginLeft: space.md }}>
                  <T variant="caption" tone="muted">
                    {isDriver ? 'Passenger' : 'Customer'}
                  </T>
                  <T variant="body" weight="bold" numberOfLines={1}>
                    {custName ?? 'Customer'}
                  </T>
                </View>
                {cust.phone ? (
                  <Pressable onPress={() => Linking.openURL(`tel:${cust.phone}`)} hitSlop={6}>
                    {({ pressed }) => (
                      <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.subtle, marginRight: space.sm, opacity: pressed ? 0.7 : 1 }}>
                        <Feather name="phone" size={17} color={color.success} />
                      </View>
                    )}
                  </Pressable>
                ) : null}
                <Pressable onPress={() => navigation.navigate('Chat', { orderId: job.id, title: custName ?? 'Customer' })} hitSlop={6}>
                  {({ pressed }) => (
                    <View style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.subtle, opacity: pressed ? 0.7 : 1 }}>
                      <Feather name="message-circle" size={17} color={color.brand[500]} />
                    </View>
                  )}
                </Pressable>
              </Card>
            ) : null}

            {/* Navigate */}
            {navTarget ? <PillButton label={`Navigate to ${inProgress ? 'drop-off' : 'pickup'}`} variant="outline" style={{ marginBottom: space.md }} onPress={openNav} /> : null}

            {/* The single next step (driver) or handover/deliver (rider) */}
            {isDriver ? (
              step ? (
                <>
                  {step.pin ? (
                    <View style={{ marginBottom: space.md }}>
                      <LabeledInput value={pin} onChangeText={setPin} placeholder="Enter rider's PIN" keyboardType="number-pad" maxLength={6} />
                      <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                        The passenger has this PIN in their app — verifying it proves you picked up the right person.
                      </T>
                    </View>
                  ) : null}
                  <PillButton label={step.label} loading={busy} disabled={busy || (!!step.pin && pin.length < 4)} onPress={runDriverStep} />
                </>
              ) : (
                <T variant="label" tone="muted" center style={{ paddingVertical: space.md }}>
                  Trip complete.
                </T>
              )
            ) : (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: color.brand[50], padding: space.md, marginBottom: space.md }}>
                  <Feather name="alert-circle" size={15} color={color.brand[600]} style={{ marginTop: 1 }} />
                  <T variant="caption" weight="semibold" tone="deep" style={{ flex: 1 }}>
                    Golden rule: collect the cash BEFORE handing over the order.
                  </T>
                </View>
                <PillButton label="Confirm payment & hand over" variant="outline" disabled={busy} onPress={() => riderAct.mutate({ id: job.id, action: 'handover' })} />
                <PillButton label="Mark delivered" style={{ marginTop: space.md }} loading={riderAct.isPending} disabled={busy} onPress={() => riderAct.mutate({ id: job.id, action: 'delivered' })} />
              </>
            )}
          </BottomSheetScrollView>
        </BottomSheet>
      ) : null}

      {/* Post-trip passenger rating — DRIVER_TO_CUSTOMER, once per ride */}
      <PopupCard visible={!!ratePopup} onClose={closeRating}>
        <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[500] }}>
          <Feather name="check" size={34} color={color.white} />
        </View>
        <T variant="title" center style={{ marginTop: space.lg }}>
          Trip complete
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          Cash collected — 100% yours. How was {ratePopup?.name}?
        </T>
        <View style={{ marginTop: space.lg }}>
          <Stars value={stars} size={34} gap={6} onRate={setStars} />
        </View>
        <PillButton
          label={rate.isPending ? 'Sending…' : 'Rate passenger'}
          style={{ alignSelf: 'stretch', marginTop: space['2xl'] }}
          disabled={rate.isPending}
          onPress={() => {
            if (!ratePopup) return;
            rate.mutate({ id: ratePopup.orderId, score: stars }, { onSettled: closeRating });
          }}
        />
        <PillButton label="Skip" variant="soft" style={{ alignSelf: 'stretch', marginTop: space.md }} onPress={closeRating} />
      </PopupCard>
    </View>
  );
}
