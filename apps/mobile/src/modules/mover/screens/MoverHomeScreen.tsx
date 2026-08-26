/** @jsxImportSource react */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color, radius, space } from '@swift/ui';
import { haptic } from '../../../lib/haptics';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { ErrorState, Pictogram, TonePill, LoadingBlock, PillButton, Screen, T, cardShadow } from '../../../kit';
import {
  useMoverKind,
  useMoverStats,
  useEarningsToday,
  useDailyEarnings,
  useDemand,
  useAvailableJobs,
  useDispatchOffers,
  useActiveJob,
  useGoOnline,
  useGoOffline,
  useAcceptJob,
  useAcceptOffer,
  useDeclineOffer,
  useVerificationStatus,
  useSelectMoverKind,
  type BoardJob,
  type DispatchOffer,
  type MoverKind,
} from '../../../hooks';
import { useLocationStore } from '../../../stores/locationStore';
import { requireAuthSessionSnapshot } from '../../../stores/authStore';
import { GEORGETOWN, useDeviceLocation } from '../../../hooks/useDeviceLocation';
import { createLiveDeviceLocationLease, grantedLocationFix } from '../../../lib/deviceLocation';
import { prepareMoverOnline } from '../../../lib/moverLocation';
import { requestMoverBackgroundPermission } from '../../../services/backgroundLocation';
import { toast } from '../../../kit/toast';
import { money } from '../../../lib/money';
import { moverJobsToday } from '../../../lib/earnings';
import { earningsSplit } from '../../../lib/earnings-breakdown';
import { FareSlider } from '../../../kit';
import { GUTTER, RoutePair, jobAmount, CustomerTrustBadge } from '../shared';
import { dk, withAlpha, DCard, DemandBand, DStat, DWeekBars } from '../surface';
import { useMoverPreview } from '../../../stores/moverPreview';
import { MoverHomeAccountButton } from './MoverHomeAccountButton';
import { useBackgroundLocationDisclosure } from './BackgroundLocationDisclosure';
import { fareLockedFor, fareToSubmit } from './fare-locked';
import { offerEarnings } from './offer-earnings';
import { canAdjustFare } from '../../../kit';

