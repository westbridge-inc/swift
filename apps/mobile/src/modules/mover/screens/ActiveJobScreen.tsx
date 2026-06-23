import { useState } from 'react';
import { View } from 'react-native';
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

      <BottomSheet index={0} snapPoints={['42%', '85%']} enableDynamicSizing={false}>
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
          <Card className="mb-md">
            <Text className="text-base font-semibold">{job.orderNumber ? `#${job.orderNumber}` : 'Current job'}</Text>
            <Text className="mt-xs text-sm text-text-secondary">Pickup: {job.pickupAddress ?? '—'}</Text>
            <Text className="mt-xs text-sm text-text-secondary">Drop-off: {job.deliveryAddress ?? job.dropoffAddress ?? '—'}</Text>
            <Text className="mt-sm text-base font-semibold">{jobAmount(job)} · cash</Text>
            <Text className="mt-xs text-xs text-text-muted">Status: {String(job.status ?? '').replace(/_/g, ' ').toLowerCase()}</Text>
          </Card>

          <Button
            label="Message customer"
            variant="outline"
            className="mb-md"
            onPress={() => navigation.navigate('Chat', { orderId: job.id, title: 'Customer' })}
          />

          {kind === 'DRIVER' ? (
            <>
              <View className="flex-row flex-wrap" style={{ gap: 8 }}>
                <Button label="On the way" variant="outline" className="flex-1" disabled={busy} onPress={() => driverAct.mutate({ id: job.id, action: 'en-route' })} />
                <Button label="Arrived" variant="outline" className="flex-1" disabled={busy} onPress={() => driverAct.mutate({ id: job.id, action: 'arrived' })} />
              </View>
              <View className="mt-sm flex-row items-center" style={{ gap: 8 }}>
                <Input
                  containerClassName="flex-1"
                  value={pin}
                  onChangeText={setPin}
                  placeholder="Rider PIN"
                  keyboardType="number-pad"
                  maxLength={4}
                />
                <Button label="Verify" disabled={busy || pin.length < 4} onPress={() => driverAct.mutate({ id: job.id, action: 'verify-pin', pin })} />
              </View>
              <Button label="Start trip" variant="outline" className="mt-sm" disabled={busy} onPress={() => driverAct.mutate({ id: job.id, action: 'start' })} />
              <Button label="Complete trip" className="mt-sm" loading={driverAct.isPending} disabled={busy} onPress={() => driverAct.mutate({ id: job.id, action: 'complete' })} />
            </>
          ) : (
            <>
              <Button label="Picked up (handover)" variant="outline" disabled={busy} onPress={() => riderAct.mutate({ id: job.id, action: 'handover' })} />
              <Button label="Mark delivered" className="mt-sm" loading={riderAct.isPending} disabled={busy} onPress={() => riderAct.mutate({ id: job.id, action: 'delivered' })} />
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}
