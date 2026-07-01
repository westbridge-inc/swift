import { useState } from 'react';
import { View, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT, Polyline } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color } from '@swift/ui';
import { Feather } from '@expo/vector-icons';
import { Text, Card, Button, PressableScale, Input, EmptyState } from '../../../components/ui';
import { useMoverKind, useActiveJob, useDriverAction, useRiderAction } from '../../../hooks';
import { money } from '../../../lib/money';

function jobAmount(j: any) {
  return money(j?.totalAmount ?? j?.taxiFareTotal ?? j?.fare ?? 0);
}

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

export function ActiveJobScreen({ navigation }: any) {
  const { kind } = useMoverKind();
  const active = useActiveJob(kind);
  const driverAct = useDriverAction();
  const riderAct = useRiderAction();
  const [pin, setPin] = useState('');
  const job: any = active.data;

  if (!job) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <EmptyState
            icon="map-marker-radius-outline"
            title="No active job"
            body="When you accept a job it'll show up here."
            actionLabel="Back"
            onAction={() => navigation?.goBack?.()}
          />
        </View>
      </SafeAreaView>
    );
  }

  const pickup = job.pickupLat != null ? { latitude: Number(job.pickupLat), longitude: Number(job.pickupLng) } : null;
  const drop = job.deliveryLat != null ? { latitude: Number(job.deliveryLat), longitude: Number(job.deliveryLng) } : null;
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
  const cust: any = job.customer ?? job.user ?? null;
  const custName = cust ? [cust.firstName, cust.lastName].filter(Boolean).join(' ') : null;
  const inProgress = String(job.status ?? '').toUpperCase() === 'RIDE_IN_PROGRESS';
  const navTarget = inProgress ? drop : pickup;
  const openNav = () => {
    if (!navTarget) return;
    const q = `${navTarget.latitude},${navTarget.longitude}`;
    Linking.openURL(`maps://?daddr=${q}`).catch(() => Linking.openURL(`https://maps.google.com/?daddr=${q}`));
  };
  const step = isDriver ? driverStep(job) : null;

  return (
    <View style={{ flex: 1 }} className="bg-surface-base">
      <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} initialRegion={region} showsUserLocation>
        {pickup ? <Marker coordinate={pickup} title="Pickup" /> : null}
        {drop ? <Marker coordinate={drop} title="Drop-off" pinColor={color.brand[500]} /> : null}
        {pickup && drop ? <Polyline coordinates={[pickup, drop]} strokeColor={color.brand[500]} strokeWidth={4} /> : null}
      </MapView>

      <SafeAreaView edges={['top']} style={{ position: 'absolute', top: 0, left: 0, zIndex: 10 }}>
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={10} className="m-lg">
          <View className="h-10 w-10 items-center justify-center rounded-full bg-surface-base" style={{ elevation: 4 }}>
            <Feather name="chevron-left" size={22} color={color.text.primary} />
          </View>
        </PressableScale>
      </SafeAreaView>

      <BottomSheet index={0} snapPoints={['48%', '88%']} enableDynamicSizing={false} backgroundStyle={{ backgroundColor: color.surface.subtle }}>
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
          {/* Route + fare */}
          <Card className="mb-md">
            <View className="flex-row items-center justify-between">
              <Text className="text-xs font-bold uppercase tracking-wider text-text-muted">
                {job.orderNumber ? `Order #${job.orderNumber}` : 'Current job'}
              </Text>
              <Text className="text-xs font-semibold capitalize text-text-secondary">
                {String(job.status ?? '').replace(/_/g, ' ').toLowerCase()}
              </Text>
            </View>
            <Text className="mt-sm font-display text-2xl font-extrabold text-text-primary">
              {jobAmount(job)} <Text className="text-sm font-semibold text-text-muted">· cash</Text>
            </Text>
            <View className="mt-md">
              <View className="flex-row items-center">
                <View style={{ width: 14, alignItems: 'center' }}>
                  <View style={{ width: 11, height: 11, borderRadius: 6, borderWidth: 2.5, borderColor: color.text.muted }} />
                </View>
                <Text className="ml-sm flex-1 text-sm font-semibold text-text-primary" numberOfLines={1}>{job.pickupAddress ?? 'Pickup'}</Text>
              </View>
              <View style={{ marginLeft: 6, height: 14, width: 2, backgroundColor: color.border.subtle, marginVertical: 2 }} />
              <View className="flex-row items-center">
                <View style={{ width: 14, alignItems: 'center' }}>
                  <Feather name="map-pin" size={15} color={color.brand[500]} />
                </View>
                <Text className="ml-sm flex-1 text-sm font-semibold text-text-primary" numberOfLines={1}>{job.deliveryAddress ?? job.dropoffAddress ?? 'Drop-off'}</Text>
              </View>
            </View>
          </Card>

          {/* Passenger / customer */}
          {cust ? (
            <Card className="mb-md flex-row items-center">
              <View className="h-11 w-11 items-center justify-center rounded-full" style={{ backgroundColor: color.brand[500] }}>
                <Text className="font-display text-base font-extrabold text-white">{(cust.firstName ?? 'C').charAt(0).toUpperCase()}</Text>
              </View>
              <View className="ml-md flex-1">
                <Text className="text-xs text-text-muted">{isDriver ? 'Passenger' : 'Customer'}</Text>
                <Text className="text-base font-bold text-text-primary" numberOfLines={1}>{custName ?? 'Customer'}</Text>
              </View>
              {cust.phone ? (
                <PressableScale
                  onPress={() => Linking.openURL(`tel:${cust.phone}`)}
                  className="mr-sm h-10 w-10 items-center justify-center rounded-full bg-surface-subtle"
                >
                  <Feather name="phone" size={17} color={color.success} />
                </PressableScale>
              ) : null}
              <PressableScale
                onPress={() => navigation.navigate('Chat', { orderId: job.id, title: custName ?? 'Customer' })}
                className="h-10 w-10 items-center justify-center rounded-full bg-surface-subtle"
              >
                <Feather name="message-circle" size={17} color={color.brand[500]} />
              </PressableScale>
            </Card>
          ) : null}

          {/* Navigate */}
          {navTarget ? (
            <Button
              label={`Navigate to ${inProgress ? 'drop-off' : 'pickup'}`}
              variant="outline"
              className="mb-md"
              onPress={openNav}
            />
          ) : null}

          {/* The single next step (driver) or handover/deliver (rider) */}
          {isDriver ? (
            step ? (
              <>
                {step.pin ? (
                  <Input
                    containerClassName="mb-sm"
                    value={pin}
                    onChangeText={setPin}
                    placeholder="Enter rider's PIN"
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                ) : null}
                <Button
                  label={busy ? 'Working…' : step.label}
                  loading={busy}
                  disabled={busy || (!!step.pin && pin.length < 4)}
                  onPress={() => driverAct.mutate({ id: job.id, action: step.action, ...(step.pin ? { pin } : {}) })}
                />
              </>
            ) : (
              <Text className="py-md text-center text-sm text-text-muted">Trip complete.</Text>
            )
          ) : (
            <>
              <Button
                label="Confirm payment & hand over"
                variant="outline"
                disabled={busy}
                onPress={() => riderAct.mutate({ id: job.id, action: 'handover' })}
              />
              <Button
                label="Mark delivered"
                className="mt-sm"
                loading={riderAct.isPending}
                disabled={busy}
                onPress={() => riderAct.mutate({ id: job.id, action: 'delivered' })}
              />
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}