/**
 * The earner home (dashboard plan Phase B/C): light, map-first, demand-aware.
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
export function DispatchOfferCard({
  offer,
  job,
  kind,
  accepting,
  onAccept,
  onDecline,
}: {
  offer: DispatchOffer;
  job: BoardJob | null | undefined;
  kind: MoverKind;
  accepting: boolean;
  onAccept: (fare: number | undefined) => void;
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
  // [REPORT-010 F-07] The RECOVERED offer payload carries the authoritative
  // money/route facts, so a card rebuilt after a socket drop never depends on
  // a separately-fetched board row for its price.
  const pickup = job?.pickupAddress ?? offer.pickupAddress ?? offer.vendorName ?? 'Pickup nearby';
  const dropoff = job?.deliveryAddress ?? job?.dropoffAddress ?? offer.deliveryAddress ?? undefined;
  const pct = total ? Math.max(0, secs / total) : 0;

  // Driver-set price: the slider runs from a floor up to the market max Swift
  // computed (ride fare for drivers, delivery fee for riders). Defaults at the
  // max — the mover lowers it to compete, never raises it. Server re-clamps.
  // Board row first, recovery payload second — NEVER an unanchored zero.
  const marketMax = isDriver
    ? Number(job?.fareTotal ?? job?.taxiFareTotal ?? offer.taxiFareTotal ?? 0)
    : Number(job?.deliveryFee ?? offer.deliveryFee ?? 0);
  // [REPORT-011 F-05] MMG money is LOCKED at the checkout total — the mover
  // cannot undercut it. Hide the fare slider and NEVER submit a fare on MMG,
  // so a recovered card can't consume the exclusive offer only to be rejected
  // with MMG_PRICE_LOCKED (which burned that mover's offer).
  const fareLocked = fareLockedFor(job, offer);
  const floor = marketMax > 0 ? Math.max(0, Math.ceil(marketMax * 0.6)) : 0;
  const [price, setPrice] = useState<number>(marketMax);
  useEffect(() => setPrice(marketMax), [offer.orderId, marketMax]);
  // Tips are proven to be the mover's on DELIVERIES only; taxi driver earnings
  // accrue in an Earning table, so a ride tip stays unclaimed here [F-257].
  const earnings = offerEarnings(price, offer.tipAmount, !isDriver);

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 30, justifyContent: 'flex-end', backgroundColor: color.scrim }}>
      <View style={[{ margin: space.lg, borderRadius: radius.xl, overflow: 'hidden', backgroundColor: color.surface.base }, cardShadow]}>
        <View style={{ backgroundColor: color.brand[500] }}>
          {total ? (
            <View
              style={{ height: 4, backgroundColor: color.surface.onBrand }}
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Time left to accept this offer"
              accessibilityValue={{ min: 0, max: total, now: secs, text: `${secs} seconds left to accept` }}
            >
              <View style={{ height: 4, width: `${pct * 100}%`, backgroundColor: color.white }} />
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.xl, paddingVertical: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Pictogram name={isDriver ? 'taxi' : 'send'} size={18} color={color.white} />
              <T variant="micro" tone="onBrand">
                {offer.isExpress ? 'Express · bigger fee' : `New ${isDriver ? 'ride' : 'delivery'} request`}
              </T>
            </View>
            {offer.etaMinutes != null ? (
              <T variant="caption" weight="bold" tone="onBrand">
                {offer.etaMinutes} min away
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
                <T variant="displayXl">{money(price)}</T>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <Feather name="dollar-sign" size={13} color={color.success} />
                  <T variant="caption" weight="bold" tone="success">
                    100% yours · cash
                  </T>
                </View>
                {/* The tip is fixed at checkout and is the mover's on top of
                    the fare (`deliveryFee + tipAmount` — rider.routes, four
                    sites). It rode the offer payload and was never drawn, so
                    the accept/decline decision was made against a number
                    smaller than the pay [F-257]. The fare keeps the big type
                    because the slider governs it; the total is what lands. */}
                {earnings.showTip ? (
                  <T variant="caption" weight="semibold" tone="success" style={{ marginTop: 2 }}>
                    + {money(earnings.tip)} tip · you get {money(earnings.total)}
                  </T>
                ) : null}
                {/* Who you'd front cash for — decide BEFORE you ride */}
                <CustomerTrustBadge trust={offer.customerTrust} cash={offer.paymentMethod === 'CASH'} />
                {/* Judge the bag before you commit (grocery runs get big) */}
                {offer.itemCount ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 6 }}>
                    <T variant="caption" tone="muted">
                      {offer.itemCount} item{offer.itemCount === 1 ? '' : 's'}
                    </T>
                    {offer.estLoad ? <TonePill label={String(offer.estLoad).toUpperCase()} tone="brand" /> : null}
                  </View>
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

          {/* [F-028-18] A RECOVERED card can arrive with as little as 4s of
              authority (TTL 14 minus the 10s worker tail) — ten adjust
              gestures cannot traverse the band in that. With too little time
              the slider is not offered at all: accepting needs ONE gesture
              and stays instant; a control that cannot finish is worse than
              its absence. */}
          {!fareLocked && marketMax > floor && canAdjustFare(offer.expiresInSeconds) ? (
            <View style={{ marginTop: space.md }}>
              {/* [F-027-08] secondsLeft makes the expiring server authority
                  audible: it was a 4dp visual bar and nothing else, so a
                  screen-reader user was never told the offer was vanishing
                  underneath them while they adjusted the fare. */}
              <FareSlider min={floor} max={marketMax} value={price} onChange={setPrice} secondsLeft={secs} />
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T variant="caption" tone="muted">
                  Slide to set your fare
                </T>
                <T variant="caption" weight="semibold" tone="muted">
                  Market max {money(marketMax)}
                </T>
              </View>
            </View>
          ) : !fareLocked && marketMax > floor ? (
            <T variant="caption" tone="muted" style={{ marginTop: space.md, textAlign: 'center' }}>
              No time left to adjust — accept at {money(marketMax)}
            </T>
          ) : null}

          <View style={{ marginTop: space.lg }}>
            <RoutePair pickup={pickup} dropoff={dropoff} pickupHint={offer.etaMinutes != null ? `Pickup · ${offer.etaMinutes} min away` : 'Pickup'} />
          </View>

          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.xl }}>
            <PillButton label="Decline" variant="outline" onPress={onDecline} style={{ paddingHorizontal: space['2xl'] }} />
            <PillButton
              label={`Accept ${isDriver ? 'ride' : 'delivery'}`}
              loading={accepting}
              onPress={() => {
                haptic.commit();
                // [REPORT-010 F-07] Without a market anchor there is no
                // legitimate price choice: send NO fare (= market rate).
                // fare 0 used to clamp the mover's pay to the 60% floor on
                // CASH and burn the offer on MMG.
                onAccept(fareToSubmit(fareLocked, marketMax, price));
              }}
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
    <View style={{ minWidth: 26, height: 26, borderRadius: 13, paddingHorizontal: 6, backgroundColor: dk.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: color.white }}>
      <T variant="caption" weight="bold" style={{ color: color.white }}>
        {count}
      </T>
    </View>
  );
}

