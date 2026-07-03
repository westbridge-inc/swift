import { useEffect, useState } from 'react';
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
import { money } from '../../../lib/money';
import { FareSlider } from '../../../components/FareSlider';

const CARD_SHADOW = elevation.raised;

function jobAmount(j: any) {
  return money(j?.totalAmount ?? j?.taxiFareTotal ?? j?.fare ?? 0);
}

// Uber-grade incoming request — a focused full-screen card: the fare you earn
// (100% yours, cash), the pickup→drop-off route, a countdown, and big Accept/Decline.
function DispatchOfferCard({
  offer,
  job,
  kind,
  accepting,
  onAccept,
  onDecline,
}: {
  offer: any;
  job: any;
  kind: MoverKind;
  accepting: boolean;
  onAccept: (fare: number) => void;
  onDecline: () => void;
}) {
  const total: number = offer.expiresInSeconds ?? 0;
  const [secs, setSecs] = useState<number>(total);
  useEffect(() => {
    if (!total) return;
    setSecs(total);
    const t = setInterval(() => setSecs((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [offer.orderId, total]);

  const isDriver = kind === 'DRIVER';
  const fare = job ? jobAmount(job) : null;
  const pickup = job?.pickupAddress ?? offer.vendorName ?? 'Pickup nearby';
  const dropoff = job?.deliveryAddress ?? job?.dropoffAddress;
  const pct = total ? Math.max(0, secs / total) : 0;

  // Driver-set price: the slider runs from a floor up to the market max Swift computed
  // (ride fare for drivers, delivery fee for riders). Default at the max — the driver
  // lowers it to compete, never raises it. The server re-clamps on accept.
  const marketMax = isDriver ? Number(job?.fareTotal ?? job?.taxiFareTotal ?? 0) : Number(job?.deliveryFee ?? 0);
  const floor = marketMax > 0 ? Math.max(0, Math.ceil(marketMax * 0.6)) : 0;
  const [price, setPrice] = useState<number>(marketMax);
  useEffect(() => setPrice(marketMax), [offer.orderId, marketMax]);

  return (
    <View className="absolute inset-0 z-30 justify-end" style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}>
      <View className="m-md overflow-hidden rounded-3xl bg-surface-base" style={elevation.floating}>
        <View style={{ backgroundColor: color.brand[500] }}>
          {total ? (
            <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.3)' }}>
              <View style={{ height: 4, width: `${pct * 100}%`, backgroundColor: '#fff' }} />
            </View>
          ) : null}
          <View className="flex-row items-center justify-between px-lg py-md">
            <View className="flex-row items-center">
              <MaterialCommunityIcons name={isDriver ? 'car' : 'package-variant'} size={18} color="#fff" />
              <Text className="ml-sm text-xs font-bold text-white" style={{ letterSpacing: 1 }}>
                NEW {isDriver ? 'RIDE' : 'DELIVERY'} REQUEST
              </Text>
            </View>
            {secs > 0 ? <Text className="text-xs font-bold text-white">{secs}s</Text> : null}
          </View>
        </View>
        <View className="p-lg">
          <View className="items-center">
            {marketMax > 0 ? (
              <>
                <Text className="text-[11px] font-bold uppercase tracking-wider text-text-muted">Your price</Text>
                <Text className="font-display text-4xl font-extrabold text-text-primary">{money(price)}</Text>
                <View className="mt-1 flex-row items-center">
                  <MaterialCommunityIcons name="cash" size={13} color={color.success} />
                  <Text className="ml-1 text-xs font-bold text-success">100% yours · cash</Text>
                </View>
              </>
            ) : (
              <>
                <Text className="text-[11px] font-bold uppercase tracking-wider text-text-muted">{isDriver ? 'You earn' : 'Order total'}</Text>
                <Text className="mt-1 font-display text-xl font-extrabold text-text-primary" numberOfLines={1}>
                  {fare ?? offer.vendorName ?? 'Job nearby'}
                </Text>
              </>
            )}
          </View>

          {marketMax > floor ? (
            <View className="mt-md">
              <FareSlider min={floor} max={marketMax} value={price} onChange={setPrice} />
              <View className="flex-row items-center justify-between">
                <Text className="text-[11px] text-text-muted">Slide to set your fare</Text>
                <Text className="text-[11px] font-semibold text-text-muted">Market max {money(marketMax)}</Text>
              </View>
            </View>
          ) : null}

          <View className="mt-lg">
            <View className="flex-row items-center">
              <View style={{ width: 12, alignItems: 'center' }}>
                <View style={{ width: 11, height: 11, borderRadius: 6, borderWidth: 2.5, borderColor: color.text.muted }} />
              </View>
              <View className="ml-sm flex-1">
                <Text className="text-xs text-text-muted">Pickup{offer.etaMinutes != null ? ` · ${offer.etaMinutes} min away` : ''}</Text>
                <Text className="text-sm font-semibold text-text-primary" numberOfLines={1}>{pickup}</Text>
              </View>
            </View>
            {dropoff ? (
              <>
                <View style={{ marginLeft: 5, height: 14, width: 2, backgroundColor: color.border.subtle, marginVertical: 2 }} />
                <View className="flex-row items-center">
                  <View style={{ width: 12, alignItems: 'center' }}>
                    <MaterialCommunityIcons name="map-marker" size={16} color={color.brand[500]} />
                  </View>
                  <View className="ml-sm flex-1">
                    <Text className="text-xs text-text-muted">Drop-off</Text>
                    <Text className="text-sm font-semibold text-text-primary" numberOfLines={1}>{dropoff}</Text>
                  </View>
                </View>
              </>
            ) : null}
          </View>

          <View className="mt-lg flex-row" style={{ gap: 10 }}>
            <PressableScale
              className="items-center justify-center rounded-full border border-border-strong px-xl"
              onPress={onDecline}
            >
              <Text className="font-body font-semibold text-text-secondary">Decline</Text>
            </PressableScale>
            <PressableScale
              className="flex-1 items-center rounded-full py-md"
              style={{ backgroundColor: color.brand[500] }}
              disabled={accepting}
              onPress={() => onAccept(price)}
            >
              <Text className="font-body font-bold text-white">
                {accepting ? 'Accepting…' : `Accept ${isDriver ? 'ride' : 'delivery'}`}
              </Text>
            </PressableScale>
          </View>
        </View>
      </View>
    </View>
  );
}

export function MoverHomeScreen({ navigation }: any) {
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
          <PressableScale onPress={() => navigation?.navigate?.('Account')} hitSlop={8} className="h-9 w-9 items-center justify-center rounded-full bg-surface-base" style={CARD_SHADOW}>
            <Feather name="user" size={17} color={color.text.primary} />
          </PressableScale>
        </View>
      </SafeAreaView>

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

          {/* Earnings hero — 100% yours, no commission. Taps into the full Earnings screen. */}
          <PressableScale className="mt-md rounded-2xl bg-surface-subtle p-lg" onPress={() => navigation?.navigate?.('Earnings')}>
            <View className="flex-row items-center justify-between">
              <Text className="text-[11px] font-bold uppercase tracking-[1.5px] text-text-muted">Earned today</Text>
              <View className="flex-row items-center">
                <Text className="text-[11px] font-semibold" style={{ color: color.brand[600] }}>All earnings</Text>
                <Feather name="chevron-right" size={14} color={color.brand[500]} />
              </View>
            </View>
            <Text className="mt-0.5 font-display text-3xl font-extrabold text-text-primary">{money(todayTotal)}</Text>
            <View className="mt-1 flex-row items-center">
              <MaterialCommunityIcons name="check-decagram" size={14} color={color.success} />
              <Text className="ml-1 text-xs font-semibold text-text-secondary">100% yours — Swift takes 0% commission</Text>
            </View>
            <View className="mt-md flex-row" style={{ gap: 8 }}>
              <View className="flex-1 rounded-xl bg-surface-base p-md">
                <MaterialCommunityIcons name={kind === 'DRIVER' ? 'car' : 'bike-fast'} size={16} color={color.brand[500]} />
                <Text className="mt-xs text-base font-bold text-text-primary">{tripsToday}</Text>
                <Text className="text-xs text-text-muted">{kind === 'DRIVER' ? 'Trips today' : 'Jobs today'}</Text>
              </View>
              <View className="flex-1 rounded-xl bg-surface-base p-md">
                <MaterialCommunityIcons name="calendar-check" size={16} color={color.brand[500]} />
                <Text className="mt-xs text-base font-bold text-text-primary">Flat weekly fee</Text>
                <Text className="text-xs text-text-muted">No commission, ever</Text>
              </View>
            </View>
          </PressableScale>

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
                  <Text className="text-xs font-bold" style={{ color: color.brand[600] }}>ACTIVE JOB</Text>
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
                    <View className="flex-row items-center justify-between">
                      <Text className="font-display text-xl font-extrabold text-text-primary">{jobAmount(j)}</Text>
                      {j.distanceKm != null ? (
                        <Text className="text-xs font-semibold text-text-muted">{j.distanceKm} km away</Text>
                      ) : null}
                    </View>
                    <View className="mt-md">
                      <View className="flex-row items-center">
                        <View style={{ width: 14, alignItems: 'center' }}>
                          <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2.5, borderColor: color.text.muted }} />
                        </View>
                        <Text className="ml-sm flex-1 text-sm font-semibold text-text-primary" numberOfLines={1}>
                          {j.vendor?.name ?? j.pickupAddress ?? 'Pickup'}
                        </Text>
                      </View>
                      {(j.deliveryAddress ?? j.dropoffAddress) ? (
                        <>
                          <View style={{ marginLeft: 6, height: 12, width: 2, backgroundColor: color.border.subtle, marginVertical: 2 }} />
                          <View className="flex-row items-center">
                            <View style={{ width: 14, alignItems: 'center' }}>
                              <Feather name="map-pin" size={14} color={color.brand[500]} />
                            </View>
                            <Text className="ml-sm flex-1 text-sm text-text-secondary" numberOfLines={1}>
                              {j.deliveryAddress ?? j.dropoffAddress}
                            </Text>
                          </View>
                        </>
                      ) : null}
                    </View>
                    <Button label="Accept" className="mt-md" loading={accept.isPending} onPress={() => accept.mutate({ id: j.id })} />
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

      {/* Incoming dispatch request — focused, Uber-grade, above everything */}
      {offer && online && !activeJob ? (
        <DispatchOfferCard
          offer={offer}
          job={jobs.find((j) => j.id === offer.orderId)}
          kind={k}
          accepting={accept.isPending}
          onAccept={(fare) => accept.mutate({ id: offer.orderId, fare }, { onSuccess: dismiss })}
          onDecline={dismiss}
        />
      ) : null}
    </View>
  );
}
