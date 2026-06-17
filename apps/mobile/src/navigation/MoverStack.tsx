import React, { useState } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Spinner, Badge } from '../components/ui';
import { DocumentChecklist } from '../components/onboarding/DocumentChecklist';
import {
  useVerificationStatus,
  useBecomePartner,
  useMoverKind,
  useEarningsToday,
  useAvailableJobs,
  useActiveJob,
  useGoOnline,
  useGoOffline,
  useAcceptJob,
  useDriverAction,
  useRiderAction,
  type MoverKind,
} from '../hooks';
import { useAuthStore } from '../stores/authStore';
import { money } from '../lib/money';

const Stack = createNativeStackNavigator();

const VTYPES = [
  { key: 'BICYCLE', label: 'Bicycle' },
  { key: 'MOTORCYCLE', label: 'Motorcycle' },
  { key: 'CAR', label: 'Car (taxi)' },
] as const;

const FIELD = 'mb-sm rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary';

function jobAmount(j: any) {
  return money(j?.totalAmount ?? j?.taxiFareTotal ?? j?.fare ?? 0);
}

// ─── Onboarding ──────────────────────────────────────────────────────────────

function VehicleSetup({ onDone }: { onDone: () => void }) {
  const become = useBecomePartner();
  const [vt, setVt] = useState<'BICYCLE' | 'MOTORCYCLE' | 'CAR'>('MOTORCYCLE');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [colr, setColr] = useState('');
  const [plate, setPlate] = useState('');
  const isCar = vt === 'CAR';
  const valid = !isCar || (!!make && !!model && !!year && !!colr && !!plate);

  const submit = () => {
    become.mutate(
      {
        role: 'MOVER',
        vehicleType: vt,
        vehicle: isCar ? { make, model, year: Number(year) || 0, color: colr, licensePlate: plate } : undefined,
      },
      { onSuccess: onDone },
    );
  };

  return (
    <Card className="mb-lg">
      <Heading size="lg" className="mb-sm">
        Your vehicle
      </Heading>
      <View className="mb-md flex-row" style={{ gap: 8 }}>
        {VTYPES.map((v) => {
          const active = v.key === vt;
          return (
            <Pressable
              key={v.key}
              onPress={() => setVt(v.key)}
              className={
                active
                  ? 'flex-1 items-center rounded-lg border border-brand-500 bg-brand-50 py-sm'
                  : 'flex-1 items-center rounded-lg border border-border-subtle py-sm'
              }
            >
              <Text className={active ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>{v.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {isCar ? (
        <>
          <TextInput value={make} onChangeText={setMake} placeholder="Make (e.g. Toyota)" placeholderTextColor={color.text.muted} className={FIELD} />
          <TextInput value={model} onChangeText={setModel} placeholder="Model (e.g. Allion)" placeholderTextColor={color.text.muted} className={FIELD} />
          <TextInput value={year} onChangeText={setYear} placeholder="Year" placeholderTextColor={color.text.muted} keyboardType="number-pad" className={FIELD} />
          <TextInput value={colr} onChangeText={setColr} placeholder="Colour" placeholderTextColor={color.text.muted} className={FIELD} />
          <TextInput value={plate} onChangeText={setPlate} placeholder="Licence plate" placeholderTextColor={color.text.muted} autoCapitalize="characters" className={FIELD} />
        </>
      ) : null}
      {become.isError ? <Text className="mb-sm text-sm text-error">Couldn&apos;t save. Try again.</Text> : null}
      <Button label={become.isPending ? 'Saving…' : 'Save vehicle'} disabled={!valid || become.isPending} onPress={submit} />
    </Card>
  );
}

function MoverOnboarding({ status }: { status: any }) {
  const { logout } = useAuthStore();
  const [vehicleSaved, setVehicleSaved] = useState(false);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center justify-between px-lg py-sm">
        <Heading size="2xl">Become a mover</Heading>
        <Pressable onPress={logout} hitSlop={8}>
          <Text className="text-sm text-text-muted">Log out</Text>
        </Pressable>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <View className="mb-md flex-row items-start rounded-lg bg-brand-50 px-lg py-md">
          <Text className="text-base">🛡️</Text>
          <Text className="ml-sm flex-1 text-sm text-brand-700">
            Set up your vehicle and upload your documents. We verify within 24 hours, then you can go online.
          </Text>
        </View>
        {!vehicleSaved ? <VehicleSetup onDone={() => setVehicleSaved(true)} /> : (
          <Card className="mb-lg flex-row items-center">
            <Text className="text-base">✓</Text>
            <Text className="ml-sm flex-1 text-sm font-semibold text-text-primary">Vehicle saved</Text>
          </Card>
        )}
        <DocumentChecklist role="MOVER" status={status} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Operations ──────────────────────────────────────────────────────────────

function MoverOps({ navigation }: any) {
  const { logout } = useAuthStore();
  const { kind, profile, loading } = useMoverKind();
  const k: MoverKind = kind ?? 'RIDER';
  const goOnline = useGoOnline(k);
  const goOffline = useGoOffline(k);
  const accept = useAcceptJob(k);
  const earnings = useEarningsToday(kind);
  const active = useActiveJob(kind);
  const online = !!profile?.isOnline;
  const available = useAvailableJobs(kind, online);

  if (loading || !kind) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  const activeJob = active.data;
  const jobs: any[] = available.data ?? [];
  const errMsg = (goOnline.error as any)?.response?.data?.message;
  const todayTotal = (earnings.data as any)?.total ?? (earnings.data as any)?.todayEarnings ?? 0;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center justify-between px-lg py-sm">
        <Heading size="2xl">{kind === 'DRIVER' ? 'Driver' : 'Rider'}</Heading>
        <Pressable onPress={logout} hitSlop={8}>
          <Text className="text-sm text-text-muted">Log out</Text>
        </Pressable>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <Card className="mb-md flex-row items-center justify-between">
          <View>
            <Text className="text-xs text-text-secondary">Today&apos;s earnings</Text>
            <Heading size="xl">{money(todayTotal)}</Heading>
          </View>
          <Badge label={online ? 'Online' : 'Offline'} tone={online ? 'success' : 'brand'} />
        </Card>

        {errMsg ? <Text className="mb-sm text-center text-sm text-error">{errMsg}</Text> : null}

        <Button
          label={online ? (goOffline.isPending ? 'Going offline…' : 'Go offline') : goOnline.isPending ? 'Going online…' : 'Go online'}
          variant={online ? 'outline' : 'solid'}
          className="mb-lg"
          disabled={goOnline.isPending || goOffline.isPending}
          onPress={() => (online ? goOffline.mutate() : goOnline.mutate())}
        />

        {activeJob ? (
          <Pressable onPress={() => navigation?.navigate?.('ActiveJob')}>
            <Card className="mb-md border-brand-500">
              <Text className="text-xs text-brand-600">Active job</Text>
              <Text className="mt-xs text-base font-semibold" numberOfLines={1}>
                {activeJob.deliveryAddress ?? activeJob.dropoffAddress ?? activeJob.orderNumber ?? 'In progress'}
              </Text>
              <Text className="mt-xs text-sm text-text-secondary">{jobAmount(activeJob)} · tap to manage ›</Text>
            </Card>
          </Pressable>
        ) : online ? (
          jobs.length === 0 ? (
            <Text className="mt-xl text-center text-text-secondary">Waiting for nearby jobs…</Text>
          ) : (
            jobs.map((j) => (
              <Card key={j.id} className="mb-md">
                <Text className="text-base font-semibold" numberOfLines={1}>
                  {j.vendor?.name ?? j.pickupAddress ?? 'New job'}
                </Text>
                <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                  {j.deliveryAddress ?? j.dropoffAddress ?? ''}
                </Text>
                <View className="mt-sm flex-row items-center justify-between">
                  <Text className="text-base font-semibold">{jobAmount(j)}</Text>
                  <Button label={accept.isPending ? '…' : 'Accept'} className="px-xl" disabled={accept.isPending} onPress={() => accept.mutate(j.id)} />
                </View>
              </Card>
            ))
          )
        ) : (
          <Text className="mt-xl text-center text-text-secondary">You&apos;re offline. Go online to receive jobs.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ActiveJobScreen({ navigation }: any) {
  const { kind } = useMoverKind();
  const active = useActiveJob(kind);
  const driverAct = useDriverAction();
  const riderAct = useRiderAction();
  const [pin, setPin] = useState('');
  const job: any = active.data;

  if (!job) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center px-2xl">
          <Text className="text-3xl">📭</Text>
          <Text className="mt-sm text-center text-text-secondary">No active job right now.</Text>
          <Button label="Back" variant="outline" className="mt-md" onPress={() => navigation?.goBack?.()} />
        </View>
      </SafeAreaView>
    );
  }

  const pickup = job.pickupLat != null ? { latitude: Number(job.pickupLat), longitude: Number(job.pickupLng) } : null;
  const drop = job.deliveryLat != null ? { latitude: Number(job.deliveryLat), longitude: Number(job.deliveryLng) } : null;
  const region = pickup && drop
    ? {
        latitude: (pickup.latitude + drop.latitude) / 2,
        longitude: (pickup.longitude + drop.longitude) / 2,
        latitudeDelta: Math.max(0.02, Math.abs(pickup.latitude - drop.latitude) * 2.2),
        longitudeDelta: Math.max(0.02, Math.abs(pickup.longitude - drop.longitude) * 2.2),
      }
    : undefined;
  const busy = driverAct.isPending || riderAct.isPending;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center px-lg py-sm">
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={8}>
          <Text className="text-2xl">‹ Back</Text>
        </Pressable>
        <Text className="ml-md text-base font-semibold">Active job</Text>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        {region ? (
          <View className="mx-lg mb-md overflow-hidden rounded-xl border border-border-subtle" style={{ height: 200 }}>
            <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} initialRegion={region} pointerEvents="none">
              {pickup ? <Marker coordinate={pickup} title="Pickup" /> : null}
              {drop ? <Marker coordinate={drop} title="Drop-off" pinColor={color.brand[500]} /> : null}
            </MapView>
          </View>
        ) : null}

        <View className="px-lg">
          <Card className="mb-md">
            <Text className="text-base font-semibold">{job.orderNumber ? `#${job.orderNumber}` : 'Current job'}</Text>
            <Text className="mt-xs text-sm text-text-secondary">Pickup: {job.pickupAddress ?? '—'}</Text>
            <Text className="mt-xs text-sm text-text-secondary">Drop-off: {job.deliveryAddress ?? job.dropoffAddress ?? '—'}</Text>
            <Text className="mt-sm text-base font-semibold">{jobAmount(job)} · cash</Text>
            <Text className="mt-xs text-xs text-text-muted">Status: {String(job.status ?? '').replace(/_/g, ' ').toLowerCase()}</Text>
          </Card>

          {kind === 'DRIVER' ? (
            <>
              <View className="flex-row flex-wrap" style={{ gap: 8 }}>
                <Button label="On the way" variant="outline" className="flex-1" disabled={busy} onPress={() => driverAct.mutate({ id: job.id, action: 'en-route' })} />
                <Button label="Arrived" variant="outline" className="flex-1" disabled={busy} onPress={() => driverAct.mutate({ id: job.id, action: 'arrived' })} />
              </View>
              <View className="mt-sm flex-row items-center" style={{ gap: 8 }}>
                <TextInput value={pin} onChangeText={setPin} placeholder="Rider PIN" placeholderTextColor={color.text.muted} keyboardType="number-pad" maxLength={4} className="flex-1 rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary" />
                <Button label="Verify" disabled={busy || pin.length < 4} onPress={() => driverAct.mutate({ id: job.id, action: 'verify-pin', pin })} />
              </View>
              <Button label="Start trip" variant="outline" className="mt-sm" disabled={busy} onPress={() => driverAct.mutate({ id: job.id, action: 'start' })} />
              <Button label={driverAct.isPending ? 'Completing…' : 'Complete trip'} className="mt-sm" disabled={busy} onPress={() => driverAct.mutate({ id: job.id, action: 'complete' })} />
            </>
          ) : (
            <>
              <Button label="Picked up (handover)" variant="outline" disabled={busy} onPress={() => riderAct.mutate({ id: job.id, action: 'handover' })} />
              <Button label={riderAct.isPending ? 'Completing…' : 'Mark delivered'} className="mt-sm" disabled={busy} onPress={() => riderAct.mutate({ id: job.id, action: 'delivered' })} />
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

function MoverRoot({ navigation }: any) {
  const { data: status, isLoading } = useVerificationStatus<any>('MOVER');

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return status?.roleVerified ? <MoverOps navigation={navigation} /> : <MoverOnboarding status={status} />;
}

export function MoverStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoverRoot" component={MoverRoot} />
      <Stack.Screen name="ActiveJob" component={ActiveJobScreen} />
    </Stack.Navigator>
  );
}