/** Store demand marker: ready-order count at a vendor. */
function StoreBadge({ ready, soon }: { ready: number; soon: number }) {
  const hot = ready > 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: hot ? dk.accent : color.white, borderWidth: 1.5, borderColor: hot ? color.white : dk.accentBorder }}>
      <Feather name="shopping-bag" size={12} color={hot ? color.white : dk.accent} />
      <T variant="caption" weight="bold" style={{ color: hot ? color.white : dk.text }}>
        {hot ? ready : soon}
      </T>
    </View>
  );
}

function MoverKindChoiceScreen({
  pending,
  selected,
  error,
  onSelect,
}: {
  pending: boolean;
  selected?: MoverKind;
  error: unknown;
  onSelect: (kind: MoverKind) => void;
}) {
  const choices: Array<{
    kind: MoverKind;
    pictogram: 'send' | 'taxi';
    title: string;
    body: string;
  }> = [
    {
      kind: 'RIDER',
      pictogram: 'send',
      title: 'Deliver orders',
      body: 'Food, groceries and parcels',
    },
    {
      kind: 'DRIVER',
      pictogram: 'taxi',
      title: 'Drive taxi rides',
      body: 'Pick up passengers nearby',
    },
  ];

  return (
    <Screen style={{ paddingHorizontal: GUTTER, justifyContent: 'center' }}>
      <View style={{ alignItems: 'center' }}>
        <View style={{ width: 72, height: 72, borderRadius: radius.xl, backgroundColor: color.brand[50], alignItems: 'center', justifyContent: 'center' }}>
          <Pictogram name="wheel" size={36} color={color.brand[600]} />
        </View>
        <T variant="title" center style={{ marginTop: space.xl }}>
          How are you working today?
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm, maxWidth: 310 }}>
          This account can do both. Choose one so Swift never sends you into the wrong work app.
        </T>
      </View>

      <View style={{ gap: space.md, marginTop: space['2xl'] }}>
        {choices.map((choice) => (
          <Pressable
            key={choice.kind}
            accessibilityRole="button"
            accessibilityLabel={`${choice.title}. ${choice.body}`}
            disabled={pending}
            onPress={() => onSelect(choice.kind)}
          >
            {({ pressed }) => (
              <View
                style={[
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    padding: space.lg,
                    borderRadius: radius.lg,
                    borderWidth: 1,
                    borderColor: selected === choice.kind ? color.brand[500] : color.border.subtle,
                    backgroundColor: color.surface.base,
                    opacity: pressed || (pending && selected !== choice.kind) ? 0.65 : 1,
                  },
                  cardShadow,
                ]}
              >
                <View style={{ width: 48, height: 48, borderRadius: radius.md, backgroundColor: color.brand[50], alignItems: 'center', justifyContent: 'center' }}>
                  <Pictogram name={choice.pictogram} size={25} color={color.brand[600]} />
                </View>
                <View style={{ flex: 1 }}>
                  <T variant="body" weight="bold">{choice.title}</T>
                  <T variant="caption" tone="muted" style={{ marginTop: 2 }}>{choice.body}</T>
                </View>
                {pending && selected === choice.kind ? (
                  <T variant="label" tone="brand">Opening…</T>
                ) : (
                  <Feather name="chevron-right" size={20} color={color.text.muted} />
                )}
              </View>
            )}
          </Pressable>
        ))}
      </View>

      {error ? (
        <T variant="label" tone="error" center style={{ marginTop: space.lg }}>
          We couldn’t switch work modes. Check your connection and try again.
        </T>
      ) : null}
    </Screen>
  );
}

