/** @jsxImportSource react */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color, radius, space } from '@swift/ui';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { LoadingBlock, PillButton, Screen, T, cardShadow } from '../../../kit';
import {
  useMoverKind,
  useMoverStats,
  useEarningsToday,
  useEarnings,
  useDemand,
  useAvailableJobs,
  useDispatchOffers,
  useActiveJob,
  useGoOnline,
  useGoOffline,
  useAcceptJob,
  useDeclineOffer,
  useBroadcastLocation,
  useVerificationStatus,
  type MoverKind,
} from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';
import { GEORGETOWN } from '../../../hooks/useDeviceLocation';
import { money } from '../../../lib/money';
import { FareSlider } from '../../../components/FareSlider';
import { GUTTER, RoutePair, jobAmount, CustomerTrustBadge } from '../shared';
import { dk, withAlpha, DCard, DStat, DWeekBars } from '../dark';

/**
 * The earner home (dashboard plan Phase B/C): dark, map-first, demand-aware.
 * The map shows REAL waiting work (Phase A endpoints); the GO ring is the one
 * big action; the panel carries the money story — today, the week's bars, and
 * the 100%-yours line that IS Swift's pitch. Every gate and cash rule from the
 * old screen survives; only the shell got the upgrade.
 */

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
                {offer.isExpress ? 'EXPRESS · BIGGER FEE' : `NEW ${isDriver ? 'RIDE' : 'DELIVERY'} REQUEST`}
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
                {/* Who you'd front cash for — decide BEFORE you ride */}
                <CustomerTrustBadge trust={offer.customerTrust} cash={offer.paymentMethod === 'CASH'} />
                {/* Judge the bag before you commit (grocery runs get big) */}
                {offer.itemCount ? (
                  <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
                    {offer.itemCount} item{offer.itemCount === 1 ? '' : 's'}
                    {offer.estLoad ? ` · ${offer.estLoad} load` : ''}
                  </T>
                ) : null}
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

/** Demand dot: a waiting taxi request, rounded to ~300 m server-side. */
function DemandDot() {
  return (
    <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: dk.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dk.accent }} />
    </View>
  );
}

