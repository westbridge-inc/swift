import React, { useState } from 'react';
import { View, ScrollView, TextInput, Switch, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Card, Button, Spinner, elevation, PressableScale, EmptyState } from '../components/ui';
import { DocumentChecklist } from '../components/onboarding/DocumentChecklist';
import { ChatScreen } from '../screens/shared/ChatScreen';
import {
  useVerificationStatus,
  useBecomePartner,
  useMoverKind,
  useEarningsToday,
  useAvailableJobs,
  useDispatchOffers,
  useActiveJob,
  useGoOnline,
  useGoOffline,
  useAcceptJob,
  useDriverAction,
  useRiderAction,
  useBroadcastLocation,
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

const CARD_SHADOW = elevation.raised;

function jobAmount(j: any) {
  return money(j?.totalAmount ?? j?.taxiFareTotal ?? j?.fare ?? 0);
}

// ─── Onboarding ──────────────────────────────────────────────────────────────

type VehicleKind = 'BICYCLE' | 'MOTORCYCLE' | 'CAR';

function VehicleSetup({ vt, setVt, onDone }: { vt: VehicleKind; setVt: (v: VehicleKind) => void; onDone: () => void }) {
  const become = useBecomePartner();
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
            <PressableScale
              key={v.key}
              onPress={() => setVt(v.key)}
              className={
                active
                  ? 'flex-1 items-center rounded-lg border border-brand-500 bg-brand-50 py-sm'
                  : 'flex-1 items-center rounded-lg border border-border-subtle py-sm'
              }
            >
              <Text className={active ? 'text-sm font-semibold text-brand-600' : 'text-sm text-text-secondary'}>{v.label}</Text>
            </PressableScale>
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
      <Button label="Save vehicle" loading={become.isPending} disabled={!valid} onPress={submit} />
    </Card>
  );
}

