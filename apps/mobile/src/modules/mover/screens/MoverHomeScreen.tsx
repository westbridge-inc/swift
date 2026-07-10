/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { Card, LoadingBlock, PillButton, Screen, T, cardShadow } from '../../../kit';
import { BrandSwitch } from '../../../kit/controls';
import {
  useMoverKind,
  useMoverStats,
  useEarningsToday,
  useAvailableJobs,
  useDispatchOffers,
  useActiveJob,
  useGoOnline,
  useGoOffline,
  useAcceptJob,
  useBroadcastLocation,
  useVerificationStatus,
  type MoverKind,
} from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';
import { GEORGETOWN } from '../../../hooks/useDeviceLocation';
import { money } from '../../../lib/money';
import { FareSlider } from '../../../components/FareSlider';
import { GUTTER, RoutePair, jobAmount } from '../shared';

/** Small stat tile inside the earnings hero. */
function HeroTile({ icon, value, label }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; value: string; label: string }) {
  return (
    <View style={{ flex: 1, borderRadius: radius.lg, backgroundColor: color.surface.base, padding: space.md }}>
      <MaterialCommunityIcons name={icon} size={16} color={color.brand[500]} />
      <T variant="body" weight="bold" numberOfLines={1} style={{ marginTop: 4 }}>
        {value}
      </T>
      <T variant="caption" tone="muted" numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

/**
 * Uber-grade incoming request — a focused full-screen card: the fare you earn
 * (100% yours, cash), pickup→drop-off, a countdown, and big Accept/Decline.
 * The capped fare slider lets the mover undercut the market max, never exceed it.
 */
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

  // Driver-set price: the slider runs from a floor up to the market max Swift
  // computed (ride fare for drivers, delivery fee for riders). Defaults at the
  // max — the mover lowers it to compete, never raises it. Server re-clamps.
  const marketMax = isDriver ? Number(job?.fareTotal ?? job?.taxiFareTotal ?? 0) : Number(job?.deliveryFee ?? 0);
  const floor = marketMax > 0 ? Math.max(0, Math.ceil(marketMax * 0.6)) : 0;
  const [price, setPrice] = useState<number>(marketMax);
  useEffect(() => setPrice(marketMax), [offer.orderId, marketMax]);

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 30, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' }}>
      <View style={[{ margin: space.lg, borderRadius: radius.xl, overflow: 'hidden', backgroundColor: color.surface.base }, cardShadow]}>
        <View style={{ backgroundColor: color.brand[500] }}>
          {total ? (
            <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.3)' }}>
              <View style={{ height: 4, width: `${pct * 100}%`, backgroundColor: color.white }} />
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.xl, paddingVertical: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <MaterialCommunityIcons name={isDriver ? 'car' : 'package-variant'} size={18} color={color.white} />
              <T variant="caption" weight="bold" tone="onBrand" style={{ letterSpacing: 1 }}>
                NEW {isDriver ? 'RIDE' : 'DELIVERY'} REQUEST
              </T>
            </View>
            {secs > 0 ? (
              <T variant="caption" weight="bold" tone="onBrand">
                {secs}s
              </T>
            ) : null}
          </View>
        </View>

        <View style={{ padding: space.xl }}>
          <View style={{ alignItems: 'center' }}>
            {marketMax > 0 ? (
              <>
                <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
                  YOUR PRICE
                </T>
                <T variant="display">{money(price)}</T>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <MaterialCommunityIcons name="cash" size={13} color={color.success} />
                  <T variant="caption" weight="bold" tone="success">
                    100% yours · cash
                  </T>
                </View>
              </>
            ) : (
              <>
                <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
                  {isDriver ? 'YOU EARN' : 'ORDER TOTAL'}
                </T>
                <T variant="title" numberOfLines={1} style={{ marginTop: 2 }}>
                  {fare ?? offer.vendorName ?? 'Job nearby'}
                </T>
              </>
            )}
          </View>

          {marketMax > floor ? (
            <View style={{ marginTop: space.md }}>
              <FareSlider min={floor} max={marketMax} value={price} onChange={setPrice} />
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T variant="caption" tone="muted">
                  Slide to set your fare
                </T>
                <T variant="caption" weight="semibold" tone="muted">
                  Market max {money(marketMax)}
                </T>
              </View>
            </View>
          ) : null}

          <View style={{ marginTop: space.lg }}>
            <RoutePair pickup={pickup} dropoff={dropoff} pickupHint={offer.etaMinutes != null ? `Pickup · ${offer.etaMinutes} min away` : 'Pickup'} />
          </View>

          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.xl }}>
            <PillButton label="Decline" variant="outline" onPress={onDecline} style={{ paddingHorizontal: space['2xl'] }} />
            <PillButton
              label={accepting ? 'Accepting…' : `Accept ${isDriver ? 'ride' : 'delivery'}`}
              disabled={accepting}
              onPress={() => onAccept(price)}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

export function MoverHomeScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { kind, profile, loading } = useMoverKind();
  const { latitude, longitude } = useLocationStore();
  const k: MoverKind = kind ?? 'RIDER';
  const goOnline = useGoOnline(k);
  const goOffline = useGoOffline(k);
  const accept = useAcceptJob(k);
  const earnings = useEarningsToday(kind);
  const stats = useMoverStats(kind);
  const vstatus = useVerificationStatus<any>('MOVER');
  const active = useActiveJob(kind);
  const online = !!profile?.isOnline;
  const available = useAvailableJobs(kind, online);
  const { offer, dismiss } = useDispatchOffers(kind, online);
  useBroadcastLocation(kind, online);

  if (loading || !kind) {
    return (
      <Screen>
        <LoadingBlock />
      </Screen>
    );
  }

  const isDriver = kind === 'DRIVER';
  const activeJob = active.data;
  const jobs: any[] = available.data ?? [];
  const errMsg = (goOnline.error as any)?.response?.data?.error?.message;

  // Soonest checklist document inside its 30-day renewal window (skipping any
  // with a renewal already in review) — surfaced before it costs them a shift.
  const DAY = 24 * 60 * 60 * 1000;
  const expiringDoc = (() => {
    const s: any = vstatus.data;
    if (!s?.checklist) return null;
    let soonest: { docType: string; days: number } | null = null;
    for (const dt of s.checklist as string[]) {
      const docs = (s.documents ?? []) as any[];
      if (docs.some((d) => d.docType === dt && d.status === 'PENDING')) continue;
      for (const d of docs) {
        if (d.docType !== dt || d.status !== 'APPROVED' || !d.expiresAt) continue;
        const ms = new Date(d.expiresAt).getTime() - Date.now();
        if (ms > 0 && ms <= 30 * DAY) {
          const days = Math.ceil(ms / DAY);
          if (!soonest || days < soonest.days) soonest = { docType: dt, days };
        }
      }
    }
    return soonest;
  })();
  const todayTotal = (earnings.data as any)?.total ?? (earnings.data as any)?.todayEarnings ?? 0;
  const tripsToday = (earnings.data as any)?.todayDeliveries ?? (earnings.data as any)?.trips ?? 0;
  const onlineHours = (stats.data as any)?.onlineHoursToday;
  const busyToggle = goOnline.isPending || goOffline.isPending;

  const region = {
    latitude: latitude ?? GEORGETOWN.latitude,
    longitude: longitude ?? GEORGETOWN.longitude,
    latitudeDelta: 0.04,
    longitudeDelta: 0.04,
  };

  return (
    <View style={{ flex: 1, backgroundColor: color.surface.base }}>
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
      <View style={{ position: 'absolute', top: insets.top, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: GUTTER, paddingVertical: space.sm }}>
        <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: 9999, backgroundColor: color.surface.base, paddingHorizontal: space.md, height: 36 }, cardShadow]}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: online ? color.success : color.text.muted }} />
          <T variant="label" weight="bold">
            {isDriver ? 'Driver' : 'Rider'}
          </T>
        </View>
        <Pressable onPress={() => navigation?.navigate?.('Account')} hitSlop={8}>
          {({ pressed }) => (
            <View style={[{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: color.surface.base, opacity: pressed ? 0.7 : 1 }, cardShadow]}>
              <Feather name="user" size={17} color={color.text.primary} />
            </View>
          )}
        </Pressable>
      </View>

      <BottomSheet index={0} snapPoints={['34%', '80%']} enableDynamicSizing={false}>
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}>
          {/* Online toggle */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: space.md }}>
              <T variant="heading">{online ? 'You’re online' : 'You’re offline'}</T>
              <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                {online ? 'Receiving jobs nearby' : 'Go online to receive jobs'}
              </T>
            </View>
            <BrandSwitch value={online} onChange={() => (busyToggle ? undefined : online ? goOffline.mutate() : goOnline.mutate())} />
          </View>

          {/* Why the switch snapped back — the gate's own words, right where you flipped it. */}
          {errMsg ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: '#FDECEC', padding: space.md, marginTop: space.md }}>
              <Feather name="alert-circle" size={15} color={color.error} style={{ marginTop: 1 }} />
              <T variant="label" tone="error" style={{ flex: 1 }}>
                {errMsg}
              </T>
            </View>
          ) : null}

          {/* Renewal nudge — a document is inside its 30-day window */}
          {expiringDoc ? (
            <Pressable onPress={() => navigation?.navigate?.('MoverDocuments')}>
              {({ pressed }) => (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: '#FDF1DC', padding: space.md, marginTop: space.md, opacity: pressed ? 0.85 : 1 }}>
                  <Feather name="clock" size={15} color={color.warning} style={{ marginTop: 1 }} />
                  <T variant="label" style={{ flex: 1, color: '#8A5A00' }}>
                    Your {expiringDoc.docType.replace(/_/g, ' ')} expires in {expiringDoc.days} day{expiringDoc.days === 1 ? '' : 's'} — tap to upload the renewal.
                  </T>
                </View>
              )}
            </Pressable>
          ) : null}

          {/* Earnings hero — taps into the full Earnings screen */}
          <Pressable onPress={() => navigation?.navigate?.('Earnings')}>
            {({ pressed }) => (
              <View style={{ marginTop: space.md, borderRadius: radius.xl, backgroundColor: color.surface.subtle, padding: space.xl, opacity: pressed ? 0.9 : 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <T variant="caption" weight="bold" tone="muted" style={{ letterSpacing: 1 }}>
                    EARNED TODAY
                  </T>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <T variant="caption" weight="semibold" tone="brand">
                      All earnings
                    </T>
                    <Feather name="chevron-right" size={14} color={color.brand[500]} />
                  </View>
                </View>
                <T variant="display" style={{ marginTop: 2 }}>
                  {money(todayTotal)}
                </T>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <MaterialCommunityIcons name="check-decagram" size={14} color={color.success} />
                  <T variant="caption" weight="semibold" tone="muted">
                    100% yours — Swift takes 0% commission
                  </T>
                </View>
                <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
                  <HeroTile icon={isDriver ? 'car' : 'bike-fast'} value={String(tripsToday)} label={isDriver ? 'Trips today' : 'Jobs today'} />
                  {!isDriver && onlineHours != null ? (
                    <HeroTile icon="clock-outline" value={`${onlineHours}h`} label="Online today" />
                  ) : (
                    <HeroTile icon="calendar-check" value="Flat weekly fee" label="No commission, ever" />
                  )}
                </View>
              </View>
            )}
          </Pressable>

          {/* D.3 — cash float headroom */}
          {profile?.float ? (
            <View style={{ marginTop: space.md, borderRadius: radius.lg, backgroundColor: color.surface.subtle, padding: space.lg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: space.md }}>
                  <T variant="caption" weight="bold" tone="muted">
                    CASH FLOAT
                  </T>
                  <T variant="body" weight="bold" style={{ marginTop: 2 }}>
                    {money(profile.float.available)} <T variant="label" tone="muted">of {money(profile.float.limit)} free</T>
                  </T>
                </View>
                <MaterialCommunityIcons name="cash-multiple" size={22} color={color.brand[500]} />
              </View>
              {Number(profile.float.limit) > 0 ? (
                <View style={{ height: 6, borderRadius: 3, backgroundColor: color.border.subtle, marginTop: space.md, overflow: 'hidden' }}>
                  <View
                    style={{
                      height: 6,
                      borderRadius: 3,
                      width: `${Math.min(100, Math.round((Number(profile.float.available) / Number(profile.float.limit)) * 100))}%`,
                      backgroundColor: Number(profile.float.available) > 0 ? color.success : color.error,
                    }}
                  />
                </View>
              ) : null}
              {online && profile.float.available <= 0 ? (
                <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                  Float limit reached — finish a delivery to free it up and receive new cash offers.
                </T>
              ) : null}
            </View>
          ) : null}

          {/* Active job / available jobs / states */}
          {activeJob ? (
            <Pressable onPress={() => navigation?.navigate?.('ActiveJob')}>
              {({ pressed }) => (
                <Card style={{ marginTop: space.md, opacity: pressed ? 0.9 : 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <T variant="caption" weight="bold" tone="brand" style={{ letterSpacing: 1 }}>
                      ACTIVE JOB
                    </T>
                    <Feather name="chevron-right" size={18} color={color.text.muted} />
                  </View>
                  <T variant="body" weight="bold" numberOfLines={1} style={{ marginTop: 4 }}>
                    {activeJob.deliveryAddress ?? activeJob.dropoffAddress ?? activeJob.orderNumber ?? 'In progress'}
                  </T>
                  <T variant="label" tone="muted" style={{ marginTop: 2 }}>
                    {jobAmount(activeJob)} · tap to manage
                  </T>
                </Card>
              )}
            </Pressable>
          ) : online ? (
            jobs.length === 0 ? (
              <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: color.surface.subtle, paddingVertical: space['2xl'], marginTop: space.lg }}>
                <MaterialCommunityIcons name="radar" size={28} color={color.text.muted} />
                <T variant="label" tone="muted" style={{ marginTop: space.sm }}>
                  Waiting for nearby jobs…
                </T>
              </View>
            ) : (
              <>
                <T variant="heading" style={{ marginTop: space.lg, marginBottom: space.md }}>
                  Available jobs
                </T>
                {jobs.map((j) => (
                  <Card key={j.id} style={{ marginBottom: space.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <T variant="title">{jobAmount(j)}</T>
                      {j.distanceKm != null ? (
                        <T variant="caption" weight="semibold" tone="muted">
                          {j.distanceKm} km away
                        </T>
                      ) : null}
                    </View>
                    <View style={{ marginTop: space.md }}>
                      <RoutePair pickup={j.vendor?.name ?? j.pickupAddress ?? 'Pickup'} dropoff={j.deliveryAddress ?? j.dropoffAddress} />
                    </View>
                    <PillButton label="Accept" size="md" style={{ marginTop: space.md }} loading={accept.isPending} onPress={() => accept.mutate({ id: j.id })} />
                  </Card>
                ))}
              </>
            )
          ) : (
            <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: color.surface.subtle, paddingVertical: space['2xl'], marginTop: space.lg }}>
              <MaterialCommunityIcons name="power-sleep" size={28} color={color.text.muted} />
              <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
                You&apos;re offline. Flip the switch to start earning.
              </T>
            </View>
          )}
        </BottomSheetScrollView>
      </BottomSheet>

      {/* Incoming dispatch request — focused, above everything */}
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