export function MoverHomeScreen({ navigation }: any) {
  const preview = useMoverPreview((state) => state.preview);
  const insets = useSafeAreaInsets();
  const {
    kind,
    profile,
    loading,
    error: moverProfileError,
    ambiguous,
    refetch: refetchMoverProfiles,
  } = useMoverKind();
  const { latitude, longitude, status: locationStatus } = useLocationStore();
  const { resolve: resolveLocationForGo } = useDeviceLocation({ refreshOnMount: false });
  const [preparingOnline, setPreparingOnline] = useState(false);
  const { disclosure, disclose } = useBackgroundLocationDisclosure();
  const k: MoverKind = kind ?? 'RIDER';
  const goOnline = useGoOnline(k);
  const goOffline = useGoOffline(k);
  const accept = useAcceptJob(k);
  const acceptOffer = useAcceptOffer(k);
  const decline = useDeclineOffer(k);
  const selectMoverKind = useSelectMoverKind();
  const earnings = useEarningsToday(kind);
  const daily = useDailyEarnings<any>(kind); // DASH-03: server-aggregated 7-day trend
  const stats = useMoverStats(kind);
  const vstatus = useVerificationStatus<any>('MOVER');
  const active = useActiveJob(kind);
  const online = !!profile?.isOnline;
  const available = useAvailableJobs(kind, online);
  const { offer, dismiss } = useDispatchOffers(kind, online);

  const liveLocation = grantedLocationFix(latitude, longitude, locationStatus);
  const here = liveLocation
    ? { lat: liveLocation.latitude, lng: liveLocation.longitude }
    : undefined;
  const demand = useDemand<any>(kind, here);

  // DASH-03: last 7 days from the SERVER-aggregated daily endpoint — the old
  // client-side grouping summed the paginated (limit-20) earnings list, so an
  // active mover's older days silently truncated to ~0.
  const week = useMemo(() => {
    const raw: any = daily.data;
    const rows: Array<{ date: string; total: number; isToday: boolean }> = Array.isArray(raw) ? raw : raw?.data ?? [];
    return rows.map((r) => ({
      // 'YYYY-MM-DD' (Guyana day) → weekday letter; noon avoids any DST/edge slip.
      label: 'SMTWTFS'[new Date(`${r.date}T12:00:00Z`).getUTCDay()]!,
      total: Number(r.total ?? 0),
      isToday: !!r.isToday,
    }));
  }, [daily.data]);

  if (loading) {
    return (
      <Screen>
        <LoadingBlock />
      </Screen>
    );
  }

  if (ambiguous) {
    return (
      <MoverKindChoiceScreen
        pending={selectMoverKind.isPending}
        selected={selectMoverKind.variables}
        error={selectMoverKind.error}
        onSelect={(nextKind) => selectMoverKind.mutate(nextKind)}
      />
    );
  }

  if (moverProfileError || !kind) {
    return (
      <Screen>
        <ErrorState
          message={moverProfileError
            ? 'We couldn’t safely load your delivery and taxi profiles. Check your connection and try again.'
            : 'Your mover profile isn’t ready yet. Refresh after completing setup, or contact Support if this keeps happening.'}
          onRetry={() => void refetchMoverProfiles()}
        />
      </Screen>
    );
  }

  const isDriver = kind === 'DRIVER';
  const activeJob = active.data;
  const jobs: any[] = available.data ?? [];
  const errMsg = (goOnline.error as any)?.response?.data?.error?.message;
  // [E12 §7.1] The two liveness refusals are ACTIONABLE, not just readable:
  // 428 wants a selfie check (there's a screen for that now); 423 means only
  // support can help. Every other gate keeps the plain banner.
  const errCode = (goOnline.error as any)?.response?.data?.error?.code as string | undefined;
  const livenessAction =
    errCode === 'LIVENESS_CHECK_REQUIRED'
      ? { label: 'Take the selfie check', go: () => navigation?.navigate?.('LivenessCheck', { profile: kind }) }
      : errCode === 'LIVENESS_LOCKED'
        ? { label: 'Contact support', go: () => navigation?.navigate?.('GetHelp', { category: 'ACCOUNT', subject: 'Identity check locked my account' }) }
        : null;
  // [E12 §7.2] A pending mid-shift prompt, surfaced IN the app: the push is
  // the primary nudge, but a mover with notifications off would otherwise be
  // forced offline in silence. The deadline is the server's column, verbatim.
  const livenessPromptBy = (() => {
    const raw = (profile as any)?.livenessPromptDeadlineAt;
    if (typeof raw !== 'string') return null;
    const at = new Date(raw);
    return Number.isFinite(at.getTime()) && at.getTime() > Date.now() ? at : null;
  })();
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
  const tripsToday = moverJobsToday(earnings.data);
  // `breakdown` rode this payload and was never drawn, so tips were invisible
  // to a mover at both ends of the day — deciding and counting [F-261].
  const split = earningsSplit((earnings.data as any)?.breakdown);
  const onlineHours = (stats.data as any)?.onlineHoursToday;
  const busyToggle = preparingOnline || goOnline.isPending || goOffline.isPending;
  const startOnline = async () => {
    if (busyToggle) return;
    setPreparingOnline(true);
    try {
      // Permission sheets and foreground fixes yield back to the app. Keep the
      // eventual GO mutation owned by the account that tapped the control.
      const owner = preview ? null : requireAuthSessionSnapshot();
      const resolution = await prepareMoverOnline({
        resolveForeground: resolveLocationForGo,
        // Play requires our own disclosure BEFORE the OS sheet [LAUNCH-3].
        // Declining keeps the earner online, foreground-only.
        requestBackground: () => requestMoverBackgroundPermission(disclose),
        getForegroundFix: () => {
          if (!createLiveDeviceLocationLease()) return null;
          const current = useLocationStore.getState();
          return grantedLocationFix(current.latitude, current.longitude, current.status);
        },
        goOnline: (location) => goOnline.mutateAsync({
          ...location,
          authSession: owner ?? undefined,
        }),
      });
      if (resolution.status !== 'granted') {
        toast.error(
          resolution.status === 'denied'
            ? 'Location access is required to go online. Enable it and try again.'
            : 'Couldn’t get your location. Try again.',
        );
      }
    } catch {
      // The mutation owns and renders its server error; avoid a duplicate toast.
    } finally {
      setPreparingOnline(false);
    }
  };

  // Camera sits slightly SOUTH of the earner so the location dot floats in
  // the upper map half, clear of the GO ring.
  const region = {
    latitude: (latitude ?? GEORGETOWN.latitude) - 0.008,
    longitude: longitude ?? GEORGETOWN.longitude,
    latitudeDelta: 0.04,
    longitudeDelta: 0.04,
  };

  // One server-backed opportunity feeds both the arm's-length band and the
  // quieter online copy. Categories keep their existing priority; they are
  // never summed into a more exciting number.
  const positiveCount = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  const waiting = positiveCount(d.waiting);
  const watchers = positiveCount(d.watchers);
  const ready = positiveCount(d.ready);
  const soon = positiveCount(d.soon);
  const demandOpportunity = isDriver
    ? waiting != null
      ? {
          count: waiting,
          label: `${waiting === 1 ? 'person' : 'people'} waiting for a ride nearby`,
          detail: watchers != null ? ` · ${watchers} watching for a driver` : '',
        }
      : watchers != null
        ? {
            count: watchers,
            label: `${watchers === 1 ? 'person' : 'people'} watching for a driver near you`,
            detail: '',
          }
        : null
    : ready != null
      ? {
          count: ready,
          label: `order${ready === 1 ? '' : 's'} ready to collect`,
          detail: d.stores?.[0] ? ` — ${d.stores[0].name} has ${d.stores[0].ready}` : '',
        }
      : soon != null
        ? {
            count: soon,
            label: `order${soon === 1 ? '' : 's'} in the kitchen near you`,
            detail: '',
          }
        : null;
  const demandLine = demandOpportunity
    ? `${demandOpportunity.count} ${demandOpportunity.label}${demandOpportunity.detail}`
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: dk.bg }}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        region={region}
        showsUserLocation={liveLocation !== null}
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
        <MoverHomeAccountButton onPress={() => navigation?.navigate?.('Account')} />
      </View>

      {/* The GO ring — the one big action when offline (reference language). */}
      {!online && !activeJob ? (
        <View style={{ pointerEvents: 'box-none', position: 'absolute', left: 0, right: 0, bottom: '38%', alignItems: 'center' }}>
          <Pressable disabled={busyToggle} onPress={() => void startOnline()}>
            {({ pressed }) => (
              <View style={{ width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.accentGlow }}>
                <View
                  style={[
                    { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.accent, opacity: pressed || busyToggle ? 0.8 : 1 },
                    cardShadow,
                  ]}
                >
                  <T variant="title" weight="bold" style={{ color: color.white, letterSpacing: 1 }}>
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

          {!online && !activeJob && demandOpportunity ? (
            <DemandBand
              count={demandOpportunity.count}
              label={demandOpportunity.label}
              disabled={busyToggle}
              onPress={() => void startOnline()}
              style={{ marginTop: space.md }}
            />
          ) : null}

          {/* Why the switch snapped back — the gate's own words, right where you flipped it. */}
          {errMsg ? (
            <View style={{ borderRadius: radius.lg, backgroundColor: withAlpha(dk.accent, 0.14), borderWidth: 1, borderColor: dk.accentBorder, padding: space.md, marginTop: space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
                <Feather name="alert-circle" size={15} color={dk.accent} style={{ marginTop: 1 }} />
                <T variant="label" style={{ flex: 1, color: dk.text }}>
                  {errMsg}
                </T>
              </View>
              {livenessAction ? (
                <PillButton
                  label={livenessAction.label}
                  size="sm"
                  style={{ marginTop: space.sm, alignSelf: 'flex-start' }}
                  onPress={livenessAction.go}
                />
              ) : null}
            </View>
          ) : null}

          {/* [E12 §7.2] A live mid-shift identity prompt — tap lands on the
              selfie screen with the same server deadline the push carries. */}
          {online && livenessPromptBy ? (
            <Pressable onPress={() => navigation?.navigate?.('LivenessCheck', { profile: kind, respondBy: livenessPromptBy.toISOString() })}>
              {({ pressed }) => (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(color.warning, 0.12), borderWidth: 1, borderColor: withAlpha(color.warning, 0.4), padding: space.md, marginTop: space.md, opacity: pressed ? 0.85 : 1 }}>
                  <Feather name="user-check" size={15} color={dk.warning} style={{ marginTop: 1 }} />
                  <T variant="label" style={{ flex: 1, color: dk.text }}>
                    Safety check-in: take a quick selfie by {livenessPromptBy.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} to stay online — tap here.
                  </T>
                </View>
              )}
            </Pressable>
          ) : null}

          {/* Renewal nudge — a document is inside its 30-day window */}
          {expiringDoc ? (
            <Pressable onPress={() => navigation?.navigate?.('MoverDocuments')}>
              {({ pressed }) => (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, borderRadius: radius.lg, backgroundColor: withAlpha(color.warning, 0.12), borderWidth: 1, borderColor: withAlpha(color.warning, 0.4), padding: space.md, marginTop: space.md, opacity: pressed ? 0.85 : 1 }}>
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
                  <Feather name="check-circle" size={14} color={dk.success} />
                  <T variant="caption" weight="semibold" style={{ color: dk.muted }}>
                    100% yours — Swift takes 0% commission
                  </T>
                </View>
                {split.showTips ? (
                  <T variant="caption" weight="semibold" style={{ marginTop: 2, color: dk.success }}>
                    includes {money(split.tips)} in tips
                  </T>
                ) : null}
                <View style={{ marginTop: space.lg }}>
                  <DWeekBars days={week} />
                </View>
              </DCard>
            )}
          </Pressable>

          {/* Stat chips (reference profile row, Swift-real numbers). */}
          <View style={{ flexDirection: 'row', gap: space.md, marginTop: space.md }}>
            <DStat icon={isDriver ? 'navigation' : 'zap'} value={String(tripsToday)} label={isDriver ? 'Trips today' : 'Jobs today'} />
            {onlineHours != null ? <DStat icon="clock" value={`${onlineHours}h`} label="Online today" /> : null}
            <DStat icon="percent" value="0%" label="Commission" />
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
                <Feather name="dollar-sign" size={22} color={dk.accent} />
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
                <Feather name="radio" size={28} color={dk.muted} />
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
                      <RoutePair pickup={j.vendor?.name ?? j.pickupAddress ?? 'Pickup'} dropoff={j.deliveryAddress ?? j.dropoffAddress} />
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
                Work shows here the moment you go online.
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
          accepting={acceptOffer.isPending}
          onAccept={(fare) => acceptOffer.mutate({ orderId: offer.orderId, fare, offerAttemptId: offer.offerAttemptId }, { onSuccess: dismiss })}
          // Tell the server too — the cascade re-offers the next mover NOW
          // instead of waiting out the 20s timeout on a card nobody wants.
          onDecline={() => {
            // [WR-010] Dismiss immediately (never trap a mover on a card they
            // refused) but be honest if dispatch never heard the decline.
            decline.mutate(
              { orderId: offer.orderId, offerAttemptId: offer.offerAttemptId },
              { onError: () => toast.show("Couldn't tell dispatch — the offer will time out on its own.") },
            );
            dismiss();
          }}
        />
      ) : null}

      {/* Play-mandated background-location disclosure. Rendered at the root so
          it survives whichever sheet is open when GO is tapped. */}
      {disclosure}
    </View>
  );
}
