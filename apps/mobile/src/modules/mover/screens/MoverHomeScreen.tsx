import { View, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, Heading, Button, Spinner, PressableScale, elevation } from '../../../components/ui';
import {
  useMoverKind,
  useEarningsToday,
  useAvailableJobs,
  useDispatchOffers,
  useActiveJob,
  useGoOnline,
  useGoOffline,
  useAcceptJob,
  useBroadcastLocation,
  type MoverKind,
} from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';
import { GEORGETOWN } from '../../../hooks/useDeviceLocation';
import { useAuthStore } from '../../../stores/authStore';
import { money } from '../../../lib/money';

const CARD_SHADOW = elevation.raised;

function jobAmount(j: any) {
  return money(j?.totalAmount ?? j?.taxiFareTotal ?? j?.fare ?? 0);
}

export function MoverHomeScreen({ navigation }: any) {
  const { logout } = useAuthStore();
  const { kind, profile, loading } = useMoverKind();
  const { latitude, longitude } = useLocationStore();
  const k: MoverKind = kind ?? 'RIDER';
  const goOnline = useGoOnline(k);
  const goOffline = useGoOffline(k);
  const accept = useAcceptJob(k);
  const earnings = useEarningsToday(kind);
  const active = useActiveJob(kind);
  const online = !!profile?.isOnline;
  const available = useAvailableJobs(kind, online);
  const { offer, dismiss } = useDispatchOffers(kind, online);
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
  const errMsg = (goOnline.error as any)?.response?.data?.error?.message;
  const todayTotal = (earnings.data as any)?.total ?? (earnings.data as any)?.todayEarnings ?? 0;
  const tripsToday = (earnings.data as any)?.todayDeliveries ?? (earnings.data as any)?.trips ?? 0;
  const busyToggle = goOnline.isPending || goOffline.isPending;

  const region = {
    latitude: latitude ?? GEORGETOWN.latitude,
    longitude: longitude ?? GEORGETOWN.longitude,
    latitudeDelta: 0.04,
    longitudeDelta: 0.04,
  };

  return (
    <View style={{ flex: 1 }} className="bg-surface-base">
      <MapView provider={PROVIDER_DEFAULT} style={{ flex: 1 }} region={region} showsUserLocation>
        {jobs.map((j) =>
          j.pickupLat != null ? (
            <Marker
              key={j.id}
              coordinate={{ latitude: Number(j.pickupLat), longitude: Number(j.pickupLng) }}
              title={j.vendor?.name ?? 'Job'}
              pinColor={color.brand[500]}
            />
          ) : null,
        )}
      </MapView>

      {/* Top bar over the map */}
      <SafeAreaView edges={['top']} style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
        <View className="flex-row items-center justify-between px-lg py-sm">
          <View className="flex-row items-center rounded-full bg-surface-base px-md py-xs" style={CARD_SHADOW}>
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: online ? color.success : color.text.muted }} />
            <Text className="ml-2 text-sm font-bold text-text-primary">{kind === 'DRIVER' ? 'Driver' : 'Rider'}</Text>
          </View>
          <PressableScale onPress={logout} hitSlop={8} className="rounded-full bg-surface-base px-md py-xs" style={CARD_SHADOW}>
            <Text className="text-sm text-text-muted">Log out</Text>
          </PressableScale>
        </View>
      </SafeAreaView>

      {/* Incoming dispatch request — Uber-driver style, over the map */}
      {offer && online && !activeJob ? (
        <View className="absolute inset-x-0" style={{ top: 96 }}>
          <View className="mx-lg overflow-hidden rounded-2xl" style={[CARD_SHADOW, { backgroundColor: color.brand[500] }]}>
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
        </View>
      ) : null}

      <BottomSheet index={0} snapPoints={['32%', '80%']} enableDynamicSizing={false}>
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
          {/* Online toggle + earnings hero */}
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-md">
              <Text className="text-lg font-bold text-text-primary">{online ? 'You’re online' : 'You’re offline'}</Text>
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

          {/* D.3 — cash float headroom */}
          {profile?.float ? (
            <View className="mt-md rounded-xl bg-surface-subtle p-md">
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

          {errMsg ? <Text className="mt-md text-center text-sm text-error">{errMsg}</Text> : null}

          {/* Active job / available jobs / states */}
          {activeJob ? (
            <PressableScale className="mt-md" onPress={() => navigation?.navigate?.('ActiveJob')}>
              <View className="rounded-2xl bg-surface-base p-lg" style={CARD_SHADOW}>
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
                <Heading size="lg" className="mb-sm mt-lg">Available jobs</Heading>
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
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}