/** Cluster badge: N waiting around here. */
function ClusterBadge({ count }: { count: number }) {
  return (
    <View style={{ minWidth: 26, height: 26, borderRadius: 13, paddingHorizontal: 6, backgroundColor: dk.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' }}>
      <T variant="caption" weight="bold" style={{ color: '#fff' }}>
        {count}
      </T>
    </View>
  );
}

/** Store demand marker: ready-order count at a vendor. */
function StoreBadge({ ready, soon }: { ready: number; soon: number }) {
  const hot = ready > 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: hot ? dk.accent : 'rgba(23,23,27,0.92)', borderWidth: 1.5, borderColor: '#fff' }}>
      <MaterialCommunityIcons name="storefront" size={12} color="#fff" />
      <T variant="caption" weight="bold" style={{ color: '#fff' }}>
        {hot ? ready : soon}
      </T>
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
  const decline = useDeclineOffer(k);
  const earnings = useEarningsToday(kind);
  const history = useEarnings<any>(kind);
  const stats = useMoverStats(kind);
  const vstatus = useVerificationStatus<any>('MOVER');
  const active = useActiveJob(kind);
  const online = !!profile?.isOnline;
  const available = useAvailableJobs(kind, online);
  const { offer, dismiss } = useDispatchOffers(kind, online);
  useBroadcastLocation(kind, online);

  const here = latitude != null && longitude != null ? { lat: latitude, lng: longitude } : undefined;
  const demand = useDemand<any>(kind, here);

  // Last 7 days from the earnings ledger, grouped client-side (reference chart).
  const week = useMemo(() => {
    const raw: any = history.data;
    const rows: any[] = Array.isArray(raw) ? raw : raw?.data ?? raw?.earnings ?? [];
    const days: Array<{ label: string; total: number; isToday: boolean }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const next = new Date(d.getTime() + 24 * 3600 * 1000);
      const total = rows
        .filter((e) => {
          const t = new Date(e.createdAt).getTime();
          return t >= d.getTime() && t < next.getTime();
        })
        .reduce((s, e) => s + Number(e.amount ?? 0), 0);
      days.push({ label: 'SMTWTFS'[d.getDay()]!, total, isToday: i === 0 });
    }
    return days;
  }, [history.data]);

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
  const d: any = demand.data ?? {};

  // Soonest checklist document inside its 30-day renewal window (skipping any
  // with a renewal already in review) — surfaced before it costs them a shift.
  const DAY = 24 * 60 * 60 * 1000;
  const expiringDoc = (() => {
    const s: any = vstatus.data;
    if (!s?.checklist) return null;
    let soonest: { docType: string; days: number } | null = null;
    for (const dt of s.checklist as string[]) {
      const docs = (s.documents ?? []) as any[];
      if (docs.some((doc) => doc.docType === dt && doc.status === 'PENDING')) continue;
      for (const doc of docs) {
        if (doc.docType !== dt || doc.status !== 'APPROVED' || !doc.expiresAt) continue;
        const ms = new Date(doc.expiresAt).getTime() - Date.now();
        if (ms > 0 && ms <= 30 * DAY) {
          const days = Math.ceil(ms / DAY);
          if (!soonest || days < soonest.days) soonest = { docType: dt, days };
        }
      }
    }
    return soonest;
  })();
  const todayTotal = (earnings.data as any)?.total ?? (earnings.data as any)?.todayEarnings ?? 0;
  const tripsToday = (earnings.data as any)?.todayDeliveries ?? (earnings.data as any)?.trips ?? (earnings.data as any)?.ridesCompleted ?? 0;
  const onlineHours = (stats.data as any)?.onlineHoursToday;
  const busyToggle = goOnline.isPending || goOffline.isPending;

  const region = {
    latitude: latitude ?? GEORGETOWN.latitude,
    longitude: longitude ?? GEORGETOWN.longitude,
    latitudeDelta: 0.04,
    longitudeDelta: 0.04,
  };

  // The one demand line the panel leads with — real counts, no theatre.
  const demandLine = isDriver
    ? (d.waiting ?? 0) > 0
      ? `${d.waiting} ${d.waiting === 1 ? 'person' : 'people'} waiting for a ride nearby${d.watchers ? ` · ${d.watchers} watching for a driver` : ''}`
      : (d.watchers ?? 0) > 0
        ? `${d.watchers} ${d.watchers === 1 ? 'person' : 'people'} watching for a driver near you`
        : null
    : (d.ready ?? 0) > 0
      ? `${d.ready} order${d.ready === 1 ? '' : 's'} ready to collect${d.stores?.[0] ? ` — ${d.stores[0].name} has ${d.stores[0].ready}` : ''}`
      : (d.soon ?? 0) > 0
        ? `${d.soon} order${d.soon === 1 ? '' : 's'} in the kitchen near you`
        : null;

  return (
    <View style={{ flex: 1, backgroundColor: dk.bg }}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        region={region}
        showsUserLocation
        userInterfaceStyle="dark"
      >
        {/* REAL demand on the map (Phase A): taxi pickups rounded ~300 m /
            stores with unassigned orders. Never customer identities. */}
        {isDriver
          ? [
              ...(d.points ?? []).map((p: any, i: number) => (
                <Marker key={`p${i}`} coordinate={{ latitude: p.lat, longitude: p.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                  <DemandDot />
                </Marker>
              )),
              ...(d.clusters ?? [])
                .filter((c: any) => c.count > 1)
                .map((c: any, i: number) => (
                  <Marker key={`c${i}`} coordinate={{ latitude: c.lat, longitude: c.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                    <ClusterBadge count={c.count} />
                  </Marker>
                )),
            ]
          : (d.stores ?? []).map((s2: any) => (
              <Marker
                key={s2.vendorId}
                coordinate={{ latitude: s2.lat, longitude: s2.lng }}
                anchor={{ x: 0.5, y: 0.5 }}
                tracksViewChanges={false}
                title={s2.name}
                description={`${s2.ready} ready · ${s2.soon} soon · ${money(s2.feesWaiting)} in fees waiting`}
              >
                <StoreBadge ready={s2.ready} soon={s2.soon} />
              </Marker>
            ))}
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
        <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: 9999, backgroundColor: dk.card, paddingHorizontal: space.md, height: 36, borderWidth: 1, borderColor: dk.line }, cardShadow]}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: online ? dk.success : dk.faint }} />
          <T variant="label" weight="bold" style={{ color: dk.text }}>
            {online ? 'LIVE' : 'OFFLINE'}
          </T>
          <T variant="label" style={{ color: dk.muted }}>
            {isDriver ? 'Swift Driver' : 'Swift Rider'}
          </T>
        </View>
        <Pressable onPress={() => navigation?.navigate?.('Account')} hitSlop={8}>
          {({ pressed }) => (
            <View style={[{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.card, borderWidth: 1, borderColor: dk.line, opacity: pressed ? 0.7 : 1 }, cardShadow]}>
              <Feather name="user" size={17} color={dk.text} />
            </View>
          )}
        </Pressable>
      </View>

      {/* The GO ring — the one big action when offline (reference language). */}
      {!online && !activeJob ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: '38%', alignItems: 'center' }}>
          <Pressable disabled={busyToggle} onPress={() => goOnline.mutate()}>
            {({ pressed }) => (
              <View style={{ width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.accentGlow }}>
                <View
                  style={[
                    { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.accent, opacity: pressed || busyToggle ? 0.8 : 1 },
                    cardShadow,
                  ]}
                >
                  <T variant="title" weight="bold" style={{ color: '#fff', letterSpacing: 1 }}>
                    {busyToggle ? '…' : 'GO'}
                  </T>
                </View>
              </View>
            )}
          </Pressable>
        </View>
      ) : null}

      <BottomSheet
        index={0}
        snapPoints={['34%', '80%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: dk.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20 }}
        handleIndicatorStyle={{ backgroundColor: dk.faint }}
      >
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}>
          {/* Status header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1, paddingRight: space.md }}>
              <T variant="heading" style={{ color: dk.text }}>
                {online ? 'You’re online' : 'You’re offline'}
              </T>
              <T variant="caption" style={{ color: dk.muted, marginTop: 2 }}>
                {online
                  ? demandLine ?? 'Watching for jobs near you'
                  : demandLine
                    ? `${demandLine} — go online to take it`
                    : 'Go online to receive jobs'}
              </T>
            </View>
            {online ? (
              <Pressable disabled={busyToggle} onPress={() => goOffline.mutate()} hitSlop={6}>
                {({ pressed }) => (
                  <View style={{ borderRadius: 9999, borderWidth: 1, borderColor: dk.line, backgroundColor: dk.card, paddingHorizontal: space.lg, paddingVertical: 8, opacity: pressed || busyToggle ? 0.7 : 1 }}>
                    <T variant="label" weight="bold" style={{ color: dk.text }}>
                      {busyToggle ? '…' : 'Stop'}
                    </T>
                  </View>
                )}
              </Pressable>
            ) : null}
          </View>

          {/* Why the switch snapped back — the gate's own words, right where you flipped it. */}
          {errMsg ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(dk.accent, 0.14), borderWidth: 1, borderColor: dk.accentBorder, padding: space.md, marginTop: space.md }}>
              <Feather name="alert-circle" size={15} color={dk.accent} style={{ marginTop: 1 }} />
              <T variant="label" style={{ flex: 1, color: dk.text }}>
                {errMsg}
              </T>
            </View>
          ) : null}

          {/* Renewal nudge — a document is inside its 30-day window */}
          {expiringDoc ? (
            <Pressable onPress={() => navigation?.navigate?.('MoverDocuments')}>
              {({ pressed }) => (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: 'rgba(245,166,35,0.12)', borderWidth: 1, borderColor: 'rgba(245,166,35,0.4)', padding: space.md, marginTop: space.md, opacity: pressed ? 0.85 : 1 }}>
                  <Feather name="clock" size={15} color={dk.warning} style={{ marginTop: 1 }} />
                  <T variant="label" style={{ flex: 1, color: dk.text }}>
                    Your {expiringDoc.docType.replace(/_/g, ' ')} expires in {expiringDoc.days} day{expiringDoc.days === 1 ? '' : 's'} — tap to upload the renewal.
                  </T>
                </View>
              )}
            </Pressable>
          ) : null}

          {/* Money story: today + the week's bars (reference Finance card). */}
          <Pressable onPress={() => navigation?.navigate?.('Earnings')}>
            {({ pressed }) => (
              <DCard style={{ marginTop: space.md, opacity: pressed ? 0.9 : 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <T variant="caption" weight="bold" style={{ color: dk.muted, letterSpacing: 1 }}>
                    EARNED TODAY
                  </T>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <T variant="caption" weight="semibold" style={{ color: dk.accent }}>
                      All earnings
                    </T>
                    <Feather name="chevron-right" size={14} color={dk.accent} />
                  </View>
                </View>
                <T variant="display" style={{ marginTop: 2, color: dk.text }}>
                  {money(todayTotal)}
                </T>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <MaterialCommunityIcons name="check-decagram" size={14} color={dk.success} />
                  <T variant="caption" weight="semibold" style={{ color: dk.muted }}>
                    100% yours — Swift takes 0% commission
                  </T>
                </View>
                <View style={{ marginTop: space.lg }}>
                  <DWeekBars days={week} />
                </View>
              </DCard>
            )}
          </Pressable>

          {/* Stat chips (reference profile row, Swift-real numbers). */}
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
            <DStat icon={isDriver ? 'car' : 'bike-fast'} value={String(tripsToday)} label={isDriver ? 'Trips today' : 'Jobs today'} />
            {onlineHours != null ? <DStat icon="clock-outline" value={`${onlineHours}h`} label="Online today" /> : null}
            <DStat icon="calendar-check" value="0%" label="Commission" />
          </View>

          {/* D.3 — cash float headroom */}
          {profile?.float ? (
            <DCard style={{ marginTop: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flex: 1, paddingRight: space.md }}>
                  <T variant="caption" weight="bold" style={{ color: dk.muted }}>
                    CASH FLOAT
                  </T>
                  <T variant="body" weight="bold" style={{ marginTop: 2, color: dk.text }}>
                    {money(profile.float.available)}{' '}
                    <T variant="label" style={{ color: dk.muted }}>
                      of {money(profile.float.limit)} free
                    </T>
                  </T>
                </View>
                <MaterialCommunityIcons name="cash-multiple" size={22} color={dk.accent} />
              </View>
              {Number(profile.float.limit) > 0 ? (
                <View style={{ height: 6, borderRadius: 3, backgroundColor: dk.cardSoft, marginTop: space.md, overflow: 'hidden' }}>
                  <View
                    style={{
                      height: 6,
                      borderRadius: 3,
                      width: `${Math.min(100, Math.round((Number(profile.float.available) / Number(profile.float.limit)) * 100))}%`,
                      backgroundColor: Number(profile.float.available) > 0 ? dk.success : dk.accent,
                    }}
                  />
                </View>
              ) : null}
              {online && profile.float.available <= 0 ? (
                <T variant="caption" style={{ color: dk.muted, marginTop: space.sm }}>
                  Float limit reached — finish a delivery to free it up and receive new cash offers.
                </T>
              ) : null}
            </DCard>
          ) : null}

          {/* Active job / available jobs / states */}
          {activeJob ? (
            <Pressable onPress={() => navigation?.navigate?.('ActiveJob')}>
              {({ pressed }) => (
                <DCard style={{ marginTop: space.md, borderColor: dk.accentBorder, opacity: pressed ? 0.9 : 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <T variant="caption" weight="bold" style={{ color: dk.accent, letterSpacing: 1 }}>
                      ACTIVE JOB
                    </T>
                    <Feather name="chevron-right" size={18} color={dk.muted} />
                  </View>
                  <T variant="body" weight="bold" numberOfLines={1} style={{ marginTop: 4, color: dk.text }}>
                    {activeJob.deliveryAddress ?? activeJob.dropoffAddress ?? activeJob.orderNumber ?? 'In progress'}
                  </T>
                  <T variant="label" style={{ color: dk.muted, marginTop: 2 }}>
                    {jobAmount(activeJob)} · tap to manage
                  </T>
                </DCard>
              )}
            </Pressable>
          ) : online ? (
            jobs.length === 0 ? (
              <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: dk.card, borderWidth: 1, borderColor: dk.line, paddingVertical: space['2xl'], marginTop: space.lg }}>
                <MaterialCommunityIcons name="radar" size={28} color={dk.muted} />
                <T variant="label" style={{ color: dk.muted, marginTop: space.sm }}>
                  {demandLine ?? 'Waiting for nearby jobs…'}
                </T>
              </View>
            ) : (
              <>
                <T variant="heading" style={{ marginTop: space.lg, marginBottom: space.md, color: dk.text }}>
                  Available jobs
                </T>
                {jobs.map((j) => (
                  <DCard key={j.id} style={{ marginBottom: space.md }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <T variant="title" style={{ color: dk.text }}>
                          {jobAmount(j)}
                        </T>
                        {j.isExpress ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 9999, backgroundColor: dk.accentSoft, paddingHorizontal: space.sm, paddingVertical: 2 }}>
                            <MaterialCommunityIcons name="lightning-bolt" size={12} color={dk.accent} />
                            <T variant="caption" weight="semibold" style={{ color: dk.accent }}>
                              EXPRESS
                            </T>
                          </View>
                        ) : null}
                      </View>
                      {j.distanceKm != null ? (
                        <T variant="caption" weight="semibold" style={{ color: dk.muted }}>
                          {j.distanceKm} km away
                        </T>
                      ) : null}
                    </View>
                    <View style={{ marginTop: space.md }}>
                      <RoutePair pickup={j.vendor?.name ?? j.pickupAddress ?? 'Pickup'} dropoff={j.deliveryAddress ?? j.dropoffAddress} dark />
                    </View>
                    {j.itemCount ? (
                      <T variant="caption" style={{ color: dk.muted, marginTop: space.sm }}>
                        {j.itemCount} item{j.itemCount === 1 ? '' : 's'}
                        {j.estLoad ? ` · ${j.estLoad} load` : ''}
                      </T>
                    ) : null}
                    {/* Who you'd front cash for — trust before float (§4d) */}
                    <CustomerTrustBadge trust={j.customerTrust} cash={j.paymentMethod === 'CASH'} />
                    <PillButton label="Accept" size="md" style={{ marginTop: space.md }} loading={accept.isPending} onPress={() => accept.mutate({ id: j.id })} />
                  </DCard>
                ))}
              </>
            )
          ) : (
            <View style={{ alignItems: 'center', borderRadius: radius.lg, backgroundColor: dk.card, borderWidth: 1, borderColor: dk.line, paddingVertical: space['2xl'], marginTop: space.lg }}>
              <MaterialCommunityIcons name="power-sleep" size={28} color={dk.muted} />
              <T variant="label" center style={{ color: dk.muted, marginTop: space.sm }}>
                {demandLine ? `${demandLine}.` : 'Work shows here the moment you go online.'}
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
          // Tell the server too — the cascade re-offers the next mover NOW
          // instead of waiting out the 20s timeout on a card nobody wants.
          onDecline={() => {
            decline.mutate(offer.orderId);
            dismiss();
          }}
        />
      ) : null}
    </View>
  );
}