function MoverOnboarding({ status }: { status: any }) {
  const { logout } = useAuthStore();
  const savedVehicle: VehicleKind | null = status?.vehicleType ?? null;
  const [vt, setVt] = useState<VehicleKind>(savedVehicle ?? 'MOTORCYCLE');
  const [vehicleSaved, setVehicleSaved] = useState(!!savedVehicle);
  // Preview the checklist for the selected vehicle (display hint). The saved
  // Driver/Rider entity is what actually gates going online, server-side.
  const { data: preview } = useVerificationStatus<any>('MOVER', vt);
  const checklistStatus = preview ?? status;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center justify-between px-lg py-sm">
        <Heading size="2xl">Become a mover</Heading>
        <PressableScale onPress={logout} hitSlop={8}>
          <Text className="text-sm text-text-muted">Log out</Text>
        </PressableScale>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <View className="mb-md flex-row items-start rounded-lg bg-brand-50 px-lg py-md">
          <MaterialCommunityIcons name="shield-check" size={20} color={color.brand[600]} />
          <Text className="ml-sm flex-1 text-sm text-brand-700">
            Set up your vehicle and upload your documents. We verify within 24 hours, then you can go online.
          </Text>
        </View>
        {!vehicleSaved ? <VehicleSetup vt={vt} setVt={setVt} onDone={() => setVehicleSaved(true)} /> : (
          <Card className="mb-lg flex-row items-center">
            <Feather name="check-circle" size={18} color={color.success} />
            <Text className="ml-sm flex-1 text-sm font-semibold text-text-primary">Vehicle saved</Text>
          </Card>
        )}
        <DocumentChecklist role="MOVER" status={checklistStatus} />
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
  const { offer, dismiss } = useDispatchOffers(kind, online);
  // Stream GPS while online so the customer sees a live, moving driver marker.
  useBroadcastLocation(kind, online);

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

  const tripsToday = (earnings.data as any)?.todayDeliveries ?? (earnings.data as any)?.trips ?? 0;
  const busyToggle = goOnline.isPending || goOffline.isPending;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="flex-row items-center justify-between px-lg py-sm">
        <Heading size="2xl">{kind === 'DRIVER' ? 'Driver' : 'Rider'}</Heading>
        <PressableScale onPress={logout} hitSlop={8}>
          <Text className="text-sm text-text-muted">Log out</Text>
        </PressableScale>
      </View>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={available.isRefetching || earnings.isRefetching}
            onRefresh={() => {
              available.refetch();
              earnings.refetch();
            }}
            tintColor={color.brand[500]}
          />
        }
      >
        {/* Online status + earnings hero */}
        <View className="mb-md overflow-hidden rounded-2xl bg-surface-base" style={CARD_SHADOW}>
          <View className="p-lg">
            <View className="flex-row items-center justify-between">
              <View className="flex-1 pr-md">
                <View className="flex-row items-center">
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: online ? color.success : color.text.muted }} />
                  <Text className="ml-2 text-lg font-bold text-text-primary">{online ? 'You’re online' : 'You’re offline'}</Text>
                </View>
                <Text className="mt-xs text-xs text-text-muted">{online ? 'Receiving jobs nearby' : 'Go online to receive jobs'}</Text>
              </View>
              <Switch
                value={online}
                disabled={busyToggle}
                onValueChange={() => (online ? goOffline.mutate() : goOnline.mutate())}
                trackColor={{ true: color.brand[500], false: color.border.subtle }}
              />
            </View>
            <View className="mt-md flex-row" style={{ gap: 8 }}>
              <View className="flex-1 rounded-xl bg-surface-subtle p-md">
                <MaterialCommunityIcons name="cash" size={18} color={color.brand[500]} />
                <Text className="mt-xs text-lg font-bold text-text-primary">{money(todayTotal)}</Text>
                <Text className="text-xs text-text-muted">Earned today</Text>
              </View>
              <View className="flex-1 rounded-xl bg-surface-subtle p-md">
                <MaterialCommunityIcons name={kind === 'DRIVER' ? 'car' : 'bike-fast'} size={18} color={color.brand[500]} />
                <Text className="mt-xs text-lg font-bold text-text-primary">{tripsToday}</Text>
                <Text className="text-xs text-text-muted">{kind === 'DRIVER' ? 'Trips today' : 'Jobs today'}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* D.3 — cash float headroom (explains "no offers" when the limit is reached). */}
        {profile?.float ? (
          <View className="mb-md rounded-2xl bg-surface-base p-lg" style={CARD_SHADOW}>
            <View className="flex-row items-center justify-between">
              <View className="flex-1 pr-md">
                <Text className="text-xs font-semibold text-text-muted">CASH FLOAT</Text>
                <Text className="mt-xs text-base font-bold text-text-primary">
                  {money(profile.float.available)}{' '}
                  <Text className="text-sm font-normal text-text-muted">of {money(profile.float.limit)} free</Text>
                </Text>
              </View>
              <MaterialCommunityIcons name="cash-multiple" size={22} color={color.brand[500]} />
            </View>
            {online && profile.float.available <= 0 ? (
              <Text className="mt-sm text-xs text-text-secondary">
                Float limit reached — finish a delivery to free it up and receive new cash offers.
              </Text>
            ) : null}
          </View>
        ) : null}

        {errMsg ? <Text className="mb-sm text-center text-sm text-error">{errMsg}</Text> : null}

        {/* Incoming dispatch request — Uber-driver style */}
        {offer && online && !activeJob ? (
          <View className="mb-md overflow-hidden rounded-2xl" style={[CARD_SHADOW, { backgroundColor: color.brand[500] }]}>
            <View className="p-lg">
              <View className="flex-row items-center">
                <MaterialCommunityIcons name={kind === 'DRIVER' ? 'car' : 'package-variant'} size={20} color="#fff" />
                <Text className="ml-sm text-xs font-bold text-white" style={{ letterSpacing: 1 }}>
                  NEW {kind === 'DRIVER' ? 'RIDE' : 'DELIVERY'} REQUEST
                </Text>
              </View>
              <Text className="mt-sm text-lg font-bold text-white" numberOfLines={1}>
                {offer.vendorName ?? offer.orderNumber ?? 'Job nearby'}
              </Text>
              {offer.etaMinutes != null ? (
                <Text className="mt-xs text-sm text-white" style={{ opacity: 0.9 }}>~{offer.etaMinutes} min to pickup</Text>
              ) : null}
              <View className="mt-md flex-row" style={{ gap: 8 }}>
                <PressableScale
                  className="flex-1 items-center rounded-lg bg-white py-md"
                  disabled={accept.isPending}
                  onPress={() => accept.mutate(offer.orderId, { onSuccess: dismiss })}
                >
                  <Text className="font-body font-bold text-brand-600">{accept.isPending ? 'Accepting…' : 'Accept'}</Text>
                </PressableScale>
                <PressableScale className="items-center justify-center rounded-lg border border-white px-xl" onPress={dismiss}>
                  <Text className="font-body font-semibold text-white">Dismiss</Text>
                </PressableScale>
              </View>
            </View>
          </View>
        ) : null}

        {/* Active job */}
        {activeJob ? (
          <PressableScale onPress={() => navigation?.navigate?.('ActiveJob')}>
            <View className="mb-md rounded-2xl bg-surface-base p-lg" style={CARD_SHADOW}>
              <View className="flex-row items-center justify-between">
                <Text className="text-xs font-bold text-brand-600">ACTIVE JOB</Text>
                <Feather name="chevron-right" size={18} color={color.text.muted} />
              </View>
              <Text className="mt-xs text-base font-bold text-text-primary" numberOfLines={1}>
                {activeJob.deliveryAddress ?? activeJob.dropoffAddress ?? activeJob.orderNumber ?? 'In progress'}
              </Text>
              <Text className="mt-xs text-sm text-text-secondary">{jobAmount(activeJob)} · tap to manage</Text>
            </View>
          </PressableScale>
        ) : online ? (
          jobs.length === 0 ? (
            <View className="mt-lg items-center rounded-2xl bg-surface-subtle py-2xl">
              <MaterialCommunityIcons name="radar" size={28} color={color.text.muted} />
              <Text className="mt-sm text-sm text-text-secondary">Waiting for nearby jobs…</Text>
            </View>
          ) : (
            <>
              <Heading size="lg" className="mb-sm">
                Available jobs
              </Heading>
              {jobs.map((j) => (
                <View key={j.id} className="mb-md rounded-2xl bg-surface-base p-lg" style={CARD_SHADOW}>
                  <Text className="text-base font-bold text-text-primary" numberOfLines={1}>
                    {j.vendor?.name ?? j.pickupAddress ?? 'New job'}
                  </Text>
                  <View className="mt-xs flex-row items-center">
                    <Feather name="map-pin" size={13} color={color.text.muted} />
                    <Text className="ml-1 flex-1 text-sm text-text-secondary" numberOfLines={1}>
                      {j.deliveryAddress ?? j.dropoffAddress ?? ''}
                    </Text>
                  </View>
                  <View className="mt-sm flex-row items-center justify-between">
                    <Text className="text-lg font-bold text-text-primary">{jobAmount(j)}</Text>
                    <Button label="Accept" className="px-2xl" loading={accept.isPending} onPress={() => accept.mutate(j.id)} />
                  </View>
                </View>
              ))}
            </>
          )
        ) : (
          <View className="mt-lg items-center rounded-2xl bg-surface-subtle py-2xl">
            <MaterialCommunityIcons name="power-sleep" size={28} color={color.text.muted} />
            <Text className="mt-sm text-center text-sm text-text-secondary">You&apos;re offline. Flip the switch to start earning.</Text>
          </View>
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
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={8}>
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
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
                <TextInput value={pin} onChangeText={setPin} placeholder="Rider PIN" placeholderTextColor={color.text.muted} keyboardType="number-pad" maxLength={4} className="flex-1 rounded-lg border border-border-subtle bg-surface-base px-lg py-md font-body text-base text-text-primary" />
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
      <Stack.Screen name="Chat" component={ChatScreen} />
    </Stack.Navigator>
  );
}
